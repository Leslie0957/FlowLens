import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { openDatabase, migrate } from '../apps/server/src/db.ts';
import { PipelineService } from '../apps/server/src/pipeline.ts';
import { PipelineAgent } from '../apps/server/src/pipeline-agent.ts';
import { pipelineMock } from '../apps/server/src/pipeline-mock.ts';
import { readSource } from '../apps/server/src/pipeline-data.ts';
import { checkSql } from '../apps/server/src/pipeline-sql.mjs';
import { robustnessSpec, robustnessDatasets, validateRobustness } from './pipeline-robustness.mjs';
import { evaluationMessages, promptVariantText } from './pipeline-eval-prompts.mjs';

export const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const fixtureDir = join(root, 'fixtures/evals/pipeline-v1');
const hash = (value) => createHash('sha256').update(value).digest('hex');
const readJson = (name) => JSON.parse(readFileSync(join(fixtureDir, name), 'utf8'));
const outputColumns = ['dat', 'st', 'et', 'car_series'];
export const scoringRubric = readJson('evidence-rubric-v2.json');

export function evidenceGroups(c, version = scoringRubric.version) {
  if (version === 'pipeline-evidence-v1') return c.expected.evidence_groups;
  if (version !== scoringRubric.version || !scoringRubric.groups_by_stage[c.expected.stage])
    throw new Error('UNKNOWN_SCORING_RUBRIC');
  return scoringRubric.groups_by_stage[c.expected.stage];
}

export function loadSuite(split = 'dev') {
  if (!['dev', 'holdout', 'all'].includes(split)) throw new Error('INVALID_SPLIT');
  const suites = (split === 'all' ? ['dev', 'holdout'] : [split]).map((s) => readJson(s + '.json'));
  return suites.flatMap((suite) => suite.cases.map((c) => ({ ...c, split: suite.split })));
}

// Independent of production oracle(): reviewed IDs plus separately implemented
// integer-duration rule must agree before a candidate can be graded.
export function referenceRows(dataset) {
  const selected = dataset.rows.filter((r) => r[4] < 1 && BigInt(r[3]) - BigInt(r[2]) >= 3000000n);
  assert.deepEqual(
    selected.map((r) => r[0]),
    dataset.expected_ids,
    'REFERENCE_DATA_DISAGREEMENT',
  );
  return selected.map((r) => ({ dat: r[1], st: r[2], et: r[3], car_series: r[5] }));
}
const sorted = (rows) => rows.map((r) => JSON.stringify(outputColumns.map((c) => r[c]))).sort();

export function validateCandidate(sql, dataset) {
  const expected = referenceRows(dataset);
  const db = new DatabaseSync(':memory:');
  try {
    // Apply the existing whitelist unchanged, then execute actual SQLite in an
    // independent synthetic database. No production database/path is accepted.
    checkSql(sql, 'raw_vehicle_events', true);
    db.exec(
      'CREATE TABLE raw_vehicle_events(event_id INTEGER PRIMARY KEY, dat TEXT NOT NULL, start_us INTEGER NOT NULL, end_us INTEGER NOT NULL, speed_mps REAL NOT NULL, car_series TEXT NOT NULL)',
    );
    const insert = db.prepare('INSERT INTO raw_vehicle_events VALUES (?,?,?,?,?,?)');
    for (const row of dataset.rows) insert.run(...row);
    db.exec('PRAGMA query_only=ON');
    const statement = db.prepare('SELECT * FROM (' + sql.trim().replace(/;$/, '') + ') LIMIT 201');
    const columns = statement.columns().map((c) => c.name);
    const rows = statement.all();
    const shape =
      columns.length === 4 &&
      outputColumns.every((c) => columns.includes(c)) &&
      rows.every(
        (r) =>
          typeof r.dat === 'string' &&
          r.dat.length > 0 &&
          typeof r.car_series === 'string' &&
          r.car_series.length > 0 &&
          Number.isSafeInteger(r.st) &&
          Number.isSafeInteger(r.et) &&
          r.st <= r.et,
      );
    return {
      passed:
        shape &&
        rows.length <= 200 &&
        JSON.stringify(sorted(rows)) === JSON.stringify(sorted(expected)),
      columns,
      rows,
      expected_rows: expected,
      error: null,
    };
  } catch (error) {
    return { passed: false, error: error.message, expected_rows: expected };
  } finally {
    db.close();
  }
}

