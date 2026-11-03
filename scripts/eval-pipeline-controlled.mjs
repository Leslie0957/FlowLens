import { controlledRun, executionPlan } from './pipeline-controlled-run.mjs';
import { fail } from './pipeline-eval-gateway.mjs';

const options = {};
const seen = new Set();
for (const arg of process.argv.slice(2)) {
  const match = /^--(cases|model|approval-id|profile|prompt-variant|split)=(.+)$/.exec(arg);
  const key = match?.[1] ?? arg;
  if (seen.has(key)) throw fail('DUPLICATE_ARGUMENT');
  seen.add(key);
  if (match) options[match[1]] = match[2];
  else if (['--plan', '--simulate', '--execute-live', '--allow-holdout'].includes(arg))
    options[arg.slice(2)] = true;
  else throw fail('UNKNOWN_ARGUMENT');
}
if ([options.plan, options.simulate, options['execute-live']].filter(Boolean).length > 1)
  throw fail('SELECT_ONE_EXECUTION_MODE');
const ids = options.cases?.split(',');
const model = options.model ?? process.env.MODEL_NAME ?? 'deepseek-flash';
const profile = options.profile ?? 'first';
const promptVariant = options['prompt-variant'] ?? 'baseline';
const split = options.split ?? 'dev';
const allowHoldout = options['allow-holdout'] === true;
if (!options.simulate && !options['execute-live']) {
  console.log(
    JSON.stringify(
      {
        mode: 'PLAN_ONLY',
        plan: executionPlan(ids, { model, profile, promptVariant, split, allowHoldout }),
        required_for_live: [
          'explicit user authorization',
          '--execute-live',
          '--approval-id=<new-id>',
          'FLOWLENS_EVAL_LIVE_APPROVED=1',
          'configured model key',
          ...(split === 'holdout'
            ? ['explicit holdout LIVE authorization', 'FLOWLENS_EVAL_HOLDOUT_APPROVED=1']
            : []),
        ],
      },
      null,
      2,
    ),
  );
} else {
  const controller = new AbortController();
  const cancel = () => controller.abort(fail('EVAL_CANCELLED'));
  process.once('SIGINT', cancel);
  process.once('SIGTERM', cancel);
  try {
    const report = await controlledRun({
      ids,
      model,
      profile,
      promptVariant,
      split,
      allowHoldout,
      simulate: !!options.simulate,
      executeLive: !!options['execute-live'],
      approvalId: options['approval-id'],
      signal: controller.signal,
      onPlan: (plan) => console.log(JSON.stringify({ mode: 'PRE_EXECUTION_PLAN', plan }, null, 2)),
    });
    console.log(
      JSON.stringify(
        {
          mode: report.mode,
          status: report.status,
          directory: report.run_directory,
          requests: report.requests,
          actual_live_api_attempts: report.actual_live_api_attempts,
          cases: report.cases.map((c) => ({
            id: c.id,
            status: c.status,
            reason: c.reason,
            failures: c.failures,
          })),
          usage: report.usage,
        },
        null,
        2,
      ),
    );
    if (report.status !== 'CHECKS_PASSED') process.exitCode = 1;
  } finally {
    process.removeListener('SIGINT', cancel);
    process.removeListener('SIGTERM', cancel);
  }
}
