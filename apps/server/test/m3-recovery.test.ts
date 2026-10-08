import { expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, migrate, seed } from '../src/db.js';
import {
  createSession,
  submitMessage,
  snapshot,
  proposeRetry,
  resolveApproval,
  saveEvidence,
} from '../src/diagnosis-store.js';
import { recoverInterruptedTurns, runDiagnosis, cancelTurn } from '../src/diagnosis-agent.js';
import { advanceDue, getRun } from '../src/store.js';
import { ToolRegistry } from '../src/tool-registry.js';
import { z } from 'zod';
import { ProbeError } from '../src/model-error.js';

it('cancellation wins over a late model response and leaves one terminal event', async () => {
  const db = openDatabase(':memory:');
  migrate(db);
  seed(db);
  const s = createSession(db, 'seed_s04', 'm3-cancel-session');
  const t = submitMessage(db, s.id, '诊断', 'm3-cancel-turn', 'MOCK', 'mock');
  let release!: () => void;
  let started!: () => void;
  const entered = new Promise<void>((r) => (started = r)),
    gate = new Promise<void>((r) => (release = r));
  const work = runDiagnosis(db, {
    turnId: t.turn_id,
    sessionId: s.id,
    runId: 'seed_s04',
    question: '诊断',
    mode: 'MOCK',
    model: 'mock',
    gateway: {
      async complete() {
        started();
        await gate;
        return {
          text: JSON.stringify({
            summary: '迟到',
            findings: [],
            missing_information: [],
            next_steps: [],
            proposed_action: null,
          }),
          calls: [],
          finishReason: 'stop',
        };
      },
    },
    logSink: () => {},
  });
  await entered;
  cancelTurn(db, t.turn_id);
  release();
  await work;
  const state = snapshot(db, s.id);
  expect(state.turns[0]).toMatchObject({ status: 'CANCELLED' });
  expect(state.results).toHaveLength(0);
  expect(
    db
      .prepare("SELECT count(*) n FROM agent_event WHERE turn_id=? AND type='turn.finished'")
      .get(t.turn_id),
  ).toMatchObject({ n: 1 });
  expect(
    db.prepare('SELECT count(*) n FROM evidence WHERE turn_id=?').get(t.turn_id),
  ).toMatchObject({ n: 1 });
  db.close();
});
it('late tool completion cannot publish success or evidence after cancellation', async () => {
  const db = openDatabase(':memory:');
  migrate(db);
  seed(db);
  const s = createSession(db, 'seed_s04', 'm3-tool-session'),
    t = submitMessage(db, s.id, '诊断', 'm3-tool-turn', 'MOCK', 'mock');
  let release!: () => void, started!: () => void;
  const entered = new Promise<void>((r) => (started = r)),
    gate = new Promise<void>((r) => (release = r));
  const registry = new ToolRegistry()
    .register({
      description: {
        name: 'get_task_run',
        description: 'Bound run',
        parameters: { type: 'object' },
      },
      schema: z.strictObject({ run_id: z.string() }),
      execute: async () => ({ output: { id: 'seed_s04' }, evidence_ids: [] }),
    })
    .register({
      description: {
        name: 'slow_read',
        description: 'Delayed read',
        parameters: { type: 'object' },
      },
      schema: z.strictObject({}),
      execute: async () => {
        started();
        await gate;
        const id = saveEvidence(db, {
          sessionId: s.id,
          turnId: t.turn_id,
          type: 'run_log',
          sourceId: 'late',
          sourceVersion: '1',
          locator: {},
          excerpt: 'late evidence',
        });
        return { output: { done: true }, evidence_ids: [id] };
      },
    });
  let calls = 0;
  const work = runDiagnosis(db, {
    turnId: t.turn_id,
    sessionId: s.id,
    runId: 'seed_s04',
    question: '诊断',
    mode: 'MOCK',
    model: 'mock',
    tools: registry,
    gateway: {
      async complete() {
        return calls++ === 0
          ? {
              text: '',
              calls: [{ id: 'slow', name: 'slow_read', arguments: {} }],
              finishReason: 'tool_calls',
            }
          : { text: '{}', calls: [], finishReason: 'stop' };
      },
    },
    logSink: () => {},
  });
  await entered;
  cancelTurn(db, t.turn_id);
  release();
  await work;
  expect(
    db.prepare('SELECT status,error_code FROM tool_call WHERE turn_id=?').get(t.turn_id),
  ).toMatchObject({ status: 'CANCELLED', error_code: 'CANCELLED' });
  expect(
    db
      .prepare("SELECT count(*) n FROM agent_event WHERE turn_id=? AND type='tool.completed'")
      .get(t.turn_id),
  ).toMatchObject({ n: 0 });
  expect(
    db.prepare('SELECT count(*) n FROM evidence WHERE turn_id=?').get(t.turn_id),
  ).toMatchObject({ n: 0 });
  expect(
    db
      .prepare("SELECT count(*) n FROM agent_event WHERE turn_id=? AND type='turn.finished'")
      .get(t.turn_id),
  ).toMatchObject({ n: 1 });
  db.close();
});
it('retrying a failed streamed model attempt removes its partial preview', async () => {
  const oldGate = process.env.FLOWLENS_LIVE_APPROVED,
    oldMax = process.env.FLOWLENS_LIVE_MAX_REQUESTS;
  process.env.FLOWLENS_LIVE_APPROVED = '1';
  process.env.FLOWLENS_LIVE_MAX_REQUESTS = '12';
  const db = openDatabase(':memory:');
  migrate(db);
  seed(db);
  const s = createSession(db, 'seed_s05', 'm3-stream-session'),
    t = submitMessage(db, s.id, '诊断', 'm3-stream-turn', 'LIVE', 'fake');
  let calls = 0;
  await runDiagnosis(db, {
    turnId: t.turn_id,
    sessionId: s.id,
    runId: 'seed_s05',
    question: '诊断',
    mode: 'LIVE',
    model: 'fake',
    gateway: {
      async complete(_messages, _signal, onDelta) {
        calls++;
        if (calls === 1) {
          onDelta?.('{"summary":"旧的错误判断' + '旧'.repeat(520));
          throw new ProbeError('MODEL_NETWORK_ERROR');
        }
        onDelta?.('{"summary":"新的判断"}');
        return {
          text: JSON.stringify({
            summary: '新的判断',
            findings: [],
            missing_information: [],
            next_steps: [],
            proposed_action: null,
          }),
          calls: [],
          finishReason: 'stop',
        };
      },
    },
    logSink: () => {},
  });
  expect(calls).toBe(2);
  const state = snapshot(db, s.id);
  expect(
    state.messages
      .filter((m) => m.role === 'assistant')
      .map((m) => m.content)
      .join(''),
  ).not.toContain('旧的错误判断');
  expect(
    state.messages
      .filter((m) => m.role === 'assistant')
      .map((m) => m.content)
      .join(''),
  ).toContain('新的判断');
  db.close();
  if (oldGate === undefined) delete process.env.FLOWLENS_LIVE_APPROVED;
  else process.env.FLOWLENS_LIVE_APPROVED = oldGate;
  if (oldMax === undefined) delete process.env.FLOWLENS_LIVE_MAX_REQUESTS;
  else process.env.FLOWLENS_LIVE_MAX_REQUESTS = oldMax;
});
it('a timed-out read-only tool is marked failed and its error is visible to the model', async () => {
  const db = openDatabase(':memory:');
  migrate(db);
  seed(db);
  const s = createSession(db, 'seed_s05', 'm3-timeout-session'),
    t = submitMessage(db, s.id, '诊断', 'm3-timeout-turn', 'MOCK', 'mock');
  const registry = new ToolRegistry()
    .register({
      description: {
        name: 'get_task_run',
        description: 'Bound run',
        parameters: { type: 'object' },
      },
      schema: z.strictObject({ run_id: z.string() }),
      execute: async () => ({ output: { id: 'seed_s05' }, evidence_ids: [] }),
    })
    .register({
      description: { name: 'slow_read', description: 'Slow read', parameters: { type: 'object' } },
      schema: z.strictObject({}),
      execute: async () => new Promise(() => {}),
    });
  let calls = 0,
    observed = '';
  const lines: string[] = [];
  await runDiagnosis(db, {
    turnId: t.turn_id,
    sessionId: s.id,
    runId: 'seed_s05',
    question: '诊断',
    mode: 'MOCK',
    model: 'mock',
    tools: registry,
    gateway: {
      async complete(messages) {
        if (calls++ === 0)
          return {
            text: '',
            calls: [{ id: 'slow', name: 'slow_read', arguments: {} }],
            finishReason: 'tool_calls',
          };
        observed = JSON.stringify(messages.at(-1));
        return {
          text: JSON.stringify({
            summary: '工具超时，证据不足',
            findings: [
              {
                cause: 'UNKNOWN',
                explanation: '工具未返回',
                evidence_ids: [],
                evidence_status: 'NEEDS_CONFIRMATION',
              },
            ],
            missing_information: ['日志'],
            next_steps: [],
            proposed_action: null,
          }),
          calls: [],
          finishReason: 'stop',
        };
      },
    },
    logSink: (line) => lines.push(line),
  });
  expect(observed).toContain('TOOL_TIMEOUT');
  expect(snapshot(db, s.id).tool_calls[0]).toMatchObject({
    status: 'FAILED',
    error_code: 'TOOL_TIMEOUT',
  });
  expect(
    lines.map((line) => JSON.parse(line)).find((item) => item.event === 'tool.failed'),
  ).toMatchObject({ turn_id: t.turn_id, error_code: 'TOOL_TIMEOUT' });
  expect(snapshot(db, s.id).turns[0]).toMatchObject({ status: 'COMPLETED' });
  db.close();
}, 10000);

