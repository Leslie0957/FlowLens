import { describe, it, expect } from 'vitest';
import { decodeChatStream } from '../src/stream.js';
import { createTools } from '../src/tools.js';
import { runTurn } from '../src/agent.js';
import { createLogger, newTraceId } from '../src/log.js';
import { DatabaseSync } from 'node:sqlite';

const stream = (pieces: string[]) =>
  (async function* () {
    for (const piece of pieces) yield new TextEncoder().encode(piece);
  })();
const fixture = [
  'data: {"choices":[{"index":0,"delta":{"content":"诊"}}]}\n\n',
  'data: {"choices":[{"index":0,"delta":{"content":"断","tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"get_task_logs","arguments":"{\\"run_id\\":\\"run_1"}}]}}]}\n\n',
  'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"}"}}]},"finish_reason":"tool_calls"}]}\n\n',
  'data: [DONE]\n\n',
];

describe('DeepSeek Chat Completions stream', () => {
  it('reassembles UTF-8, SSE and fragmented tool arguments', async () => {
    const bytes = new TextEncoder().encode(fixture.join(''));
    const parts = Array.from(bytes, (byte) => new Uint8Array([byte]));
    let firstDeltaCount = 0;
    const result = await decodeChatStream(
      (async function* () {
        yield* parts;
      })(),
      () => firstDeltaCount++,
    );
    expect(firstDeltaCount).toBe(1);
    expect(result.text).toBe('诊断');
    expect(result.calls).toEqual([
      { id: 'call_1', name: 'get_task_logs', arguments: { run_id: 'run_1' } },
    ]);
  });
  it('rejects truncated and invalid arguments without executing', async () => {
    await expect(decodeChatStream(stream(fixture.slice(0, -1)))).rejects.toMatchObject({
      code: 'PROTOCOL_ERROR',
    });
    const invalid =
      'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"x","function":{"name":"get_task_logs","arguments":"{bad"}}]},"finish_reason":"tool_calls"}]}\n\ndata: [DONE]\n\n';
    await expect(decodeChatStream(stream([invalid]))).rejects.toMatchObject({
      code: 'PROTOCOL_ERROR',
    });
  });
});

