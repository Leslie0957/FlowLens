import { expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { pipelineRepairSchema, type PipelineRepair } from '@flowlens/contracts';
import { openDatabase, migrate } from '../src/db.js';
import { PipelineService } from '../src/pipeline.js';
import { PipelineAgent } from '../src/pipeline-agent.js';
import { ToolRegistry } from '../src/tool-registry.js';
import { canonical, diagnosisLimits } from '../src/pipeline-diag-config.js';
import { sharedLiveBudget } from '../src/live-budget.js';
import { LocalError } from '../src/local-execution.js';
import type { ModelGateway } from '../src/model-gateway.js';

type Messages = Record<string, unknown>[];
const initial = (m: Messages) => JSON.parse(String(m.find((x) => x.role === 'user')!.content));
const results = (m: Messages) =>
  m
    .filter((x) => x.role === 'tool')
    .map((x) => ({
      call_id: x.tool_call_id,
      ...JSON.parse(String(x.content)),
    }));
const requestTools = (...names: string[]) => ({
  text: '',
  finishReason: 'tool_calls' as const,
  calls: names.map((name) => ({ id: randomUUID(), name, arguments: {} })),
});
function answer(m: Messages, overrides: Record<string, unknown> = {}) {
  return {
    text: JSON.stringify({
      diagnosis: '现有错误可确认失败；缺少外部意图，请人工核对。',
      failed_step: initial(m).failure.failed_step,
      action: 'MANUAL_REQUIRED',
      evidence_ids: [initial(m).failure.evidence_id],
      candidate: null,
      ...overrides,
    }),
    finishReason: 'stop' as const,
    calls: [],
  };
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
    return { project, e };
  };
  return {
    root,
    pipeline,
    agent,
    failure,
    async close() {
      await Promise.all(agents.map((a) => a.stopAll()));
      await pipeline.stopAll();
      db.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

it('actual feedback determines two different routes; every batched call reaches the next request and approved candidates verify, commit and restore', async () => {
  const s = setup();
  const traces: unknown[] = [];
  try {
    for (const template of ['A', 'B']) {
      const { project, e } = await s.failure(template);
      const requests: Messages[] = [];
      let route = '',
        newSql = '';
      const gateway: ModelGateway = {
        async complete(m) {
          requests.push(structuredClone(m));
          const observed = results(m);
          if (!observed.length) {
            const context = initial(m);
            expect(context.failure).toMatchObject({
              status: e.status,
              error_code: e.error_code,
              error_message: e.error_message,
            });
            expect(context).not.toHaveProperty('template');
            expect(context).not.toHaveProperty('sql');
            expect(context).not.toHaveProperty('schema');
            expect(context).not.toHaveProperty('contract');
            // Decision depends on the real error, not a test template selector.
            route = /no such column/.test(context.failure.error_message) ? 'column' : 'output';
            return requestTools(route === 'column' ? 'get_sql' : 'get_output_preview');
          }
          const lastAssistant = m.filter((x) => x.role === 'assistant').at(-1)!;
          for (const c of lastAssistant.tool_calls as { id: string }[]) {
            expect(observed.filter((r) => r.call_id === c.id)).toHaveLength(1);
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
          const sql = observed.find((r) => typeof r.output.sql === 'string');
          if (route === 'column') {
            const schema = observed.find((r) => Array.isArray(r.output.source));
            const actualColumn = schema.output.source.find((c: { name: string }) =>
              c.name.startsWith('speed_'),
            ).name;
            const missingColumn = initial(m).failure.error_message.split('no such column: ')[1];
            newSql = sql.output.sql.replace(missingColumn, actualColumn);
          } else {
            const output = observed.find((r) => Array.isArray(r.output.columns));
            const rules = observed.find((r) => Array.isArray(r.output.business_key));
            const unexpected = output.output.columns.find(
              (c: string) => !rules.output.columns.includes(c),
            );
            const required = rules.output.columns.find(
              (c: string) => !output.output.columns.includes(c),
            );
            newSql = sql.output.sql.replace(required + ' AS ' + unexpected, required);
          }
          return answer(m, {
            action: 'SQL_PATCH',
            evidence_ids: [
              initial(m).failure.evidence_id,
              ...observed.flatMap((r) => r.evidence_ids),
            ],
            candidate: {
              file_path: 'task.sql',
              base_hash: sql.output.base_hash,
              new_content: newSql,
            },
          });
        },
      };
      const a = s.agent({ gateway });
      const r = await a.waitFor(
        a.create(project.id, e.id, randomUUID(), 'MOCK', 'feedback-controlled').id,
      );
      expect(r.status).toBe('PENDING_APPROVAL');
      expect(r.model_requests).toBe(3);
      expect(r.tools.map((t) => t.name)).toEqual(
        template === 'A'
          ? ['get_sql', 'get_schema']
          : ['get_output_preview', 'get_sql', 'get_task_contract'],
      );
      expect(r.tools.map((t) => t.request)).toEqual(template === 'A' ? [1, 2] : [1, 2, 2]);
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
      traces.push({
        fixture: template,
        mode: 'deterministic gateway, real tools and SQLite; not LIVE quality',
        requests,
        repair: done,
        executions: s.pipeline.snapshot(project.id).executions,
        batch: s.pipeline.snapshot(project.id).batches[0],
      });
    }
    if (process.env.FLOWLENS_ADAPTIVE_TRACE_DIR) {
      const dir = resolve(process.env.FLOWLENS_ADAPTIVE_TRACE_DIR);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'feedback-trajectories.json'), JSON.stringify(traces, null, 2));
    }
  } finally {
    await s.close();
  }
});

it('model reads recent logs then independently requests an earlier page and cites its persisted range', async () => {
  const s = setup();
  try {
    const { project, e } = await s.failure();
    e.logs = Array.from({ length: 47 }, (_, i) => ({
      at: '2026-10-08T00:00:00Z',
      step: 'query',
      level: i === 4 ? 'ERROR' : 'INFO',
      message: i === 4 ? '早期关键错误：来源字段缺失' : `普通日志${i + 1}`,
    }));
    s.pipeline.put('execution', e);
    const a = s.agent({
      gateway: {
        async complete(m) {
          const pages = results(m);
          if (!pages.length) {
            expect(JSON.stringify(m)).not.toContain('早期关键错误');
            return requestTools('get_logs');
          }
          const last = pages.at(-1)!;
          if (
            !last.output.logs.some((l: { message: string }) => l.message.includes('早期关键错误'))
          ) {
            expect(last.output.has_more).toBe(true);
            return {
              text: '',
              finishReason: 'tool_calls',
              calls: [
                {
                  id: randomUUID(),
                  name: 'get_logs',
                  arguments: { before_seq: last.output.next_before_seq },
                },
              ],
            };
          }
          return answer(m, {
            diagnosis: '较早页证据确认来源字段缺失',
            evidence_ids: last.evidence_ids,
          });
        },
      },
    });
    const r = await a.waitFor(a.create(project.id, e.id, randomUUID(), 'MOCK', 'paged').id);
    expect(r.status).toBe('NO_CANDIDATE');
    expect(r.tools.map((t) => t.args)).toEqual([{}, { before_seq: 28 }, { before_seq: 8 }]);
    expect(r.model_requests).toBe(4);
    const persisted = s.pipeline.repair(r.id);
    expect(persisted.evidence.find((v) => v.id === r.evidence_ids[0])?.read_range).toMatchObject({
      execution_id: e.id,
      before_seq: 8,
      first_seq: 1,
      last_seq: 7,
    });
  } finally {
    await s.close();
  }
});

it('changing limits and filters on observed log rows does not reset progress; first empty observation allows subsequent bundles', async () => {
  const s = setup();
  try {
    const { project, e } = await s.failure();
    for (const empty of [false, true]) {
      let requests = 0;
      const a = s.agent({
        gateway: {
          async complete(m) {
            requests++;
            if (empty && requests === 1)
              return {
                text: '',
                finishReason: 'tool_calls',
                calls: [
                  { id: randomUUID(), name: 'get_logs', arguments: { step: 'verification' } },
                ],
              };
            if (empty && requests === 2) return requestTools('get_sql', 'get_schema');
            if (empty) return answer(m);
            return {
              text: '',
              finishReason: 'tool_calls',
              calls: [{ id: randomUUID(), name: 'get_logs', arguments: { limit: 20 + requests } }],
            };
          },
        },
      });
      const r = await a.waitFor(a.create(project.id, e.id, randomUUID(), 'MOCK', 'no-progress').id);
      expect(r.status).toBe(empty ? 'NO_CANDIDATE' : 'FAILED');
      if (!empty) {
        expect(r.error_code).toBe('REPAIR_NO_PROGRESS');
        expect(r.model_requests).toBe(4);
      } else expect(r.tools.every((t) => t.status === 'COMPLETED')).toBe(true);
    }
  } finally {
    await s.close();
  }
});

it('first-read bundles receive exact deferred feedback; model selects one source, observes it, then may batch later reads', async () => {
  const s = setup();
  try {
    const { project, e } = await s.failure();
    let count = 0;
    const a = s.agent({
      gateway: {
        async complete(m) {
          count++;
          if (count === 1) return requestTools('get_sql', 'get_schema', 'get_logs');
          if (count === 2) {
            expect(results(m)).toHaveLength(3);
            for (const result of results(m)) {
              expect(result.error_code).toBe('REPAIR_FIRST_OBSERVATION_REQUIRED');
              expect(result).not.toHaveProperty('evidence_ids');
              expect(result).not.toHaveProperty('output');
            }
            expect(
              s.pipeline.repair(s.pipeline.snapshot(project.id).repairs[0]!.id).evidence,
            ).toHaveLength(1);
            return requestTools('get_sql');
          }
          if (count === 3) {
            expect(results(m).at(-1).output.sql).toContain('speed_kph');
            return requestTools('get_schema', 'get_task_contract');
          }
          expect(results(m).filter((x) => x.output)).toHaveLength(3);
          const calls = m
            .filter((x) => x.role === 'assistant')
            .flatMap((x) => x.tool_calls as { id: string }[]);
          for (const call of calls)
            expect(results(m).filter((x) => x.call_id === call.id)).toHaveLength(1);
          return answer(m);
        },
      },
    });
    const repair = await a.waitFor(
      a.create(project.id, e.id, randomUUID(), 'MOCK', 'controlled').id,
    );
    expect(repair.status).toBe('NO_CANDIDATE');
    expect(repair.tools.map((t) => t.status)).toEqual([
      'FAILED',
      'FAILED',
      'FAILED',
      'COMPLETED',
      'COMPLETED',
      'COMPLETED',
    ]);
    expect(repair.tools.filter((t) => t.status === 'COMPLETED').map((t) => t.request)).toEqual([
      2, 3, 3,
    ]);
    expect(repair.evidence).toHaveLength(4);
    const repeat = s.agent({
      gateway: {
        async complete() {
          return requestTools('get_sql', 'get_schema');
        },
      },
    });
    const stalled = await repeat.waitFor(
      repeat.create(project.id, e.id, randomUUID(), 'MOCK', 'controlled').id,
    );
    expect(stalled).toMatchObject({
      status: 'FAILED',
      error_code: 'REPAIR_NO_PROGRESS',
      model_requests: 3,
    });
    expect(stalled.evidence).toHaveLength(1);
    expect(s.pipeline.snapshot(project.id).target.row_count).toBe(0);
  } finally {
    await s.close();
  }
});

it('initial evidence alone supports conservative advice; one SQL tool plus initial failure supports a candidate', async () => {
  const s = setup();
  try {
    const { project, e } = await s.failure();
    const advice = s.agent({
      gateway: {
        async complete(m) {
          return answer(m);
        },
      },
    });
    const r = await advice.waitFor(
      advice.create(project.id, e.id, randomUUID(), 'MOCK', 'controlled').id,
    );
    expect(r).toMatchObject({ status: 'NO_CANDIDATE', candidate: null, model_requests: 1 });
    expect(r.tools).toEqual([]);
    expect(r.evidence[0]).toMatchObject({
      type: 'INITIAL_FAILURE',
      source_id: e.id,
      source_version: e.revision_hash + ':' + e.input_hash,
    });
    const patch = s.agent({
      gateway: {
        async complete(m) {
          if (!results(m).length) return requestTools('get_sql');
          const sql = results(m)[0];
          return answer(m, {
            action: 'SQL_PATCH',
            evidence_ids: [initial(m).failure.evidence_id, ...sql.evidence_ids],
            candidate: {
              file_path: 'task.sql',
              base_hash: sql.output.base_hash,
              new_content: sql.output.sql.replace('speed_kph', 'speed_mps'),
            },
          });
        },
      },
    });
    const candidate = await patch.waitFor(
      patch.create(project.id, e.id, randomUUID(), 'MOCK', 'controlled').id,
    );
    expect(candidate.status).toBe('PENDING_APPROVAL');
    expect(candidate.tools.map((t) => t.name)).toEqual(['get_sql']);
    expect(s.pipeline.snapshot(project.id).executions).toHaveLength(1);
    expect(s.pipeline.snapshot(project.id).target.row_count).toBe(0);
    expect(s.pipeline.project(project.id).current_revision_id).toBe(project.current_revision_id);
  } finally {
    await s.close();
  }
});

it('missing SQL, duplicate/foreign/version-invalid citations, wrong failure stage and NO_CHANGE receive precise bounded feedback', async () => {
  const s = setup();
  try {
    const { project, e } = await s.failure();
    const other = await s.failure('B');
    const foreignAgent = s.agent({
      gateway: {
        async complete(m) {
          return answer(m);
        },
      },
    });
    const foreign = await foreignAgent.waitFor(
      foreignAgent.create(other.project.id, other.e.id, randomUUID(), 'MOCK', 'controlled').id,
    );
    for (const [kind, code] of [
      ['sql', 'REPAIR_SQL_EVIDENCE_REQUIRED'],
      ['duplicate', 'REPAIR_EVIDENCE_INVALID'],
      ['foreign', 'REPAIR_EVIDENCE_INVALID'],
      ['random', 'REPAIR_EVIDENCE_INVALID'],
      ['version', 'REPAIR_EVIDENCE_INVALID'],
      ['stage', 'REPAIR_STAGE_INVALID'],
      ['healthy', 'REPAIR_ACTION_INVALID'],
    ]) {
      let count = 0;
      const a = s.agent({
        gateway: {
          async complete(m) {
            if (++count === 2) {
              const feedback = JSON.parse(String(m.at(-1)!.content));
              expect(feedback.error_code).toBe(code);
              expect(feedback).not.toHaveProperty('missing_tools');
            }
            const id = initial(m).failure.evidence_id;
            return answer(
              m,
              kind === 'sql'
                ? {
                    action: 'SQL_PATCH',
                    candidate: {
                      file_path: 'task.sql',
                      base_hash: e.revision_hash,
                      new_content: 'SELECT 1',
                    },
                  }
                : kind === 'duplicate'
                  ? { evidence_ids: [id, id] }
                  : kind === 'foreign'
                    ? { evidence_ids: [foreign.evidence[0]!.id] }
                    : kind === 'random'
                      ? { evidence_ids: [randomUUID()] }
                      : kind === 'stage'
                        ? { failed_step: 'validate' }
                        : kind === 'healthy'
                          ? { action: 'NO_CHANGE' }
                          : {},
            );
          },
        },
      });
      if (kind === 'version')
        vi.spyOn(a, 'registry').mockImplementation((r) => {
          r.evidence[0]!.source_version = 'wrong';
          return new ToolRegistry();
        });
      const r = await a.waitFor(a.create(project.id, e.id, randomUUID(), 'MOCK', 'controlled').id);
      expect(r).toMatchObject({ status: 'FAILED', error_code: code, candidate: null });
      expect(r.response_checks.map((c) => c.code)).toEqual([code, code]);
      expect(r.response_checks.every((c) => c.response_text)).toBe(true);
      expect(r.tools).toHaveLength(0);
    }
  } finally {
    await s.close();
  }
});

it('invalid arguments are returned by call ID and can be corrected, while unauthorized tools and changed scope stop', async () => {
  const s = setup();
  try {
    const { project, e } = await s.failure();
    let requests = 0;
    const a = s.agent({
      gateway: {
        async complete(m) {
          if (++requests === 1)
            return {
              text: '',
              finishReason: 'tool_calls',
              calls: [{ id: 'bad', name: 'get_sql', arguments: { project_id: randomUUID() } }],
            };
          if (requests === 2) {
            expect(results(m)[0]).toMatchObject({
              call_id: 'bad',
              error_code: 'INVALID_ARGUMENTS',
            });
            return requestTools('get_sql');
          }
          if (requests === 3) return requestTools('get_logs', 'get_schema');
          expect(results(m)).toHaveLength(4);
          return answer(m);
        },
      },
    });
    const r = await a.waitFor(a.create(project.id, e.id, randomUUID(), 'MOCK', 'controlled').id);
    expect(r.status).toBe('NO_CANDIDATE');
    expect(r.tools.map((t) => t.status)).toEqual(['FAILED', 'COMPLETED', 'COMPLETED', 'COMPLETED']);
    expect(r.evidence).toHaveLength(4);
    for (const kind of ['unknown', 'scope']) {
      const b = s.agent({
        gateway: {
          async complete() {
            if (kind === 'scope')
              s.pipeline.save(
                project.id,
                project.current_revision_id,
                s.pipeline.revision(project.current_revision_id).sql + ' ',
                randomUUID(),
              );
            return requestTools(kind === 'unknown' ? 'shell' : 'get_sql');
          },
        },
      });
      const failed = await b.waitFor(
        b.create(project.id, e.id, randomUUID(), 'MOCK', 'controlled').id,
      );
      expect(failed.error_code).toBe(kind === 'unknown' ? 'TOOL_NOT_ALLOWED' : 'REPAIR_STALE');
      expect(failed.tools[0]?.status).toBe('FAILED');
      expect(failed.evidence).toHaveLength(1);
    }
    expect(s.pipeline.snapshot(project.id).target.row_count).toBe(0);
  } finally {
    await s.close();
  }
});

it('repeated observations and alternating old observations stall despite fresh call and evidence UUIDs', async () => {
  const s = setup();
  try {
    const { project, e } = await s.failure();
    for (const alternating of [false, true]) {
      let requests = 0;
      const a = s.agent({
        gateway: {
          async complete() {
            return requestTools(alternating && ++requests % 2 === 0 ? 'get_logs' : 'get_sql');
          },
        },
      });
      const r = await a.waitFor(a.create(project.id, e.id, randomUUID(), 'MOCK', 'controlled').id);
      expect(r).toMatchObject({
        status: 'FAILED',
        error_code: 'REPAIR_NO_PROGRESS',
        candidate: null,
      });
      expect(r.model_requests).toBe(alternating ? 5 : 4);
      expect(new Set(r.evidence.map((x) => x.id)).size).toBe(r.evidence.length);
      expect(new Set(r.tools.map((x) => x.call_id)).size).toBe(r.tools.length);
    }
  } finally {
    await s.close();
  }
});

it('the reported B trajectory feeds repeats back and allows exactly one answer correction without consuming the stall budget', async () => {
  const s = setup();
  const traces: unknown[] = [];
  try {
    const { project, e } = await s.failure('B');
    for (const outcome of ['valid', 'malformed', 'foreign-citation']) {
      let requests = 0;
      const sent: Messages[] = [];
      const a = s.agent({
        gateway: {
          async complete(m, _signal, _onDelta, _onFirstDelta, options) {
            sent.push(structuredClone(m));
            requests++;
            if (requests === 1) return requestTools('get_sql', 'get_output_preview');
            if (requests === 2) {
              expect(
                results(m).every(
                  (result) => result.error_code === 'REPAIR_FIRST_OBSERVATION_REQUIRED',
                ),
              ).toBe(true);
              return requestTools('get_sql');
            }
            if (requests === 3) return requestTools('get_task_contract', 'get_schema');
            if (requests === 4 || requests === 5) return requestTools('get_output_preview');
            if (requests === 6 || requests === 7) {
              const feedback = JSON.parse(String(m.at(-1)!.content));
              const name = requests === 6 ? 'get_output_preview' : 'get_task_contract';
              const original = results(m).find(
                (result) =>
                  result.output &&
                  (name === 'get_output_preview' ? result.output.validation : result.output.rule),
              );
              expect(feedback).toMatchObject({
                feedback_type: 'REPEATED_OBSERVATION',
                consecutive_no_progress_rounds: requests - 5,
                repeated_reads: [{ name, reuse_evidence_ids: original.evidence_ids }],
              });
              if (requests === 6) return requestTools('get_task_contract');
            }
            const sql = results(m).find((result) => result.output?.sql);
            const output = results(m).find((result) => result.output?.validation);
            const response = answer(m, {
              diagnosis:
                '输出列 vehicle_type 与契约要求的 car_series 不符，候选仅移除错误别名，待人工批准后验证。',
              action: 'SQL_PATCH',
              evidence_ids:
                requests === 8 && outcome === 'foreign-citation'
                  ? [randomUUID(), ...sql.evidence_ids]
                  : [...sql.evidence_ids, ...output.evidence_ids],
              candidate: {
                file_path: 'task.sql',
                base_hash: sql.output.base_hash,
                new_content: sql.output.sql.replace('car_series AS vehicle_type', 'car_series'),
              },
            });
            if (requests === 7 || outcome === 'malformed')
              return {
                ...response,
                text: '已具备充分证据，提交最小列别名修复。\n\n' + response.text,
              };
            expect(requests).toBe(8);
            expect(options).toEqual({ toolChoice: 'none', jsonMode: true });
            expect(JSON.parse(String(m.at(-1)!.content)).error_code).toBe('REPAIR_RESPONSE_JSON');
            return response;
          },
        },
      });
      const repair = await a.waitFor(
        a.create(project.id, e.id, randomUUID(), 'MOCK', 'reported-B').id,
      );
      expect(repair.model_requests).toBe(8);
      expect(repair.tools).toHaveLength(8);
      expect(repair.tools.filter((tool) => tool.status === 'COMPLETED')).toHaveLength(6);
      expect(repair.response_checks[0]?.code).toBe('REPAIR_RESPONSE_JSON');
      if (outcome === 'valid') {
        expect(repair.status).toBe('PENDING_APPROVAL');
        expect(repair.response_checks).toHaveLength(1);
        expect(repair.candidate?.sql).not.toContain('vehicle_type');
      } else {
        expect(repair.status).toBe('FAILED');
        expect(repair.error_code).toBe(
          outcome === 'malformed' ? 'REPAIR_RESPONSE_JSON' : 'REPAIR_EVIDENCE_INVALID',
        );
        expect(repair.response_checks).toHaveLength(2);
        expect(repair.candidate).toBeNull();
      }
      expect(s.pipeline.project(project.id).current_revision_id).toBe(project.current_revision_id);
      expect(s.pipeline.snapshot(project.id).executions).toHaveLength(1);
      expect(s.pipeline.snapshot(project.id).target.row_count).toBe(0);
      traces.push({ outcome, repair, sent_messages: sent });
    }
    if (process.env.FLOWLENS_OBSERVATION_TRACE_DIR) {
      const evidence = resolve(process.env.FLOWLENS_OBSERVATION_TRACE_DIR);
      mkdirSync(evidence, { recursive: true });
      writeFileSync(join(evidence, 'reported-B-replay.json'), JSON.stringify(traces, null, 2));
    }
  } finally {
    await s.close();
  }
});

// Two sessions perform 109 real stdio reads with persisted evidence. Give only
// this integration case time for a slower CI runner; Agent budgets stay intact.
it('more than eight requests with new actual observations completes; request 101 never occurs at the default cap', async () => {
  const s = setup();
  try {
    const { project, e } = await s.failure();
    e.logs = Array.from({ length: 120 }, (_, i) => ({
      at: '2026-10-08T00:00:00Z',
      step: 'query',
      level: 'INFO',
      message: `独立观测${i + 1}`,
    }));
    s.pipeline.put('execution', e);
    for (const count of [10, 101]) {
      let calls = 0;
      const a = s.agent({
        gateway: {
          async complete(m) {
            if (++calls === count) return answer(m);
            const previous = results(m).at(-1)?.output;
            return {
              text: '',
              finishReason: 'tool_calls',
              calls: [
                {
                  id: randomUUID(),
                  name: 'get_logs',
                  arguments: {
                    limit: 1,
                    ...(previous ? { before_seq: previous.next_before_seq } : {}),
                  },
                },
              ],
            };
          },
        },
      });
      // Real MCP pagination supplies new immutable observations; the request
      // budget test no longer mutates a finished execution during diagnosis.
      const r = await a.waitFor(a.create(project.id, e.id, randomUUID(), 'MOCK', 'controlled').id);
      expect(calls).toBe(count === 10 ? 10 : 100);
      expect(r.diagnosis_limits?.max_requests).toBe(100);
      expect(r.status).toBe(count === 10 ? 'NO_CANDIDATE' : 'FAILED');
      expect(r.error_code).toBe(count === 10 ? null : 'MODEL_REQUEST_LIMIT');
      expect(r.tools).toHaveLength(count === 10 ? 9 : 100);
    }
  } finally {
    await s.close();
  }
}, 60000);

it('tool, context and request limits preserve evidence and never publish a candidate', async () => {
  const s = setup();
  try {
    const { project, e } = await s.failure();
    for (const [limits, code, requests] of [
      [{ max_tool_calls: 1 }, 'REPAIR_TOOL_LIMIT', 1],
      [{ max_context_bytes: 1 }, 'REPAIR_CONTEXT_LIMIT', 0],
      [{ max_context_bytes: 8000 }, 'REPAIR_CONTEXT_LIMIT', null],
      [{ max_requests: 1 }, 'MODEL_REQUEST_LIMIT', 1],
    ] as const) {
      let actualRequests = 0;
      const a = s.agent({
        limits: requests === null ? { ...limits, max_stall_rounds: 100 } : limits,
        gateway: {
          async complete(messages) {
            actualRequests++;
            if ('max_context_bytes' in limits)
              expect(Buffer.byteLength(JSON.stringify(messages))).toBeLessThanOrEqual(
                limits.max_context_bytes,
              );
            return code === 'REPAIR_CONTEXT_LIMIT'
              ? requestTools('get_sql')
              : requestTools('get_sql', 'get_schema', 'get_logs');
          },
        },
      });
      const r = await a.waitFor(a.create(project.id, e.id, randomUUID(), 'MOCK', 'controlled').id);
      expect(r).toMatchObject({
        status: 'FAILED',
        error_code: code,
        candidate: null,
        model_requests: actualRequests,
      });
      if (requests !== null) expect(actualRequests).toBe(requests);
      else {
        // The exact boundary shifts when public instructions change. Verify
        // byte enforcement and retained real evidence instead of prompt length.
        expect(actualRequests).toBeGreaterThan(0);
        expect(r.tools).toHaveLength(actualRequests);
        expect(r.tools.every((tool) => tool.status === 'COMPLETED')).toBe(true);
        expect(r.evidence).toHaveLength(actualRequests + 1);
      }
      expect(r.evidence[0]?.type).toBe('INITIAL_FAILURE');
    }
  } finally {
    await s.close();
  }
});

it('cancel and timeout race late model responses without publishing; restart and old budgets remain explicit', async () => {
  const s = setup();
  try {
    const { project, e } = await s.failure();
    for (const cancel of [true, false]) {
      let resolve!: (r: ReturnType<typeof answer>) => void;
      let messages!: Messages;
      const complete = vi.fn((m: Messages) => {
        messages = structuredClone(m);
        return new Promise<ReturnType<typeof answer>>((r) => (resolve = r));
      });
      const a = s.agent({ limits: { timeout_ms: cancel ? 5000 : 3000 }, gateway: { complete } });
      const created = a.create(project.id, e.id, randomUUID(), 'MOCK', 'controlled');
      await vi.waitFor(() => expect(complete).toHaveBeenCalledOnce(), {
        interval: 10,
        timeout: 2500,
      });
      if (cancel) a.cancel(project.id, created.id);
      const r = await a.waitFor(created.id);
      expect(r.status).toBe(cancel ? 'CANCELLED' : 'FAILED');
      expect(r.error_code).toBe(cancel ? 'REPAIR_CANCELLED' : 'REPAIR_TIMEOUT');
      resolve(answer(messages));
      await new Promise((r) => setTimeout(r, 5));
      expect(s.pipeline.repair(created.id)).toEqual(r);
      expect(r.model_turns).toHaveLength(0);
      expect(r.candidate).toBeNull();
    }
    const old = s.pipeline.list<PipelineRepair>('repair', project.id)[0]!;
    old.status = 'RUNNING';
    s.pipeline.put('repair', old);
    s.pipeline.recover();
    expect(s.pipeline.repair(old.id).status).toBe('INTERRUPTED');
    const legacy = pipelineRepairSchema.parse({
      ...old,
      diagnosis_limits: undefined,
      model_turns: undefined,
    });
    expect(legacy.diagnosis_limits).toBeNull();
    expect(legacy.model_turns).toEqual([]);
  } finally {
    await s.close();
  }
});

it('LIVE per-session allowance still reserves the shared paid budget before every actual request', async () => {
  const s = setup();
  vi.stubEnv('MODEL_API_KEY', 'controlled-no-network');
  vi.stubEnv('FLOWLENS_LIVE_APPROVED', '1');
  vi.stubEnv('FLOWLENS_LIVE_MAX_REQUESTS', '1');
  try {
    const { project, e } = await s.failure();
    let reserves = 0;
    const spy = vi.spyOn(sharedLiveBudget, 'reserve').mockImplementation((approved, limit) => {
      expect(approved).toBe('1');
      expect(limit).toBe('1');
      if (++reserves > 1) throw new LocalError('LIVE_REQUEST_BUDGET_EXCEEDED', 429);
      return reserves;
    });
    const complete = vi.fn(async () => requestTools('get_sql'));
    const a = s.agent({ gateway: { complete } });
    const r = await a.waitFor(a.create(project.id, e.id, randomUUID(), 'LIVE', 'controlled').id);
    expect(r.diagnosis_limits?.max_requests).toBe(100);
    expect(complete).toHaveBeenCalledOnce();
    expect(spy).toHaveBeenCalledTimes(2);
    expect(r.error_code).toBe('LIVE_REQUEST_BUDGET_EXCEEDED');
    expect(r.candidate).toBeNull();
  } finally {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await s.close();
  }
});

it('configuration validates every positive integer and freezes each session; canonicalization retains business times', () => {
  expect(diagnosisLimits()).toEqual({
    max_requests: 100,
    max_tool_calls: 200,
    timeout_ms: 900000,
    max_stall_rounds: 3,
    max_context_bytes: 262144,
  });
  for (const value of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    expect(() => diagnosisLimits({ max_requests: value })).toThrow('INVALID_DIAG_CONFIG');
  }
  expect(canonical({ b: 2, a: 1 })).toBe(canonical({ a: 1, b: 2 }));
  expect(canonical({ at: 'yesterday' })).not.toBe(canonical({ at: 'today' }));
});

it('session limits are copied once and elapsed time cannot be bypassed by an immediate response', async () => {
  const s = setup();
  try {
    const { project, e } = await s.failure();
    const limits = { max_requests: 7 };
    const a = s.agent({
      limits,
      gateway: {
        async complete(m) {
          return answer(m);
        },
      },
    });
    const created = a.create(project.id, e.id, randomUUID(), 'MOCK', 'controlled');
    limits.max_requests = 2;
    expect((await a.waitFor(created.id)).diagnosis_limits?.max_requests).toBe(7);
    const b = s.agent({
      limits: { timeout_ms: 10 },
      gateway: {
        async complete(m) {
          const end = performance.now() + 30;
          while (performance.now() < end) {
            /* simulate synchronous provider work */
          }
          return answer(m);
        },
      },
    });
    const failed = await b.waitFor(
      b.create(project.id, e.id, randomUUID(), 'MOCK', 'controlled').id,
    );
    expect(failed).toMatchObject({
      status: 'FAILED',
      error_code: 'REPAIR_TIMEOUT',
      candidate: null,
    });
    expect(failed.diagnosis).toBeNull();
  } finally {
    await s.close();
  }
});

it('failed calls count toward the tool ceiling, and repeated reads can still finish before the stall threshold', async () => {
  const s = setup();
  try {
    const { project, e } = await s.failure();
    const a = s.agent({
      limits: { max_tool_calls: 2 },
      gateway: {
        async complete() {
          return {
            text: '',
            finishReason: 'tool_calls',
            calls: [{ id: randomUUID(), name: 'get_sql', arguments: { extra: true } }],
          };
        },
      },
    });
    const r = await a.waitFor(a.create(project.id, e.id, randomUUID(), 'MOCK', 'controlled').id);
    expect(r.error_code).toBe('REPAIR_TOOL_LIMIT');
    expect(r.tools.map((t) => t.status)).toEqual(['FAILED', 'FAILED']);
    expect(r.evidence).toHaveLength(1);
    let calls = 0;
    const b = s.agent({
      gateway: {
        async complete(m) {
          return ++calls < 3 ? requestTools('get_sql') : answer(m);
        },
      },
    });
    const done = await b.waitFor(b.create(project.id, e.id, randomUUID(), 'MOCK', 'controlled').id);
    expect(done.status).toBe('NO_CANDIDATE');
    expect(done.tools).toHaveLength(2);
  } finally {
    await s.close();
  }
});

it('public investigation notes retain actual evidence dependencies and live phases; unsupported notes remain raw only', async () => {
  const s = setup();
  try {
    const { project, e } = await s.failure();
    for (const kind of ['supported', 'forged', 'malformed']) {
      const a = s.agent({
        gateway: {
          async complete(m) {
            const active = s.pipeline.list<PipelineRepair>('repair', project.id)[0]!;
            expect(active.diagnosis_phase).toBe('MODEL_DECIDING');
            if (!results(m).length) {
              expect(String(m[0]!.content)).toContain(
                '即使使用普通文本而非 JSON 调查说明，也必须用简体中文',
              );
              expect(initial(m).request).toContain('每轮调查说明和最终诊断均用简体中文');
              const call = requestTools('get_sql');
              return {
                ...call,
                text:
                  kind === 'malformed'
                    ? 'not json'
                    : JSON.stringify({
                        investigation: {
                          question: '源码中是什么字段？',
                          reason: '初始错误没有完整 SQL。',
                          evidence_ids: [
                            kind === 'forged' ? randomUUID() : initial(m).failure.evidence_id,
                          ],
                        },
                      }),
              };
            }
            const assistant = m.filter((x) => x.role === 'assistant').at(-1)!;
            expect(assistant.content).toBe(active.model_turns[0]?.text);
            expect(results(m)[0].call_id).toBe(active.tools[0]?.call_id);
            return answer(m);
          },
        },
      });
      const r = await a.waitFor(a.create(project.id, e.id, randomUUID(), 'MOCK', 'controlled').id);
      expect(r.status).toBe('NO_CANDIDATE');
      expect(r.diagnosis_phase).toBeNull();
      expect(r.model_turns[0]?.text).toBeTruthy();
      if (kind === 'supported')
        expect(r.model_turns[0]?.investigation?.evidence_ids).toEqual([r.evidence[0]!.id]);
      else expect(r.model_turns[0]?.investigation).toBeNull();
    }
  } finally {
    await s.close();
  }
});
