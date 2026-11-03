import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  executionPlan,
  authorizeLive,
  controlledRun,
  completionStream,
} from '../../../scripts/pipeline-controlled-run.mjs';
import {
  evaluationGateway,
  checkedLimits,
  FIRST_LIMITS,
  EFFECT_LIMITS,
  requestLedger,
  fail,
} from '../../../scripts/pipeline-eval-gateway.mjs';
import { validateCandidate, root } from '../../../scripts/pipeline-eval-core.mjs';
import { robustnessDatasets, validateRobustness } from '../../../scripts/pipeline-robustness.mjs';
import { deepSeekGateway } from '../src/model-gateway.js';
import { pipelineTools } from '../src/pipeline-tools.js';

const temp = () => mkdtempSync(join(tmpdir(), 'flowlens-controlled-test-'));
const sql =
  'SELECT dat, start_us AS st, end_us AS et, car_series FROM raw_vehicle_events WHERE speed_mps < 1 AND end_us - start_us >= 3000000;';
const completion = { text: '{}', calls: [], finishReason: 'stop' };
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

it('robustness uses independent classes to reject narrowing, truncation, omission, extra selection and wrong output while accepting equivalent SQL', () => {
  expect(
    robustnessDatasets().map((d: { expected_ids: number[] }) => d.expected_ids.length),
  ).toEqual([32, 32, 0, 1, 5]);
  for (const good of [
    sql,
    sql.replace(';', ' ORDER BY event_id DESC;'),
    sql.replace(
      'speed_mps < 1 AND end_us - start_us >= 3000000',
      'end_us - start_us >= 3000000 AND speed_mps < 1',
    ),
  ])
    expect(validateRobustness(good, validateCandidate).passed).toBe(true);
  for (const bad of [
    sql.replace('< 1', '< 0.9995'),
    sql.replace(';', ' LIMIT 4;'),
    sql.replace('< 1', '<= 1'),
    sql.replace('>= 3000000', '> 3000000'),
    sql.replace('>= 3000000', '>= 3'),
    sql.replace(' AND end_us - start_us >= 3000000', ''),
    sql.replace(' AND ', ' OR '),
    sql.replace(';', ' AND end_us - start_us < 9000000;'),
    sql.replace('start_us AS st', 'start_us + 1 AS st'),
  ])
    expect(validateRobustness(bad, validateCandidate).passed).toBe(false);
});

it('plans require explicit unique development IDs and bounded positive settings', () => {
  for (const ids of [undefined, [], ['D01', 'D01'], ['H01'], ['all'], ['G01'], ['D99']])
    expect(() => executionPlan(ids)).toThrow();
  expect(() => executionPlan(['D01'], { limits: { requests_total: 25 } })).toThrow('INVALID_LIMIT');
  expect(() => checkedLimits({ request_ms: 0 })).toThrow('INVALID_LIMIT');
  expect(executionPlan(['D01', 'D02', 'D04', 'D07']).cost.output_token_config_ceiling).toBe(24576);
});

it('effect profile is explicit, preserves the first-run limits and still rejects excessive or malformed ceilings', () => {
  expect(checkedLimits()).toEqual(FIRST_LIMITS);
  expect(FIRST_LIMITS.requests_per_case).toBe(6);
  expect(executionPlan(['D07']).limit_profile).toBe('first');
  const plan = executionPlan(['D07'], { profile: 'effect' });
  expect(plan.limit_profile).toBe('effect');
  expect(plan.limits).toEqual(EFFECT_LIMITS);
  expect(plan.cost.output_token_config_ceiling).toBe(40960);
  expect(plan.network_retries).toBe(0);
  expect(plan.holdout_agent_runs).toBe(0);
  expect(() => checkedLimits({}, 'unlimited')).toThrow('INVALID_LIMIT_PROFILE');
  expect(() => checkedLimits({ requests_per_case: 21 }, 'effect')).toThrow('INVALID_LIMIT');
  expect(() => checkedLimits({ output_tokens: 4096 }, 'effect')).toThrow('INVALID_LIMIT');
  const ledger = requestLedger(['D07'], checkedLimits({}, 'effect'));
  for (let i = 0; i < 20; i++) ledger.reserve('D07');
  expect(() => ledger.reserve('D07')).toThrow('EVAL_CASE_REQUEST_LIMIT');
});

