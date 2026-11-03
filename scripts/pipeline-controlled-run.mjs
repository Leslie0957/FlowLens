import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import {
  runEvaluation,
  loadSuite,
  controlledGateway,
  metadata,
  root,
  scoringRubric,
} from './pipeline-eval-core.mjs';
import { checkedLimits, requestLedger, evaluationGateway, fail } from './pipeline-eval-gateway.mjs';
import { robustnessSpec } from './pipeline-robustness.mjs';
import { promptVariantText, evaluationMessages } from './pipeline-eval-prompts.mjs';
import { pipelineDefaultPrompt } from '../apps/server/src/pipeline-prompts.ts';

const hash = (s) => createHash('sha256').update(s).digest('hex');
let activeLiveRun = false;
export function executionPlan(
  ids,
  {
    model = 'deepseek-flash',
    limits = {},
    profile = 'first',
    promptVariant = 'baseline',
    split = 'dev',
    allowHoldout = false,
  } = {},
) {
  if (
    !Array.isArray(ids) ||
    !ids.length ||
    ids.some((id) => typeof id !== 'string') ||
    new Set(ids).size !== ids.length
  )
    throw fail('EXPLICIT_UNIQUE_CASE_IDS_REQUIRED');
  if (!['dev', 'holdout'].includes(split)) throw fail('INVALID_CONTROLLED_SPLIT');
  if (split === 'holdout' && allowHoldout !== true) throw fail('EXPLICIT_HOLDOUT_OPT_IN_REQUIRED');
  if (split === 'dev' && allowHoldout !== false)
    throw fail('HOLDOUT_OPT_IN_REQUIRES_HOLDOUT_SPLIT');
  const available = loadSuite(split);
  if (ids.some((id) => !available.some((c) => c.id === id)))
    throw fail(
      split === 'dev' ? 'ONLY_EXPLICIT_DEV_CASES_ALLOWED' : 'ONLY_EXPLICIT_HOLDOUT_CASES_ALLOWED',
    );
  if (typeof model !== 'string' || !/^[a-zA-Z0-9._:-]{1,80}$/.test(model))
    throw fail('INVALID_MODEL_ID');
  const effective = checkedLimits(limits, profile);
  const promptText = promptVariantText(promptVariant);
  return {
    schema_version: 2,
    cases: [...ids],
    split,
    allow_holdout: allowHoldout,
    model,
    limit_profile: profile,
    prompt_variant: promptVariant,
    prompt_supplement_sha256: hash(promptText),
    prompt_sha256: hash(
      evaluationMessages([{ role: 'system', content: pipelineDefaultPrompt }], promptVariant)[0]
        .content,
    ),
    limits: effective,
    network_retries: 0,
    holdout_agent_runs: 0,
    holdout_cases_planned: split === 'holdout' ? ids.length : 0,
    scoring_version: scoringRubric.version,
    robustness_version: robustnessSpec.version,
    versions: metadata(),
    approval_scope: 'isolated candidate validation only; no target commit',
    cost: {
      output_token_config_ceiling:
        Math.min(effective.requests_total, ids.length * effective.requests_per_case) *
        effective.output_tokens,
      estimate: null,
      unknown: [
        'input tokens per turn',
        'cache billing and current unit prices',
        'incomplete response usage',
        'provider model revision',
      ],
      note: 'Request/output caps are not an exact monetary cap.',
    },
  };
}

