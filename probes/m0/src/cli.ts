import { runTurn } from './agent.js';
const mode = process.argv[2];
if (mode !== 'mock' && mode !== 'failure' && mode !== 'live') {
  process.stderr.write('Usage: node dist/cli.js mock|failure|live\n');
  process.exitCode = 2;
} else {
  const liveRequests = Number(process.env.FLOWLENS_LIVE_MAX_REQUESTS);
  const liveOutput = Number(process.env.FLOWLENS_LIVE_MAX_OUTPUT_TOKENS ?? 1024);
  if (
    mode === 'live' &&
    (process.env.FLOWLENS_LIVE_APPROVED !== '1' ||
      !Number.isInteger(liveRequests) ||
      liveRequests < 1 ||
      liveRequests > 12 ||
      !Number.isInteger(liveOutput) ||
      liveOutput < 1 ||
      liveOutput > 2048)
  ) {
    process.stderr.write(
      'LIVE requires FLOWLENS_LIVE_APPROVED=1, FLOWLENS_LIVE_MAX_REQUESTS (1-12), FLOWLENS_LIVE_MAX_OUTPUT_TOKENS (1-2048), plus a local MODEL_API_KEY. No request sent.\n',
    );
    process.exitCode = 2;
  } else {
    const input = {
      mode: mode === 'live' ? ('LIVE' as const) : ('MOCK' as const),
      runId: 'run_1',
      sessionId: 'm0_session',
      turnId: 'm0_turn',
      question: '这次运行为什么失败？请查证据。',
      apiKey: process.env.MODEL_API_KEY,
      model: process.env.MODEL_NAME ?? 'deepseek-flash',
      baseUrl: process.env.MODEL_BASE_URL ?? 'https://api.deepseek.com',
      maxOutputTokens: mode === 'live' ? liveOutput : 1024,
      limits: mode === 'live' ? { maxModels: liveRequests } : undefined,
      mockInvalidEvidence: mode === 'failure',
    };
    const result = await runTurn(input);
    process.stdout.write(
      JSON.stringify({
        status: result.status,
        error_code: result.errorCode ?? null,
        trace_id: result.traceId,
        provider_mode: result.providerMode,
        events: result.events.map((e) => ({
          type: e.type,
          tool_call_id: e.tool_call_id,
          status: e.status,
          code: e.code,
          ...(e.type === 'diagnosis.completed' ? { result: e.result } : {}),
        })),
      }) + '\n',
    );
    if (result.status !== 'COMPLETED') process.exitCode = 1;
  }
}
