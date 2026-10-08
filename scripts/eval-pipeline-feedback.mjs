import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';
import { openDatabase, migrate } from '../apps/server/dist/db.js';
import { PipelineService } from '../apps/server/dist/pipeline.js';
import { PipelineAgent, pipelineTools } from '../apps/server/dist/pipeline-agent.js';
import { deepSeekGateway } from '../apps/server/dist/model-gateway.js';

if (!process.argv.includes('--execute-live') || !process.argv.includes('--approve-test-candidate'))
  throw new Error('EXPLICIT_LIVE_FLAGS_REQUIRED');
if (!process.env.MODEL_API_KEY || process.env.FLOWLENS_LIVE_APPROVED !== '1')
  throw new Error('LIVE_NOT_CONFIGURED');
const standing = process.env.FLOWLENS_LIVE_MAX_REQUESTS;
const requested = Number(process.env.FLOWLENS_PIPELINE_EVAL_LIVE_MAX_REQUESTS ?? 8);
if (!Number.isSafeInteger(requested) || requested < 1) throw new Error('INVALID_EVAL_BUDGET');
const cap = standing === 'unlimited' ? requested : Math.min(requested, Number(standing ?? 0));
if (!Number.isSafeInteger(cap) || cap < 1) throw new Error('LIVE_BUDGET_UNAVAILABLE');
process.env.FLOWLENS_LIVE_MAX_REQUESTS = String(cap);
const directory = resolve(
  'logs/pipeline/feedback-live-' + new Date().toISOString().replace(/[:.]/g, '-'),
);
mkdirSync(directory, { recursive: true });
const report = {
  at: new Date().toISOString(),
  mode: 'LIVE',
  shared_request_cap: cap,
  actual_requests: 0,
  isolated_synthetic_db: true,
  approval: 'test approval only in this new isolated database',
  cases: [],
};
const db = openDatabase(join(directory, 'app.sqlite'));
migrate(db);
const pipeline = new PipelineService(db, join(directory, 'projects'));
const agents = [];
const chosen = process.argv.find((a) => a.startsWith('--fixture='))?.split('=')[1];
if (chosen && !['A', 'B'].includes(chosen)) throw new Error('INVALID_FIXTURE');
try {
  for (const template of chosen ? [chosen] : ['A', 'B']) {
    const item = { fixture: template, requests: [] };
    report.cases.push(item);
    const gateway = deepSeekGateway({
      apiKey: process.env.MODEL_API_KEY,
      model: process.env.MODEL_NAME ?? 'deepseek-flash',
      baseUrl: process.env.MODEL_BASE_URL ?? 'https://api.deepseek.com',
      maxOutputTokens: 2048,
      tools: pipelineTools,
      jsonMode: false,
    });
    const agent = new PipelineAgent(pipeline, {
      limits: { timeout_ms: 120000 },
      gateway: {
        async complete(messages, signal) {
          const entry = { request: item.requests.length + 1, messages: structuredClone(messages) };
          item.requests.push(entry);
          report.actual_requests++;
          const response = await gateway.complete(messages, signal);
          entry.response = response;
          console.log(
            JSON.stringify({
              fixture: template,
              request: entry.request,
              calls: response.calls.map((c) => c.name),
            }),
          );
          return response;
        },
      },
    });
    agents.push(agent);
    try {
      const project = pipeline.create(template, 'feedback-create-' + template);
      item.project_id = project.id;
      const failed = await pipeline.waitFor(
        pipeline.start(project.id, 'feedback-failure-' + template).id,
      );
      const started = Date.now();
      const repair = await agent.waitFor(
        agent.create(
          project.id,
          failed.id,
          'feedback-diagnose-' + template,
          'LIVE',
          process.env.MODEL_NAME ?? 'deepseek-flash',
        ).id,
      );
      item.elapsed_ms = Date.now() - started;
      item.repair = repair;
      item.tool_rounds = [
        ...new Set(repair.tools.filter((t) => t.status === 'COMPLETED').map((t) => t.request)),
      ];
      item.feedback_observed = item.tool_rounds.length >= 2;
      for (const request of item.requests) {
        const calls = request.messages
          .filter((m) => m.role === 'assistant')
          .flatMap((m) => m.tool_calls ?? []);
        const results = request.messages.filter((m) => m.role === 'tool');
        assert.equal(calls.length, results.length);
        for (const call of calls) {
          const returned = results.filter((m) => m.tool_call_id === call.id);
          assert.equal(returned.length, 1);
          assert.deepEqual(
            JSON.parse(returned[0].content),
            repair.tools.find((t) => t.call_id === call.id)?.result,
          );
        }
      }
      item.exact_feedback_forwarded = true;
      item.evidence_dependent_choices = repair.model_turns
        .filter((turn) => turn.calls.length && turn.investigation)
        .flatMap((turn) => {
          const prior = repair.tools
            .filter((tool) => tool.status === 'COMPLETED' && tool.request < turn.request)
            .flatMap((tool) => tool.result.evidence_ids);
          const cited = turn.investigation.evidence_ids.filter((id) => prior.includes(id));
          return cited.length
            ? [
                {
                  request: turn.request,
                  question: turn.investigation.question,
                  reason: turn.investigation.reason,
                  prior_tool_evidence_ids: cited,
                },
              ]
            : [];
        });
      assert.ok(
        item.evidence_dependent_choices.length,
        'no actual prior-tool evidence cited for a later read',
      );
      assert.equal(pipeline.snapshot(project.id).target.row_count, 0);
      assert.equal(repair.status, 'PENDING_APPROVAL');
      agent.decide(project.id, repair.id, 'approve', 'feedback-approve-' + template, true);
      const done = await agent.waitFor(repair.id);
      assert.equal(done.status, 'VERIFIED');
      assert.equal(done.commit_approval?.status, 'COMMITTED');
      assert.equal(pipeline.snapshot(project.id).target.row_count, 4);
      pipeline.restore(project.id, done.commit_approval.batch_id, 'feedback-restore-' + template);
      assert.equal(pipeline.snapshot(project.id).target.row_count, 0);
      item.final = pipeline.snapshot(project.id);
      item.status = item.feedback_observed ? 'PASSED' : 'FEEDBACK_ROUTE_NOT_OBSERVED';
    } catch (e) {
      item.status = 'FAILED';
      item.error = e.code ?? e.message;
    }
    writeFileSync(join(directory, 'case-' + template + '.json'), JSON.stringify(item, null, 2));
  }
} finally {
  await Promise.all(agents.map((a) => a.stopAll()));
  await pipeline.stopAll();
  db.close();
  report.status = report.cases.every((c) => c.status === 'PASSED') ? 'PASSED' : 'FAILED';
  writeFileSync(join(directory, 'report.json'), JSON.stringify(report, null, 2));
  console.log(
    JSON.stringify({
      report: join(directory, 'report.json'),
      status: report.status,
      actual_requests: report.actual_requests,
      cases: report.cases.map((c) => ({
        fixture: c.fixture,
        status: c.status,
        tool_rounds: c.tool_rounds,
        error: c.error,
      })),
    }),
  );
  if (report.status !== 'PASSED') process.exitCode = 1;
}
