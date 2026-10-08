import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { openDatabase, migrate } from '../apps/server/dist/db.js';
import { PipelineService } from '../apps/server/dist/pipeline.js';
import { PipelineAgent } from '../apps/server/dist/pipeline-agent.js';
if (!process.argv.includes('--execute-live') || !process.argv.includes('--approve-test-candidate'))
  throw new Error('EXPLICIT_LIVE_FLAGS_REQUIRED');
if (!process.env.MODEL_API_KEY || process.env.FLOWLENS_LIVE_APPROVED !== '1')
  throw new Error('LIVE_NOT_CONFIGURED');
// Process-local test budget, never alter .env.local or its standing authorization.
const configured = process.env.FLOWLENS_LIVE_MAX_REQUESTS;
const evalCap = Number(process.env.FLOWLENS_PIPELINE_EVAL_LIVE_MAX_REQUESTS ?? 8);
if (!Number.isSafeInteger(evalCap) || evalCap < 1) throw new Error('INVALID_EVAL_BUDGET');
process.env.FLOWLENS_LIVE_MAX_REQUESTS = String(
  configured === 'unlimited' ? evalCap : Math.min(evalCap, Number(configured ?? 0)),
);
const directory = resolve('logs/pipeline/live-' + new Date().toISOString().replace(/[:.]/g, '-'));
mkdirSync(directory, { recursive: true });
const report = {
  at: new Date().toISOString(),
  mode: 'LIVE',
  request_cap: Number(process.env.FLOWLENS_LIVE_MAX_REQUESTS),
  isolated_synthetic_db: true,
  approval: 'script test approval in isolated DB; not a human UI acceptance',
  database: join(directory, 'app.sqlite'),
  cases: [],
};
const db = openDatabase(report.database);
migrate(db);
const pipeline = new PipelineService(db, join(directory, 'projects')),
  agent = new PipelineAgent(pipeline);
try {
  for (const template of ['A', 'B']) {
    const item = { template };
    report.cases.push(item);
    try {
      const project = pipeline.create(template, 'create-' + template);
      item.project_id = project.id;
      const failure = await pipeline.waitFor(pipeline.start(project.id, 'failure-' + template).id);
      item.initial = {
        status: failure.status,
        error_code: failure.error_code,
        failed_step: failure.failed_step,
        exit_code: failure.exit_code,
      };
      const started = Date.now();
      const repair = await agent.waitFor(
        agent.create(
          project.id,
          failure.id,
          'diagnose-' + template,
          'LIVE',
          process.env.MODEL_NAME ?? 'deepseek-flash',
        ).id,
      );
      item.model = {
        status: repair.status,
        provider_mode: repair.provider_mode,
        model: repair.model,
        requests: repair.model_requests,
        elapsed_ms: Date.now() - started,
        diagnosis_limits: repair.diagnosis_limits,
        usage: repair.usage,
        error_code: repair.error_code,
        tools: repair.tools.map((t) => ({
          request: t.request,
          call_id: t.call_id,
          name: t.name,
          status: t.status,
          error_code: t.error_code,
        })),
        evidence: repair.evidence,
        response_checks: repair.response_checks,
        model_turns: repair.model_turns,
        diagnosis: repair.diagnosis,
        diff: repair.candidate?.diff,
      };
      if (repair.status === 'PENDING_APPROVAL') {
        agent.decide(project.id, repair.id, 'approve', 'approve-' + template);
        const verified = await agent.waitFor(repair.id);
        item.verification = {
          status: verified.status,
          execution: verified.verification_execution_id
            ? pipeline.execution(verified.verification_execution_id)
            : null,
        };
        if (verified.status === 'VERIFIED') {
          const precheck = await pipeline.waitFor(
            pipeline.start(project.id, 'precheck-' + template).id,
          );
          item.commit = pipeline.commit(project.id, precheck.id, 'commit-' + template);
          item.query = await pipeline.query(project.id, {
            scope: 'target',
            sql: 'SELECT COUNT(*) AS n FROM mining_results',
          });
          const batch = pipeline.snapshot(project.id).batches[0];
          if (batch) item.restore = pipeline.restore(project.id, batch.id, 'restore-' + template);
          item.after = pipeline.snapshot(project.id).target;
        }
      }
      writeFileSync(
        join(directory, 'case-' + template + '.json'),
        JSON.stringify(pipeline.snapshot(project.id), null, 2),
      );
    } catch (e) {
      item.error_code = e.code ?? e.message;
    }
  }
} finally {
  await pipeline.stopAll();
  await agent.stopAll();
  db.close();
  writeFileSync(join(directory, 'report.json'), JSON.stringify(report, null, 2));
  console.log(
    JSON.stringify(
      {
        report: join(directory, 'report.json'),
        cases: report.cases.map((c) => ({
          template: c.template,
          initial: c.initial,
          model: c.model,
          verification_status: c.verification?.status,
          commit: c.commit,
          restore: c.restore,
          error: c.error_code,
        })),
      },
      null,
      2,
    ),
  );
}
if (
  report.cases.some(
    (c) =>
      c.verification?.status !== 'VERIFIED' ||
      c.commit?.status !== 'SUCCEEDED' ||
      c.restore?.status !== 'SUCCEEDED',
  )
)
  process.exitCode = 1;
