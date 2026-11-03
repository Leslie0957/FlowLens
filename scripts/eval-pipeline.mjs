import { loadSuite, runEvaluation, evidenceGroups, scoringRubric } from './pipeline-eval-core.mjs';

const args = process.argv.slice(2);
// Deliberately no LIVE implementation in phase 1: neither env files nor model
// credentials are loaded. Explicit LIVE approval needs a separate reviewed run.
for (const arg of args) {
  if (
    !['--mock', '--controlled', '--plan'].includes(arg) &&
    !/^--split=(dev|holdout|all)$/.test(arg)
  )
    throw new Error('UNSUPPORTED_ARGUMENT_NO_LIVE_ALLOWED: ' + arg);
}
if (args.includes('--mock') && args.includes('--controlled')) throw new Error('SELECT_ONE_POLICY');
if (args.includes('--plan') && (args.includes('--mock') || args.includes('--controlled')))
  throw new Error('PLAN_CANNOT_EXECUTE');
const split = args.find((a) => a.startsWith('--split='))?.slice(8) ?? 'dev';
if (!args.includes('--mock') && !args.includes('--controlled')) {
  console.log(
    JSON.stringify(
      {
        mode: 'PLAN_ONLY',
        split,
        scoring_version: scoringRubric.version,
        cases: loadSuite(split).map((c) => ({
          ...c,
          necessary_evidence: evidenceGroups(c),
          legacy_v1_evidence_groups: c.expected.evidence_groups,
        })),
        live_supported: false,
      },
      null,
      2,
    ),
  );
} else {
  const report = await runEvaluation({
    split,
    policy: args.includes('--controlled') ? 'controlled' : 'builtin',
  });
  console.log(
    JSON.stringify(
      {
        status: report.status,
        directory: report.run_directory,
        database: report.database_directory,
        summary: report.summary,
        failures: report.cases
          .filter((c) => c.status !== 'CHECKS_PASSED')
          .map((c) => ({ id: c.id, failures: c.failures })),
      },
      null,
      2,
    ),
  );
  if (report.status !== 'CHECKS_PASSED') process.exitCode = 1;
}
