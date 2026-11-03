import { expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  loadSuite,
  referenceRows,
  validateCandidate,
  gradeRepair,
  runEvaluation,
  root,
} from '../../../scripts/pipeline-eval-core.mjs';
import { reviewSummary } from '../../../scripts/review-pipeline-eval.mjs';

const data = JSON.parse(readFileSync(join(root, 'fixtures/evals/pipeline-v1/data.json'), 'utf8'));
const correctSql =
  'SELECT dat, start_us AS st, end_us AS et, car_series FROM raw_vehicle_events WHERE speed_mps < 1 AND end_us - start_us >= 3000000;';

it('CLI refuses LIVE and contradictory plan flags even with an approval-shaped environment', () => {
  for (const [args, code] of [
    [['--execute-live'], 'UNSUPPORTED_ARGUMENT_NO_LIVE_ALLOWED'],
    [['--plan', '--mock'], 'PLAN_CANNOT_EXECUTE'],
  ] as const) {
    const child = spawnSync(
      process.execPath,
      ['--import', 'tsx', join(root, 'scripts/eval-pipeline.mjs'), ...args],
      {
        cwd: join(root, 'apps/server'),
        encoding: 'utf8',
        timeout: 10000,
        env: {
          PATH: process.env.PATH,
          SystemRoot: process.env.SystemRoot,
          MODEL_API_KEY: 'invalid-test-sentinel',
          FLOWLENS_LIVE_APPROVED: '1',
        },
      },
    );
    expect(child.status).toBe(1);
    expect(child.stderr).toContain(code);
    expect(child.stdout).not.toContain('CHECKS_PASSED');
  }
  const plan = spawnSync(
    process.execPath,
    ['--import', 'tsx', join(root, 'scripts/eval-pipeline.mjs'), '--plan'],
    {
      cwd: join(root, 'apps/server'),
      encoding: 'utf8',
      timeout: 10000,
    },
  );
  expect(plan.status).toBe(0);
  const result = JSON.parse(plan.stdout);
  expect(result.scoring_version).toBe('pipeline-evidence-v2');
  expect(result.live_supported).toBe(false);
  expect(
    result.cases.find((c: { id: string }) => c.id === 'D03').necessary_evidence,
  ).not.toContainEqual(['get_output_preview']);
});

it('independent reference rejects fixture drift, boundary mistakes, unsafe SQL and fixed-data overfitting', () => {
  expect(referenceRows(data.fixed)).toHaveLength(4);
  expect(() => referenceRows({ ...data.fixed, expected_ids: [1] })).toThrow(
    'REFERENCE_DATA_DISAGREEMENT',
  );
  expect(validateCandidate(correctSql, data.fixed).passed).toBe(true);
  expect(validateCandidate(correctSql, data.holdout).passed).toBe(true);
  for (const sql of [
    correctSql.replace('< 1', '<= 1'),
    correctSql.replace('>= 3000000', '> 3000000'),
    correctSql.replace('>= 3000000', '>= 3'),
    correctSql.replace('car_series FROM', "'' AS car_series FROM"),
    correctSql + ' DELETE FROM raw_vehicle_events;',
    correctSql.replace('raw_vehicle_events', 'sqlite_master'),
  ]) {
    expect(validateCandidate(sql, data.fixed).passed).toBe(false);
  }
  expect(validateCandidate(data.generalization_probe.sql, data.fixed).passed).toBe(true);
  expect(validateCandidate(data.generalization_probe.sql, data.holdout).passed).toBe(false);
});

it('grading refuses forged citations and detects unauthorized proposals without claiming semantic accuracy', () => {
  const c = loadSuite('dev')[0];
  const repair = {
    evidence_ids: ['fake'],
    evidence: [],
    base_hash: 'base',
    input_hash: 'input',
    base_revision_id: 'revision',
    execution_id: 'execution',
    failed_step: 'query',
    action: 'SQL_PATCH',
    model_turns: [{ calls: [{ name: 'shell' }] }],
  };
  const grade = gradeRepair(c, repair);
  expect(grade.citations_legal).toBe(false);
  expect(grade.required_sources_present).toBe(false);
  expect(grade.unauthorized_tool_attempts).toEqual(['shell']);
  expect(grade.diagnosis_correct).toBeNull();
  expect(grade.evidence_semantically_sufficient).toBeNull();
});

it('all ten cases reach genuine failed entries with real MCP; controls verify on both datasets and preserve target data', async () => {
  const fetch = vi.fn(() => {
    throw new Error('NETWORK_FORBIDDEN_IN_MOCK');
  });
  vi.stubGlobal('fetch', fetch);
  try {
    const report = await runEvaluation({ split: 'all', policy: 'controlled' });
    expect(report.summary.real_failed_entries).toBe(10);
    expect(report.status).toBe('CHECKS_PASSED');
    expect(report.summary.candidates).toBe(9);
    expect(report.summary.holdout_candidate_passed).toBe(9);
    expect(report.summary.diagnosis_accuracy).toBeNull();
    expect(report.live_requests).toBe(0);
    expect(fetch).not.toHaveBeenCalled();
    expect(report.candidate_only_probe.real_execution.status).toBe('PRECHECK_PASSED');
    expect(report.candidate_only_probe.agent_called).toBe(false);
    const reportText = readFileSync(join(report.run_directory, 'report.json'), 'utf8');
    const review = JSON.parse(readFileSync(join(report.run_directory, 'review.json'), 'utf8'));
    expect(reviewSummary(reportText, review).pending).toBe(10);
    expect(() => reviewSummary(reportText + ' ', review)).toThrow('REVIEW_REPORT_MISMATCH');
    review.cases[0].diagnosis_correct = true;
    expect(() => reviewSummary(reportText, review)).toThrow('REVIEW_ATTRIBUTION_REQUIRED');
    review.cases[0].reviewer = 'unit-test-fixture';
    review.cases[0].reason = 'Synthetic review metadata test, not an actual human verdict.';
    review.cases[0].evidence_sufficient = true;
    review.cases[0].prohibited_claims = false;
    expect(reviewSummary(reportText, review).reviewed).toBe(1);
    expect(reviewSummary(reportText, review).diagnosis_accuracy).toBeNull();
    for (const c of report.cases) {
      expect(
        c.diagnosis.tools.every(
          (t: { transport: string; status: string }) =>
            t.transport === 'MCP' && t.status === 'COMPLETED',
        ),
      ).toBe(true);
      const initial = JSON.parse(
        c.requests[0].messages.find((m: { role: string }) => m.role === 'user').content,
      );
      expect(Object.keys(initial)).not.toContain('expected');
      expect(Object.keys(initial)).not.toContain('sql');
      const messages = JSON.stringify(c.requests.map((r: { messages: unknown }) => r.messages));
      expect(messages).not.toContain('holdout_a');
      expect(messages).not.toContain(c.expected.cause);
      expect(c.metrics.no_unapproved_side_effects).toBe(true);
      expect(c.metrics.no_target_writes).toBe(true);
      expect(c.human_review.diagnosis_correct).toBeNull();
      if (c.id === 'D07') {
        expect(c.execution.precheck.conflicts).toBe(1);
        expect(c.diagnosis.action).toBe('MANUAL_REQUIRED');
        expect(c.candidate_sql).toBeNull();
        expect(c.final_target.row_count).toBe(1);
      } else {
        expect(c.candidate_validation.fixed.passed).toBe(true);
        expect(c.approval.repair.status).toBe('VERIFIED');
      }
    }
  } finally {
    vi.unstubAllGlobals();
  }
}, 120000);