it('restart interrupts unfinished turns, keeps history, and allows a new turn', () => {
  const folder = mkdtempSync(join(tmpdir(), 'flowlens-m3-'));
  try {
    const path = join(folder, 'db.sqlite');
    let db = openDatabase(path);
    migrate(db);
    seed(db);
    const s = createSession(db, 'seed_s04', 'm3-restart-session');
    const t = submitMessage(db, s.id, '旧问题', 'm3-restart-turn', 'MOCK', 'mock');
    db.prepare("UPDATE diagnosis_turn SET status='RUNNING' WHERE id=?").run(t.turn_id);
    db.prepare('INSERT INTO tool_call VALUES (?,?,?,?,?,?,?,?,?)').run(
      'm3-tool',
      t.turn_id,
      'get_task_logs',
      '{}',
      'RUNNING',
      null,
      null,
      new Date().toISOString(),
      null,
    );
    db.close();
    db = openDatabase(path);
    migrate(db);
    seed(db);
    expect(recoverInterruptedTurns(db)).toBe(1);
    const state = snapshot(db, s.id);
    expect(state.turns[0]).toMatchObject({ status: 'INTERRUPTED', error_code: 'SERVER_RESTARTED' });
    expect(state.tool_calls[0]).toMatchObject({
      status: 'CANCELLED',
      error_code: 'SERVER_RESTARTED',
    });
    expect(
      db
        .prepare("SELECT count(*) n FROM agent_event WHERE turn_id=? AND type='turn.finished'")
        .get(t.turn_id),
    ).toMatchObject({ n: 1 });
    expect(recoverInterruptedTurns(db)).toBe(0);
    expect(submitMessage(db, s.id, '新问题', 'm3-new-turn', 'MOCK', 'mock').turn_id).toBeTruthy();
    db.close();
  } finally {
    try {
      rmSync(folder, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    } catch {
      /* Windows SQLite file locks may outlive a failed assertion. */
    }
  }
});

it('approved retry resumes from stored simulation progress after reopening', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'flowlens-m3-run-'));
  try {
    const path = join(folder, 'db.sqlite');
    let db = openDatabase(path);
    migrate(db);
    seed(db);
    const s = createSession(db, 'seed_s04', 'm3-run-session'),
      t = submitMessage(db, s.id, '为什么失败', 'm3-run-turn', 'MOCK', 'mock');
    await runDiagnosis(db, {
      turnId: t.turn_id,
      sessionId: s.id,
      runId: 'seed_s04',
      question: '为什么失败',
      mode: 'MOCK',
      model: 'mock',
      logSink: () => {},
    });
    const p = proposeRetry(db, 'seed_s04', t.turn_id, '模拟重试', 'm3-run-proposal'),
      approval = resolveApproval(db, p.id, 'approve', 'm3-run-approval');
    const id = String(approval.child_run_id);
    const start = Date.now();
    advanceDue(db, start);
    advanceDue(db, start + 2500);
    const before = db.prepare('SELECT count(*) n FROM task_log WHERE run_id=?').get(id) as {
      n: number;
    };
    db.close();
    db = openDatabase(path);
    migrate(db);
    seed(db);
    advanceDue(db, start + 8000);
    advanceDue(db, start + 9000);
    expect(getRun(db, id)).toMatchObject({ status: 'SUCCEEDED', parent_run_id: 'seed_s04' });
    const after = db.prepare('SELECT count(*) n FROM task_log WHERE run_id=?').get(id) as {
      n: number;
    };
    expect(after.n).toBeGreaterThan(before.n);
    expect(db.prepare('SELECT count(*) n FROM task_log WHERE run_id=?').get(id)).toMatchObject({
      n: after.n,
    });
    expect(
      db.prepare('SELECT count(*) n FROM task_run WHERE parent_run_id=?').get('seed_s04'),
    ).toMatchObject({ n: 1 });
    db.close();
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});
