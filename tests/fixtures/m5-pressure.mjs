// Test-only fixture: never exposed by a product API or seeded into the dev DB.
import { openDatabase, migrate, seed, transaction } from '../../apps/server/dist/db.js';
import {
  createSession,
  submitMessage,
  markTurn,
  saveEvidence,
  saveResult,
  event,
} from '../../apps/server/dist/diagnosis-store.js';
import { resolve, dirname, basename, relative, sep } from 'node:path';
import { tmpdir } from 'node:os';
export function seedPressure(path) {
  const absolute = resolve(path),
    rel = relative(tmpdir(), absolute);
  if (
    rel.startsWith('..') ||
    rel.startsWith(sep) ||
    !basename(dirname(absolute)).startsWith('flowlens-e2e-') ||
    basename(absolute) !== 'test.sqlite'
  )
    throw Error('PRESSURE_REQUIRES_ISOLATED_E2E_DB');
  const db = openDatabase(absolute);
  try {
    migrate(db);
    seed(db);
    const stamp = '2026-10-01T00:00:00.000Z',
      runId = 'm5_pressure_run';
    transaction(db, () => {
      db.prepare(
        `INSERT INTO task_run SELECT ?,task_id,data_source,scenario_id,?,NULL,status,step_states_json,params_json,?,started_at,finished_at,error_code,error_message,summary_json FROM task_run WHERE id='seed_s04'`,
      ).run(runId, runId, stamp);
      const insert = db.prepare('INSERT INTO task_log VALUES (?,?,?,?,?,?,?)');
      for (let i = 1; i <= 10000; i++)
        insert.run(
          'pressure_log_' + i,
          runId,
          i,
          stamp,
          i === 50 ? 'ERROR' : 'INFO',
          'read',
          i === 50
            ? 'ReadTimeout: upstream request exceeded 5s (pressure fixture)'
            : 'Synthetic pressure log ' + i,
        );
    });
    const session = createSession(db, runId, 'pressure-session', Date.parse(stamp));
    const submitted = submitMessage(
      db,
      session.id,
      '压力测试：查看分页外证据',
      'pressure-question',
      'MOCK',
      'pressure-fixture',
      Date.parse(stamp) + 1,
    );
    markTurn(db, submitted.turn_id, 'RUNNING');
    const evidence = saveEvidence(db, {
      sessionId: session.id,
      turnId: submitted.turn_id,
      type: 'LOG',
      sourceId: 'pressure_log_50',
      sourceVersion: stamp,
      locator: { run_id: runId, log_id: 'pressure_log_50' },
      excerpt: 'ReadTimeout: upstream request exceeded 5s (pressure fixture)',
    });
    transaction(db, () => {
      const insert = db.prepare('INSERT INTO tool_call VALUES (?,?,?,?,?,?,?,?,?)');
      for (let i = 1; i <= 200; i++)
        insert.run(
          'pressure_tool_' + i,
          submitted.turn_id,
          'get_task_logs',
          JSON.stringify({ run_id: runId, limit: 200 }),
          'SUCCEEDED',
          JSON.stringify({ summary: '压力记录 ' + i + ' · FIXTURE，非实际模型调用', count: 1 }),
          null,
          new Date(Date.parse(stamp) + i).toISOString(),
          new Date(Date.parse(stamp) + i + 1).toISOString(),
        );
    });
    for (let i = 1; i <= 200; i++) {
      event(db, session.id, submitted.turn_id, 'tool.started', {
        tool_call_id: 'pressure_tool_' + i,
        name: 'get_task_logs',
        args: { run_id: runId, limit: 200 },
      });
      event(db, session.id, submitted.turn_id, 'tool.completed', {
        tool_call_id: 'pressure_tool_' + i,
        summary: '压力记录 ' + i + ' · FIXTURE，非实际模型调用',
        evidence_ids: [evidence],
      });
    }
    const logCount = db.prepare('SELECT count(*) n FROM task_log WHERE run_id=?').get(runId).n;
    const toolCount = db
      .prepare('SELECT count(*) n FROM tool_call WHERE turn_id=?')
      .get(submitted.turn_id).n;
    if (logCount !== 10000 || toolCount !== 200) throw Error('INVALID_PRESSURE_DATA');
    saveResult(db, session.id, submitted.turn_id, {
      summary: '压力测试：已保存 10000 日志和 200 工具记录（FIXTURE）',
      findings: [
        {
          cause: 'UPSTREAM_TIMEOUT',
          explanation: '合成超时日志，仅用于分页与引用展示验证。',
          evidence_ids: [evidence],
          evidence_status: 'SUPPORTED',
        },
      ],
      missing_information: [],
      next_steps: ['此压力数据不代表生产负载或模型运行轨迹。'],
      proposed_action: null,
    });
    return { runId, sessionId: session.id };
  } finally {
    db.close();
  }
}
