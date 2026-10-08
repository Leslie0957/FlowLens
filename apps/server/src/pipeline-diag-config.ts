import type { PipelineDiagnosisLimits } from '@flowlens/contracts';
import { LocalError } from './local-execution.js';

const settings = {
  max_requests: ['FLOWLENS_PIPELINE_DIAG_MAX_REQUESTS', 100],
  max_tool_calls: ['FLOWLENS_PIPELINE_DIAG_MAX_TOOL_CALLS', 200],
  timeout_ms: ['FLOWLENS_PIPELINE_DIAG_TIMEOUT_MS', 900000],
  max_stall_rounds: ['FLOWLENS_PIPELINE_DIAG_MAX_STALL_ROUNDS', 3],
  max_context_bytes: ['FLOWLENS_PIPELINE_DIAG_MAX_CONTEXT_BYTES', 262144],
} as const;

export function diagnosisLimits(
  overrides: Partial<PipelineDiagnosisLimits> = {},
): PipelineDiagnosisLimits {
  const result = {} as PipelineDiagnosisLimits;
  for (const key of Object.keys(settings) as (keyof PipelineDiagnosisLimits)[]) {
    const [env, fallback] = settings[key];
    const raw = overrides[key] ?? process.env[env] ?? fallback;
    const value = Number(raw);
    if (!/^\d+$/.test(String(raw)) || !Number.isSafeInteger(value) || value < 1) {
      throw new LocalError('INVALID_DIAG_CONFIG', 400);
    }
    result[key] = value;
  }
  return result;
}

// Only actual output participates. Evidence UUIDs, call IDs and trace timestamps
// live outside output; business timestamps within output remain significant.
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value !== null && typeof value === 'object') {
    const object = value as Record<string, unknown>;
    return (
      '{' +
      Object.keys(object)
        .sort()
        .map((key) => JSON.stringify(key) + ':' + canonical(object[key]))
        .join(',') +
      '}'
    );
  }
  return JSON.stringify(value);
}
