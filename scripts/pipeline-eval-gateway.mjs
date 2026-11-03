import { appendFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { decodeChatStream } from '../apps/server/src/model-stream.ts';
import { ProbeError } from '../apps/server/src/model-error.ts';
import { pipelineTools } from '../apps/server/src/pipeline-tools.ts';
import { createHash } from 'node:crypto';

export const fail = (code) => new ProbeError(code);
export const FIRST_LIMITS = Object.freeze({
  requests_per_case: 6,
  requests_total: 24,
  output_tokens: 1024,
  tools_per_case: 8,
  request_ms: 30000,
  case_ms: 90000,
  run_ms: 360000,
  context_bytes: 32768,
  request_bytes: 65536,
  response_bytes: 262144,
});
export const EFFECT_LIMITS = Object.freeze({
  ...FIRST_LIMITS,
  requests_per_case: 20,
  requests_total: 80,
  output_tokens: 2048,
  tools_per_case: 30,
  request_ms: 60000,
  case_ms: 300000,
  run_ms: 1200000,
});
export const LIMIT_PROFILES = Object.freeze({ first: FIRST_LIMITS, effect: EFFECT_LIMITS });
export function checkedLimits(overrides = {}, profile = 'first') {
  if (!Object.hasOwn(LIMIT_PROFILES, profile)) throw fail('INVALID_LIMIT_PROFILE');
  const ceiling = LIMIT_PROFILES[profile];
  if (Object.keys(overrides).some((k) => !Object.hasOwn(ceiling, k))) throw fail('UNKNOWN_LIMIT');
  const result = { ...ceiling, ...overrides };
  for (const [key, value] of Object.entries(result))
    if (!Number.isSafeInteger(value) || value < 1 || value > ceiling[key])
      throw fail('INVALID_LIMIT');
  return result;
}
export function requestLedger(ids, limits) {
  let total = 0;
  const perCase = Object.fromEntries(ids.map((id) => [id, 0]));
  return {
    reserve(id) {
      if (!(id in perCase)) throw fail('INVALID_CASE_ID');
      if (total >= limits.requests_total) throw fail('EVAL_GLOBAL_REQUEST_LIMIT');
      if (perCase[id] >= limits.requests_per_case) throw fail('EVAL_CASE_REQUEST_LIMIT');
      perCase[id]++;
      return ++total;
    },
    snapshot: () => ({ total, per_case: { ...perCase } }),
  };
}

function streamMetadata(raw) {
  const meta = {
    model_reported: null,
    response_id: null,
    system_fingerprint: null,
    model_revision: null,
    usage: null,
  };
  for (const event of raw.replaceAll('\r\n', '\n').split('\n\n')) {
    const value = event
      .split('\n')
      .filter((s) => s.startsWith('data:'))
      .map((s) => s.slice(5).trimStart())
      .join('\n');
    if (!value || value === '[DONE]') continue;
    try {
      const p = JSON.parse(value);
      if (typeof p.model === 'string') meta.model_reported = p.model;
      if (typeof p.id === 'string') meta.response_id = p.id;
      if (typeof p.system_fingerprint === 'string') meta.system_fingerprint = p.system_fingerprint;
      if (typeof p.model_revision === 'string') meta.model_revision = p.model_revision;
      if (p.usage && typeof p.usage === 'object') meta.usage = p.usage;
    } catch {
      /* incomplete packets remain in the raw trace */
    }
  }
  return meta;
}

// Evaluation-only transport; reuse the production SSE decoder and native tool
// schema. No changes to production gateway/Agent or global fetch monkeypatches.
export function evaluationGateway({
  model,
  apiKey,
  caseId,
  limits,
  ledger,
  directory,
  signal: outerSignal,
  transport = globalThis.fetch,
  simulated = false,
  records,
  beforeDispatch = () => {},
  runDeadline = Infinity,
  caseDeadline = Infinity,
}) {
  if (typeof apiKey !== 'string' || !apiKey.trim()) throw fail('MODEL_NOT_CONFIGURED');
  let local = 0;
  const checkDeadline = () => {
    if (performance.now() >= runDeadline) throw fail('EVAL_RUN_TIMEOUT');
    if (performance.now() >= caseDeadline) throw fail('EVAL_CASE_TIMEOUT');
  };
  return {
    async complete(messages, agentSignal, onDelta, onFirstDelta, options) {
      const body = {
        model,
        messages,
        tools: pipelineTools.map((t) => ({ type: 'function', function: t })),
        tool_choice: options?.toolChoice ?? 'auto',
        ...(options?.jsonMode === true ? { response_format: { type: 'json_object' } } : {}),
        thinking: { type: 'disabled' },
        max_tokens: limits.output_tokens,
        stream: true,
        stream_options: { include_usage: true },
      };
      const serialized = JSON.stringify(body);
      if (Buffer.byteLength(serialized) > limits.request_bytes)
        throw fail('EVAL_REQUEST_BYTE_LIMIT');
      const timeout = new AbortController();
      const signal = AbortSignal.any([agentSignal, outerSignal, timeout.signal].filter(Boolean));
      if (signal.aborted) throw signal.reason ?? fail('EVAL_CANCELLED');
      beforeDispatch();
      checkDeadline();
      const number = ledger.reserve(caseId);
      const stem = `${caseId}-wire-${++local}`;
      const entry = {
        case_id: caseId,
        global_request: number,
        local_request: local,
        transport: simulated ? 'OFFLINE_STUB' : 'LIVE_API',
        state: 'RESERVED',
        dispatched: false,
        requested_model: model,
        request: body,
        started_at: new Date().toISOString(),
        prompt_sha256: createHash('sha256')
          .update(
            messages
              .filter((m) => m.role === 'system')
              .map((m) => m.content)
              .join('\n'),
          )
          .digest('hex'),
        tools_sha256: createHash('sha256').update(JSON.stringify(body.tools)).digest('hex'),
        http_status: null,
        provider_request_id: null,
        ...streamMetadata(''),
        cost: null,
        usage_status: simulated ? 'NOT_APPLICABLE_SIMULATION' : 'UNKNOWN',
      };
      records.push(entry);
      const save = () =>
        writeFileSync(join(directory, stem + '.json'), JSON.stringify(entry, null, 2));
      const rawPath = join(directory, stem + '.sse');
      writeFileSync(rawPath, '');
      save();
      const started = performance.now();
      let raw = '',
        byteCount = 0,
        reader,
        ended = false;
      const timer = setTimeout(
        () => timeout.abort(fail('EVAL_REQUEST_TIMEOUT')),
        limits.request_ms,
      );
      let abortHandler;
      const aborted = new Promise((_, reject) => {
        abortHandler = () => reject(signal.reason ?? fail('EVAL_CANCELLED'));
        signal.addEventListener('abort', abortHandler, { once: true });
      });
      const work = async () => {
        checkDeadline();
        if (signal.aborted) throw signal.reason ?? fail('EVAL_CANCELLED');
        entry.dispatched = true;
        entry.state = 'DISPATCHING';
        save();
        const response = await transport('https://api.deepseek.com/chat/completions', {
          method: 'POST',
          signal,
          headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
          body: serialized,
        });
        if (signal.aborted || ended) {
          response.body?.cancel().catch(() => {});
          throw signal.reason ?? fail('EVAL_CANCELLED');
        }
        entry.http_status = response.status;
        entry.provider_request_id = response.headers.get('x-request-id');
        save();
        if (!response.ok) {
          response.body?.cancel().catch(() => {});
          throw fail(
            [401, 403].includes(response.status)
              ? 'MODEL_AUTH_ERROR'
              : response.status === 429
                ? 'MODEL_RATE_LIMIT'
                : response.status >= 500
                  ? 'MODEL_UNAVAILABLE'
                  : 'MODEL_REQUEST_ERROR',
          );
        }
        if (!response.body) throw fail('PROTOCOL_ERROR');
        reader = response.body.getReader();
        const decoder = new TextDecoder();
        const chunks = async function* () {
          while (true) {
            const chunk = await reader.read();
            if (signal.aborted || ended) throw signal.reason ?? fail('EVAL_CANCELLED');
            if (chunk.done) break;
            byteCount += chunk.value.byteLength;
            if (byteCount > limits.response_bytes) throw fail('EVAL_RESPONSE_BYTE_LIMIT');
            raw += decoder.decode(chunk.value, { stream: true });
            appendFileSync(rawPath, chunk.value);
            yield chunk.value;
          }
          raw += decoder.decode();
        };
        return decodeChatStream(chunks(), onFirstDelta, onDelta);
      };
      try {
        const completion = await Promise.race([work(), aborted]);
        if (signal.aborted) throw signal.reason ?? fail('EVAL_CANCELLED');
        entry.state = 'COMPLETED';
        entry.completion = completion;
        return completion;
      } catch (error) {
        entry.state = 'FAILED';
        entry.error = {
          code: signal.aborted
            ? (signal.reason?.code ?? 'EVAL_CANCELLED')
            : (error.code ?? 'MODEL_NETWORK_ERROR'),
          message: String(error.message ?? error).replaceAll(apiKey, '[REDACTED]'),
        };
        throw fail(entry.error.code);
      } finally {
        ended = true;
        clearTimeout(timer);
        signal.removeEventListener('abort', abortHandler);
        if (reader) reader.cancel().catch(() => {});
        Object.assign(entry, streamMetadata(raw));
        entry.usage_status = simulated
          ? 'NOT_APPLICABLE_SIMULATION'
          : entry.usage
            ? 'REPORTED'
            : 'UNKNOWN_POSSIBLY_BILLED';
        entry.elapsed_ms = performance.now() - started;
        save();
      }
    },
  };
}