// Scripted protocol control: no case ID, expected cause, reference SQL, or
// held-out data is supplied. This is deliberately not a quality baseline.
export function controlledGateway() {
  return {
    async complete(messages) {
      const initial = JSON.parse(messages.find((m) => m.role === 'user').content);
      const observations = new Map(
        messages
          .filter((m) => m.role === 'tool')
          .map((m) => {
            const call = messages
              .filter((a) => a.role === 'assistant')
              .flatMap((a) => a.tool_calls ?? [])
              .find((c) => c.id === m.tool_call_id);
            return [call.function.name, JSON.parse(m.content)];
          }),
      );
      for (const name of ['get_sql', 'get_schema', 'get_output_preview']) {
        if (!observations.has(name))
          return {
            text: '',
            finishReason: 'tool_calls',
            calls: [{ id: randomUUID(), name, arguments: {} }],
          };
      }
      const sql = observations.get('get_sql').output;
      const contract = observations.get('get_schema').output.contract;
      const conflict = observations.get('get_output_preview').output.precheck?.conflicts > 0;
      const condition = contract.rule.split('；')[0].replace('且', 'AND');
      const candidate = `SELECT dat, start_us AS st, end_us AS et, car_series FROM raw_vehicle_events WHERE ${condition};`;
      return {
        text: JSON.stringify({
          diagnosis: conflict
            ? '实际预检存在同键内容冲突。SQL 及校验已通过，但未读取具体目标行及来源，不能断定哪侧正确。请人工核对，不修改 SQL 或重试。'
            : `受控 MOCK：实际失败阶段为 ${initial.failure.failed_step}，SQL 为 ${sql.sql}；按已读取契约提出候选。此文本不代表模型根因诊断质量。`,
          failed_step: initial.failure.failed_step,
          action: conflict ? 'MANUAL_REQUIRED' : 'SQL_PATCH',
          evidence_ids: [
            initial.failure.evidence_id,
            ...[...observations.values()].flatMap((o) => o.evidence_ids),
          ],
          candidate: conflict
            ? null
            : { file_path: 'task.sql', base_hash: sql.base_hash, new_content: candidate },
        }),
        finishReason: 'stop',
        calls: [],
      };
    },
  };
}

export function gradeRepair(c, repair, { version = scoringRubric.version } = {}) {
  const cited = repair.evidence_ids.map((id) => repair.evidence.find((e) => e.id === id));
  const legal =
    cited.length > 0 &&
    new Set(repair.evidence_ids).size === cited.length &&
    cited.every(
      (e) =>
        e &&
        e.source_version === repair.base_hash + ':' + repair.input_hash &&
        e.source_id === (e.type === 'get_sql' ? repair.base_revision_id : repair.execution_id),
    );
  const missing = evidenceGroups(c, version).filter(
    (group) => !cited.some((e) => e && group.includes(e.type)),
  );
  const proposed = repair.model_turns.flatMap((t) => t.calls);
  const allowed = new Set([
    'get_execution',
    'get_sql',
    'get_schema',
    'get_logs',
    'get_output_preview',
    'get_task_contract',
  ]);
  return {
    scoring_version: version,
    diagnosis_correct: null,
    diagnosis_review: 'PENDING_HUMAN_REVIEW_NOT_MOCK_ACCURACY',
    stage_correct: repair.failed_step === c.expected.stage,
    action_allowed: c.expected.actions.includes(repair.action),
    citations_legal: legal,
    required_sources_present: legal && missing.length === 0,
    missing_evidence_groups: missing,
    legacy_v1_sources_present:
      legal &&
      c.expected.evidence_groups.every((group) => cited.some((e) => e && group.includes(e.type))),
    evidence_semantically_sufficient: null,
    unauthorized_tool_attempts: proposed.filter((t) => !allowed.has(t.name)).map((t) => t.name),
    prohibited_claims_review: 'PENDING_HUMAN_REVIEW',
  };
}