it('old standing authorization is insufficient and an explicit approval ID cannot be reused', () => {
  const plan = executionPlan(['D01']);
  const directory = temp();
  const env = {
    MODEL_API_KEY: 'invalid-test-secret',
    FLOWLENS_LIVE_APPROVED: '1',
    FLOWLENS_LIVE_MAX_REQUESTS: 'unlimited',
  };
  expect(() =>
    authorizeLive(plan, { executeLive: true, approvalId: 'test-one', directory, env }),
  ).toThrow('EXPLICIT_EVAL_LIVE_APPROVAL_REQUIRED');
  const approved = { ...env, FLOWLENS_EVAL_LIVE_APPROVED: '1' };
  expect(() =>
    authorizeLive(plan, { executeLive: false, approvalId: 'test-one', directory, env: approved }),
  ).toThrow();
  authorizeLive(plan, { executeLive: true, approvalId: 'test-one', directory, env: approved });
  expect(() =>
    authorizeLive(plan, { executeLive: true, approvalId: 'test-one', directory, env: approved }),
  ).toThrow('APPROVAL_ALREADY_USED');
  expect(readFileSync(join(directory, 'approval-test-one.json'), 'utf8')).not.toContain(
    env.MODEL_API_KEY,
  );
});

it('CLI defaults to plan and refuses a real run without the new authorization switch', () => {
  const run = (args: string[]) =>
    spawnSync(
      process.execPath,
      ['--import', 'tsx', join(root, 'scripts/eval-pipeline-controlled.mjs'), ...args],
      {
        cwd: join(root, 'apps/server'),
        encoding: 'utf8',
        timeout: 10000,
        env: {
          PATH: process.env.PATH,
          SystemRoot: process.env.SystemRoot,
          MODEL_API_KEY: 'invalid-test-secret',
          FLOWLENS_LIVE_APPROVED: '1',
          FLOWLENS_LIVE_MAX_REQUESTS: 'unlimited',
        },
      },
    );
  const plan = run(['--cases=D01']);
  expect(plan.status).toBe(0);
  expect(JSON.parse(plan.stdout).mode).toBe('PLAN_ONLY');
  const effect = run(['--cases=D07', '--profile=effect']);
  expect(effect.status).toBe(0);
  expect(JSON.parse(effect.stdout).plan.limits.requests_per_case).toBe(20);
  expect(JSON.parse(effect.stdout).plan.limits.output_tokens).toBe(2048);
  expect(run(['--cases=D07', '--profile=unknown']).stderr).toContain('INVALID_LIMIT_PROFILE');
  const refused = run(['--cases=D01', '--execute-live', '--approval-id=test-refused']);
  expect(refused.status).toBe(1);
  expect(refused.stderr).toContain('EXPLICIT_EVAL_LIVE_APPROVAL_REQUIRED');
  expect(run(['--cases=H01', '--simulate']).stderr).toContain('ONLY_EXPLICIT_DEV_CASES_ALLOWED');
});

