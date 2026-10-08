import { decodeChatStream, type Completion } from './stream.js';
import { ProbeError } from './error.js';
import { toolDescriptions } from './tools.js';

export interface ModelGateway {
  complete(
    messages: Record<string, unknown>[],
    signal?: AbortSignal,
    onFirstDelta?: () => void,
  ): Promise<Completion>;
}
export function deepSeekGateway(config: {
  apiKey: string;
  model: string;
  baseUrl: string;
  maxOutputTokens: number;
}): ModelGateway {
  const root = config.baseUrl.replace(/\/$/, '');
  if (root !== 'https://api.deepseek.com')
    throw new ProbeError('INVALID_CONFIG', 'Only official DeepSeek endpoint is enabled in M0');
  return {
    async complete(messages, signal, onFirstDelta) {
      let response: Response;
      try {
        response = await fetch(root + '/chat/completions', {
          method: 'POST',
          signal,
          headers: { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: config.model,
            messages,
            tools: toolDescriptions.map((t) => ({ type: 'function', function: t })),
            tool_choice: 'auto',
            thinking: { type: 'disabled' },
            max_tokens: config.maxOutputTokens,
            stream: true,
            stream_options: { include_usage: true },
          }),
        });
      } catch {
        if (signal?.aborted) throw new ProbeError('CANCELLED');
        throw new ProbeError('MODEL_NETWORK_ERROR');
      }
      if (!response.ok) {
        const code =
          response.status === 401 || response.status === 403
            ? 'MODEL_AUTH_ERROR'
            : response.status === 429
              ? 'MODEL_RATE_LIMIT'
              : response.status >= 500
                ? 'MODEL_UNAVAILABLE'
                : 'MODEL_REQUEST_ERROR';
        // Do not read/echo provider body; it can contain request content.
        throw new ProbeError(code);
      }
      if (!response.body) throw new ProbeError('PROTOCOL_ERROR', 'Missing response stream');
      return decodeChatStream(response.body, onFirstDelta);
    },
  };
}
