import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { openDatabase, migrate } from '../src/db.js';
import { PipelineService } from '../src/pipeline.js';
import { PipelineAgent } from '../src/pipeline-agent.js';
import type { ModelGateway } from '../src/model-gateway.js';

const fixture = JSON.parse(
  readFileSync(
    new URL('../../../fixtures/regressions/pipeline-investigation-only-v1.json', import.meta.url),
    'utf8',
  ),
);
type Messages = Record<string, unknown>[];
const initial = (m: Messages) => JSON.parse(String(m.find((x) => x.role === 'user')!.content));
const replay = (m: Messages, index: number) => ({
  ...fixture.responses[index],
  text: fixture.responses[index].text.replaceAll(
    '{{INITIAL_FAILURE_EVIDENCE_ID}}',
    initial(m).failure.evidence_id,
  ),
});
const feedback = (m: Messages) => JSON.parse(String(m.at(-1)!.content));
const manual = (m: Messages) => ({
  text: JSON.stringify({
    diagnosis: '离线协议控制：仅核对恢复路径，现有证据不足以在本测试中提交修复，交人工处理。',
    failed_step: initial(m).failure.failed_step,
    action: 'MANUAL_REQUIRED',
    candidate: null,
    evidence_ids: [initial(m).failure.evidence_id],
  }),
  finishReason: 'stop' as const,
  calls: [],
});

afterEach(() => vi.unstubAllGlobals());
async function exercise(gateway: ModelGateway, maxRequests = 10) {
  const directory = mkdtempSync(join(tmpdir(), 'flowlens-investigation-replay-'));
  const db = openDatabase(join(directory, 'app.sqlite'));
  migrate(db);
  const pipeline = new PipelineService(db, join(directory, 'projects'));
  const agent = new PipelineAgent(pipeline, { gateway, limits: { max_requests: maxRequests } });
  const network = vi.fn(() => {
    throw new Error('REAL_NETWORK_FORBIDDEN');
  });
  vi.stubGlobal('fetch', network);
  try {
    // Reproduce the protocol failure on existing B, not by rerunning held-out H02.
    const project = pipeline.create('B', randomUUID());
    const execution = await pipeline.waitFor(pipeline.start(project.id, randomUUID()).id);
    expect(execution).toMatchObject({ status: 'FAILED', failed_step: 'validate' });
    const before = pipeline.snapshot(project.id);
    const result = await agent.waitFor(
      agent.create(project.id, execution.id, randomUUID(), 'MOCK', 'recorded-protocol-replay').id,
    );
    const after = pipeline.snapshot(project.id);
    expect(after.target).toEqual(before.target);
    expect(after.revision).toEqual(before.revision);
    expect(after.executions).toHaveLength(1);
    expect(after.operations).toEqual(before.operations);
    expect(network).not.toHaveBeenCalled();
    return result;
  } finally {
    await agent.stopAll();
    await pipeline.stopAll();
    db.close();
  }
}

it('recorded investigation-only replies receive specific feedback but still fail after exactly one unsuccessful correction', async () => {
  let count = 0;
  const result = await exercise({
    async complete(messages, _signal, _delta, _first, options) {
      expect(options).toBeUndefined();
      if (count === 1) {
        expect(feedback(messages).feedback_type).toBe('INVESTIGATION_WITHOUT_TOOL_CALL');
        expect(feedback(messages).instruction).toContain('原生 tool_calls');
      }
      return replay(messages, count++);
    },
  });
  expect(count).toBe(2);
  expect(result).toMatchObject({
    status: 'FAILED',
    error_code: 'REPAIR_RESPONSE_SCHEMA',
    candidate: null,
    diagnosis: null,
  });
  expect(result.tools).toHaveLength(0);
  expect(result.model_turns).toHaveLength(2);
  expect(result.model_turns.every((t) => t.calls.length === 0 && t.investigation === null)).toBe(
    true,
  );
  expect(result.response_checks.map((c) => c.code)).toEqual([
    'REPAIR_RESPONSE_SCHEMA',
    'REPAIR_RESPONSE_SCHEMA',
  ]);
});

it('one correction can resume a real native MCP call without executing anything mentioned only in response text', async () => {
  let count = 0;
  const result = await exercise({
    async complete(messages, _signal, _delta, _first, options) {
      count++;
      if (count === 1) return replay(messages, 0);
      if (count === 2) {
        const note = feedback(messages);
        expect(note.feedback_type).toBe('INVESTIGATION_WITHOUT_TOOL_CALL');
        expect(note.available_evidence).toEqual([
          { id: initial(messages).failure.evidence_id, type: 'INITIAL_FAILURE' },
        ]);
        expect(options).toBeUndefined();
        expect(messages.filter((m) => m.role === 'tool')).toHaveLength(0);
        return {
          text: '',
          finishReason: 'tool_calls',
          calls: [{ id: 'native-recovery', name: 'get_sql', arguments: {} }],
        };
      }
      expect(messages.filter((m) => m.role === 'tool')).toHaveLength(1);
      return manual(messages);
    },
  });
  expect(count).toBe(3);
  expect(result).toMatchObject({
    status: 'NO_CANDIDATE',
    action: 'MANUAL_REQUIRED',
    candidate: null,
  });
  expect(result.tools).toHaveLength(1);
  expect(result.tools[0]).toMatchObject({
    call_id: 'native-recovery',
    name: 'get_sql',
    transport: 'MCP',
    status: 'COMPLETED',
  });
  expect(result.response_checks).toHaveLength(1);
});

it('targeted protocol feedback does not reset the correction allowance after a resumed tool call', async () => {
  let count = 0;
  const result = await exercise({
    async complete(messages) {
      count++;
      if (count === 1) return replay(messages, 0);
      if (count === 2)
        return {
          text: '',
          finishReason: 'tool_calls',
          calls: [{ id: 'read-once', name: 'get_sql', arguments: {} }],
        };
      return { text: '{}', finishReason: 'stop', calls: [] };
    },
  });
  expect(count).toBe(3);
  expect(result).toMatchObject({
    status: 'FAILED',
    error_code: 'REPAIR_RESPONSE_SCHEMA',
    candidate: null,
  });
  expect(result.tools).toHaveLength(1);
  expect(result.response_checks).toHaveLength(2);
});

it('request exhaustion still stops before any correction dispatch or tool execution', async () => {
  const complete = vi.fn(async (messages: Messages) => replay(messages, 0));
  const result = await exercise({ complete }, 1);
  expect(complete).toHaveBeenCalledTimes(1);
  expect(result).toMatchObject({
    status: 'FAILED',
    error_code: 'MODEL_REQUEST_LIMIT',
    candidate: null,
  });
  expect(result.tools).toHaveLength(0);
});

it.each(['{}', '{"investigation":{},"diagnosis":"incomplete"}', 'not JSON'])(
  'other malformed replies keep their existing correction path: %s',
  async (text) => {
    let count = 0;
    const result = await exercise({
      async complete(messages) {
        count++;
        if (count === 1) return { text, finishReason: 'stop', calls: [] };
        expect(feedback(messages).feedback_type).toBeUndefined();
        return manual(messages);
      },
    });
    expect(result.status).toBe('NO_CANDIDATE');
    expect(result.tools).toHaveLength(0);
  },
);