it('six genuine observations can be followed by a seventh final answer under effect without changing Prompt or scoring', async () => {
  const network = vi.fn(() => {
    throw new Error('REAL_NETWORK_FORBIDDEN');
  });
  vi.stubGlobal('fetch', network);
  const factory = () => async (_url: string, options: { body: string }) => {
    const { messages } = JSON.parse(options.body);
    const results = messages
      .filter((m: { role: string }) => m.role === 'tool')
      .map((m: { content: string }) => JSON.parse(m.content));
    const names = [
      'get_sql',
      'get_schema',
      'get_logs',
      'get_execution',
      'get_task_contract',
      'get_output_preview',
    ];
    if (results.length < names.length)
      return completionStream({
        text: '',
        finishReason: 'tool_calls',
        calls: [{ id: 'offline-' + results.length, name: names[results.length], arguments: {} }],
      });
    const initial = JSON.parse(messages.find((m: { role: string }) => m.role === 'user').content);
    return completionStream({
      text: JSON.stringify({
        diagnosis: '离线协议测试：已观察到业务键冲突，缺少目标来源信息，需要人工处理。',
        failed_step: initial.failure.failed_step,
        action: 'MANUAL_REQUIRED',
        candidate: null,
        evidence_ids: [
          initial.failure.evidence_id,
          ...results.flatMap((r: { evidence_ids: string[] }) => r.evidence_ids),
        ],
      }),
      calls: [],
      finishReason: 'stop',
    });
  };
  const first = await controlledRun({
    ids: ['D07'],
    simulate: true,
    directory: temp(),
    profile: 'first',
    transportFactory: factory,
  });
  const effect = await controlledRun({
    ids: ['D07'],
    simulate: true,
    directory: temp(),
    profile: 'effect',
    transportFactory: factory,
  });
  expect(first.requests.total).toBe(6);
  expect(first.cases[0].diagnosis.error_code).toBe('MODEL_REQUEST_LIMIT');
  expect(effect.requests.total).toBe(7);
  expect(effect.status).toBe('CHECKS_PASSED');
  expect(effect.cases[0].diagnosis.action).toBe('MANUAL_REQUIRED');
  expect(effect.cases[0].diagnosis.diagnosis_limits.max_stall_rounds).toBe(3);
  expect(effect.cases[0].candidate_sql).toBeNull();
  expect(effect.cases[0].metrics.no_target_writes).toBe(true);
  expect(effect.prompt_hashes).toEqual(first.prompt_hashes);
  expect(effect.plan.scoring_version).toBe(first.plan.scoring_version);
  expect(effect.actual_live_api_attempts).toBe(0);
  expect(
    effect.records.every((r: { request: { max_tokens: number } }) => r.request.max_tokens === 2048),
  ).toBe(true);
  expect(network).not.toHaveBeenCalled();
}, 30000);

it('effect still stops repeated unchanged observations before reaching the larger request cap', async () => {
  let calls = 0;
  const report = await controlledRun({
    ids: ['D07'],
    simulate: true,
    directory: temp(),
    profile: 'effect',
    transportFactory: () => async () =>
      completionStream({
        text: '',
        finishReason: 'tool_calls',
        calls: [{ id: 'repeated-offline-' + ++calls, name: 'get_sql', arguments: {} }],
      }),
  });
  expect(report.cases[0].diagnosis.error_code).toBe('REPAIR_NO_PROGRESS');
  expect(report.requests.total).toBe(4);
  expect(report.requests.total).toBeLessThan(20);
  expect(report.cases[0].candidate_sql).toBeNull();
  expect(report.cases[0].metrics.no_target_writes).toBe(true);
  expect(report.actual_live_api_attempts).toBe(0);
}, 15000);

it('single-case and global request ceilings count failures and cannot be reset by selecting another case', () => {
  const one = requestLedger(
    ['D01', 'D02'],
    checkedLimits({ requests_per_case: 1, requests_total: 2 }),
  );
  one.reserve('D01');
  expect(() => one.reserve('D01')).toThrow('EVAL_CASE_REQUEST_LIMIT');
  one.reserve('D02');
  expect(() => one.reserve('D02')).toThrow('EVAL_GLOBAL_REQUEST_LIMIT');
  expect(one.snapshot()).toEqual({ total: 2, per_case: { D01: 1, D02: 1 } });
});

