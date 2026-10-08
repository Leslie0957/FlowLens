import {expect, it, vi} from 'vitest';
import {mkdtempSync, mkdirSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {pipelineRepairSchema, type PipelineRepair} from '@flowlens/contracts';
import {openDatabase, migrate} from '../src/db.js';
import {PipelineService} from '../src/pipeline.js';
import {PipelineAgent} from '../src/pipeline-agent.js';
import {ToolRegistry} from '../src/tool-registry.js';
import {canonical, diagnosisLimits} from '../src/pipeline-diag-config.js';
import {sharedLiveBudget} from '../src/live-budget.js';
import {LocalError} from '../src/local-execution.js';
import type {ModelGateway} from '../src/model-gateway.js';

type Messages = Record<string, unknown>[];
const initial = (m: Messages) => JSON.parse(String(m.find(x => x.role === 'user')!.content));
const results = (m: Messages) => m.filter(x => x.role === 'tool').map(x => ({
  call_id: x.tool_call_id,
  ...JSON.parse(String(x.content))
}));
const requestTools = (...names: string[]) => ({text: '', finishReason: 'tool_calls' as const,
  calls: names.map(name => ({id: randomUUID(), name, arguments: {}}))});
function answer(m: Messages, overrides: Record<string, unknown> = {}) {
  return {text: JSON.stringify({diagnosis: '现有错误可确认失败；缺少外部意图，请人工核对。',
    failed_step: initial(m).failure.failed_step, action: 'MANUAL_REQUIRED',
    evidence_ids: [initial(m).failure.evidence_id], candidate: null, ...overrides}),
  finishReason: 'stop' as const, calls: []};
}
function setup() {
  const root = mkdtempSync(join(tmpdir(), 'flowlens-adaptive-'));
  const db = openDatabase(join(root, 'app.sqlite'));
  migrate(db);
  const pipeline = new PipelineService(db, join(root, 'projects'));
  const agents: PipelineAgent[] = [];
  const agent = (options: ConstructorParameters<typeof PipelineAgent>[1]) => {
    const a = new PipelineAgent(pipeline, options);
    agents.push(a);
    return a;
  };
  const failure = async (template = 'A') => {
    const project = pipeline.create(template, randomUUID());
    const e = await pipeline.waitFor(pipeline.start(project.id, randomUUID()).id);
    expect(e.status).toBe('FAILED');
    return {project, e};
  };
  return {root, pipeline, agent, failure, async close() {
    await Promise.all(agents.map(a => a.stopAll()));
    await pipeline.stopAll();
    db.close();
    rmSync(root, {recursive: true, force: true});
  }};
}

it('actual feedback determines two different routes; every batched call reaches the next request and approved candidates verify, commit and restore', async () => {
  const s = setup();
  const traces: unknown[] = [];
  try {
    for (const template of ['A', 'B']) {
      const {project, e} = await s.failure(template);
      const requests: Messages[] = [];
      let route = '', newSql = '';
      const gateway: ModelGateway = {async complete(m) {
        requests.push(structuredClone(m));
        const observed = results(m);
        if (!observed.length) {
          const context = initial(m);
          expect(context.failure).toMatchObject({status: e.status, error_code: e.error_code, error_message: e.error_message});
          expect(context).not.toHaveProperty('template');
          expect(context).not.toHaveProperty('sql');
          expect(context).not.toHaveProperty('schema');
          expect(context).not.toHaveProperty('contract');
          // Decision depends on the real error, not a test template selector.
          route = /no such column/.test(context.failure.error_message) ? 'column' : 'output';
          return requestTools(route === 'column' ? 'get_sql' : 'get_output_preview');
        }
        const lastAssistant = m.filter(x => x.role === 'assistant').at(-1)!;
        for (const c of lastAssistant.tool_calls as {id: string}[]) {
          expect(observed.filter(r => r.call_id === c.id)).toHaveLength(1);
        }
        if (observed.length === 1) {
          if (route === 'column') {
            expect(observed[0].output.sql).toContain('speed_kph');
            return requestTools('get_schema');
          }
          expect(observed[0].output.columns).toContain('vehicle_type');
          expect(observed[0].output.validation.passed).toBe(false);
          return requestTools('get_sql', 'get_task_contract');
        }
        const sql = observed.find(r => typeof r.output.sql === 'string');
        if (route === 'column') {
          const schema = observed.find(r => Array.isArray(r.output.source));
          const actualColumn = schema.output.source.find((c: {name: string}) => c.name.startsWith('speed_')).name;
          const missingColumn = initial(m).failure.error_message.split('no such column: ')[1];
          newSql = sql.output.sql.replace(missingColumn, actualColumn);
        } else {
          const output = observed.find(r => Array.isArray(r.output.columns));
          const rules = observed.find(r => Array.isArray(r.output.business_key));
          const unexpected = output.output.columns.find((c: string) => !rules.output.columns.includes(c));
          const required = rules.output.columns.find((c: string) => !output.output.columns.includes(c));
          newSql = sql.output.sql.replace(required + ' AS ' + unexpected, required);
        }
        return answer(m, {action: 'SQL_PATCH', evidence_ids: [initial(m).failure.evidence_id, ...observed.flatMap(r => r.evidence_ids)],
          candidate: {file_path: 'task.sql', base_hash: sql.output.base_hash, new_content: newSql}});
      }};
      const a = s.agent({gateway});
      const r = await a.waitFor(a.create(project.id, e.id, randomUUID(), 'MOCK', 'feedback-controlled').id);
      expect(r.status).toBe('PENDING_APPROVAL');
      expect(r.model_requests).toBe(3);
      expect(r.tools.map(t => t.name)).toEqual(template === 'A' ? ['get_sql', 'get_schema'] : ['get_output_preview', 'get_sql', 'get_task_contract']);
      expect(r.tools.map(t => t.request)).toEqual(template === 'A' ? [1, 2] : [1, 2, 2]);
      expect(r.model_turns).toHaveLength(3);
      expect(r.response_checks).toEqual([]);
      expect(s.pipeline.snapshot(project.id).target.row_count).toBe(0);
      expect(s.pipeline.snapshot(project.id).executions).toHaveLength(1);
      a.decide(project.id, r.id, 'approve', randomUUID(), true);
      const done = await a.waitFor(r.id);
      expect(done.status).toBe('VERIFIED');
      expect(done.commit_approval?.status).toBe('COMMITTED');
      const batch = s.pipeline.snapshot(project.id).batches[0]!;
      expect(s.pipeline.snapshot(project.id).target.row_count).toBe(4);
      expect(s.pipeline.restore(project.id, batch.id, randomUUID()).status).toBe('SUCCEEDED');
      expect(s.pipeline.snapshot(project.id).target.row_count).toBe(0);
      traces.push({fixture: template, mode: 'deterministic gateway, real tools and SQLite; not LIVE quality', requests,
        repair: done, executions: s.pipeline.snapshot(project.id).executions, batch: s.pipeline.snapshot(project.id).batches[0]});
    }
    if (process.env.FLOWLENS_ADAPTIVE_TRACE_DIR) {
      const dir = resolve(process.env.FLOWLENS_ADAPTIVE_TRACE_DIR);
      mkdirSync(dir, {recursive: true});
      writeFileSync(join(dir, 'feedback-trajectories.json'), JSON.stringify(traces, null, 2));
    }
  } finally {await s.close();}
});

it('initial evidence alone supports conservative advice; one SQL tool plus initial failure supports a candidate', async () => {
  const s = setup();
  try {
    const {project, e} = await s.failure();
    const advice = s.agent({gateway: {async complete(m) {return answer(m);}}});
    const r = await advice.waitFor(advice.create(project.id, e.id, randomUUID(), 'MOCK', 'controlled').id);
    expect(r).toMatchObject({status: 'NO_CANDIDATE', candidate: null, model_requests: 1});
    expect(r.tools).toEqual([]);
    expect(r.evidence[0]).toMatchObject({type: 'INITIAL_FAILURE', source_id: e.id, source_version: e.revision_hash + ':' + e.input_hash});
    const patch = s.agent({gateway: {async complete(m) {
      if (!results(m).length) return requestTools('get_sql');
      const sql = results(m)[0];
      return answer(m, {action: 'SQL_PATCH', evidence_ids: [initial(m).failure.evidence_id, ...sql.evidence_ids],
        candidate: {file_path: 'task.sql', base_hash: sql.output.base_hash, new_content: sql.output.sql.replace('speed_kph', 'speed_mps')}});
    }}});
    const candidate = await patch.waitFor(patch.create(project.id, e.id, randomUUID(), 'MOCK', 'controlled').id);
    expect(candidate.status).toBe('PENDING_APPROVAL');
    expect(candidate.tools.map(t => t.name)).toEqual(['get_sql']);
    expect(s.pipeline.snapshot(project.id).executions).toHaveLength(1);
    expect(s.pipeline.snapshot(project.id).target.row_count).toBe(0);
    expect(s.pipeline.project(project.id).current_revision_id).toBe(project.current_revision_id);
  } finally {await s.close();}
});

it('missing SQL, duplicate/foreign/version-invalid citations, wrong failure stage and NO_CHANGE receive precise bounded feedback', async () => {
  const s = setup();
  try {
    const {project, e} = await s.failure();
    const other = await s.failure('B');
    const foreignAgent = s.agent({gateway: {async complete(m) {return answer(m);}}});
    const foreign = await foreignAgent.waitFor(foreignAgent.create(other.project.id, other.e.id, randomUUID(), 'MOCK', 'controlled').id);
    for (const [kind, code] of [
      ['sql', 'REPAIR_SQL_EVIDENCE_REQUIRED'], ['duplicate', 'REPAIR_EVIDENCE_INVALID'],
      ['foreign', 'REPAIR_EVIDENCE_INVALID'], ['random', 'REPAIR_EVIDENCE_INVALID'],
      ['version', 'REPAIR_EVIDENCE_INVALID'], ['stage', 'REPAIR_STAGE_INVALID'], ['healthy', 'REPAIR_ACTION_INVALID']
    ]) {
      let count = 0;
      const a = s.agent({gateway: {async complete(m) {
        if (++count === 2) {
          const feedback = JSON.parse(String(m.at(-1)!.content));
          expect(feedback.error_code).toBe(code);
          expect(feedback).not.toHaveProperty('missing_tools');
        }
        const id = initial(m).failure.evidence_id;
        return answer(m, kind === 'sql' ? {action: 'SQL_PATCH', candidate: {file_path: 'task.sql', base_hash: e.revision_hash, new_content: 'SELECT 1'}} :
          kind === 'duplicate' ? {evidence_ids: [id, id]} : kind === 'foreign' ? {evidence_ids: [foreign.evidence[0]!.id]} :
          kind === 'random' ? {evidence_ids: [randomUUID()]} : kind === 'stage' ? {failed_step: 'validate'} : kind === 'healthy' ? {action: 'NO_CHANGE'} : {});
      }}});
      if (kind === 'version') vi.spyOn(a, 'registry').mockImplementation(r => {r.evidence[0]!.source_version = 'wrong'; return new ToolRegistry();});
      const r = await a.waitFor(a.create(project.id, e.id, randomUUID(), 'MOCK', 'controlled').id);
      expect(r).toMatchObject({status: 'FAILED', error_code: code, candidate: null});
      expect(r.response_checks.map(c => c.code)).toEqual([code, code]);
      expect(r.response_checks.every(c => c.response_text)).toBe(true);
      expect(r.tools).toHaveLength(0);
    }
  } finally {await s.close();}
});

it('invalid arguments are returned by call ID and can be corrected, while unauthorized tools and changed scope stop', async () => {
  const s = setup();
  try {
    const {project, e} = await s.failure();
    let requests = 0;
    const a = s.agent({gateway: {async complete(m) {
      if (++requests === 1) return {text: '', finishReason: 'tool_calls', calls: [{id: 'bad', name: 'get_sql', arguments: {project_id: randomUUID()}}]};
      if (requests === 2) {
        expect(results(m)[0]).toMatchObject({call_id: 'bad', error_code: 'INVALID_ARGUMENTS'});
        return requestTools('get_sql', 'get_logs');
      }
      expect(results(m)).toHaveLength(3);
      return answer(m);
    }}});
    const r = await a.waitFor(a.create(project.id, e.id, randomUUID(), 'MOCK', 'controlled').id);
    expect(r.status).toBe('NO_CANDIDATE');
    expect(r.tools.map(t => t.status)).toEqual(['FAILED', 'COMPLETED', 'COMPLETED']);
    expect(r.evidence).toHaveLength(3);
    for (const kind of ['unknown', 'scope']) {
      const b = s.agent({gateway: {async complete() {
        if (kind === 'scope') s.pipeline.save(project.id, project.current_revision_id, s.pipeline.revision(project.current_revision_id).sql + ' ', randomUUID());
        return requestTools(kind === 'unknown' ? 'shell' : 'get_sql');
      }}});
      const failed = await b.waitFor(b.create(project.id, e.id, randomUUID(), 'MOCK', 'controlled').id);
      expect(failed.error_code).toBe(kind === 'unknown' ? 'TOOL_NOT_ALLOWED' : 'REPAIR_STALE');
      expect(failed.tools[0]?.status).toBe('FAILED');
      expect(failed.evidence).toHaveLength(1);
    }
    expect(s.pipeline.snapshot(project.id).target.row_count).toBe(0);
  } finally {await s.close();}
});

it('repeated observations and alternating old observations stall despite fresh call and evidence UUIDs', async () => {
  const s = setup();
  try {
    const {project, e} = await s.failure();
    for (const alternating of [false, true]) {
      let requests = 0;
      const a = s.agent({gateway: {async complete() {
        return requestTools(alternating && ++requests % 2 === 0 ? 'get_logs' : 'get_sql');
      }}});
      const r = await a.waitFor(a.create(project.id, e.id, randomUUID(), 'MOCK', 'controlled').id);
      expect(r).toMatchObject({status: 'FAILED', error_code: 'REPAIR_NO_PROGRESS', candidate: null});
      expect(r.model_requests).toBe(alternating ? 5 : 4);
      expect(new Set(r.evidence.map(x => x.id)).size).toBe(r.evidence.length);
      expect(new Set(r.tools.map(x => x.call_id)).size).toBe(r.tools.length);
    }
  } finally {await s.close();}
});

it('more than eight requests with new actual observations completes; request 101 never occurs at the default cap', async () => {
  const s = setup();
  try {
    const {project, e} = await s.failure();
    for (const count of [10, 101]) {
      let calls = 0;
      const a = s.agent({gateway: {async complete(m) {
        if (++calls === count) return answer(m);
        return requestTools('get_execution');
      }}});
      // Inject actual persisted, changing observations to isolate the request cap
      // from the separate repeat guard. No paid model or new production tool.
      const original = a.registry.bind(a);
      vi.spyOn(a, 'registry').mockImplementation(r => {
        const registry = original(r), call = registry.call.bind(registry);
        vi.spyOn(registry, 'call').mockImplementation(async (...args) => {
          const stored = s.pipeline.execution(e.id);
          stored.error_message = 'controlled observation ' + calls;
          s.pipeline.put('execution', stored);
          return call(...args);
        });
        return registry;
      });
      const r = await a.waitFor(a.create(project.id, e.id, randomUUID(), 'MOCK', 'controlled').id);
      expect(calls).toBe(count === 10 ? 10 : 100);
      expect(r.diagnosis_limits?.max_requests).toBe(100);
      expect(r.status).toBe(count === 10 ? 'NO_CANDIDATE' : 'FAILED');
      expect(r.error_code).toBe(count === 10 ? null : 'MODEL_REQUEST_LIMIT');
      expect(r.tools).toHaveLength(count === 10 ? 9 : 100);
    }
  } finally {await s.close();}
});

it('tool, context and request limits preserve evidence and never publish a candidate', async () => {
  const s = setup();
  try {
    const {project, e} = await s.failure();
    for (const [limits, code, requests] of [
      [{max_tool_calls: 1}, 'REPAIR_TOOL_LIMIT', 1],
      [{max_context_bytes: 1}, 'REPAIR_CONTEXT_LIMIT', 0],
      [{max_context_bytes: 4000}, 'REPAIR_CONTEXT_LIMIT', 1],
      [{max_requests: 1}, 'MODEL_REQUEST_LIMIT', 1]
    ] as const) {
      const a = s.agent({limits, gateway: {async complete() {return requestTools('get_sql', 'get_schema', 'get_logs');}}});
      const r = await a.waitFor(a.create(project.id, e.id, randomUUID(), 'MOCK', 'controlled').id);
      expect(r).toMatchObject({status: 'FAILED', error_code: code, candidate: null, model_requests: requests});
      expect(r.evidence[0]?.type).toBe('INITIAL_FAILURE');
      if (code === 'REPAIR_CONTEXT_LIMIT' && requests) expect(r.tools).toHaveLength(3);
    }
  } finally {await s.close();}
});

it('cancel and timeout race late model responses without publishing; restart and old budgets remain explicit', async () => {
  const s = setup();
  try {
    const {project, e} = await s.failure();
    for (const cancel of [true, false]) {
      let resolve!: (r: ReturnType<typeof answer>) => void;
      let messages!: Messages;
      const complete = vi.fn((m: Messages) => {messages = structuredClone(m); return new Promise<ReturnType<typeof answer>>(r => resolve = r);});
      const a = s.agent({limits: {timeout_ms: cancel ? 1000 : 20}, gateway: {complete}});
      const created = a.create(project.id, e.id, randomUUID(), 'MOCK', 'controlled');
      await vi.waitFor(() => expect(complete).toHaveBeenCalledOnce(), {interval: 1});
      if (cancel) a.cancel(project.id, created.id);
      const r = await a.waitFor(created.id);
      expect(r.status).toBe(cancel ? 'CANCELLED' : 'FAILED');
      expect(r.error_code).toBe(cancel ? 'REPAIR_CANCELLED' : 'REPAIR_TIMEOUT');
      resolve(answer(messages));
      await new Promise(r => setTimeout(r, 5));
      expect(s.pipeline.repair(created.id)).toEqual(r);
      expect(r.model_turns).toHaveLength(0);
      expect(r.candidate).toBeNull();
    }
    const old = s.pipeline.list<PipelineRepair>('repair', project.id)[0]!;
    old.status = 'RUNNING';
    s.pipeline.put('repair', old);
    s.pipeline.recover();
    expect(s.pipeline.repair(old.id).status).toBe('INTERRUPTED');
    const legacy = pipelineRepairSchema.parse({...old, diagnosis_limits: undefined, model_turns: undefined});
    expect(legacy.diagnosis_limits).toBeNull();
    expect(legacy.model_turns).toEqual([]);
  } finally {await s.close();}
});

it('LIVE per-session allowance still reserves the shared paid budget before every actual request', async () => {
  const s = setup();
  vi.stubEnv('MODEL_API_KEY', 'controlled-no-network');
  vi.stubEnv('FLOWLENS_LIVE_APPROVED', '1');
  vi.stubEnv('FLOWLENS_LIVE_MAX_REQUESTS', '1');
  try {
    const {project, e} = await s.failure();
    let reserves = 0;
    const spy = vi.spyOn(sharedLiveBudget, 'reserve').mockImplementation((approved, limit) => {
      expect(approved).toBe('1'); expect(limit).toBe('1');
      if (++reserves > 1) throw new LocalError('LIVE_REQUEST_BUDGET_EXCEEDED', 429);
      return reserves;
    });
    const complete = vi.fn(async () => requestTools('get_sql'));
    const a = s.agent({gateway: {complete}});
    const r = await a.waitFor(a.create(project.id, e.id, randomUUID(), 'LIVE', 'controlled').id);
    expect(r.diagnosis_limits?.max_requests).toBe(100);
    expect(complete).toHaveBeenCalledOnce();
    expect(spy).toHaveBeenCalledTimes(2);
    expect(r.error_code).toBe('LIVE_REQUEST_BUDGET_EXCEEDED');
    expect(r.candidate).toBeNull();
  } finally {vi.restoreAllMocks(); vi.unstubAllEnvs(); await s.close();}
});

it('configuration validates every positive integer and freezes each session; canonicalization retains business times', () => {
  expect(diagnosisLimits()).toEqual({max_requests: 100, max_tool_calls: 200, timeout_ms: 900000, max_stall_rounds: 3, max_context_bytes: 262144});
  for (const value of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    expect(() => diagnosisLimits({max_requests: value})).toThrow('INVALID_DIAG_CONFIG');
  }
  expect(canonical({b: 2, a: 1})).toBe(canonical({a: 1, b: 2}));
  expect(canonical({at: 'yesterday'})).not.toBe(canonical({at: 'today'}));
});

it('session limits are copied once and elapsed time cannot be bypassed by an immediate response', async () => {
  const s = setup();
  try {
    const {project, e} = await s.failure();
    const limits = {max_requests: 7};
    const a = s.agent({limits, gateway: {async complete(m) {return answer(m);}}});
    const created = a.create(project.id, e.id, randomUUID(), 'MOCK', 'controlled');
    limits.max_requests = 2;
    expect((await a.waitFor(created.id)).diagnosis_limits?.max_requests).toBe(7);
    const b = s.agent({limits: {timeout_ms: 10}, gateway: {async complete(m) {
      const end = performance.now() + 30;
      while (performance.now() < end) { /* simulate synchronous provider work */ }
      return answer(m);
    }}});
    const failed = await b.waitFor(b.create(project.id, e.id, randomUUID(), 'MOCK', 'controlled').id);
    expect(failed).toMatchObject({status: 'FAILED', error_code: 'REPAIR_TIMEOUT', candidate: null});
    expect(failed.diagnosis).toBeNull();
  } finally {await s.close();}
});

it('failed calls count toward the tool ceiling, and repeated reads can still finish before the stall threshold', async () => {
  const s = setup();
  try {
    const {project, e} = await s.failure();
    const a = s.agent({limits: {max_tool_calls: 2}, gateway: {async complete() {
      return {text: '', finishReason: 'tool_calls', calls: [{id: randomUUID(), name: 'get_sql', arguments: {extra: true}}]};
    }}});
    const r = await a.waitFor(a.create(project.id, e.id, randomUUID(), 'MOCK', 'controlled').id);
    expect(r.error_code).toBe('REPAIR_TOOL_LIMIT');
    expect(r.tools.map(t => t.status)).toEqual(['FAILED', 'FAILED']);
    expect(r.evidence).toHaveLength(1);
    let calls = 0;
    const b = s.agent({gateway: {async complete(m) {return ++calls < 3 ? requestTools('get_sql') : answer(m);}}});
    const done = await b.waitFor(b.create(project.id, e.id, randomUUID(), 'MOCK', 'controlled').id);
    expect(done.status).toBe('NO_CANDIDATE');
    expect(done.tools).toHaveLength(2);
  } finally {await s.close();}
});
