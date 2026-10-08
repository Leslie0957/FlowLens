import { expect, it, vi } from 'vitest';
import request from 'supertest';
import { openDatabase, migrate, seed } from '../src/db.js';
import { createApp } from '../src/http.js';
import { advanceDue, getRun } from '../src/store.js';
import { createTools } from '../src/diagnosis-tools.js';
import {
  createSession,
  submitMessage,
  getEvidence,
  resolveApproval,
  proposeRetry,
  event,
  getApproval,
  retryEligibility,
} from '../src/diagnosis-store.js';
import { runDiagnosis } from '../src/diagnosis-agent.js';
import { ProbeError } from '../src/model-error.js';
import { buildContext } from '../src/diagnosis-context.js';

it('allows two retries in a recovery chain and refuses a third', async () => {
  const db = openDatabase(':memory:');
  migrate(db);
  seed(db);
  let runId = 'seed_s04';
  for (let depth = 0; depth < 2; depth++) {
    expect(retryEligibility(db, runId).allowed).toBe(true);
    const s = createSession(db, runId, 'chain-session-' + depth),
      t = submitMessage(db, s.id, '诊断', 'chain-turn-' + depth, 'MOCK', 'mock');
    await runDiagnosis(db, {
      turnId: t.turn_id,
      sessionId: s.id,
      runId,
      question: '诊断',
      mode: 'MOCK',
      model: 'mock',
      logSink: () => {},
    });
    const p = proposeRetry(db, runId, t.turn_id, '上游超时', 'chain-proposal-' + depth);
    const approval = resolveApproval(db, p.id, 'approve', 'chain-approve-' + depth);
    expect(retryEligibility(db, runId).allowed).toBe(false);
    runId = approval.child_run_id as string;
    // Controlled fixture: a retry also suffers a transient upstream timeout.
    db.prepare("UPDATE task_run SET status='FAILED',error_code='UPSTREAM_TIMEOUT' WHERE id=?").run(
      runId,
    );
    // A known failure diagnosis must now cite an actual stored error log.
    db.prepare('INSERT INTO task_log VALUES (?,?,?,?,?,?,?)').run(
      runId + '_timeout',
      runId,
      1,
      new Date().toISOString(),
      'ERROR',
      'read',
      'ReadTimeout: upstream request exceeded 5s',
    );
  }
  expect(retryEligibility(db, runId)).toMatchObject({
    allowed: false,
    reason_code: 'RECOVERY_LIMIT',
  });
  db.close();
});

it('context keeps six complete turns, earlier verified summaries and no other session', async () => {
  const db = openDatabase(':memory:');
  migrate(db);
  seed(db);
  const s = createSession(db, 'seed_s05', 'context-session');
  for (let i = 0; i < 8; i++) {
    const t = submitMessage(
      db,
      s.id,
      'question-' + i,
      'context-turn-' + i,
      'MOCK',
      'mock',
      Date.now() + i,
    );
    await runDiagnosis(db, {
      turnId: t.turn_id,
      sessionId: s.id,
      runId: 'seed_s05',
      question: 'question-' + i,
      mode: 'MOCK',
      model: 'mock',
      logSink: () => {},
    });
  }
  const other = createSession(db, 'seed_s04', 'other-context');
  submitMessage(db, other.id, 'OTHER_SESSION_SECRET', 'other-turn', 'MOCK', 'mock');
  const items = buildContext(db, s.id, 'next-turn'),
    serialized = JSON.stringify(items);
  expect(items.filter((x) => x.role === 'assistant')).toHaveLength(6);
  expect(serialized).toContain('older_verified_diagnoses');
  expect(serialized).not.toContain('question-0');
  expect(serialized).not.toContain('OTHER_SESSION_SECRET');
  expect(items.some((x) => x.role === 'tool')).toBe(false);
  db.close();
});

