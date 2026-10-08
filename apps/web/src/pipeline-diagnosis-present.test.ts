import { expect, it } from 'vitest';
import { pipelineExecutionSchema, pipelineRepairSchema } from '@flowlens/contracts';
import {
  investigationRounds,
  repairRelation,
  repeatedReadRequests,
} from './pipeline-diagnosis-present';

const id = '10000000-0000-4000-8000-000000000001';
const verificationId = '20000000-0000-4000-8000-000000000002';
const precheckId = '30000000-0000-4000-8000-000000000003';
const revisionId = '40000000-0000-4000-8000-000000000004';
const hash = 'a'.repeat(64);
const repair = pipelineRepairSchema.parse({
  id,
  project_id: id,
  execution_id: id,
  base_revision_id: id,
  base_hash: hash,
  input_hash: hash,
  status: 'VERIFIED',
  provider_mode: 'MOCK',
  model: 'test',
  created_at: 'now',
  expires_at: null,
  tools: [],
  evidence: [],
  diagnosis: 'supported',
  action: 'SQL_PATCH',
  failed_step: 'query',
  evidence_ids: [],
  candidate: null,
  approved_revision_id: revisionId,
  verification_execution_id: verificationId,
  error_code: null,
  model_requests: 3,
  usage: { prompt_tokens: 0, completion_tokens: 0 },
  commit_approval: {
    approved_at: 'now',
    target_version: 0,
    target_hash: hash,
    status: 'COMMITTED',
    execution_id: precheckId,
    operation_id: null,
    batch_id: null,
    error_code: null,
    error_message: null,
  },
});
const execution = pipelineExecutionSchema.parse({
  id: verificationId,
  project_id: id,
  revision_id: revisionId,
  revision_hash: hash,
  input_hash: hash,
  kind: 'VERIFICATION',
  status: 'SUCCEEDED',
  created_at: 'now',
  finished_at: 'now',
  logs: [],
  rows: [],
  columns: [],
  error_code: null,
  error_message: null,
  failed_step: null,
  exit_code: 0,
  validation: null,
  precheck: null,
  verification: null,
});

it('only actual failure, bound verification and explicitly approved precheck show a repair; same SQL reruns stay separate', () => {
  expect(
    repairRelation(repair, {
      ...execution,
      id,
      revision_id: id,
      status: 'FAILED',
      kind: 'PRECHECK',
    }),
  ).toBe('FAILURE');
  expect(repairRelation(repair, execution)).toBe('VERIFICATION');
  expect(repairRelation(repair, { ...execution, id: precheckId, kind: 'PRECHECK' })).toBe(
    'PRECHECK',
  );
  expect(repairRelation(repair, { ...execution, id: 'rerun', kind: 'PRECHECK' })).toBeNull();
  expect(
    repairRelation(
      { ...repair, commit_approval: null },
      { ...execution, id: precheckId, kind: 'PRECHECK' },
    ),
  ).toBeNull();
  expect(repairRelation(repair, { ...execution, revision_id: id })).toBeNull();
  expect(repairRelation(repair, { ...execution, project_id: revisionId })).toBeNull();
});

it('rounds follow actual model requests, preserve batched calls and include pending feedback decisions', () => {
  const tool = {
    id,
    request: 1,
    name: 'get_sql',
    status: 'COMPLETED',
    args: {},
    result: {},
    error_code: null,
  };
  const calls = ['get_sql', 'get_schema'].map((name, i) => ({
    id: 'call-' + i,
    name,
    arguments: {},
  }));
  const rounds = investigationRounds({
    ...repair,
    status: 'RUNNING',
    model_requests: 3,
    tools: [tool, { ...tool, id: revisionId, name: 'get_schema' }],
    model_turns: [
      { request: 1, text: '', finish_reason: 'tool_calls', calls },
      { request: 2, text: '{}', finish_reason: 'stop', calls: [] },
    ],
    response_checks: [{ request: 2, code: 'REPAIR_RESPONSE_SCHEMA', message: 'invalid' }],
  });
  expect(rounds.map((r) => r.request)).toEqual([1, 2, 3]);
  expect(rounds[0]?.tools).toHaveLength(2);
  expect(rounds[1]?.state).toBe('结论需纠正');
  expect(rounds[2]?.state).toBe('等待模型选择');
  const legacy = investigationRounds({ ...repair, tools: [{ ...tool, request: undefined }] });
  expect(legacy).toHaveLength(1);
  expect(legacy[0]?.label).toContain('轮次未记录');
});

it('actual public prose is visible even without JSON notes; malformed or forged structured notes are not promoted', () => {
  const calls = [{ id: 'read', name: 'get_sql', arguments: {} }];
  const text = 'The schema confirms speed_mps. Now I need the current SQL.';
  const round = (value: string) =>
    investigationRounds({
      ...repair,
      model_turns: [{ request: 1, text: value, finish_reason: 'tool_calls', calls }],
    })[0]!;
  expect(round(text).explanation).toBe(text);
  for (const value of [
    '',
    '{"investigation":{"evidence_ids":["forged"]}}',
    '{bad json',
    '```json\n{}',
    '<｜｜DSML｜｜ invoke',
  ]) {
    expect(round(value).explanation).toBeNull();
  }
  expect(
    investigationRounds({
      ...repair,
      model_turns: [{ request: 1, text, finish_reason: 'stop', calls: [] }],
    })[0]!.explanation,
  ).toBeNull();
});

it('repeat labels compare actual output and args, ignore fresh evidence IDs, and retain changed business values', () => {
  const tool = {
    id,
    request: 2,
    name: 'get_sql',
    status: 'COMPLETED',
    args: { a: 1, b: 2 },
    result: { output: { sql: 'SELECT 1', base_hash: hash }, evidence_ids: ['old'] },
    error_code: null,
  };
  const repeated = {
    ...tool,
    id: revisionId,
    request: 4,
    args: { b: 2, a: 1 },
    result: { output: { base_hash: hash, sql: 'SELECT 1' }, evidence_ids: ['new'] },
  };
  const map = repeatedReadRequests({
    ...repair,
    tools: [
      tool,
      repeated,
      { ...repeated, id: 'changed', result: { output: { sql: 'SELECT 2', base_hash: hash } } },
      { ...repeated, id: 'failed', status: 'FAILED' },
      { ...repeated, id: 'args', args: { a: 2, b: 2 } },
    ],
  });
  expect([...map]).toEqual([[revisionId, 2]]);
});

it('log repetition uses already observed sequence/content rather than page args, metadata or MCP evidence IDs', () => {
  const log = { seq: 3, at: 'now', step: 'query', level: 'ERROR', message: '实际错误' };
  const tool = {
    id,
    request: 1,
    name: 'get_logs',
    status: 'COMPLETED',
    args: { limit: 1 },
    result: { output: { logs: [log], matched_count: 40 }, evidence_ids: ['old'] },
    error_code: null,
    transport: 'MCP' as const,
  };
  const map = repeatedReadRequests({
    ...repair,
    tools: [
      tool,
      {
        ...tool,
        id: 'same',
        request: 2,
        args: { limit: 100 },
        result: { output: { logs: [log], matched_count: 1 }, evidence_ids: ['fresh'] },
      },
      { ...tool, id: 'new', request: 3, result: { output: { logs: [log, { ...log, seq: 2 }] } } },
      { ...tool, id: 'old-subset', request: 4, result: { output: { logs: [{ ...log, seq: 2 }] } } },
    ],
  });
  expect([...map]).toEqual([
    ['same', 1],
    ['old-subset', 3],
  ]);
});