describe('read-only tools', () => {
  it('uses real fixture handlers and registers evidence', async () => {
    const tools = createTools();
    const result = await tools.call(
      'get_task_logs',
      { run_id: 'run_1' },
      { runId: 'run_1', sessionId: 'ses_1', turnId: 'turn_1' },
    );
    expect(
      result.output.logs.some((l: { message: string }) => l.message.includes('ReadTimeout')),
    ).toBe(true);
    expect(result.evidenceIds.length).toBeGreaterThan(0);
  });
  it('denies unknown and cross-run calls', async () => {
    const tools = createTools();
    const ctx = { runId: 'run_1', sessionId: 'ses_1', turnId: 'turn_1' };
    await expect(tools.call('run_shell', { command: 'echo x' }, ctx)).rejects.toMatchObject({
      code: 'TOOL_NOT_ALLOWED',
    });
    await expect(tools.call('get_task_logs', { run_id: 'run_2' }, ctx)).rejects.toMatchObject({
      code: 'TOOL_SCOPE',
    });
    await expect(
      tools.call('get_task_logs', { run_id: 'run_1', limit: 101 }, ctx),
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENTS' });
  });
});

describe('agent lifecycle', () => {
  it('mock runs actual tools and reports one terminal result', async () => {
    const events = [] as { type: string }[];
    const result = await runTurn({
      mode: 'MOCK',
      runId: 'run_1',
      sessionId: 'ses_1',
      turnId: 'turn_1',
      question: '原因?',
      onEvent: (e) => events.push(e),
    });
    expect(result.status).toBe('COMPLETED');
    expect(events.filter((e) => e.type === 'turn.finished')).toHaveLength(1);
    expect(events.some((e) => e.type === 'tool.completed')).toBe(true);
    expect(
      result.events.find((e) => e.type === 'diagnosis.completed')?.result?.findings[0]?.cause,
    ).toBe('UPSTREAM_TIMEOUT');
  });
  it('LIVE without key fails before any call and never falls back', async () => {
    let calls = 0;
    const result = await runTurn({
      mode: 'LIVE',
      runId: 'run_1',
      sessionId: 'ses_1',
      turnId: 'turn_1',
      question: '?',
      apiKey: '',
      gateway: {
        complete: async () => {
          calls++;
          throw Error('unexpected');
        },
      },
    });
    expect(result).toMatchObject({ status: 'FAILED', errorCode: 'MODEL_NOT_CONFIGURED' });
    expect(calls).toBe(0);
  });
  it('rejects invented evidence and does not finish successfully', async () => {
    const result = await runTurn({
      mode: 'MOCK',
      runId: 'run_1',
      sessionId: 'ses_1',
      turnId: 'turn_1',
      question: '?',
      mockInvalidEvidence: true,
    });
    expect(result.status).toBe('FAILED');
    expect(result.errorCode).toBe('INVALID_EVIDENCE');
  });
  it('cancellation wins over late model result', async () => {
    const abort = new AbortController();
    let release!: () => void;
    const wait = new Promise<void>((r) => (release = r));
    const pending = runTurn({
      mode: 'LIVE',
      runId: 'run_1',
      sessionId: 'ses_1',
      turnId: 'turn_1',
      question: '?',
      apiKey: 'fake',
      signal: abort.signal,
      gateway: {
        complete: async () => {
          await wait;
          return { text: 'late', calls: [], finishReason: 'stop' };
        },
      },
    });
    await Promise.resolve();
    abort.abort();
    release();
    expect((await pending).status).toBe('CANCELLED');
  });
});

describe('diagnostic log and storage smoke', () => {
  it('regenerates invalid IDs and emits no unlisted secrets', () => {
    const lines: string[] = [];
    const logger = createLogger((s) => lines.push(s));
    const id = newTraceId('bad\nsecret');
    logger.write('model.failed', {
      trace_id: id,
      error_code: 'MODEL_ERROR',
      apiKey: 'SENSITIVE',
      prompt: 'PROMPT_SECRET',
    });
    expect(id).not.toContain('secret');
    expect(lines.join('')).not.toContain('SENSITIVE');
    expect(lines.join('')).not.toContain('PROMPT_SECRET');
  });
  it('SQLite rolls back, enforces uniqueness, persists on reopen', () => {
    const db = new DatabaseSync(':memory:');
    db.exec(
      "CREATE TABLE x (id TEXT PRIMARY KEY, v TEXT); BEGIN; INSERT INTO x VALUES ('a','first'); ROLLBACK;",
    );
    expect(db.prepare('SELECT count(*) as c FROM x').get()).toMatchObject({ c: 0 });
    db.exec("INSERT INTO x VALUES ('a','first')");
    expect(() => db.exec("INSERT INTO x VALUES ('a','second')")).toThrow();
    db.close();
  });
});

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProbeError } from '../src/error.js';