it('retries a transient model error once and preserves the same diagnostic turn', async () => {
  const db = openDatabase(':memory:');
  migrate(db);
  seed(db);
  const s = createSession(db, 'seed_s05', 'transient-session');
  const t = submitMessage(db, s.id, '诊断', 'transient-turn', 'MOCK', 'mock');
  let count = 0;
  await runDiagnosis(db, {
    turnId: t.turn_id,
    sessionId: s.id,
    runId: 'seed_s05',
    question: '诊断',
    mode: 'MOCK',
    model: 'mock',
    logSink: () => {},
    gateway: {
      async complete() {
        count++;
        if (count === 1) throw new ProbeError('MODEL_NETWORK_ERROR');
        return {
          text: JSON.stringify({
            summary: '信息不足',
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
  });
  expect(count).toBe(2);
  expect(db.prepare('SELECT status FROM diagnosis_turn WHERE id=?').get(t.turn_id)).toMatchObject({
    status: 'COMPLETED',
  });
  db.close();
});

it('rejects non-string messages and extra authority fields before creating a turn', async () => {
  const db = openDatabase(':memory:');
  migrate(db);
  seed(db);
  const app = createApp(db, () => {});
  const s = createSession(db, 'seed_s04', 'strict-session');
  for (const content of [{ content: 123 }, { content: '诊断', approved: true }]) {
    const response = await request(app)
      .post(`/api/v1/sessions/${s.id}/messages`)
      .set('Idempotency-Key', 'bad-message')
      .send(content);
    expect(response.status).toBe(400);
  }
  expect(db.prepare('SELECT count(*) n FROM diagnosis_turn').get()).toMatchObject({ n: 0 });
  db.close();
});

it('replays every persisted event when the terminal session exceeds one read batch', async () => {
  const db = openDatabase(':memory:');
  migrate(db);
  seed(db);
  const app = createApp(db, () => {});
  const s = createSession(db, 'seed_s04', 'replay-session');
  const t = submitMessage(db, s.id, '诊断', 'replay-turn', 'MOCK', 'mock');
  for (let i = 0; i < 510; i++) event(db, s.id, t.turn_id, 'turn.started', { status: 'RUNNING' });
  db.prepare("UPDATE diagnosis_turn SET status='FAILED' WHERE id=?").run(t.turn_id);
  const response = await request(app).get(`/api/v1/sessions/${s.id}/events?after_seq=0`);
  expect(response.text.match(/^id:/gm) ?? []).toHaveLength(510);
  db.close();
});

it('expires an approval on read without executing it', async () => {
  const db = openDatabase(':memory:');
  migrate(db);
  seed(db);
  const s = createSession(db, 'seed_s04', 'expiry-read');
  const t = submitMessage(db, s.id, '诊断', 'expiry-read-turn', 'MOCK', 'mock');
  await runDiagnosis(db, {
    turnId: t.turn_id,
    sessionId: s.id,
    runId: 'seed_s04',
    question: '诊断',
    mode: 'MOCK',
    model: 'mock',
    logSink: () => {},
  });
  const p = proposeRetry(
    db,
    'seed_s04',
    t.turn_id,
    '读取过期状态',
    'expiry-proposal',
    Date.now() - 700000,
  );
  expect(getApproval(db, p.id)?.status).toBe('EXPIRED');
  db.close();
});

it('repairs output with explicit field types and safe validation feedback', async () => {
  const db = openDatabase(':memory:');
  migrate(db);
  seed(db);
  const session = createSession(db, 'seed_s05', 'repair-session');
  const sent = submitMessage(db, session.id, '诊断', 'repair-turn', 'MOCK', 'mock');
  let calls = 0;
  const lines: string[] = [];
  await runDiagnosis(db, {
    turnId: sent.turn_id,
    sessionId: session.id,
    runId: 'seed_s05',
    question: '诊断',
    mode: 'MOCK',
    model: 'mock',
    logSink: (line) => lines.push(line),
    gateway: {
      async complete(messages) {
        calls++;
        if (calls === 2) expect(String(messages.at(-1)?.content)).toContain('missing_information');
        return {
          text: JSON.stringify({
            summary: '信息不足',
            findings: [],
            missing_information: calls === 1 ? 'private-input' : [],
            next_steps: [],
            proposed_action: null,
          }),
          calls: [],
          finishReason: 'stop',
        };
      },
    },
  });
  expect(
    db.prepare('SELECT status FROM diagnosis_turn WHERE id=?').get(sent.turn_id),
  ).toMatchObject({ status: 'COMPLETED' });
  expect(lines.join(' ')).toContain('result.invalid');
  expect(lines.join(' ')).not.toContain('private-input');
  db.close();
});

it('adds durable M2 records without changing seeded runs', () => {
  const db = openDatabase(':memory:');
  migrate(db);
  seed(db);
  expect(
    (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version,
  ).toBeGreaterThanOrEqual(3);
  expect(db.prepare('SELECT count(*) n FROM task_run').get()).toMatchObject({ n: 6 });
  for (const table of [
    'diagnosis_session',
    'diagnosis_turn',
    'message',
    'tool_call',
    'evidence',
    'diagnosis_result',
    'agent_event',
    'approval_request',
    'action_execution',
  ]) {
    expect(
      db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table),
    ).toMatchObject({ name: table });
  }
  db.close();
});

it('S00 reports no failure and S05 remains unknown in deterministic mock diagnoses', async () => {
  const db = openDatabase(':memory:');
  migrate(db);
  seed(db);
  for (const [runId, cause] of [
    ['seed_s00', 'NONE'],
    ['seed_s05', 'UNKNOWN'],
  ]) {
    const session = createSession(db, runId, 'case-' + runId);
    const sent = submitMessage(db, session.id, '请诊断这次运行', 'turn-' + runId, 'MOCK', 'mock');
    await runDiagnosis(db, {
      turnId: sent.turn_id,
      sessionId: session.id,
      runId,
      question: '请诊断这次运行',
      mode: 'MOCK',
      model: 'mock',
      logSink: () => {},
    });
    const row = db
      .prepare('SELECT findings_json FROM diagnosis_result WHERE turn_id=?')
      .get(sent.turn_id) as { findings_json: string };
    expect(JSON.parse(row.findings_json)[0].cause).toBe(cause);
  }
  db.close();
});

it('rejection and expiry never create a simulated child', async () => {
  const db = openDatabase(':memory:');
  migrate(db);
  seed(db);
  for (const [suffix, decision] of [
    ['reject', 'reject'],
    ['expire', 'expire'],
  ] as const) {
    const session = createSession(db, 'seed_s04', 'session-' + suffix);
    const sent = submitMessage(db, session.id, '为什么失败', 'turn-' + suffix, 'MOCK', 'mock');
    await runDiagnosis(db, {
      turnId: sent.turn_id,
      sessionId: session.id,
      runId: 'seed_s04',
      question: '为什么失败',
      mode: 'MOCK',
      model: 'mock',
      logSink: () => {},
    });
    const now = Date.now();
    const proposal = proposeRetry(
      db,
      'seed_s04',
      sent.turn_id,
      '演示审批',
      'proposal-' + suffix,
      now,
    );
    const result = resolveApproval(
      db,
      proposal.id,
      decision === 'reject' ? 'reject' : 'approve',
      'resolve-' + suffix,
      decision === 'expire' ? now + 600001 : now + 1000,
    );
    expect(result.status).toBe(decision === 'reject' ? 'REJECTED' : 'EXPIRED');
  }
  expect(
    db.prepare('SELECT count(*) n FROM task_run WHERE parent_run_id=?').get('seed_s04'),
  ).toMatchObject({ n: 0 });
  db.close();
});

it('read-only tools enforce the bound run and register versioned runbook evidence', async () => {
  const db = openDatabase(':memory:');
  migrate(db);
  seed(db);
  const tools = createTools(db);
  const scope = { runId: 'seed_s04', sessionId: 's1', turnId: 't1' };
  await expect(tools.call('get_task_logs', { run_id: 'seed_s00' }, scope)).rejects.toMatchObject({
    code: 'TOOL_SCOPE',
  });
  await expect(tools.call('shell', { command: 'echo unsafe' }, scope)).rejects.toMatchObject({
    code: 'TOOL_NOT_ALLOWED',
  });
  const session = createSession(db, 'seed_s04', 'scope-session');
  const sent = submitMessage(db, session.id, '为什么失败', 'scope-turn', 'MOCK', 'mock');
  const found = await tools.call(
    'search_runbook',
    { query: 'ReadTimeout' },
    { runId: 'seed_s04', sessionId: session.id, turnId: sent.turn_id },
  );
  expect(found.evidence_ids).toHaveLength(1);
  expect(getEvidence(db, session.id, found.evidence_ids[0]!)).toMatchObject({
    type: 'RUNBOOK',
    source_id: 'upstream-timeout',
    source_version: '1',
  });
  expect(getEvidence(db, 'different-session', found.evidence_ids[0]!)).toBeUndefined();
  db.close();
});

it('invalid model evidence fails without persisting a diagnosis result', async () => {
  const db = openDatabase(':memory:');
  migrate(db);
  seed(db);
  const session = createSession(db, 'seed_s04', 'invalid-session');
  const sent = submitMessage(db, session.id, '为什么失败', 'invalid-turn', 'MOCK', 'mock');
  const bad = {
    summary: '错误引用',
    findings: [
      {
        cause: 'UPSTREAM_TIMEOUT',
        explanation: '猜测',
        evidence_ids: ['made-up-id'],
        evidence_status: 'SUPPORTED',
      },
    ],
    missing_information: [],
    next_steps: [],
    proposed_action: null,
  };
  const lines: string[] = [];
  await runDiagnosis(db, {
    turnId: sent.turn_id,
    sessionId: session.id,
    runId: 'seed_s04',
    question: '为什么失败',
    mode: 'MOCK',
    model: 'mock',
    gateway: {
      async complete() {
        return { text: JSON.stringify(bad), calls: [], finishReason: 'stop' };
      },
    },
    logSink: (line) => lines.push(line),
  });
  expect(
    db.prepare('SELECT status,error_code FROM diagnosis_turn WHERE id=?').get(sent.turn_id),
  ).toMatchObject({ status: 'FAILED', error_code: 'INVALID_EVIDENCE' });
  expect(db.prepare('SELECT count(*) n FROM diagnosis_result').get()).toMatchObject({ n: 0 });
  db.close();
  expect(
    lines.map((line) => JSON.parse(line)).find((item) => item.event === 'turn.failed'),
  ).toMatchObject({
    session_id: session.id,
    turn_id: sent.turn_id,
    error_code: 'INVALID_EVIDENCE',
  });
  expect(lines.join(' ')).not.toContain('made-up-id');
  expect(lines.join(' ')).not.toContain('为什么失败');
});

it('S04 approval creates exactly one simulated child and S00 cannot retry', async () => {
  const db = openDatabase(':memory:');
  migrate(db);
  seed(db);
  const app = createApp(db, () => {});
  const session = await request(app)
    .post('/api/v1/sessions')
    .set('Idempotency-Key', 'approval-session')
    .send({ run_id: 'seed_s04' });
  const id = session.body.data.id as string;
  const sent = await request(app)
    .post(`/api/v1/sessions/${id}/messages`)
    .set('Idempotency-Key', 'approval-turn')
    .send({ content: '为什么失败？' });
  const turnId = sent.body.data.turn_id as string;
  await vi.waitFor(
    () =>
      expect(db.prepare('SELECT status FROM diagnosis_turn WHERE id=?').get(turnId)).toMatchObject({
        status: 'COMPLETED',
      }),
    { timeout: 2000 },
  );
  const proposal = await request(app)
    .post('/api/v1/runs/seed_s04/retry-proposals')
    .set('Idempotency-Key', 'proposal-one')
    .send({ turn_id: turnId, reason: '已知暂时性超时' });
  expect(proposal.status).toBe(201);
  expect(proposal.body.data.status).toBe('PENDING');
  const approvalId = proposal.body.data.id as string;
  const first = await request(app)
    .post(`/api/v1/approvals/${approvalId}/approve`)
    .set('Idempotency-Key', 'approve-one')
    .send({});
  const second = await request(app)
    .post(`/api/v1/approvals/${approvalId}/approve`)
    .set('Idempotency-Key', 'approve-one')
    .send({});
  expect(first.body.data.status).toBe('APPROVED');
  expect(second.body.data.child_run_id).toBe(first.body.data.child_run_id);
  expect(
    db.prepare('SELECT count(*) n FROM task_run WHERE parent_run_id=?').get('seed_s04'),
  ).toMatchObject({ n: 1 });
  const child = first.body.data.child_run_id as string;
  const now = Date.now();
  advanceDue(db, now);
  advanceDue(db, now + 7000);
  expect(getRun(db, child)).toMatchObject({ status: 'SUCCEEDED', parent_run_id: 'seed_s04' });
  const rejected = await request(app)
    .post('/api/v1/runs/seed_s00/retry-proposals')
    .set('Idempotency-Key', 'invalid-proposal')
    .send({ turn_id: turnId, reason: 'retry' });
  expect(rejected.status).toBe(409);
  db.close();
});

it('creates one run-bound session per idempotent request and rejects a changed target', async () => {
  const db = openDatabase(':memory:');
  migrate(db);
  seed(db);
  const app = createApp(db, () => {});
  const a = await request(app)
    .post('/api/v1/sessions')
    .set('Idempotency-Key', 'm2-session')
    .send({ run_id: 'seed_s04' });
  expect(a.status).toBe(201);
  expect(a.body.data.run_id).toBe('seed_s04');
  const b = await request(app)
    .post('/api/v1/sessions')
    .set('Idempotency-Key', 'm2-session')
    .send({ run_id: 'seed_s04' });
  expect(b.body.data.id).toBe(a.body.data.id);
  const conflict = await request(app)
    .post('/api/v1/sessions')
    .set('Idempotency-Key', 'm2-session')
    .send({ run_id: 'seed_s00' });
  expect(conflict.status).toBe(409);
  expect(db.prepare('SELECT count(*) n FROM diagnosis_session').get()).toMatchObject({ n: 1 });
  db.close();
});

it('persists a mock turn, replays events, and blocks an unapproved retry', async () => {
  const db = openDatabase(':memory:');
  migrate(db);
  seed(db);
  const app = createApp(db, () => {});
  const session = await request(app)
    .post('/api/v1/sessions')
    .set('Idempotency-Key', 'm2-flow')
    .send({ run_id: 'seed_s04' });
  const id = session.body.data.id as string;
  const sent = await request(app)
    .post(`/api/v1/sessions/${id}/messages`)
    .set('Idempotency-Key', 'm2-question')
    .send({ content: '这次运行为什么失败？' });
  expect(sent.status).toBe(202);
  expect(sent.body.data.turn_id).toBeTruthy();
  const snapshot = await request(app).get(`/api/v1/sessions/${id}`);
  expect(snapshot.status).toBe(200);
  expect(
    snapshot.body.data.messages.filter((message: { role: string }) => message.role === 'user'),
  ).toHaveLength(1);
  expect(snapshot.body.data.last_event_seq).toBeGreaterThanOrEqual(0);
  const replay = await request(app)
    .get(`/api/v1/sessions/${id}/events?after_seq=0`)
    .set('Accept', 'text/event-stream');
  expect(replay.status).toBe(200);
  expect(replay.text).toContain('event: turn.started');
  const blocked = await request(app)
    .post('/api/v1/runs/seed_s04/retry-proposals')
    .set('Idempotency-Key', 'm2-premature')
    .send({ turn_id: 'invented', reason: 'retry' });
  expect(blocked.status).toBe(409);
  expect(db.prepare('SELECT count(*) n FROM task_run').get()).toMatchObject({ n: 6 });
  db.close();
});
