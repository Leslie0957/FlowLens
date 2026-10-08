import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openDatabase, migrate, seed } from './db.js';
import { createSession, submitMessage } from './diagnosis-store.js';
import { runDiagnosis } from './diagnosis-agent.js';

if (
  process.env.FLOWLENS_LIVE_APPROVED !== '1' ||
  process.env.MODEL_MODE !== 'LIVE' ||
  !process.env.MODEL_API_KEY ||
  Number(process.env.FLOWLENS_LIVE_MAX_REQUESTS) < 1 ||
  Number(process.env.FLOWLENS_LIVE_MAX_REQUESTS) > 6 ||
  Number(process.env.MODEL_MAX_OUTPUT_TOKENS) !== 2048
) {
  process.stderr.write(
    'M2 LIVE validation requires explicit remaining request budget (1-6), 2048-token gate and local key. No request sent.\n',
  );
  process.exitCode = 2;
} else {
  const folder = mkdtempSync(join(tmpdir(), 'flowlens-m2-live-'));
  const db = openDatabase(join(folder, 'live.sqlite'));
  let requests = 0;
  const sink = (line: string) => {
    process.stderr.write(line + '\n');
    try {
      if ((JSON.parse(line) as { event: string }).event === 'model.started') requests++;
    } catch {
      /* only known JSON log lines count */
    }
  };
  try {
    migrate(db);
    seed(db);
    const session = createSession(db, 'seed_s04', 'm2-live-validation');
    for (const [index, question] of [
      '这次运行为什么失败？请使用只读工具核对日志与 Runbook，并引用证据。',
      '这个问题重试有用吗？请说明依据与限制。',
    ].entries()) {
      const sent = submitMessage(
        db,
        session.id,
        question,
        'm2-live-turn-' + index,
        'LIVE',
        process.env.MODEL_NAME ?? 'deepseek-flash',
      );
      await runDiagnosis(db, {
        turnId: sent.turn_id,
        sessionId: session.id,
        runId: 'seed_s04',
        question,
        mode: 'LIVE',
        model: process.env.MODEL_NAME ?? 'deepseek-flash',
        logSink: sink,
      });
      const state = db
        .prepare('SELECT status,error_code FROM diagnosis_turn WHERE id=?')
        .get(sent.turn_id) as { status: string; error_code: string | null };
      const result = db
        .prepare('SELECT findings_json FROM diagnosis_result WHERE turn_id=?')
        .get(sent.turn_id) as { findings_json: string } | undefined;
      const tools = (
        db.prepare('SELECT count(*) n FROM tool_call WHERE turn_id=?').get(sent.turn_id) as {
          n: number;
        }
      ).n;
      const evidence = (
        db.prepare('SELECT count(*) n FROM evidence WHERE turn_id=?').get(sent.turn_id) as {
          n: number;
        }
      ).n;
      process.stdout.write(
        JSON.stringify({
          turn: index + 1,
          status: state.status,
          error_code: state.error_code,
          model_requests_so_far: requests,
          tool_calls: tools,
          evidence_count: evidence,
          causes: result
            ? (JSON.parse(result.findings_json) as { cause: string }[]).map((x) => x.cause)
            : [],
        }) + '\n',
      );
      if (state.status !== 'COMPLETED') {
        process.exitCode = 1;
        break;
      }
    }
  } finally {
    db.close();
    rmSync(folder, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}