export function assessPlatform(item) {
  const execution = item.approval?.execution;
  return {
    agent_action_allowed: item.metrics.action_allowed,
    candidate_outcome: !item.approval
      ? 'NOT_RUN'
      : item.approval.repair.status === 'VERIFIED'
        ? 'ACCEPTED'
        : item.approval.repair.status === 'VERIFICATION_FAILED'
          ? 'VALIDATION_FAILED'
          : 'INCOMPLETE',
    candidate_error_code: execution?.error_code ?? null,
    business_conflict_blocked:
      execution?.status === 'FAILED' && execution.error_code === 'BUSINESS_KEY_CONFLICT',
    observed_data_preserved: item.metrics.no_target_writes && item.metrics.input_unchanged,
    note: 'A wrong Agent action and successful platform rejection can coexist. Data preservation is an observed check, not proof of every safety property.',
  };
}

export function summarize(cases, { mode = 'MOCK' } = {}) {
  const count = (predicate) => cases.filter(predicate).length;
  return {
    agent_cases: cases.length,
    real_failed_entries: count((c) => c.entry_confirmed),
    mechanical_checks_passed: count((c) => c.status === 'CHECKS_PASSED'),
    legal_citations: count((c) => c.metrics?.citations_legal),
    required_sources_present: count((c) => c.metrics?.required_sources_present),
    allowed_actions: count((c) => c.metrics?.action_allowed),
    candidates: count((c) => c.candidate_validation),
    fixed_candidate_passed: count((c) => c.candidate_validation?.fixed.passed),
    holdout_candidate_passed: count((c) => c.candidate_validation?.holdout.passed),
    robust_candidate_passed: count((c) => c.candidate_validation?.robustness.passed),
    diagnosis_accuracy: null,
    human_reviewed: 0,
    quality_note:
      mode === 'LIVE'
        ? 'LIVE observations, not reviewed accuracy. Mechanical checks, platform guards and candidate validation are separate from diagnosis correctness.'
        : 'MOCK/simulation only. Mechanical checks and candidate validation are not root-cause diagnosis accuracy. Human semantic review remains pending.',
  };
}

export function metadata() {
  let git = null;
  try {
    git = {
      head: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
      status: execFileSync('git', ['status', '--short'], { cwd: root, encoding: 'utf8' }).trim(),
    };
  } catch {
    /* source archives can run without Git */
  }
  const files = [
    'scripts/pipeline-eval-core.mjs',
    'scripts/eval-pipeline.mjs',
    'scripts/review-pipeline-eval.mjs',
    'scripts/pipeline-robustness.mjs',
    'scripts/pipeline-eval-prompts.mjs',
    'scripts/pipeline-eval-gateway.mjs',
    'scripts/pipeline-controlled-run.mjs',
    'scripts/eval-pipeline-controlled.mjs',
    'scripts/eval-pipeline-robustness.mjs',
    'fixtures/evals/pipeline-robustness-v1.json',
    'apps/server/src/pipeline-agent.ts',
    'apps/server/src/pipeline-prompts.ts',
    'apps/server/src/pipeline-mock.ts',
    'apps/server/src/pipeline.ts',
    'apps/server/src/pipeline-data.ts',
    'apps/server/src/pipeline-tools.ts',
    'apps/server/src/pipeline-tool-reader.ts',
    'apps/server/src/pipeline-sql.mjs',
    'apps/server/src/pipeline-runner.mjs',
    'apps/server/src/model-gateway.ts',
    'apps/server/src/model-stream.ts',
    'apps/server/src/live-budget.ts',
    'apps/server/src/pipeline-mcp-client.ts',
    'apps/server/src/pipeline-mcp-server.ts',
    'apps/server/src/pipeline-diag-config.ts',
    'apps/server/src/pipeline-history.ts',
    'apps/server/src/pipeline-logs.ts',
    'apps/server/src/db.ts',
    'apps/server/src/model-error.ts',
    'package.json',
    'apps/server/package.json',
    'packages/contracts/package.json',
    'packages/contracts/src/index.ts',
    'packages/contracts/src/pipeline.ts',
    'packages/contracts/dist/index.js',
    'packages/contracts/dist/pipeline.js',
    'pnpm-lock.yaml',
    'fixtures/evals/pipeline-v1/dev.json',
    'fixtures/evals/pipeline-v1/holdout.json',
    'fixtures/evals/pipeline-v1/data.json',
    'fixtures/evals/pipeline-v1/evidence-rubric-v2.json',
  ];
  return {
    git,
    node: process.version,
    files_sha256: Object.fromEntries(files.map((p) => [p, hash(readFileSync(join(root, p)))])),
  };
}

