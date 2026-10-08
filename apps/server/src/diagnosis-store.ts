import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { transaction } from './db.js';
import { getRun } from './store.js';
import { PROMPT_VERSION } from './prompt-version.js';

export class DomainError extends Error {
  constructor(
    public code: string,
    public status = 409,
  ) {
    super(code);
  }
}
const iso = (now: number) => new Date(now).toISOString();
const hash = (data: unknown) => createHash('sha256').update(JSON.stringify(data)).digest('hex');
type Row = Record<string, unknown>;
function dedup<T>(
  db: DatabaseSync,
  scope: string,
  key: string,
  payload: unknown,
  create: () => T,
  now: number,
): T {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(key)) throw new DomainError('INVALID_IDEMPOTENCY_KEY', 400);
  const digest = hash(payload);
  const previous = db
    .prepare(
      'SELECT request_hash,response_json FROM request_dedup WHERE scope=? AND idempotency_key=?',
    )
    .get(scope, key) as { request_hash: string; response_json: string } | undefined;
  if (previous) {
    if (previous.request_hash !== digest) throw new DomainError('IDEMPOTENCY_CONFLICT');
    return JSON.parse(previous.response_json) as T;
  }
  const result = create();
  db.prepare('INSERT INTO request_dedup VALUES (?,?,?,?,?)').run(
    scope,
    key,
    digest,
    JSON.stringify(result),
    iso(now),
  );
  return result;
}
export function createSession(db: DatabaseSync, runId: string, key: string, now = Date.now()) {
  return transaction(db, () =>
    dedup(
      db,
      'session.create',
      key,
      { run_id: runId },
      () => {
        if (!getRun(db, runId)) throw new DomainError('RUN_NOT_FOUND', 404);
        const result = {
          id: randomUUID(),
          run_id: runId,
          title: '新诊断',
          created_at: iso(now),
          updated_at: iso(now),
        };
        db.prepare('INSERT INTO diagnosis_session VALUES (?,?,?,?,?)').run(
          result.id,
          result.run_id,
          result.title,
          result.created_at,
          result.updated_at,
        );
        return result;
      },
      now,
    ),
  );
}
export function getSession(db: DatabaseSync, id: string) {
  return db.prepare('SELECT * FROM diagnosis_session WHERE id=?').get(id) as Row | undefined;
}
export function listSessions(db: DatabaseSync, runId: string) {
  return db
    .prepare('SELECT * FROM diagnosis_session WHERE run_id=? ORDER BY updated_at DESC LIMIT 100')
    .all(runId) as Row[];
}
export function listHistory(
  db: DatabaseSync,
  options: { q?: string; page: number; limit: number },
) {
  const from = ` FROM diagnosis_session s JOIN task_run r ON r.id=s.run_id JOIN task_definition t ON t.id=r.task_id
 LEFT JOIN diagnosis_turn d ON d.id=(SELECT id FROM diagnosis_turn WHERE session_id=s.id ORDER BY created_at DESC,rowid DESC LIMIT 1)
 LEFT JOIN diagnosis_result result ON result.turn_id=d.id`;
  const where = options.q ? ' WHERE instr(lower(s.title||t.name||s.run_id),lower(?))>0' : '';
  const args = options.q ? [options.q] : [];
  const total = (db.prepare('SELECT count(*) n' + from + where).get(...args) as { n: number }).n;
  const data = db
    .prepare(
      `SELECT s.id,s.run_id,s.title,s.updated_at,t.name task_name,r.scenario_id,r.status run_status,
 d.status last_status,d.error_code last_error_code,d.provider_mode,result.summary,
 (SELECT count(*) FROM diagnosis_turn WHERE session_id=s.id) turn_count` +
        from +
        where +
        ' ORDER BY s.updated_at DESC,s.id DESC LIMIT ? OFFSET ?',
    )
    .all(...args, options.limit, (options.page - 1) * options.limit);
  return { data, total };
}
export function event(
  db: DatabaseSync,
  sessionId: string,
  turnId: string,
  type: string,
  payload: Record<string, unknown>,
  now = Date.now(),
) {
  return transaction(db, () => {
    const seq = (
      db
        .prepare('SELECT COALESCE(MAX(seq),0)+1 n FROM agent_event WHERE session_id=?')
        .get(sessionId) as { n: number }
    ).n;
    const entry = {
      schema_version: 1,
      event_id: randomUUID(),
      seq,
      session_id: sessionId,
      turn_id: turnId,
      timestamp: iso(now),
      type,
      payload,
    };
    db.prepare('INSERT INTO agent_event VALUES (?,?,?,?,?,?,?)').run(
      entry.event_id,
      sessionId,
      turnId,
      seq,
      type,
      JSON.stringify(payload),
      entry.timestamp,
    );
    return entry;
  });
}
export function eventsAfter(db: DatabaseSync, sessionId: string, after: number) {
  const rows = db
    .prepare('SELECT * FROM agent_event WHERE session_id=? AND seq>? ORDER BY seq LIMIT 500')
    .all(sessionId, after) as Row[];
  return rows.map((row) => ({
    schema_version: 1,
    event_id: row.id,
    seq: row.seq,
    session_id: row.session_id,
    turn_id: row.turn_id,
    timestamp: row.created_at,
    type: row.type,
    payload: JSON.parse(row.payload_json as string),
  }));
}
export function snapshot(db: DatabaseSync, id: string) {
  db.exec('BEGIN');
  try {
    const session = getSession(db, id);
    if (!session) throw new DomainError('SESSION_NOT_FOUND', 404);
    const turns = db
      .prepare('SELECT * FROM diagnosis_turn WHERE session_id=? ORDER BY created_at')
      .all(id) as Row[];
    const messages = db
      .prepare('SELECT * FROM message WHERE session_id=? ORDER BY created_at')
      .all(id) as Row[];
    const tool_calls = db
      .prepare(
        'SELECT t.* FROM tool_call t JOIN diagnosis_turn d ON d.id=t.turn_id WHERE d.session_id=? ORDER BY t.started_at',
      )
      .all(id) as Row[];
    const results = db
      .prepare(
        'SELECT r.* FROM diagnosis_result r JOIN diagnosis_turn d ON d.id=r.turn_id WHERE d.session_id=? ORDER BY r.created_at',
      )
      .all(id) as Row[];
    const last_event_seq = (
      db.prepare('SELECT COALESCE(MAX(seq),0) n FROM agent_event WHERE session_id=?').get(id) as {
        n: number;
      }
    ).n;
    db.exec('COMMIT');
    return { schema_version: 1, session, turns, messages, tool_calls, results, last_event_seq };
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
export function submitMessage(
  db: DatabaseSync,
  sessionId: string,
  content: string,
  key: string,
  mode: 'LIVE' | 'MOCK',
  model: string,
  now = Date.now(),
) {
  const clean = content.trim();
  if (clean.length < 1 || clean.length > 2000) throw new DomainError('INVALID_ARGUMENTS', 400);
  return transaction(db, () =>
    dedup(
      db,
      'message.' + sessionId,
      key,
      { content: clean },
      () => {
        const session = getSession(db, sessionId);
        if (!session) throw new DomainError('SESSION_NOT_FOUND', 404);
        const active = (
          db
            .prepare(
              "SELECT count(*) n FROM diagnosis_turn WHERE session_id=? AND status IN ('QUEUED','RUNNING')",
            )
            .get(sessionId) as { n: number }
        ).n;
        if (active) throw new DomainError('ACTIVE_TURN_EXISTS');
        const allActive = (
          db
            .prepare("SELECT count(*) n FROM diagnosis_turn WHERE status IN ('QUEUED','RUNNING')")
            .get() as { n: number }
        ).n;
        if (allActive >= 2) throw new DomainError('TURN_LIMIT', 429);
        const turnId = randomUUID(),
          messageId = randomUUID(),
          stamp = iso(now);
        db.prepare('INSERT INTO diagnosis_turn VALUES (?,?,?,?,?,?,?,?,?,?)').run(
          turnId,
          sessionId,
          'QUEUED',
          mode,
          model,
          PROMPT_VERSION,
          null,
          stamp,
          null,
          null,
        );
        db.prepare('INSERT INTO message VALUES (?,?,?,?,?,?,?)').run(
          messageId,
          sessionId,
          turnId,
          'user',
          clean,
          0,
          stamp,
        );
        db.prepare(
          'UPDATE diagnosis_session SET updated_at=?,title=CASE WHEN title=? THEN ? ELSE title END WHERE id=?',
        ).run(stamp, '新诊断', clean.slice(0, 30), sessionId);
        return { user_message_id: messageId, turn_id: turnId };
      },
      now,
    ),
  );
}
export function markTurn(
  db: DatabaseSync,
  id: string,
  status: string,
  errorCode: string | null = null,
) {
  const now = iso(Date.now());
  db.prepare(
    "UPDATE diagnosis_turn SET status=?,error_code=?,started_at=CASE WHEN ?='RUNNING' THEN COALESCE(started_at,?) ELSE started_at END,finished_at=CASE WHEN ? IN ('COMPLETED','FAILED','CANCELLED','INTERRUPTED') THEN ? ELSE finished_at END WHERE id=?",
  ).run(status, errorCode, status, now, status, now, id);
}
export function turn(db: DatabaseSync, id: string) {
  return db.prepare('SELECT * FROM diagnosis_turn WHERE id=?').get(id) as Row | undefined;
}
export function saveEvidence(
  db: DatabaseSync,
  input: {
    sessionId: string;
    turnId: string;
    type: string;
    sourceId: string;
    sourceVersion: string;
    locator: Record<string, unknown>;
    excerpt: string;
  },
) {
  return transaction(db, () => {
    const active = db
      .prepare(
        "SELECT id FROM diagnosis_turn WHERE id=? AND session_id=? AND status IN ('QUEUED','RUNNING')",
      )
      .get(input.turnId, input.sessionId);
    if (!active) throw new DomainError('TURN_NOT_RUNNING');
    const id = randomUUID();
    db.prepare('INSERT INTO evidence VALUES (?,?,?,?,?,?,?,?,?)').run(
      id,
      input.sessionId,
      input.turnId,
      input.type,
      input.sourceId,
      input.sourceVersion,
      JSON.stringify(input.locator),
      input.excerpt.slice(0, 2000),
      iso(Date.now()),
    );
    return id;
  });
}
export function appendAssistantDelta(
  db: DatabaseSync,
  sessionId: string,
  turnId: string,
  messageId: string | undefined,
  delta: string,
) {
  return transaction(db, () => {
    if (turn(db, turnId)?.status !== 'RUNNING') throw new DomainError('TURN_NOT_RUNNING');
    const id = messageId ?? randomUUID(),
      stamp = iso(Date.now());
    if (!messageId)
      db.prepare('INSERT INTO message VALUES (?,?,?,?,?,?,?)').run(
        id,
        sessionId,
        turnId,
        'assistant',
        '',
        1,
        stamp,
      );
    db.prepare('UPDATE message SET content=content||? WHERE id=?').run(delta, id);
    const seq = (
      db
        .prepare('SELECT COALESCE(MAX(seq),0)+1 n FROM agent_event WHERE session_id=?')
        .get(sessionId) as { n: number }
    ).n;
    const item = {
      schema_version: 1,
      event_id: randomUUID(),
      seq,
      session_id: sessionId,
      turn_id: turnId,
      timestamp: stamp,
      type: 'message.delta',
      payload: { message_id: id, delta },
    };
    db.prepare('INSERT INTO agent_event VALUES (?,?,?,?,?,?,?)').run(
      item.event_id,
      sessionId,
      turnId,
      seq,
      item.type,
      JSON.stringify(item.payload),
      stamp,
    );
    return { messageId: id, item };
  });
}
export function resetAssistantContent(
  db: DatabaseSync,
  sessionId: string,
  turnId: string,
  messageId: string,
  content: string,
) {
  return transaction(db, () => {
    if (turn(db, turnId)?.status !== 'RUNNING') throw new DomainError('TURN_NOT_RUNNING');
    db.prepare(
      "UPDATE message SET content=? WHERE id=? AND session_id=? AND turn_id=? AND role='assistant'",
    ).run(content, messageId, sessionId, turnId);
    const seq = (
      db
        .prepare('SELECT COALESCE(MAX(seq),0)+1 n FROM agent_event WHERE session_id=?')
        .get(sessionId) as { n: number }
    ).n;
    const stamp = iso(Date.now());
    db.prepare('INSERT INTO agent_event VALUES (?,?,?,?,?,?,?)').run(
      randomUUID(),
      sessionId,
      turnId,
      seq,
      'message.reset',
      JSON.stringify({ message_id: messageId, content }),
      stamp,
    );
  });
}
export function getEvidence(db: DatabaseSync, sessionId: string, id: string) {
  const row = db
    .prepare('SELECT * FROM evidence WHERE id=? AND session_id=?')
    .get(id, sessionId) as Row | undefined;
  return row ? { ...row, locator: JSON.parse(row.locator_json as string) } : undefined;
}
export function saveResult(
  db: DatabaseSync,
  sessionId: string,
  turnId: string,
  result: {
    summary: string;
    findings: unknown[];
    missing_information: string[];
    next_steps: string[];
    proposed_action: unknown;
  },
) {
  return transaction(db, () => {
    if (turn(db, turnId)?.status !== 'RUNNING') throw new DomainError('TURN_NOT_RUNNING');
    const id = randomUUID();
    const stamp = iso(Date.now());
    db.prepare('INSERT INTO diagnosis_result VALUES (?,?,?,?,?,?,?,?)').run(
      id,
      turnId,
      result.summary,
      JSON.stringify(result.findings),
      JSON.stringify(result.missing_information),
      JSON.stringify(result.next_steps),
      JSON.stringify(result.proposed_action),
      stamp,
    );
    const seq = (
      db
        .prepare('SELECT COALESCE(MAX(seq),0)+1 n FROM agent_event WHERE session_id=?')
        .get(sessionId) as { n: number }
    ).n;
    const item = {
      schema_version: 1,
      event_id: randomUUID(),
      seq,
      session_id: sessionId,
      turn_id: turnId,
      timestamp: stamp,
      type: 'diagnosis.completed',
      payload: { result },
    };
    db.prepare('INSERT INTO agent_event VALUES (?,?,?,?,?,?,?)').run(
      item.event_id,
      sessionId,
      turnId,
      seq,
      item.type,
      JSON.stringify(item.payload),
      stamp,
    );
    const finish = {
      ...item,
      event_id: randomUUID(),
      seq: seq + 1,
      type: 'turn.finished',
      payload: { status: 'COMPLETED' },
    };
    db.prepare('INSERT INTO agent_event VALUES (?,?,?,?,?,?,?)').run(
      finish.event_id,
      sessionId,
      turnId,
      seq + 1,
      finish.type,
      JSON.stringify(finish.payload),
      stamp,
    );
    db.prepare("UPDATE diagnosis_turn SET status='COMPLETED',finished_at=? WHERE id=?").run(
      stamp,
      turnId,
    );
    return [item, finish];
  });
}
export function retryEligibility(db: DatabaseSync, runId: string) {
  const run = getRun(db, runId);
  if (!run) throw new DomainError('RUN_NOT_FOUND', 404);
  let ancestor = run,
    depth = 0;
  const visited = new Set([run.id]);
  while (ancestor.parent_run_id) {
    const parent = getRun(db, ancestor.parent_run_id);
    if (!parent || visited.has(parent.id) || ++depth >= 2)
      return { allowed: false, reason_code: 'RECOVERY_LIMIT', message: '恢复链最多两次模拟重试' };
    visited.add(parent.id);
    ancestor = parent;
  }
  const allowed =
    run.status === 'FAILED' && run.scenario_id === 'S04' && run.error_code === 'UPSTREAM_TIMEOUT';
  const existing = db.prepare('SELECT id FROM task_run WHERE parent_run_id=?').get(runId);
  return {
    allowed: allowed && !existing,
    reason_code: allowed ? (existing ? 'ALREADY_RETRIED' : null) : 'NOT_TRANSIENT_TIMEOUT',
    message: allowed
      ? existing
        ? '已创建重试运行'
        : '可申请模拟重试'
      : '仅已知上游超时失败允许重试',
  };
}
export function proposeRetry(
  db: DatabaseSync,
  runId: string,
  turnId: string,
  reason: string,
  key: string,
  now = Date.now(),
) {
  return transaction(db, () =>
    dedup(
      db,
      'retry.proposal.' + runId,
      key,
      { turn_id: turnId, reason },
      () => {
        const eligibility = retryEligibility(db, runId);
        if (!eligibility.allowed) throw new DomainError('RETRY_NOT_ALLOWED');
        const completed = db
          .prepare(
            "SELECT d.id FROM diagnosis_turn d JOIN diagnosis_session s ON s.id=d.session_id JOIN diagnosis_result r ON r.turn_id=d.id WHERE d.id=? AND d.status='COMPLETED' AND s.run_id=?",
          )
          .get(turnId, runId);
        if (!completed) throw new DomainError('DIAGNOSIS_REQUIRED');
        const result = db
          .prepare('SELECT proposed_action_json FROM diagnosis_result WHERE turn_id=?')
          .get(turnId) as { proposed_action_json: string | null };
        const proposal = JSON.parse(result.proposed_action_json ?? 'null') as {
          type?: string;
          run_id?: string;
        } | null;
        if (proposal?.type !== 'RETRY_RUN' || proposal.run_id !== runId)
          throw new DomainError('RETRY_NOT_PROPOSED');
        const pending = db
          .prepare("SELECT id FROM approval_request WHERE run_id=? AND status='PENDING'")
          .get(runId);
        if (pending) throw new DomainError('APPROVAL_ALREADY_PENDING');
        const run = getRun(db, runId)!;
        const id = randomUUID(),
          stamp = iso(now);
        const item = {
          id,
          run_id: runId,
          turn_id: turnId,
          status: 'PENDING',
          action: 'RETRY_RUN',
          reason,
          params: run.params,
          expires_at: iso(now + 600000),
          created_at: stamp,
          child_run_id: null,
        };
        db.prepare('INSERT INTO approval_request VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(
          id,
          runId,
          turnId,
          'PENDING',
          'RETRY_RUN',
          hash(run.params),
          hash({ status: run.status, params: run.params, error_code: run.error_code }),
          reason,
          item.expires_at,
          stamp,
          null,
        );
        return item;
      },
      now,
    ),
  );
}
export function getApproval(db: DatabaseSync, id: string, now = Date.now()) {
  const row = db.prepare('SELECT * FROM approval_request WHERE id=?').get(id) as Row | undefined;
  if (!row) return undefined;
  const run = getRun(db, row.run_id as string);
  if (row.status === 'PENDING') {
    const expired = now >= Date.parse(row.expires_at as string);
    const stale =
      !run ||
      row.run_snapshot_hash !==
        hash({ status: run.status, params: run.params, error_code: run.error_code });
    if (expired || stale) {
      row.status = expired ? 'EXPIRED' : 'STALE';
      db.prepare('UPDATE approval_request SET status=?,resolved_at=? WHERE id=?').run(
        row.status as string,
        iso(now),
        id,
      );
    }
  }
  const execution = db.prepare('SELECT * FROM action_execution WHERE approval_id=?').get(id) as
    Row | undefined;
  return {
    id: row.id,
    run_id: row.run_id,
    turn_id: row.turn_id,
    status: row.status,
    action: row.action,
    reason: row.reason,
    params: run?.params ?? {},
    expires_at: row.expires_at,
    created_at: row.created_at,
    child_run_id: execution?.child_run_id ?? null,
    execution_status: execution?.status ?? null,
  };
}
export function listApprovals(db: DatabaseSync, runId: string) {
  return (
    db
      .prepare('SELECT id FROM approval_request WHERE run_id=? ORDER BY created_at DESC')
      .all(runId) as { id: string }[]
  ).map((row) => getApproval(db, row.id));
}
export function resolveApproval(
  db: DatabaseSync,
  id: string,
  decision: 'approve' | 'reject',
  key: string,
  now = Date.now(),
) {
  return transaction(db, () =>
    dedup(
      db,
      'approval.' + id,
      key,
      { decision },
      () => {
        const approval = getApproval(db, id, now);
        if (!approval) throw new DomainError('APPROVAL_NOT_FOUND', 404);
        if (approval.status !== 'PENDING') {
          if (approval.status === 'EXPIRED' || approval.status === 'STALE') return approval;
          if (approval.status === (decision === 'approve' ? 'APPROVED' : 'REJECTED'))
            return approval;
          throw new DomainError('APPROVAL_RESOLVED');
        }
        if (now >= Date.parse(approval.expires_at as string)) {
          db.prepare("UPDATE approval_request SET status='EXPIRED',resolved_at=? WHERE id=?").run(
            iso(now),
            id,
          );
          return getApproval(db, id)!;
        }
        const run = getRun(db, approval.run_id as string)!;
        const row = db
          .prepare('SELECT run_snapshot_hash FROM approval_request WHERE id=?')
          .get(id) as { run_snapshot_hash: string };
        if (
          row.run_snapshot_hash !==
            hash({ status: run.status, params: run.params, error_code: run.error_code }) ||
          !retryEligibility(db, run.id).allowed
        ) {
          db.prepare("UPDATE approval_request SET status='STALE',resolved_at=? WHERE id=?").run(
            iso(now),
            id,
          );
          return getApproval(db, id)!;
        }
        if (decision === 'reject') {
          db.prepare("UPDATE approval_request SET status='REJECTED',resolved_at=? WHERE id=?").run(
            iso(now),
            id,
          );
          return getApproval(db, id)!;
        }
        const childId = randomUUID(),
          stamp = iso(now),
          steps = { read: 'PENDING', validate: 'PENDING', load: 'PENDING', aggregate: 'PENDING' };
        db.prepare(
          `INSERT INTO task_run(id,task_id,data_source,scenario_id,scenario_instance_id,parent_run_id,status,step_states_json,params_json,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)`,
        ).run(
          childId,
          run.task_id,
          'FIXTURE',
          'S04',
          randomUUID(),
          run.id,
          'PENDING',
          JSON.stringify(steps),
          JSON.stringify(run.params),
          stamp,
        );
        db.prepare('INSERT INTO simulation_state VALUES (?,?,?,?,?,?)').run(
          childId,
          '1',
          'retry',
          0,
          0,
          stamp,
        );
        db.prepare('INSERT INTO action_execution VALUES (?,?,?,?,?,?)').run(
          randomUUID(),
          id,
          'QUEUED',
          childId,
          null,
          stamp,
        );
        db.prepare("UPDATE approval_request SET status='APPROVED',resolved_at=? WHERE id=?").run(
          stamp,
          id,
        );
        return getApproval(db, id)!;
      },
      now,
    ),
  );
}
