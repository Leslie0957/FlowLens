import { afterEach, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  executionPlan,
  authorizeLive,
  controlledRun,
} from '../../../scripts/pipeline-controlled-run.mjs';
import { loadSuite, root, runEvaluation } from '../../../scripts/pipeline-eval-core.mjs';

const temp = () => mkdtempSync(join(tmpdir(), 'flowlens-holdout-test-'));
const ids = ['H01', 'H02', 'H03'];
const selection = {
  split: 'holdout',
  allowHoldout: true,
  profile: 'effect',
  promptVariant: 'grounded-actions-v1',
};
const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

it('holdout plans require explicit split, opt-in and unique IDs; development defaults stay restricted', () => {
  expect(() => executionPlan(ids)).toThrow('ONLY_EXPLICIT_DEV_CASES_ALLOWED');
  expect(() => executionPlan(ids, { split: 'holdout' })).toThrow(
    'EXPLICIT_HOLDOUT_OPT_IN_REQUIRED',
  );
  expect(() => executionPlan(ids, { split: 'all', allowHoldout: true })).toThrow(
    'INVALID_CONTROLLED_SPLIT',
  );
  expect(() => executionPlan(['D01'], { allowHoldout: true })).toThrow(
    'HOLDOUT_OPT_IN_REQUIRES_HOLDOUT_SPLIT',
  );
  expect(() => executionPlan(['H01', 'D01'], selection)).toThrow(
    'ONLY_EXPLICIT_HOLDOUT_CASES_ALLOWED',
  );
  expect(() => executionPlan(['H01', 'H01'], selection)).toThrow(
    'EXPLICIT_UNIQUE_CASE_IDS_REQUIRED',
  );
  expect(() => executionPlan(undefined, selection)).toThrow('EXPLICIT_UNIQUE_CASE_IDS_REQUIRED');
  const plan = executionPlan(ids, selection);
  expect(plan.split).toBe('holdout');
  expect(plan.holdout_cases_planned).toBe(3);
  expect(plan.holdout_agent_runs).toBe(0);
  expect(plan.prompt_sha256).toBe(
    '5b5425cb0f1bf9c454076c6c8336b6f493862a8091cc19f04368067764f8b07b',
  );
  expect(plan.limits.requests_per_case).toBe(20);
  expect(plan.network_retries).toBe(0);
  expect(plan.versions.files_sha256['fixtures/evals/pipeline-v1/holdout.json']).toBe(
    '0c72c3353f3aa2b8bdd0a57f57f03ad60a68d469cfa092c9e543010397a4b92d',
  );
});

it('LIVE holdout authorization is separate and denied before approval-file creation or transport', async () => {
  const directory = temp();
  const plan = executionPlan(ids, selection);
  const env = { FLOWLENS_EVAL_LIVE_APPROVED: '1', MODEL_API_KEY: 'invalid-offline-key' };
  expect(() =>
    authorizeLive(plan, { executeLive: true, approvalId: 'holdout-offline-test', directory, env }),
  ).toThrow('EXPLICIT_HOLDOUT_LIVE_APPROVAL_REQUIRED');
  expect(readdirSync(directory)).toEqual([]);
  vi.stubEnv('FLOWLENS_EVAL_LIVE_APPROVED', '1');
  vi.stubEnv('FLOWLENS_EVAL_HOLDOUT_APPROVED', '0');
  const network = vi.fn(() => {
    throw new Error('NETWORK_FORBIDDEN');
  });
  vi.stubGlobal('fetch', network);
  await expect(
    controlledRun({
      ids,
      ...selection,
      executeLive: true,
      approvalId: 'holdout-offline-test',
      directory,
    }),
  ).rejects.toThrow('EXPLICIT_HOLDOUT_LIVE_APPROVAL_REQUIRED');
  expect(network).not.toHaveBeenCalled();
  expect(readdirSync(directory)).toEqual([]);
});

it('direct evaluation cannot bypass the holdout opt-in or its LIVE authorization', async () => {
  const directory = temp();
  const gatewayFactory = vi.fn(() => {
    throw new Error('GATEWAY_MUST_NOT_BE_CREATED');
  });
  await expect(
    runEvaluation({
      split: 'holdout',
      caseIds: ['H01'],
      directory,
      gatewayFactory,
      execution: { mode: 'SIMULATED_LIVE' },
    }),
  ).rejects.toThrow('EXPLICIT_HOLDOUT_OPT_IN_REQUIRED');
  vi.stubEnv('FLOWLENS_EVAL_LIVE_APPROVED', '1');
  vi.stubEnv('FLOWLENS_EVAL_HOLDOUT_APPROVED', '0');
  await expect(
    runEvaluation({
      split: 'holdout',
      caseIds: ['H01'],
      directory,
      gatewayFactory,
      execution: {
        mode: 'LIVE',
        executeLive: true,
        approvalId: 'offline-test',
        allowHoldout: true,
      },
    }),
  ).rejects.toThrow('EXPLICIT_HOLDOUT_LIVE_APPROVAL_REQUIRED');
  expect(gatewayFactory).not.toHaveBeenCalled();
  expect(readdirSync(directory)).toEqual([]);
});

