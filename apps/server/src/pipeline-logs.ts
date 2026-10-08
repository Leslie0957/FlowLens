import { logReadArgsSchema, type PipelineExecution, type LogReadOutput } from '@flowlens/contracts';
import { LocalError } from './local-execution.js';

export const TOOL_OUTPUT_BYTES = 20 * 1024;

// Cursor positions always refer to the immutable execution's original array.
export function readLogs(
  logs: PipelineExecution['logs'],
  raw: Record<string, unknown>,
  maxBytes = TOOL_OUTPUT_BYTES,
): LogReadOutput {
  const parsed = logReadArgsSchema.safeParse(raw);
  if (!parsed.success) throw new LocalError('INVALID_ARGUMENTS', 400);
  const args = parsed.data;
  const before = args.before_seq ?? logs.length + 1;
  if (before > logs.length + 1) throw new LocalError('LOG_CURSOR_INVALID', 400);
  const matched = logs
    .map((log, index) => ({ ...log, seq: index + 1 }))
    .filter(
      (log) =>
        log.seq < before &&
        (!args.step || log.step === args.step) &&
        (!args.level || log.level === args.level),
    );
  const output: LogReadOutput = {
    logs: [],
    has_more: false,
    next_before_seq: null,
    matched_count: matched.length,
    truncated_by_bytes: false,
  };
  for (
    let index = matched.length - 1;
    index >= 0 && output.logs.length < (args.limit ?? 20);
    index--
  ) {
    const candidate: LogReadOutput = {
      ...output,
      logs: [matched[index]!, ...output.logs],
      has_more: index > 0,
      next_before_seq: index > 0 ? matched[index]!.seq : null,
    };
    // Reserve the longer `false` spelling; changing the truncation flag is safe.
    if (Buffer.byteLength(JSON.stringify(candidate), 'utf8') > maxBytes) {
      if (!output.logs.length) throw new LocalError('LOG_ENTRY_TOO_LARGE', 409);
      output.truncated_by_bytes = true;
      break;
    }
    Object.assign(output, candidate);
  }
  return output;
}