export function authorizeLive(
  plan,
  { executeLive, approvalId, env = process.env, directory } = {},
) {
  if (executeLive !== true || env.FLOWLENS_EVAL_LIVE_APPROVED !== '1')
    throw fail('EXPLICIT_EVAL_LIVE_APPROVAL_REQUIRED');
  if (plan.split === 'holdout' && env.FLOWLENS_EVAL_HOLDOUT_APPROVED !== '1')
    throw fail('EXPLICIT_HOLDOUT_LIVE_APPROVAL_REQUIRED');
  if (!/^[A-Za-z0-9_-]{3,64}$/.test(approvalId ?? '')) throw fail('EXPLICIT_APPROVAL_ID_REQUIRED');
  if (!env.MODEL_API_KEY?.trim()) throw fail('MODEL_NOT_CONFIGURED');
  if (env.MODEL_PROVIDER && env.MODEL_PROVIDER !== 'deepseek') throw fail('INVALID_MODEL_PROVIDER');
  if (env.MODEL_BASE_URL && env.MODEL_BASE_URL.replace(/\/$/, '') !== 'https://api.deepseek.com')
    throw fail('INVALID_MODEL_ENDPOINT');
  mkdirSync(directory, { recursive: true });
  try {
    writeFileSync(
      join(directory, 'approval-' + approvalId + '.json'),
      JSON.stringify(
        {
          approval_id: approvalId,
          plan_sha256: hash(JSON.stringify(plan)),
          at: new Date().toISOString(),
        },
        null,
        2,
      ),
      { flag: 'wx' },
    );
  } catch (e) {
    if (e.code === 'EEXIST') throw fail('APPROVAL_ALREADY_USED');
    throw e;
  }
}

// Deterministic, explicitly labelled offline wire substitute. It sees only
// the same actual messages/tools that a provider would see, not case labels.
export function offlineTransport() {
  const gateway = controlledGateway();
  return async (_url, options) => {
    const response = await gateway.complete(JSON.parse(options.body).messages, options.signal);
    return completionStream(response);
  };
}
export function completionStream(response, metadata = {}) {
  const delta = {
    content: response.text,
    ...(response.calls.length
      ? {
          tool_calls: response.calls.map((c, index) => ({
            index,
            id: c.id,
            type: 'function',
            function: { name: c.name, arguments: JSON.stringify(c.arguments) },
          })),
        }
      : {}),
  };
  return new Response(
    'data: ' +
      JSON.stringify({ ...metadata, choices: [{ delta, finish_reason: response.finishReason }] }) +
      '\n\ndata: [DONE]\n\n',
    { headers: { 'Content-Type': 'text/event-stream' } },
  );
}

