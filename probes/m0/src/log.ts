import { randomUUID } from 'node:crypto';
const SAFE_ID = /^[a-zA-Z0-9_-]{8,80}$/;
export function newTraceId(inbound?: string): string {
  return inbound && SAFE_ID.test(inbound) ? inbound : randomUUID();
}
export type LogField = string | number | boolean | null | undefined;
export type LogSink = (line: string) => void;
const fields = [
  'trace_id',
  'request_id',
  'run_id',
  'session_id',
  'turn_id',
  'tool_call_id',
  'provider_mode',
  'model',
  'prompt_version',
  'duration_ms',
  'first_event_ms',
  'error_code',
  'usage',
] as const;
export function createLogger(sink: LogSink = (line) => process.stderr.write(line + '\n')) {
  return {
    write(
      event: string,
      input: Record<string, unknown> = {},
      level: 'info' | 'warn' | 'error' = 'info',
    ) {
      const record: Record<string, LogField> = {
        timestamp: new Date().toISOString(),
        level,
        module: 'm0-probe',
        event: event.slice(0, 64),
        outcome: level === 'error' ? 'failure' : 'ok',
      };
      for (const key of fields) {
        const value = input[key];
        if (typeof value === 'string') record[key] = value.slice(0, 120).replace(/[\r\n\t]/g, ' ');
        else if (typeof value === 'number' && Number.isFinite(value)) record[key] = value;
        else if (typeof value === 'boolean') record[key] = value;
      }
      try {
        sink(JSON.stringify(record));
      } catch {
        /* ordinary diagnostics may not replace business result */
      }
    },
  };
}
