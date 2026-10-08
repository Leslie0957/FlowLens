import { expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate, openDatabase } from '../src/db.js';
import { PipelineService } from '../src/pipeline.js';
import { PipelineAgent } from '../src/pipeline-agent.js';
import { PipelineMcpClient } from '../src/pipeline-mcp-client.js';
import { canonical } from '../src/pipeline-diag-config.js';
import { sha } from '../src/pipeline-data.js';
import { pipelineTools, type PipelineToolScope } from '../src/pipeline-tools.js';
import { TOOL_OUTPUT_BYTES } from '../src/pipeline-logs.js';
import { readPipelineTool } from '../src/pipeline-tool-reader.js';

const fixture = fileURLToPath(new URL('./fixtures/pipeline-mcp-fixture.ts', import.meta.url));
function alive(pid: number | null) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
async function setup() {
  const root = mkdtempSync(join(tmpdir(), 'flowlens-mcp-')),
    dbPath = join(root, 'app.sqlite'),
    db = openDatabase(dbPath);
  migrate(db);
  const pipeline = new PipelineService(db, join(root, 'projects')),
    agent = new PipelineAgent(pipeline);
  const project = pipeline.create('A', randomUUID()),
    e = await pipeline.waitFor(pipeline.start(project.id, randomUUID()).id);
  e.logs = Array.from({ length: 55 }, (_, i) => ({
    at: '2026-10-08T00:00:00Z',
    step: i % 2 ? 'validate' : 'query',
    level: i === 2 ? 'ERROR' : 'INFO',
    message: `真实持久化日志${i + 1}`,
  }));
  pipeline.put('execution', e);
  // Persist a bound running repair without starting another service. This
  // isolates SDK transport tests from the independently tested model loop.
  const queued = agent.create(project.id, e.id, randomUUID(), 'MOCK', 'test');
  agent.cancel(project.id, queued.id);
  await agent.waitFor(queued.id);
  const repair = pipeline.repair(queued.id);
  repair.status = 'RUNNING';
  pipeline.put('repair', repair);
  const scope: PipelineToolScope = {
    app_db_path: dbPath,
    project_dir: pipeline.path(project.id, ''),
    repair_id: repair.id,
    project_id: project.id,
    execution_id: e.id,
    revision_id: e.revision_id,
    revision_hash: e.revision_hash,
    input_hash: e.input_hash,
    logs_hash: sha(canonical(e.logs)),
    execution_hash: sha(canonical(e)),
  };
  const clients: PipelineMcpClient[] = [];
  const client = (
    options: ConstructorParameters<typeof PipelineMcpClient>[1] = {},
    binding = scope,
  ) => {
    const value = new PipelineMcpClient(binding, options);
    clients.push(value);
    return value;
  };
  return {
    root,
    db,
    pipeline,
    repair,
    project,
    e,
    scope,
    client,
    async close() {
      await Promise.all(clients.map((c) => c.close()));
      await agent.stopAll();
      await pipeline.stopAll();
      db.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

it('real stdio SDK discovers all six strict tools, reads actual databases and pages immutable logs without writes', async () => {
  const s = await setup();
  try {
    const beforeEvents = s.db.prepare('SELECT count(*) n FROM pipeline_event').get()?.n;
    const targetPath = s.pipeline.path(s.project.id, 'target.sqlite');
    const dbBefore = readFileSync(targetPath);
    const c = await s.client().connect();
    const pid = c.pid;
    expect(alive(pid)).toBe(true);
    expect(
      c
        .describe()
        .map((t) => t.name)
        .sort(),
    ).toEqual(pipelineTools.map((t) => t.name).sort());
    for (const tool of c.describe()) expect(tool.parameters.additionalProperties).toBe(false);
    const results = [];
    for (const tool of c.describe()) {
      const result = await c.call(tool.name, {});
      expect(result.source).toMatchObject({
        project_id: s.project.id,
        execution_id: s.e.id,
        revision_hash: s.e.revision_hash,
      });
      results.push({ name: tool.name, ...result });
    }
    expect(results.find((r) => r.name === 'get_sql')!.output).toHaveProperty(
      'sql',
      s.pipeline.revision(s.e.revision_id).sql,
    );
    expect(results.find((r) => r.name === 'get_schema')!.output).toHaveProperty(
      'source',
      s.pipeline.schema(s.project.id).source,
    );
    const first = await c.call('get_logs', { limit: 12, step: 'query' });
    const page = first.output as { logs: { seq: number }[]; next_before_seq: number };
    expect(page.logs.map((l) => l.seq)).toEqual(Array.from({ length: 12 }, (_, i) => 33 + i * 2));
    const next = await c.call('get_logs', {
      limit: 12,
      step: 'query',
      before_seq: page.next_before_seq,
    });
    expect((next.output as { logs: { seq: number }[] }).logs.at(-1)!.seq).toBe(31);
    expect(await c.call('get_logs', { limit: 12, step: 'query' })).toEqual(first);
    expect((await c.call('get_logs', { before_seq: 1 })).output).toMatchObject({
      logs: [],
      has_more: false,
    });
    expect(s.db.prepare('SELECT count(*) n FROM pipeline_event').get()?.n).toBe(beforeEvents);
    expect(readFileSync(targetPath)).toEqual(dbBefore);
    if (process.env.FLOWLENS_MAINTENANCE_TRACE_DIR) {
      mkdirSync(process.env.FLOWLENS_MAINTENANCE_TRACE_DIR, { recursive: true });
      writeFileSync(
        join(process.env.FLOWLENS_MAINTENANCE_TRACE_DIR, 'mcp-tools.json'),
        JSON.stringify(
          { transport: 'stdio', sdk: '2.3.1', tools: c.describe(), results, first, next },
          null,
          2,
        ),
      );
    }
    await c.close();
    expect(alive(pid)).toBe(false);
  } finally {
    await s.close();
  }
});

it('rejects unknown tools/arguments/cursors and stale/cross-project/execution/revision/input bindings', async () => {
  const s = await setup();
  try {
    const c = await s.client().connect();
    await expect(c.call('shell', {})).rejects.toMatchObject({ code: 'TOOL_NOT_ALLOWED' });
    await expect(c.call('get_logs', { project_id: randomUUID() })).rejects.toMatchObject({
      code: 'INVALID_ARGUMENTS',
    });
    await expect(c.call('get_logs', { before_seq: 57 })).rejects.toMatchObject({
      code: 'LOG_CURSOR_INVALID',
    });
    // Also exercise the SDK/server boundary, bypassing FlowLens's client prevalidation.
    const invalid = await c.client.callTool({
      name: 'get_logs',
      arguments: { limit: 1.5, extra: true },
    });
    expect(invalid.isError).toBe(true);
    await expect(c.client.callTool({ name: 'shell', arguments: {} })).rejects.toThrow();
    for (const patch of [
      { execution_id: randomUUID() },
      { revision_id: randomUUID() },
      { input_hash: sha('changed') },
      { revision_hash: sha('changed') },
    ]) {
      const foreign = await s.client({}, { ...s.scope, ...patch }).connect();
      await expect(foreign.call('get_sql', {})).rejects.toMatchObject({
        code: expect.stringMatching(/TOOL_SCOPE|REPAIR_STALE/),
      });
      await foreign.close();
    }
    const other = s.pipeline.create('A', randomUUID());
    const foreign = await s
      .client({}, { ...s.scope, project_id: other.id, project_dir: s.pipeline.path(other.id, '') })
      .connect();
    await expect(foreign.call('get_sql', {})).rejects.toMatchObject({ code: 'REPAIR_STALE' });
    s.pipeline.save(
      s.project.id,
      s.project.current_revision_id,
      s.pipeline.revision(s.e.revision_id).sql + ' ',
      randomUUID(),
    );
    await expect(c.call('get_logs', {})).rejects.toMatchObject({ code: 'REPAIR_STALE' });
  } finally {
    await s.close();
  }
});

it('server opens read-only connections and refuses a changed execution/log range or stopped diagnosis', async () => {
  const s = await setup();
  try {
    const c = await s.client().connect();
    s.e.logs[0]!.message = 'changed';
    s.pipeline.put('execution', s.e);
    await expect(c.call('get_logs', {})).rejects.toMatchObject({ code: 'REPAIR_STALE' });
    s.repair.status = 'CANCELLED';
    s.pipeline.put('repair', s.repair);
    await expect(c.call('get_sql', {})).rejects.toMatchObject({ code: 'REPAIR_NOT_RUNNING' });
    const readOnly = new DatabaseSync(s.scope.app_db_path, { readOnly: true });
    expect(() => readOnly.exec('DELETE FROM pipeline_entity')).toThrow();
    readOnly.close();
    expect(() => readPipelineTool({ ...s.scope, project_dir: s.root }, 'get_sql', {})).toThrow(
      'TOOL_SCOPE',
    );
  } finally {
    await s.close();
  }
});

it('SDK discovers every tool across real paginated tools/list responses', async () => {
  const s = await setup();
  try {
    const c = await s.client({ entryPath: fixture, entryArgs: ['paginated'] }).connect();
    expect(c.describe().map((t) => t.name)).toEqual(pipelineTools.map((t) => t.name));
    expect((await c.call('get_task_contract', {})).output).toHaveProperty('business_key');
  } finally {
    await s.close();
  }
});

it('discovery rejects missing/extra/changed definitions and closes its actual child on failure', async () => {
  const s = await setup();
  try {
    for (const mode of ['missing', 'extra', 'schema']) {
      const c = s.client({ entryPath: fixture, entryArgs: [mode] });
      await expect(c.connect()).rejects.toMatchObject({
        code: mode === 'missing' ? 'MCP_TOOLS_MISSING' : 'MCP_TOOL_DEFINITION_INVALID',
      });
      expect(c.pid).toBeNull();
    }
    const missing = s.client({ entryPath: join(s.root, 'missing.js') });
    await expect(missing.connect()).rejects.toMatchObject({
      code: expect.stringMatching(/MCP_CONNECT_FAILED|MCP_PROCESS_EXITED/),
    });
    expect(missing.pid).toBeNull();
  } finally {
    await s.close();
  }
});

it('validates structured results, sources, business isError and the full response byte cap', async () => {
  const s = await setup();
  vi.stubEnv('MODEL_API_KEY', 'never-pass-this-to-the-tool-service');
  vi.stubEnv('MODEL_BASE_URL', 'never-pass-this-either');
  try {
    for (const [mode, code] of [
      ['source', 'MCP_SOURCE_INVALID'],
      ['shape', 'MCP_RESULT_INVALID'],
      ['business', 'TEST_TOOL_FAILURE'],
      ['oversize', 'TOOL_OUTPUT_LIMIT'],
    ]) {
      const c = await s.client({ entryPath: fixture, entryArgs: [mode] }).connect();
      await expect(c.call('get_sql', {})).rejects.toMatchObject({ code });
      const pid = c.pid;
      await c.close();
      expect(alive(pid)).toBe(false);
    }
    s.e.logs = s.e.logs.map((l) => ({ ...l, message: '证据'.repeat(900) }));
    s.pipeline.put('execution', s.e);
    const binding = {
      ...s.scope,
      logs_hash: sha(canonical(s.e.logs)),
      execution_hash: sha(canonical(s.e)),
    };
    const c = await s.client({}, binding).connect();
    const raw = await c.client.callTool({ name: 'get_logs', arguments: { limit: 100 } });
    expect(Buffer.byteLength(JSON.stringify(raw))).toBeLessThanOrEqual(TOOL_OUTPUT_BYTES);
    expect(raw.structuredContent?.output).toMatchObject({
      has_more: true,
      truncated_by_bytes: true,
    });
  } finally {
    vi.unstubAllEnvs();
    await s.close();
  }
});

it('times out/cancels calls and handles malformed protocol or unexpected process exit without fallback', async () => {
  const s = await setup();
  try {
    for (const mode of ['timeout', 'cancel', 'protocol', 'exit']) {
      const c = await s
        .client({
          entryPath: fixture,
          entryArgs: [mode === 'timeout' || mode === 'cancel' ? 'stall' : mode],
          timeoutMs: 2000,
        })
        .connect();
      const pid = c.pid,
        controller = new AbortController();
      const promise = c.call('get_sql', {}, controller.signal);
      if (mode === 'cancel') setTimeout(() => controller.abort(), 30);
      await expect(promise).rejects.toMatchObject({
        code:
          mode === 'cancel'
            ? 'MCP_CANCELLED'
            : mode === 'timeout'
              ? 'MCP_TIMEOUT'
              : mode === 'exit'
                ? 'MCP_PROCESS_EXITED'
                : expect.stringMatching(/MCP_PROTOCOL_ERROR|MCP_TIMEOUT/),
      });
      await c.close();
      expect(alive(pid)).toBe(false);
    }
  } finally {
    await s.close();
  }
});

it('Agent marks real MCP calls, writes paged results back by call ID and keeps a durable cited range', async () => {
  const s = await setup();
  // The standalone transport fixture repair is complete; allow a new real Agent.
  s.repair.status = 'NO_CANDIDATE';
  s.pipeline.put('repair', s.repair);
  const agent = new PipelineAgent(s.pipeline, {
    gateway: {
      async complete(messages) {
        const initial = JSON.parse(String(messages.find((m) => m.role === 'user')!.content));
        const observed = messages
          .filter((m) => m.role === 'tool')
          .map((m) => ({ ...JSON.parse(String(m.content)), call_id: m.tool_call_id }));
        if (!observed.length)
          return {
            text: '',
            finishReason: 'tool_calls',
            calls: [{ id: 'recent', name: 'get_logs', arguments: { limit: 10 } }],
          };
        if (observed.length === 1) {
          expect(observed[0].call_id).toBe('recent');
          expect(observed[0].output.next_before_seq).toBe(46);
          return {
            text: '',
            finishReason: 'tool_calls',
            calls: [
              { id: 'older', name: 'get_logs', arguments: { before_seq: 46, level: 'ERROR' } },
            ],
          };
        }
        expect(observed[1].call_id).toBe('older');
        expect(observed[1].output.logs[0].seq).toBe(3);
        return {
          text: JSON.stringify({
            diagnosis: '较早页日志确认错误',
            failed_step: initial.failure.failed_step,
            action: 'MANUAL_REQUIRED',
            evidence_ids: observed[1].evidence_ids,
            candidate: null,
          }),
          finishReason: 'stop',
          calls: [],
        };
      },
    },
  });
  try {
    const result = await agent.waitFor(
      agent.create(s.project.id, s.e.id, randomUUID(), 'MOCK', 'mcp-feedback').id,
    );
    expect(result.status).toBe('NO_CANDIDATE');
    expect(
      result.tools.every(
        (t) =>
          t.transport === 'MCP' &&
          t.tool_server === 'flowlens-pipeline-readonly' &&
          t.status === 'COMPLETED',
      ),
    ).toBe(true);
    const stored = s.pipeline.repair(result.id);
    expect(stored.evidence.find((e) => e.id === stored.evidence_ids[0])?.read_range).toMatchObject({
      before_seq: 46,
      first_seq: 3,
      last_seq: 3,
    });
    if (process.env.FLOWLENS_MAINTENANCE_TRACE_DIR) {
      mkdirSync(process.env.FLOWLENS_MAINTENANCE_TRACE_DIR, { recursive: true });
      writeFileSync(
        join(process.env.FLOWLENS_MAINTENANCE_TRACE_DIR, 'mcp-model-loop.json'),
        JSON.stringify(stored, null, 2),
      );
    }
  } finally {
    await agent.stopAll();
    await s.close();
  }
});

it('Agent connection failure does not call the model; cancellation/timeout of real MCP calls publishes no successful trace or evidence', async () => {
  const s = await setup();
  const agents: PipelineAgent[] = [];
  const pids: (number | null)[] = [];
  const connect = PipelineMcpClient.prototype.connect;
  const spy = vi.spyOn(PipelineMcpClient.prototype, 'connect').mockImplementation(async function (
    this: PipelineMcpClient,
    signal,
  ) {
    const result = await connect.call(this, signal);
    pids.push(this.pid);
    return result;
  });
  s.repair.status = 'NO_CANDIDATE';
  s.pipeline.put('repair', s.repair);
  try {
    for (const mode of ['missing', 'cancel', 'timeout']) {
      const complete = vi.fn(async () => ({
        text: '',
        finishReason: 'tool_calls' as const,
        calls: [{ id: 'pending', name: 'get_sql', arguments: {} }],
      }));
      const agent = new PipelineAgent(s.pipeline, {
        gateway: { complete },
        mcp: {
          entryPath: mode === 'missing' ? join(s.root, 'missing.js') : fixture,
          entryArgs: [mode === 'cancel' ? 'late' : 'stall'],
          timeoutMs: 2000,
        },
        limits: { timeout_ms: 10000 },
      });
      agents.push(agent);
      const queued = agent.create(s.project.id, s.e.id, randomUUID(), 'MOCK', mode);
      if (mode === 'cancel') {
        await vi.waitFor(
          () => expect(s.pipeline.repair(queued.id).tools[0]?.status).toBe('RUNNING'),
          { timeout: 5000, interval: 5 },
        );
        agent.cancel(s.project.id, queued.id);
      }
      const result = await agent.waitFor(queued.id);
      expect(result.evidence).toHaveLength(1);
      expect(result.tools.every((t) => t.status === 'FAILED')).toBe(true);
      expect(result.error_code).toBe(
        mode === 'cancel'
          ? 'REPAIR_CANCELLED'
          : mode === 'timeout'
            ? 'MCP_TIMEOUT'
            : 'MCP_CONNECT_FAILED',
      );
      if (mode === 'missing') expect(complete).not.toHaveBeenCalled();
      expect(result.candidate).toBeNull();
    }
    expect(pids.every((pid) => !alive(pid))).toBe(true);
  } finally {
    spy.mockRestore();
    await Promise.all(agents.map((a) => a.stopAll()));
    await s.close();
  }
});