export async function controlledRun({
  ids,
  model,
  limits,
  profile = 'first',
  promptVariant = 'baseline',
  split = 'dev',
  allowHoldout = false,
  simulate = false,
  executeLive = false,
  approvalId,
  directory,
  signal,
  transportFactory,
  onPlan = () => {},
} = {}) {
  const plan = executionPlan(ids, { model, limits, profile, promptVariant, split, allowHoldout });
  onPlan(plan); // CLI prints BEFORE authorization, databases or requests.
  if (!simulate && transportFactory) throw fail('TEST_TRANSPORT_REQUIRES_SIMULATION');
  const parent = directory ? resolve(directory) : join(root, 'logs/pipeline/controlled');
  if (!simulate) {
    if (activeLiveRun) throw fail('LIVE_RUN_ALREADY_ACTIVE');
    authorizeLive(plan, { executeLive, approvalId, directory: join(parent, 'authorizations') });
    activeLiveRun = true;
  }
  const savedEnv = {
    approved: process.env.FLOWLENS_LIVE_APPROVED,
    limit: process.env.FLOWLENS_LIVE_MAX_REQUESTS,
  };
  if (!simulate) {
    process.env.FLOWLENS_LIVE_APPROVED = '1';
    process.env.FLOWLENS_LIVE_MAX_REQUESTS = String(plan.limits.requests_total);
  }
  let report, runDir, timer;
  const controller = new AbortController();
  const runDeadline = performance.now() + plan.limits.run_ms;
  const outer = AbortSignal.any([controller.signal, signal].filter(Boolean));
  const ledger = requestLedger(ids, plan.limits);
  try {
    mkdirSync(parent, { recursive: true });
    runDir = mkdtempSync(join(parent, simulate ? 'simulation-' : 'live-'));
    report = {
      mode: simulate ? 'SIMULATED_LIVE' : 'LIVE',
      split,
      plan,
      approval_id: simulate ? null : approvalId,
      started_at: new Date().toISOString(),
      run_directory: runDir,
      records: [],
      cases: ids.map((id) => ({ id, status: 'NOT_RUN' })),
      diagnosis_accuracy: null,
      human_reviewed: 0,
    };
    writeFileSync(join(runDir, 'plan.json'), JSON.stringify(plan, null, 2));
    for (const path of Object.keys(plan.versions.files_sha256)) {
      const target = join(runDir, 'source-snapshot', path);
      mkdirSync(dirname(target), { recursive: true });
      copyFileSync(join(root, path), target);
    }
    const assertVersion = () => {
      for (const [path, sha] of Object.entries(plan.versions.files_sha256))
        if (hash(readFileSync(join(root, path))) !== sha) throw fail('EVAL_SOURCE_CHANGED');
    };
    const save = () => {
      report.requests = ledger.snapshot();
      report.actual_live_api_attempts = simulate
        ? 0
        : report.records.filter((r) => r.dispatched).length;
      writeFileSync(join(runDir, 'report.json'), JSON.stringify(report, null, 2));
    };
    timer = setTimeout(
      () => controller.abort(fail('EVAL_RUN_TIMEOUT')),
      Math.max(0, runDeadline - performance.now()),
    );
    save();
    for (const item of report.cases) {
      if (performance.now() >= runDeadline && !outer.aborted)
        controller.abort(fail('EVAL_RUN_TIMEOUT'));
      if (outer.aborted) {
        item.reason = outer.reason?.code ?? 'EVAL_CANCELLED';
        continue;
      }
      if (ledger.snapshot().total >= plan.limits.requests_total) {
        item.reason = 'EVAL_GLOBAL_REQUEST_LIMIT';
        continue;
      }
      const caseController = new AbortController();
      const caseDeadline = performance.now() + plan.limits.case_ms;
      const caseSignal = AbortSignal.any([outer, caseController.signal]);
      const caseTimer = setTimeout(
        () => caseController.abort(fail('EVAL_CASE_TIMEOUT')),
        plan.limits.case_ms,
      );
      const started = performance.now();
      item.status = 'RUNNING';
      save();
      try {
        assertVersion();
        const caseDir = join(runDir, item.id);
        mkdirSync(caseDir);
        const transport = simulate
          ? (transportFactory?.(item.id) ?? offlineTransport())
          : globalThis.fetch;
        const gateway = evaluationGateway({
          model: plan.model,
          apiKey: simulate ? 'offline-not-a-key' : process.env.MODEL_API_KEY,
          caseId: item.id,
          limits: plan.limits,
          ledger,
          directory: caseDir,
          signal: caseSignal,
          simulated: simulate,
          records: report.records,
          transport,
          beforeDispatch: assertVersion,
          runDeadline,
          caseDeadline,
        });
        const sub = await runEvaluation({
          split,
          caseIds: [item.id],
          includeProbe: false,
          directory: caseDir,
          gatewayFactory: () => gateway,
          execution: {
            mode: report.mode,
            promptVariant,
            model: plan.model,
            executeLive,
            approvalId,
            allowHoldout,
            signal: caseSignal,
            getDispatchCount: () =>
              report.records.filter((r) => r.case_id === item.id && r.dispatched).length,
            agentLimits: {
              max_requests: plan.limits.requests_per_case,
              max_tool_calls: plan.limits.tools_per_case,
              timeout_ms: plan.limits.case_ms,
              max_context_bytes: plan.limits.context_bytes,
              max_stall_rounds: 3,
            },
          },
        });
        Object.assign(item, sub.cases[0]);
        item.raw_report = join(sub.run_directory, 'report.json');
        item.database_directory = sub.database_directory;
        if (caseSignal.aborted) {
          item.status = 'STOPPED';
          item.reason = caseSignal.reason?.code ?? 'EVAL_CANCELLED';
        }
      } catch (error) {
        item.status = 'EXECUTION_FAILED';
        item.reason = error.code ?? error.message;
      } finally {
        clearTimeout(caseTimer);
        item.elapsed_ms = performance.now() - started;
        save();
      }
      // Abort the batch on infrastructure/auth/protocol/isolation failures. A
      // genuine diagnosed business failure stays in the report and may continue.
      const stopCodes = new Set([
        'MODEL_AUTH_ERROR',
        'MODEL_REQUEST_ERROR',
        'MODEL_RATE_LIMIT',
        'MODEL_UNAVAILABLE',
        'MODEL_NETWORK_ERROR',
        'PROTOCOL_ERROR',
        'INTERNAL_ERROR',
        'EVAL_SOURCE_CHANGED',
        'EVAL_REQUEST_BYTE_LIMIT',
        'EVAL_RESPONSE_BYTE_LIMIT',
        'EVAL_REQUEST_TIMEOUT',
        'EVAL_GLOBAL_REQUEST_LIMIT',
        'LIVE_REQUEST_BUDGET_EXCEEDED',
        'LIVE_NOT_APPROVED',
        'MODEL_NOT_CONFIGURED',
      ]);
      const infrastructure = item.diagnosis?.error_code ?? item.reason;
      if (
        stopCodes.has(infrastructure) ||
        item.metrics?.no_target_writes === false ||
        item.metrics?.input_unchanged === false
      )
        controller.abort(fail(infrastructure ?? 'EVAL_ISOLATION_FAILED'));
    }
    report.status = outer.aborted
      ? 'STOPPED'
      : report.cases.every((c) => c.status === 'CHECKS_PASSED')
        ? 'CHECKS_PASSED'
        : 'CHECKS_FAILED';
    return report;
  } catch (error) {
    if (!report) throw error;
    report.status = 'EXECUTION_FAILED';
    report.error = { code: error.code ?? 'EVAL_EXECUTOR_ERROR', message: error.message };
    for (const item of report.cases) if (item.status === 'NOT_RUN') item.reason = report.error.code;
    return report;
  } finally {
    clearTimeout(timer);
    if (!simulate) {
      if (savedEnv.approved === undefined) delete process.env.FLOWLENS_LIVE_APPROVED;
      else process.env.FLOWLENS_LIVE_APPROVED = savedEnv.approved;
      if (savedEnv.limit === undefined) delete process.env.FLOWLENS_LIVE_MAX_REQUESTS;
      else process.env.FLOWLENS_LIVE_MAX_REQUESTS = savedEnv.limit;
      activeLiveRun = false;
    }
    if (report) {
      report.finished_at = new Date().toISOString();
      report.stop_reason = outer.aborted ? (outer.reason?.code ?? 'EVAL_CANCELLED') : null;
      report.requests = ledger.snapshot();
      report.actual_live_api_attempts = simulate
        ? 0
        : report.records.filter((r) => r.dispatched).length;
      const dispatchedCases = new Set(
        report.records.filter((r) => r.dispatched).map((r) => r.case_id),
      );
      report.holdout_agent_runs = !simulate && split === 'holdout' ? dispatchedCases.size : 0;
      report.simulated_holdout_agent_runs =
        simulate && split === 'holdout' ? dispatchedCases.size : 0;
      report.usage = {
        reported_totals: report.records.reduce(
          (sum, r) => ({
            prompt_tokens:
              sum.prompt_tokens +
              (Number.isSafeInteger(r.usage?.prompt_tokens) && r.usage.prompt_tokens >= 0
                ? r.usage.prompt_tokens
                : 0),
            completion_tokens:
              sum.completion_tokens +
              (Number.isSafeInteger(r.usage?.completion_tokens) && r.usage.completion_tokens >= 0
                ? r.usage.completion_tokens
                : 0),
          }),
          { prompt_tokens: 0, completion_tokens: 0 },
        ),
        unknown_requests: report.records.filter(
          (r) =>
            !Number.isSafeInteger(r.usage?.prompt_tokens) ||
            r.usage.prompt_tokens < 0 ||
            !Number.isSafeInteger(r.usage?.completion_tokens) ||
            r.usage.completion_tokens < 0,
        ).length,
        cost: null,
        note: simulate
          ? 'Simulation, not billing or real model accuracy.'
          : 'Reported subtotal only; unknown usage may still be billed.',
      };
      report.status ??= 'EXECUTION_FAILED';
      report.prompt_hashes = [...new Set(report.records.map((r) => r.prompt_sha256))];
      const content = JSON.stringify(report, null, 2);
      writeFileSync(join(runDir, 'report.json'), content);
      writeFileSync(
        join(runDir, 'review.json'),
        JSON.stringify(
          {
            report_sha256: hash(content),
            mode: report.mode,
            cases: report.cases.map((c) => ({
              id: c.id,
              diagnosis_correct: null,
              evidence_sufficient: null,
              prohibited_claims: null,
              reviewer: null,
              reason: null,
            })),
          },
          null,
          2,
        ),
      );
    }
  }
}