it('evaluation wire body matches production gateway, uses the explicit 1024 cap and captures provider metadata without credentials', async () => {
  vi.stubEnv('MODEL_MAX_OUTPUT_TOKENS', '2048');
  const messages = [{ role: 'system', content: 'synthetic evaluation protocol test' }];
  let productionBody;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url, options) => {
      productionBody = JSON.parse(options.body);
      return completionStream(completion);
    }),
  );
  await deepSeekGateway({
    apiKey: 'invalid-test-secret',
    model: 'deepseek-flash',
    baseUrl: 'https://api.deepseek.com',
    maxOutputTokens: 1024,
    tools: pipelineTools,
    jsonMode: false,
  }).complete(messages, new AbortController().signal);
  let evaluationBody;
  const records: Record<string, unknown>[] = [];
  const directory = temp();
  const limits = checkedLimits();
  const gateway = evaluationGateway({
    model: 'deepseek-flash',
    apiKey: 'invalid-test-secret',
    caseId: 'D01',
    limits,
    ledger: requestLedger(['D01'], limits),
    directory,
    records,
    transport: async (_url: string, options: { body: string }) => {
      evaluationBody = JSON.parse(options.body);
      const response = completionStream(completion, {
        id: 'response-fixture',
        model: 'reported-alias',
        usage: { prompt_tokens: 10, completion_tokens: 2, prompt_cache_hit_tokens: 4 },
      });
      response.headers.set('x-request-id', 'request-fixture');
      return response;
    },
  });
  await gateway.complete(messages, new AbortController().signal);
  expect(evaluationBody).toEqual(productionBody);
  expect(records[0].requested_model).toBe('deepseek-flash');
  expect(records[0].model_reported).toBe('reported-alias');
  expect(records[0].model_revision).toBeNull();
  expect(records[0].provider_request_id).toBe('request-fixture');
  expect(JSON.stringify(records)).not.toContain('invalid-test-secret');
});

it('HTTP failures are not retried and missing usage remains unknown', async () => {
  const limits = checkedLimits(),
    records: Record<string, unknown>[] = [],
    transport = vi.fn(async () => new Response('not logged', { status: 429 }));
  const ledger = requestLedger(['D01'], limits);
  const gateway = evaluationGateway({
    model: 'stub',
    apiKey: 'invalid-key',
    caseId: 'D01',
    limits,
    ledger,
    directory: temp(),
    records,
    transport,
  });
  await expect(gateway.complete([], new AbortController().signal)).rejects.toThrow(
    'MODEL_RATE_LIMIT',
  );
  expect(transport).toHaveBeenCalledTimes(1);
  expect(ledger.snapshot().total).toBe(1);
  expect(records[0].usage).toBeNull();
  expect(records[0].usage_status).toBe('UNKNOWN_POSSIBLY_BILLED');
});

it('request deadline stops even an uncooperative transport and partial SSE is retained on timeout', async () => {
  for (const partial of [false, true]) {
    const limits = checkedLimits({ request_ms: 20 }),
      directory = temp(),
      records: Record<string, unknown>[] = [];
    const transport = partial
      ? async () =>
          new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(
                  new TextEncoder().encode(
                    'data: ' +
                      JSON.stringify({
                        id: 'partial-id',
                        choices: [{ delta: { content: 'partial reply' } }],
                      }) +
                      '\n\n',
                  ),
                );
              },
            }),
          )
      : async () => new Promise<Response>(() => {});
    const gateway = evaluationGateway({
      model: 'stub',
      apiKey: 'invalid-key',
      caseId: 'D01',
      limits,
      ledger: requestLedger(['D01'], limits),
      directory,
      records,
      transport,
    });
    await expect(gateway.complete([], new AbortController().signal)).rejects.toThrow(
      'EVAL_REQUEST_TIMEOUT',
    );
    expect(records[0].state).toBe('FAILED');
    if (partial)
      expect(readFileSync(join(directory, 'D01-wire-1.sse'), 'utf8')).toContain('partial reply');
  }
});

it('oversized request bodies are blocked before reserving or dispatching', async () => {
  const limits = checkedLimits({ request_bytes: 1 }),
    ledger = requestLedger(['D01'], limits),
    transport = vi.fn();
  const gateway = evaluationGateway({
    model: 'stub',
    apiKey: 'invalid-key',
    caseId: 'D01',
    limits,
    ledger,
    directory: temp(),
    records: [],
    transport,
  });
  await expect(gateway.complete([], new AbortController().signal)).rejects.toThrow(
    'EVAL_REQUEST_BYTE_LIMIT',
  );
  expect(ledger.snapshot().total).toBe(0);
  expect(transport).not.toHaveBeenCalled();
});

