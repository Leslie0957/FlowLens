import { expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { reviewSummary } from '../../../scripts/review-pipeline-eval.mjs';
import {
  loadSuite,
  gradeRepair,
  assessPlatform,
  validateCandidate,
  runEvaluation,
  root,
} from '../../../scripts/pipeline-eval-core.mjs';

const data = JSON.parse(readFileSync(join(root, 'fixtures/evals/pipeline-v1/data.json'), 'utf8'));
const correctSql =
  'SELECT dat, start_us AS st, end_us AS et, car_series FROM raw_vehicle_events WHERE speed_mps < 1 AND end_us - start_us >= 3000000;';
function citedRepair(types: string[], stage: string, action = 'SQL_PATCH') {
  const revision = randomUUID(),
    execution = randomUUID();
  const evidence = types.map((type) => ({
    id: randomUUID(),
    type,
    source_id: type === 'get_sql' ? revision : execution,
    source_version: 'base:input',
    excerpt: 'Synthetic grading-only fixture, never persisted as a Pipeline execution.',
  }));
  return {
    base_revision_id: revision,
    execution_id: execution,
    base_hash: 'base',
    input_hash: 'input',
    evidence,
    evidence_ids: evidence.map((e) => e.id),
    model_turns: [],
    failed_step: stage,
    action,
  };
}

it('bounded SQL mismatch conclusions need failure, SQL and rules, not a mandatory output call; missing facts still fail', () => {
  for (const c of loadSuite('dev').filter((c: { id: string }) =>
    ['D03', 'D04', 'D05', 'D06'].includes(c.id),
  )) {
    const repair = citedRepair(['INITIAL_FAILURE', 'get_sql', 'get_schema'], 'validate');
    const current = gradeRepair(c, repair);
    expect(current.required_sources_present).toBe(true);
    expect(current.legacy_v1_sources_present).toBe(false);
    expect(
      gradeRepair(c, repair, { version: 'pipeline-evidence-v1' }).required_sources_present,
    ).toBe(false);
    expect(current.evidence_semantically_sufficient).toBeNull();
    expect(current.diagnosis_correct).toBeNull();
    for (const types of [
      ['INITIAL_FAILURE', 'get_sql'],
      ['INITIAL_FAILURE', 'get_schema'],
      ['get_sql', 'get_schema'],
    ])
      expect(gradeRepair(c, citedRepair(types, 'validate')).required_sources_present).toBe(false);
    const wrongVersion = structuredClone(repair);
    wrongVersion.evidence[0].source_version = 'foreign:input';
    expect(gradeRepair(c, wrongVersion).citations_legal).toBe(false);
  }
});

it('D07 permits bounded manual handoff from initial conflict alone but SQL_PATCH remains wrong even when safely blocked', () => {
  const c = loadSuite('dev').find((c: { id: string }) => c.id === 'D07');
  const bounded = gradeRepair(c, citedRepair(['INITIAL_FAILURE'], 'precheck', 'MANUAL_REQUIRED'));
  expect(bounded.required_sources_present).toBe(true);
  expect(bounded.action_allowed).toBe(true);
  expect(bounded.evidence_semantically_sufficient).toBeNull();
  const wrong = gradeRepair(
    c,
    citedRepair(['INITIAL_FAILURE', 'get_sql', 'get_schema'], 'precheck'),
  );
  expect(wrong.action_allowed).toBe(false);
  const platform = assessPlatform({
    metrics: { ...wrong, no_target_writes: true, input_unchanged: true },
    approval: {
      repair: { status: 'VERIFICATION_FAILED' },
      execution: { status: 'FAILED', error_code: 'BUSINESS_KEY_CONFLICT' },
    },
  });
  expect(platform.agent_action_allowed).toBe(false);
  expect(platform.business_conflict_blocked).toBe(true);
  expect(platform.observed_data_preserved).toBe(true);
});

it('frozen datasets reject listed mutations and G01 but do not cover every incorrect threshold or row limit', () => {
  const cases = loadSuite('all');
  expect(new Set(cases.map((c: { sql: string }) => c.sql)).size).toBe(10);
  for (const c of cases.filter((c: { id: string }) => c.id !== 'D07')) {
    expect(validateCandidate(c.sql, data.fixed).passed).toBe(false);
    expect(validateCandidate(c.sql, data.holdout).passed).toBe(false);
  }
  expect(validateCandidate(data.generalization_probe.sql, data.fixed).passed).toBe(true);
  expect(validateCandidate(data.generalization_probe.sql, data.holdout).passed).toBe(false);
  // Deliberate counterexamples documenting dataset blind spots. Do not change
  // frozen labels/data to make these disappear or claim full generalization.
  for (const sql of [correctSql.replace('< 1', '< 0.9995'), correctSql.replace(';', ' LIMIT 4;')]) {
    expect(validateCandidate(sql, data.fixed).passed).toBe(true);
    expect(validateCandidate(sql, data.holdout).passed).toBe(true);
  }
});

it('partial human review cannot turn a selected successful subset into whole-run LIVE accuracy', () => {
  // Only a synthetic report format test. No LIVE gateway or API is created.
  const reportText = JSON.stringify({ mode: 'LIVE', cases: [{ id: 'D03' }, { id: 'D07' }] });
  const review = {
    mode: 'LIVE',
    report_sha256: createHash('sha256').update(reportText).digest('hex'),
    cases: [
      {
        id: 'D03',
        diagnosis_correct: true,
        evidence_sufficient: true,
        prohibited_claims: false,
        reviewer: 'test-fixture',
        reason: 'Synthetic positive verdict',
      },
      {
        id: 'D07',
        diagnosis_correct: null,
        evidence_sufficient: null,
        prohibited_claims: null,
        reviewer: null as string | null,
        reason: null as string | null,
      },
    ],
  };
  expect(reviewSummary(reportText, review).diagnosis_accuracy).toBeNull();
  expect(reviewSummary(reportText, review).reviewed_subset_correct).toEqual({
    correct: 1,
    total: 1,
  });
  Object.assign(review.cases[1], {
    diagnosis_correct: false,
    evidence_sufficient: false,
    prohibited_claims: false,
    reviewer: 'test-fixture',
    reason: 'Synthetic negative verdict',
  });
  expect(reviewSummary(reportText, review).diagnosis_accuracy).toEqual({ correct: 1, total: 2 });
});

it('failed gateway calls leave per-request errors and partial traces; development only and no paid network', async () => {
  const fetch = vi.fn(() => {
    throw new Error('NETWORK_FORBIDDEN');
  });
  vi.stubGlobal('fetch', fetch);
  try {
    const report = await runEvaluation({
      split: 'dev',
      policy: 'builtin',
      gatewayFactory: () => ({
        async complete() {
          throw Object.assign(new Error('Synthetic gateway failure for journal regression'), {
            code: 'SYNTHETIC_GATEWAY_FAILURE',
          });
        },
      }),
    });
    expect(report.cases).toHaveLength(7);
    expect(report.status).toBe('CHECKS_FAILED');
    expect(report.scoring_version).toBe('pipeline-evidence-v2');
    for (const c of report.cases) {
      const requests = JSON.parse(
        readFileSync(join(report.run_directory, c.id + '-requests.json'), 'utf8'),
      );
      expect(requests[0].status).toBe('FAILED');
      expect(requests[0].error.code).toBe('SYNTHETIC_GATEWAY_FAILURE');
      expect(requests[0].elapsed_ms).toBeGreaterThanOrEqual(0);
      expect(c.split).toBe('dev');
    }
    expect(fetch).not.toHaveBeenCalled();
    expect(report.live_requests).toBe(0);
  } finally {
    vi.unstubAllGlobals();
  }
}, 30000);