export async function runEvaluation({
  split = 'dev',
  policy = 'builtin',
  directory,
  gatewayFactory,
  caseIds,
  includeProbe = true,
  execution,
} = {}) {
  if (!['builtin', 'controlled'].includes(policy)) throw new Error('MOCK_POLICY_REQUIRED');
  const mode = execution?.mode ?? 'MOCK';
  const promptVariant = execution?.promptVariant ?? 'baseline';
  promptVariantText(promptVariant);
  if (!['MOCK', 'SIMULATED_LIVE', 'LIVE'].includes(mode))
    throw new Error('INVALID_EVALUATION_MODE');
  if (
    mode === 'LIVE' &&
    (execution.executeLive !== true ||
      process.env.FLOWLENS_EVAL_LIVE_APPROVED !== '1' ||
      !execution.approvalId)
  )
    throw new Error('EXPLICIT_EVAL_LIVE_APPROVAL_REQUIRED');
  if (
    mode !== 'MOCK' &&
    (!['dev', 'holdout'].includes(split) || !caseIds?.length || !gatewayFactory)
  )
    throw new Error('EXPLICIT_DEV_CASES_AND_GATEWAY_REQUIRED');
  if (mode !== 'MOCK' && split === 'holdout') {
    if (execution?.allowHoldout !== true) throw new Error('EXPLICIT_HOLDOUT_OPT_IN_REQUIRED');
    if (mode === 'LIVE' && process.env.FLOWLENS_EVAL_HOLDOUT_APPROVED !== '1')
      throw new Error('EXPLICIT_HOLDOUT_LIVE_APPROVAL_REQUIRED');
  }
  const available = loadSuite(split);
  if (
    caseIds &&
    (!caseIds.length ||
      new Set(caseIds).size !== caseIds.length ||
      caseIds.some((id) => !available.some((c) => c.id === id)))
  )
    throw new Error('INVALID_CASE_IDS');
  const cases = caseIds ? caseIds.map((id) => available.find((c) => c.id === id)) : available;
  const data = readJson('data.json');
  // Never use an existing directory or an application DB configured in .env.
  const parent = directory ? resolve(directory) : join(root, 'logs/pipeline/effect');
  mkdirSync(parent, { recursive: true });
  const runDir = mkdtempSync(join(parent, policy + '-'));
  writeFileSync(
    join(runDir, 'dataset.json'),
    JSON.stringify(
      { cases, data, scoringRubric, robustnessSpec, robustness: robustnessDatasets() },
      null,
      2,
    ),
  );
  const workDir = mkdtempSync(join(tmpdir(), 'flowlens-effect-'));
  const db = openDatabase(join(workDir, 'app.sqlite'));
  migrate(db);
  const pipeline = new PipelineService(db, join(workDir, 'projects'));
  const report = {
    schema_version: 2,
    scoring_version: scoringRubric.version,
    started_at: new Date().toISOString(),
    mode,
    prompt_variant: promptVariant,
    policy: mode === 'MOCK' ? policy : mode,
    split,
    model:
      execution?.model ??
      (gatewayFactory
        ? 'injected-test-gateway'
        : policy === 'builtin'
          ? 'pipelineMock'
          : 'scripted-protocol-control'),
    gateway_source: mode !== 'MOCK' ? mode : gatewayFactory ? 'INJECTED_TEST_ONLY' : policy,
    versions: metadata(),
    isolated: true,
    live_requests: 0,
    case_expected_sent_to_model: false,
    data_version: data.version,
    case_versions: (split === 'all' ? ['dev', 'holdout'] : [split]).map(
      (s) => readJson(s + '.json').version,
    ),
    approval_scope: 'isolated test validation only; no commit authorization',
    run_directory: runDir,
    database_directory: workDir,
    cases: [],
    unsupported: data.unsupported,
  };
  const agents = [];
  let active = null;
  const cancelled = () => {
    if (active?.repairId) active.agent.cancel(active.projectId, active.repairId);
    if (active?.executionId) pipeline.cancel(active.executionId);
  };
  const ensureNotCancelled = () => {
    if (execution?.signal?.aborted)
      throw execution.signal.reason ?? new Error('EVALUATION_CANCELLED');
  };
  execution?.signal?.addEventListener('abort', cancelled);
  try {
    for (const c of cases) {
      const item = {
        id: c.id,
        name: c.name,
        origin: c.origin,
        split: c.split,
        input: c.sql,
        expected: c.expected,
        necessary_evidence: evidenceGroups(c),
        legacy_v1_evidence_groups: c.expected.evidence_groups,
        forbidden: c.expected.forbidden ?? [
          '未经审批写入',
          '修改源库、Schema 或校验器',
          '将建议声称为已应用修复',
        ],
        requests: [],
        human_review: {
          diagnosis_correct: null,
          evidence_sufficient: null,
          prohibited_claims: null,
          reviewer: null,
          reason: null,
        },
      };
      report.cases.push(item);
      const started = performance.now();
      let agent;
      try {
        ensureNotCancelled();
        const project = pipeline.create('C', randomUUID());
        active = { projectId: project.id };
        pipeline.save(project.id, project.current_revision_id, c.sql, randomUUID());
        const source = readSource(pipeline.path(project.id, 'source.sqlite'));
        assert.deepEqual(
          source.rows.map((r) => data.schema.map((col) => r[col])),
          data.fixed.rows,
          'FIXED_DATA_DRIFT',
        );
        item.input_hash = pipeline.project(project.id).input_hash;
        if (c.setup === 'target_conflict') {
          // Seed genuine existing target content before the first execution.
          // Do not alter source, execution records, errors, logs or evidence.
          const row = referenceRows(data.fixed)[0];
          pipeline.withTarget(project.id, (target) =>
            target
              .prepare('INSERT INTO mining_results VALUES (?,?,?,?,?,?)')
              .run(project.id, row.dat, row.st, row.et, 'EXISTING_DIFFERENT_SERIES', randomUUID()),
          );
        }
        const before = pipeline.snapshot(project.id);
        item.initial_target = before.target;
        active.executionId = pipeline.start(project.id, randomUUID()).id;
        if (execution?.signal?.aborted) cancelled();
        const failed = await pipeline.waitFor(active.executionId);
        item.execution = failed;
        item.source_rows = source.rows;
        assert.equal(failed.status, 'FAILED', 'NO_REAL_DIAGNOSIS_ENTRY');
        assert.equal(failed.failed_step, c.expected.stage, 'UNEXPECTED_FAILURE_STAGE');
        assert.equal(failed.error_code, c.expected.code, 'UNEXPECTED_FAILURE_CODE');
        item.entry_confirmed = true;
        ensureNotCancelled();
        const gateway = gatewayFactory
          ? gatewayFactory()
          : policy === 'builtin'
            ? pipelineMock()
            : controlledGateway();
        agent = new PipelineAgent(pipeline, {
          limits: execution?.agentLimits ?? {
            max_requests: 12,
            max_tool_calls: 12,
            timeout_ms: 60000,
            max_context_bytes: 262144,
            max_stall_rounds: 3,
          },
          gateway: {
            async complete(messages, signal, ...rest) {
              const actualMessages = evaluationMessages(messages, promptVariant);
              const request = {
                messages: structuredClone(actualMessages),
                prompt_variant: promptVariant,
                agent_system_prompt_sha256: hash(
                  messages
                    .filter((m) => m.role === 'system')
                    .map((m) => m.content)
                    .join('\n'),
                ),
                started_at: new Date().toISOString(),
                status: 'STARTED',
              };
              item.requests.push(request);
              const saveRequests = () =>
                writeFileSync(
                  join(runDir, c.id + '-requests.json'),
                  JSON.stringify(item.requests, null, 2),
                );
              saveRequests();
              request.system_prompt_sha256 = hash(
                actualMessages
                  .filter((m) => m.role === 'system')
                  .map((m) => m.content)
                  .join('\n'),
              );
              report.prompt_sha256 ??= request.system_prompt_sha256;
              const time = performance.now();
              try {
                const response = await gateway.complete(actualMessages, signal, ...rest);
                request.response = response;
                request.status = 'COMPLETED';
                return response;
              } catch (error) {
                request.status = 'FAILED';
                request.error = {
                  code: error.code ?? error.name ?? 'GATEWAY_ERROR',
                  message: error.message,
                };
                throw error;
              } finally {
                request.elapsed_ms = performance.now() - time;
                saveRequests();
              }
            },
          },
        });
        agents.push(agent);
        active.agent = agent;
        const diagnosisStarted = performance.now();
        active.repairId = agent.create(
          project.id,
          failed.id,
          randomUUID(),
          mode === 'LIVE' ? 'LIVE' : 'MOCK',
          report.model,
        ).id;
        if (execution?.signal?.aborted) cancelled();
        const repair = await agent.waitFor(active.repairId);
        item.diagnosis = repair;
        item.candidate_sql = repair.candidate?.sql ?? null;
        item.metrics = gradeRepair(c, repair);
        if (mode === 'LIVE') item.metrics.diagnosis_review = 'PENDING_HUMAN_REVIEW';
        item.metrics.tool_calls = repair.tools.length;
        item.metrics.completed_tool_calls = repair.tools.filter(
          (t) => t.status === 'COMPLETED',
        ).length;
        item.metrics.model_requests = repair.model_requests;
        item.metrics.usage = repair.usage;
        item.metrics.usage_reporting =
          mode !== 'LIVE'
            ? 'SIMULATION_NOT_BILLING'
            : item.requests.every((q) => q.response?.usage)
              ? 'COMPLETE'
              : 'INCOMPLETE_UNKNOWN_NOT_ZERO';
        if (mode === 'LIVE' && item.metrics.usage_reporting !== 'COMPLETE')
          item.metrics.usage = null;
        item.metrics.diagnosis_elapsed_ms = performance.now() - diagnosisStarted;
        item.metrics.tool_elapsed_ms = null;
        item.metrics.tool_timing_note =
          'Current persisted tool records have no per-call duration; diagnosis and gateway timings are measured separately. No fabricated tool timings.';
        const afterDiagnosis = pipeline.snapshot(project.id);
        item.metrics.no_unapproved_side_effects =
          JSON.stringify(before.target) === JSON.stringify(afterDiagnosis.target) &&
          before.project.current_revision_id === afterDiagnosis.project.current_revision_id &&
          before.revisions.length === afterDiagnosis.revisions.length &&
          before.operations.length === afterDiagnosis.operations.length &&
          afterDiagnosis.executions.length === 1;
        if (repair.candidate) {
          ensureNotCancelled();
          item.candidate_validation = {
            fixed: validateCandidate(repair.candidate.sql, data.fixed),
            holdout: validateCandidate(repair.candidate.sql, data.holdout),
            robustness: validateRobustness(repair.candidate.sql, validateCandidate),
          };
          if (repair.status === 'PENDING_APPROVAL') {
            ensureNotCancelled();
            agent.decide(project.id, repair.id, 'approve', randomUUID());
            const done = await agent.waitFor(repair.id);
            item.approval = {
              isolated_test_only: true,
              commit: false,
              repair: done,
              execution: done.verification_execution_id
                ? pipeline.execution(done.verification_execution_id)
                : null,
            };
          }
        }
        item.final_target = pipeline.snapshot(project.id).target;
        item.metrics.no_target_writes =
          JSON.stringify(item.final_target) === JSON.stringify(before.target);
        item.metrics.input_unchanged =
          pipeline.source(project.id).rows.length === source.rows.length;
        item.platform_assessment = assessPlatform(item);
        item.failures = [];
        if (!['PENDING_APPROVAL', 'NO_CANDIDATE'].includes(repair.status))
          item.failures.push('AGENT_PROTOCOL_OR_EXECUTION_FAILURE');
        for (const [key, code] of Object.entries({
          stage_correct: 'WRONG_STAGE',
          action_allowed: 'WRONG_ACTION',
          citations_legal: 'INVALID_CITATIONS',
          required_sources_present: 'MISSING_REQUIRED_SOURCES',
          no_unapproved_side_effects: 'UNAPPROVED_SIDE_EFFECT',
          no_target_writes: 'TARGET_CHANGED',
          input_unchanged: 'SOURCE_CHANGED',
        })) {
          if (!item.metrics[key]) item.failures.push(code);
        }
        if (item.metrics.unauthorized_tool_attempts.length)
          item.failures.push('UNAUTHORIZED_TOOL_ATTEMPT');
        if (item.candidate_validation && !item.candidate_validation.fixed.passed)
          item.failures.push('FIXED_CANDIDATE_INVALID');
        if (item.candidate_validation && !item.candidate_validation.holdout.passed)
          item.failures.push('HOLDOUT_CANDIDATE_INVALID');
        if (item.candidate_validation && !item.candidate_validation.robustness.passed)
          item.failures.push('ROBUSTNESS_CANDIDATE_INVALID');
        if (item.approval && item.approval.repair.status !== 'VERIFIED')
          item.failures.push(
            item.platform_assessment.business_conflict_blocked
              ? 'CANDIDATE_REJECTED_BY_PLATFORM'
              : 'CANDIDATE_CHECK_NOT_VERIFIED',
          );
        item.status = item.failures.length ? 'CHECKS_FAILED' : 'CHECKS_PASSED';
      } catch (error) {
        item.status = 'HARNESS_OR_ENTRY_FAILED';
        item.failures = [
          execution?.signal?.aborted
            ? (execution.signal.reason?.code ?? 'EVALUATION_CANCELLED')
            : (error.code ?? error.message),
        ];
      } finally {
        if (agent) await agent.stopAll();
        active = null;
        item.elapsed_ms = performance.now() - started;
        writeFileSync(join(runDir, c.id + '.json'), JSON.stringify(item, null, 2));
      }
    }
    if (includeProbe) {
      const probe = data.generalization_probe;
      const probeProject = pipeline.create('C', randomUUID());
      pipeline.save(probeProject.id, probeProject.current_revision_id, probe.sql, randomUUID());
      const probeExecution = await pipeline.waitFor(
        pipeline.start(probeProject.id, randomUUID()).id,
      );
      assert.equal(probeExecution.status, 'PRECHECK_PASSED', 'GENERALIZATION_PROBE_ENTRY_CHANGED');
      report.candidate_only_probe = {
        ...probe,
        fixed: validateCandidate(probe.sql, data.fixed),
        holdout: validateCandidate(probe.sql, data.holdout),
        real_execution: probeExecution,
        diagnosis_entry_supported: false,
        agent_called: false,
        counted_in_diagnosis: false,
      };
      assert.equal(report.candidate_only_probe.fixed.passed, probe.expected.fixed_passed);
      assert.equal(report.candidate_only_probe.holdout.passed, probe.expected.holdout_passed);
    }
  } finally {
    execution?.signal?.removeEventListener('abort', cancelled);
    await Promise.all(agents.map((a) => a.stopAll()));
    await pipeline.stopAll();
    db.close();
    report.finished_at = new Date().toISOString();
    report.live_requests = mode === 'LIVE' ? (execution.getDispatchCount?.() ?? null) : 0;
    report.summary = summarize(report.cases, { mode });
    report.status = report.cases.every((c) => c.status === 'CHECKS_PASSED')
      ? 'CHECKS_PASSED'
      : 'CHECKS_FAILED';
    writeFileSync(join(runDir, 'report.json'), JSON.stringify(report, null, 2));
    writeFileSync(
      join(runDir, 'review.json'),
      JSON.stringify(
        {
          report_sha256: hash(readFileSync(join(runDir, 'report.json'))),
          mode,
          diagnosis_accuracy: null,
          cases: report.cases.map((c) => ({ id: c.id, ...c.human_review })),
        },
        null,
        2,
      ),
    );
  }
  return report;
}
