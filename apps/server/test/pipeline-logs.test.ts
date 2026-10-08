import { expect, it } from 'vitest';
import { readLogs, TOOL_OUTPUT_BYTES } from '../src/pipeline-logs.js';
import type { PipelineExecution } from '@flowlens/contracts';

const logs = (count: number): PipelineExecution['logs'] =>
  Array.from({ length: count }, (_, i) => ({
    at: '2026-10-08T00:00:00Z',
    step: i % 2 ? 'validate' : 'query',
    level: i % 3 ? 'INFO' : 'ERROR',
    message: `日志${i + 1}`,
  }));

it('pages every original sequence exactly once, filters before paging, and keeps stable empty/final pages', () => {
  const input = logs(53);
  let before: number | undefined;
  const seen: number[] = [];
  do {
    const page = readLogs(input, before ? { before_seq: before } : {});
    expect(readLogs(input, before ? { before_seq: before } : {})).toEqual(page);
    expect(page.logs.map((l) => l.seq)).toEqual(
      [...page.logs.map((l) => l.seq)].sort((a, b) => a - b),
    );
    seen.push(...page.logs.map((l) => l.seq));
    before = page.next_before_seq ?? undefined;
    expect(page.has_more).toBe(!!before);
  } while (before);
  expect(seen.sort((a, b) => a - b)).toEqual(Array.from({ length: 53 }, (_, i) => i + 1));
  const page = readLogs(input, { before_seq: 30, step: 'query', level: 'ERROR', limit: 3 });
  expect(page.logs.map((l) => l.seq)).toEqual([13, 19, 25]);
  expect(page.matched_count).toBe(5);
  expect(page.next_before_seq).toBe(13);
  expect(readLogs(input, { before_seq: 1 })).toMatchObject({
    logs: [],
    has_more: false,
    next_before_seq: null,
  });
  expect(readLogs(input, { step: 'verification' }).logs).toEqual([]);
  expect(readLogs([], {})).toMatchObject({ logs: [], matched_count: 0 });
});

it('rejects unsafe inputs and impossible cursors instead of silently restarting', () => {
  for (const args of [
    { limit: 0 },
    { limit: 101 },
    { limit: 1.2 },
    { before_seq: 0 },
    { before_seq: -1 },
    { before_seq: 2.5 },
    { before_seq: Number.MAX_SAFE_INTEGER + 1 },
    { step: 'shell' },
    { level: 'FATAL' },
    { execution_id: 'other' },
    { project_id: 'other' },
    { sql: 'select 1' },
  ]) {
    expect(() => readLogs(logs(5), args)).toThrow('INVALID_ARGUMENTS');
  }
  expect(() => readLogs(logs(5), { before_seq: 7 })).toThrow('LOG_CURSOR_INVALID');
});

it('fits UTF-8 output including metadata and continues without losing a truncated page', () => {
  const input = logs(30).map((l) => ({ ...l, message: '证据'.repeat(900) }));
  let before: number | undefined;
  const seen: number[] = [];
  do {
    const page = readLogs(input, { limit: 100, ...(before ? { before_seq: before } : {}) });
    expect(Buffer.byteLength(JSON.stringify(page), 'utf8')).toBeLessThanOrEqual(TOOL_OUTPUT_BYTES);
    expect(page.logs.every((l) => l.message === input[0]!.message)).toBe(true);
    if (page.has_more) expect(page.truncated_by_bytes).toBe(true);
    seen.push(...page.logs.map((l) => l.seq));
    before = page.next_before_seq ?? undefined;
  } while (before);
  expect(new Set(seen).size).toBe(30);
  expect(() => readLogs([{ ...input[0]!, message: '证据'.repeat(4000) }], {})).toThrow(
    'LOG_ENTRY_TOO_LARGE',
  );
});