it('CLI holdout selection remains plan-only without an execution mode and rejects incomplete opt-ins', () => {
  const run = (args: string[]) =>
    spawnSync(
      process.execPath,
      ['--import', 'tsx', join(root, 'scripts/eval-pipeline-controlled.mjs'), ...args],
      {
        cwd: join(root, 'apps/server'),
        encoding: 'utf8',
        env: {
          ...process.env,
          MODEL_API_KEY: '',
          FLOWLENS_EVAL_LIVE_APPROVED: '0',
          FLOWLENS_EVAL_HOLDOUT_APPROVED: '0',
        },
      },
    );
  const args = [
    '--cases=H01,H02,H03',
    '--split=holdout',
    '--allow-holdout',
    '--profile=effect',
    '--prompt-variant=grounded-actions-v1',
  ];
  const planned = run(args);
  expect(planned.status).toBe(0);
  expect(JSON.parse(planned.stdout).mode).toBe('PLAN_ONLY');
  expect(JSON.parse(planned.stdout).plan.cases).toEqual(ids);
  expect(run(args.filter((a) => a !== '--allow-holdout')).stderr).toContain(
    'EXPLICIT_HOLDOUT_OPT_IN_REQUIRED',
  );
  expect(run([...args, '--split=dev']).stderr).toContain('DUPLICATE_ARGUMENT');
  expect(run([...args, '--execute-live', '--approval-id=offline-test']).stderr).toContain(
    'EXPLICIT_EVAL_LIVE_APPROVAL_REQUIRED',
  );
});

it('offline holdout protocol uses separate real databases and MCP without exposing expected labels or changing frozen files', async () => {
  const directory = temp(),
    sentinel = join(directory, 'existing.sqlite');
  writeFileSync(sentinel, 'DO NOT TOUCH');
  vi.stubEnv('APP_DB_PATH', sentinel);
  const network = vi.fn(() => {
    throw new Error('NETWORK_FORBIDDEN');
  });
  vi.stubGlobal('fetch', network);
  const frozen = ['dev.json', 'holdout.json', 'data.json', 'evidence-rubric-v2.json'];
  const before = frozen.map((p) => sha(readFileSync(join(root, 'fixtures/evals/pipeline-v1', p))));
  const report = await controlledRun({ ids, ...selection, simulate: true, directory });
  expect(report.status).toBe('CHECKS_PASSED');
  expect(report.mode).toBe('SIMULATED_LIVE');
  expect(report.holdout_agent_runs).toBe(0);
  expect(report.simulated_holdout_agent_runs).toBe(3);
  expect(report.actual_live_api_attempts).toBe(0);
  expect(report.prompt_hashes).toEqual([report.plan.prompt_sha256]);
  expect(
    new Set(report.cases.map((c: { database_directory: string }) => c.database_directory)).size,
  ).toBe(3);
  for (const c of report.cases) {
    expect(c.split).toBe('holdout');
    expect(c.execution.status).toBe('FAILED');
    expect(c.metrics.input_unchanged).toBe(true);
    expect(c.metrics.no_target_writes).toBe(true);
    expect(c.candidate_validation.fixed.passed).toBe(true);
    expect(c.candidate_validation.holdout.passed).toBe(true);
    expect(c.candidate_validation.robustness.passed).toBe(true);
    expect(c.metrics.diagnosis_correct).toBeNull();
    expect(existsSync(c.raw_report)).toBe(true);
  }
  for (const record of report.records) {
    const wire = JSON.stringify(record.request.messages);
    for (const c of loadSuite('holdout')) expect(wire).not.toContain(c.expected.cause);
    const initial = JSON.parse(
      record.request.messages.find((m: { role: string }) => m.role === 'user').content,
    );
    expect(initial).not.toHaveProperty('expected');
    expect(initial).not.toHaveProperty('case_id');
  }
  expect(readFileSync(sentinel, 'utf8')).toBe('DO NOT TOUCH');
  expect(frozen.map((p) => sha(readFileSync(join(root, 'fixtures/evals/pipeline-v1', p))))).toEqual(
    before,
  );
  expect(network).not.toHaveBeenCalled();
}, 45000);

it('holdout keeps global-budget failure records and never starts an unselected case', async () => {
  const report = await controlledRun({
    ids: ['H01', 'H02'],
    ...selection,
    simulate: true,
    directory: temp(),
    limits: { requests_total: 1 },
  });
  expect(report.requests.total).toBe(1);
  expect(report.cases.map((c: { id: string }) => c.id)).toEqual(['H01', 'H02']);
  expect(report.cases[1].status).toBe('NOT_RUN');
  expect(report.cases[1].reason).toBe('EVAL_GLOBAL_REQUEST_LIMIT');
  expect(report.simulated_holdout_agent_runs).toBe(1);
  expect(report.holdout_agent_runs).toBe(0);
  expect(existsSync(report.cases[0].raw_report)).toBe(true);
}, 15000);
