import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { openDatabase, migrate, seed } from '../src/db.js';
import { createSession, submitMessage } from '../src/diagnosis-store.js';
import { runDiagnosis } from '../src/diagnosis-agent.js';
const cases = JSON.parse(
  readFileSync(new URL('../../../fixtures/evals/p0.json', import.meta.url), 'utf8'),
) as { scenario_id: string; question: string; cause: string; retry: boolean }[];
it.each(cases)('deterministic $scenario_id: $question', async (item) => {
  const db = openDatabase(':memory:');
  migrate(db);
  seed(db);
  const runId = 'seed_' + item.scenario_id.toLowerCase(),
    s = createSession(db, runId, 'eval-session');
  const t = submitMessage(db, s.id, item.question, 'eval-turn', 'MOCK', 'mock');
  await runDiagnosis(db, {
    turnId: t.turn_id,
    sessionId: s.id,
    runId,
    question: item.question,
    mode: 'MOCK',
    model: 'mock',
    logSink: () => {},
  });
  const result = db
    .prepare(
      'SELECT findings_json,missing_information_json,proposed_action_json FROM diagnosis_result WHERE turn_id=?',
    )
    .get(t.turn_id) as Record<string, string>;
  const findings = JSON.parse(result.findings_json!) as { cause: string; evidence_ids: string[] }[];
  expect(findings[0]?.cause).toBe(item.cause);
  expect(findings[0]?.evidence_ids.length).toBeGreaterThan(0);
  expect(JSON.parse(result.proposed_action_json!) !== null).toBe(item.retry);
  if (item.cause === 'UNKNOWN')
    expect(JSON.parse(result.missing_information_json!).length).toBeGreaterThan(0);
  for (const finding of findings)
    for (const id of finding.evidence_ids)
      expect(
        db.prepare('SELECT id FROM evidence WHERE id=? AND session_id=?').get(id, s.id),
      ).toBeTruthy();
  db.close();
});