it('SQLite file survives close and reopen without touching user data', () => {
  const folder = mkdtempSync(join(tmpdir(), 'flowlens-m0-'));
  const path = join(folder, 'smoke.sqlite');
  try {
    const first = new DatabaseSync(path);
    first.exec("CREATE TABLE x (id TEXT PRIMARY KEY, v TEXT); INSERT INTO x VALUES ('a','saved')");
    first.close();
    const second = new DatabaseSync(path);
    expect(second.prepare("SELECT v FROM x WHERE id='a'").get()).toMatchObject({ v: 'saved' });
    second.close();
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});
it('limits model and tool calls with deterministic budget errors', async () => {
  const logger = () => {};
  const empty = {
    text: '',
    calls: [{ id: 'x', name: 'get_task_run', arguments: { run_id: 'run_1' } }],
    finishReason: 'tool_calls' as const,
  };
  const result = await runTurn({
    mode: 'LIVE',
    apiKey: 'fake',
    runId: 'run_1',
    sessionId: 'ses_1',
    turnId: 'turn_1',
    question: '?',
    limits: { maxModels: 2, maxTools: 1 },
    logSink: logger,
    gateway: { complete: async () => empty },
  });
  expect(result).toMatchObject({ status: 'FAILED', errorCode: 'BUDGET_EXCEEDED' });
  expect(result.events.filter((e) => e.type === 'tool.completed')).toHaveLength(1);
});
it('model timeout reports failure and ignores late completion', async () => {
  let release!: () => void;
  const pending = new Promise<void>((r) => (release = r));
  const task = runTurn({
    mode: 'LIVE',
    apiKey: 'fake',
    runId: 'run_1',
    sessionId: 'ses_1',
    turnId: 'turn_1',
    question: '?',
    limits: { modelTimeoutMs: 10 },
    logSink: () => {},
    gateway: {
      complete: async () => {
        await pending;
        return { text: 'late', calls: [], finishReason: 'stop' };
      },
    },
  });
  const result = await task;
  release();
  expect(result).toMatchObject({ status: 'FAILED', errorCode: 'MODEL_TIMEOUT' });
  expect(result.events.filter((e) => e.type === 'turn.finished')).toHaveLength(1);
});
it('logger sink failure does not hide business result', () => {
  const logger = createLogger(() => {
    throw new ProbeError('SINK_FAILED');
  });
  expect(() =>
    logger.write('model.failed', { trace_id: newTraceId(), error_code: 'MODEL_ERROR' }, 'error'),
  ).not.toThrow();
});
it('transient model error retries once and counts both requests', async () => {
  let calls = 0;
  const lines: string[] = [];
  const result = await runTurn({
    mode: 'LIVE',
    apiKey: 'fake',
    runId: 'run_1',
    sessionId: 'ses_1',
    turnId: 'turn_1',
    question: '?',
    logSink: (s) => lines.push(s),
    limits: { maxModels: 2 },
    gateway: {
      complete: async () => {
        calls++;
        throw new ProbeError('MODEL_RATE_LIMIT');
      },
    },
  });
  expect(result).toMatchObject({ status: 'FAILED', errorCode: 'MODEL_RATE_LIMIT' });
  expect(calls).toBe(2);
  expect(lines.filter((l) => JSON.parse(l).event === 'model.started')).toHaveLength(2);
});
it('tool timeout produces a tool.failed event and does not hang', async () => {
  const real = createTools();
  const slow = {
    ...real,
    call: async (...args: Parameters<typeof real.call>): ReturnType<typeof real.call> =>
      args[0] === 'get_task_run' ? real.call(...args) : await new Promise(() => {}),
  };
  let request = 0;
  const result = await runTurn({
    mode: 'LIVE',
    apiKey: 'fake',
    runId: 'run_1',
    sessionId: 'ses_1',
    turnId: 'turn_1',
    question: '?',
    limits: { toolTimeoutMs: 10 },
    toolExecutor: slow,
    logSink: () => {},
    gateway: {
      complete: async () =>
        request++ === 0
          ? {
              text: '',
              calls: [{ id: 'x', name: 'get_task_logs', arguments: { run_id: 'run_1' } }],
              finishReason: 'tool_calls',
            }
          : { text: 'invalid', calls: [], finishReason: 'stop' },
    },
  });
  expect(result.events.some((e) => e.type === 'tool.failed' && e.code === 'TOOL_TIMEOUT')).toBe(
    true,
  );
});
it('multiple tool IDs remain separate; heartbeat and multiline data are accepted', async () => {
  const pieces = [
    ': heartbeat\n\n',
    'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"a","function":{"name":"get_task_run","arguments":"{\\"run_id\\":\\"run_1\\"}"}},{"index":1,"id":"b","function":{"name":"get_task_logs","arguments":"{\\"run_id\\":\\"run_1\\"}"}}]},"finish_reason":"tool_calls"}]}\n\n',
    'data: [DONE]\n\n',
  ];
  const result = await decodeChatStream(stream(pieces));
  expect(result.calls.map((c) => c.id)).toEqual(['a', 'b']);
});

import { vi } from 'vitest';
import { deepSeekGateway } from '../src/gateway.js';
it('gateway sends only the bounded official Chat Completions request', async () => {
  const fetchMock = vi.fn(async (...args: unknown[]) => {
    void args;
    return new Response(fixture.join(''), {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    });
  });
  vi.stubGlobal('fetch', fetchMock);
  try {
    const gateway = deepSeekGateway({
      apiKey: 'fake-key',
      model: 'deepseek-flash',
      baseUrl: 'https://api.deepseek.com',
      maxOutputTokens: 512,
    });
    let firstDeltaCount = 0;
    const value = await gateway.complete(
      [{ role: 'user', content: 'safe fixture' }],
      undefined,
      () => firstDeltaCount++,
    );
    expect(firstDeltaCount).toBe(1);
    expect(value.calls[0]?.name).toBe('get_task_logs');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, options] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.deepseek.com/chat/completions');
    const body = JSON.parse(String(options.body));
    expect(body).toMatchObject({
      model: 'deepseek-flash',
      stream: true,
      thinking: { type: 'disabled' },
      max_tokens: 512,
    });
    expect(body.tools).toHaveLength(4);
  } finally {
    vi.unstubAllGlobals();
  }
});
it('gateway classifies HTTP auth errors without exposing provider body', async () => {
  const fetchMock = vi.fn(async () => new Response('secret provider body', { status: 401 }));
  vi.stubGlobal('fetch', fetchMock);
  try {
    await expect(
      deepSeekGateway({
        apiKey: 'fake',
        model: 'deepseek-flash',
        baseUrl: 'https://api.deepseek.com',
        maxOutputTokens: 512,
      }).complete([{ role: 'user', content: 'x' }]),
    ).rejects.toMatchObject({ code: 'MODEL_AUTH_ERROR' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  } finally {
    vi.unstubAllGlobals();
  }
});

it('LIVE gateway contract replacement uses same tool lifecycle without network', async () => {
  let step = 0;
  const requests: Record<string, unknown>[][] = [];
  const gateway = {
    complete: async (messages: Record<string, unknown>[]) => {
      requests.push(structuredClone(messages));
      if (step++ === 0)
        return {
          text: '',
          calls: [{ id: 'live_call_1', name: 'get_task_logs', arguments: { run_id: 'run_1' } }],
          finishReason: 'tool_calls' as const,
        };
      const tool = messages.at(-1);
      const ids = JSON.parse(String(tool?.content)).evidence_ids as string[];
      return {
        text: JSON.stringify({
          summary: '日志显示读取超时',
          findings: [
            {
              cause: 'UPSTREAM_TIMEOUT',
              explanation: 'ReadTimeout',
              evidence_ids: [ids[0]],
              evidence_status: 'SUPPORTED',
            },
          ],
          missing_information: [],
          next_steps: ['检查上游'],
          proposed_action: null,
        }),
        calls: [],
        finishReason: 'stop' as const,
      };
    },
  };
  const result = await runTurn({
    mode: 'LIVE',
    apiKey: 'fake',
    runId: 'run_1',
    sessionId: 'ses_1',
    turnId: 'turn_1',
    question: '?',
    gateway,
    logSink: () => {},
  });
  expect(result.status).toBe('COMPLETED');
  expect(result.providerMode).toBe('LIVE');
  expect(requests).toHaveLength(2);
  expect(requests[1]?.at(-1)?.role).toBe('tool');
  expect(result.events.filter((e) => e.type === 'turn.finished')).toHaveLength(1);
});
it('whole-turn timeout is reported distinctly from user cancellation', async () => {
  const result = await runTurn({
    mode: 'LIVE',
    apiKey: 'fake',
    runId: 'run_1',
    sessionId: 'ses_1',
    turnId: 'turn_1',
    question: '?',
    limits: { turnTimeoutMs: 10, modelTimeoutMs: 1000 },
    logSink: () => {},
    gateway: { complete: async () => await new Promise(() => {}) },
  });
  expect(result).toMatchObject({ status: 'FAILED', errorCode: 'TURN_TIMEOUT' });
});
it('model receives the bound current run ID and state before tool selection', async () => {
  let firstMessages: Record<string, unknown>[] = [];
  const result = await runTurn({
    mode: 'LIVE',
    apiKey: 'fake',
    runId: 'run_1',
    sessionId: 'ses_1',
    turnId: 'turn_1',
    question: 'why?',
    logSink: () => {},
    gateway: {
      complete: async (messages) => {
        firstMessages = messages;
        return { text: '{}', calls: [], finishReason: 'stop' };
      },
    },
  });
  const serialized = JSON.stringify(firstMessages);
  expect(serialized).toContain('run_1');
  expect(serialized).toContain('ReadTimeout');
  expect(result.status).toBe('FAILED');
});

it('records first meaningful streamed delta without logging response text', async () => {
  const lines: string[] = [];
  const result = await runTurn({
    mode: 'LIVE',
    apiKey: 'fake',
    runId: 'run_1',
    sessionId: 'ses_1',
    turnId: 'turn_1',
    question: 'why?',
    logSink: (s) => lines.push(s),
    gateway: {
      complete: async (_messages, _signal, onFirstDelta) => {
        onFirstDelta?.();
        return {
          text: JSON.stringify({
            summary: 'checked',
            findings: [],
            missing_information: [],
            next_steps: [],
            proposed_action: null,
          }),
          calls: [],
          finishReason: 'stop',
        };
      },
    },
  });
  expect(result.status).toBe('COMPLETED');
  const completed = lines
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .find((line) => line.event === 'model.completed');
  expect(completed?.first_event_ms).toEqual(expect.any(Number));
  expect(JSON.stringify(completed)).not.toContain('checked');
});