it('offline first-run plan uses four isolated real Agent/MCP contexts, validates candidates and never touches the configured DB', async () => {
  const directory = temp(),
    sentinel = join(directory, 'existing.sqlite');
  writeFileSync(sentinel, 'DO NOT TOUCH');
  vi.stubEnv('APP_DB_PATH', sentinel);
  const network = vi.fn(() => {
    throw new Error('REAL_NETWORK_FORBIDDEN');
  });
  vi.stubGlobal('fetch', network);
  const report = await controlledRun({
    ids: ['D01', 'D02', 'D04', 'D07'],
    simulate: true,
    directory,
  });
  expect(report.status).toBe('CHECKS_PASSED');
  expect(report.actual_live_api_attempts).toBe(0);
  expect(report.requests.total).toBe(16);
  expect(network).not.toHaveBeenCalled();
  expect(
    new Set(report.cases.map((c: { database_directory: string }) => c.database_directory)).size,
  ).toBe(4);
  expect(readFileSync(sentinel, 'utf8')).toBe('DO NOT TOUCH');
  for (const c of report.cases) {
    expect(c.split).toBe('dev');
    expect(c.metrics.no_target_writes).toBe(true);
    expect(existsSync(c.raw_report)).toBe(true);
    if (c.id === 'D07') {
      expect(c.diagnosis.action).toBe('MANUAL_REQUIRED');
      expect(c.candidate_sql).toBeNull();
    } else expect(c.candidate_validation.robustness.passed).toBe(true);
  }
  expect(
    existsSync(join(report.run_directory, 'source-snapshot/scripts/pipeline-controlled-run.mjs')),
  ).toBe(true);
}, 60000);

it('global exhaustion marks remaining cases not run rather than resetting the budget', async () => {
  const report = await controlledRun({
    ids: ['D01', 'D02'],
    simulate: true,
    directory: temp(),
    limits: { requests_total: 1 },
  });
  expect(report.requests.total).toBe(1);
  expect(report.cases[1].status).toBe('NOT_RUN');
  expect(report.cases[1].reason).toBe('EVAL_GLOBAL_REQUEST_LIMIT');
});

it('the Agent single-case step cap stops after one request without an extra provider dispatch', async () => {
  const report = await controlledRun({
    ids: ['D01'],
    simulate: true,
    directory: temp(),
    limits: { requests_per_case: 1 },
  });
  expect(report.requests.total).toBe(1);
  expect(report.cases[0].diagnosis.model_requests).toBe(1);
  expect(report.cases[0].diagnosis.error_code).toBe('MODEL_REQUEST_LIMIT');
  expect(report.cases[0].diagnosis.diagnosis_limits.max_tool_calls).toBe(8);
  expect(report.actual_live_api_attempts).toBe(0);
});

it('external cancellation preserves the failed execution and stops remaining cases', async () => {
  const controller = new AbortController();
  const report = await controlledRun({
    ids: ['D01', 'D02'],
    simulate: true,
    directory: temp(),
    signal: controller.signal,
    transportFactory: () => async () => {
      controller.abort(fail('EVAL_CANCELLED'));
      return completionStream(completion);
    },
  });
  expect(report.status).toBe('STOPPED');
  expect(report.cases[0].execution.status).toBe('FAILED');
  expect(report.cases[1].status).toBe('NOT_RUN');
  expect(existsSync(report.cases[0].raw_report)).toBe(true);
  expect(report.actual_live_api_attempts).toBe(0);
});

it('case and run timeouts retain records without reaching a provider', async () => {
  for (const [limits, reason] of [
    [{ case_ms: 20 }, 'EVAL_CASE_TIMEOUT'],
    [{ run_ms: 20 }, 'EVAL_RUN_TIMEOUT'],
  ] as const) {
    const report = await controlledRun({ ids: ['D01'], simulate: true, directory: temp(), limits });
    expect(report.cases[0].reason).toBe(reason);
    expect(report.requests.total).toBe(0);
    expect(report.actual_live_api_attempts).toBe(0);
    expect(existsSync(join(report.run_directory, 'report.json'))).toBe(true);
  }
});
