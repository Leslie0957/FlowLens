import { expect, it, vi } from 'vitest';
import { deepSeekGateway } from '../src/model-gateway.js';

function stream(packets: unknown[]) {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const packet of packets)
          controller.enqueue(new TextEncoder().encode('data: ' + JSON.stringify(packet) + '\n\n'));
        controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
        controller.close();
      },
    }),
  );
}

it('Pipeline can opt out of forced JSON response mode while preserving content and native fragmented tool calls', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(
      stream([
        { choices: [{ delta: { content: '{"investigation":{"question":"inspect SQL"}}' } }] },
        {
          choices: [
            {
              delta: {
                tool_calls: [
                  { index: 0, id: 'call_sql', function: { name: 'get_sql', arguments: '{' } },
                ],
              },
            },
          ],
        },
        {
          choices: [
            {
              delta: { tool_calls: [{ index: 0, function: { arguments: '}' } }] },
              finish_reason: 'tool_calls',
            },
          ],
        },
      ]),
    ),
  );
  try {
    const tools = [
      { name: 'get_sql', description: 'bound SQL', parameters: { type: 'object', properties: {} } },
    ];
    const r = await deepSeekGateway({
      apiKey: 'test-only',
      model: 'test',
      baseUrl: 'https://api.deepseek.com',
      maxOutputTokens: 2048,
      jsonMode: false,
      tools,
    }).complete([], new AbortController().signal);
    const payload = JSON.parse(String(vi.mocked(fetch).mock.calls[0]?.[1]?.body));
    expect(payload).not.toHaveProperty('response_format');
    expect(payload.tool_choice).toBe('auto');
    expect(payload.tools[0].function.name).toBe('get_sql');
    expect(r.calls).toEqual([{ id: 'call_sql', name: 'get_sql', arguments: {} }]);
    expect(r.text).toContain('investigation');
  } finally {
    vi.unstubAllGlobals();
  }
});

it('tool-like text is retained as text and never converted to executable tool calls', async () => {
  const text = '{"investigation":{}}\n<｜｜DSML｜｜ invoke name="shell">';
  vi.stubGlobal(
    'fetch',
    vi
      .fn()
      .mockResolvedValue(
        stream([{ choices: [{ delta: { content: text }, finish_reason: 'stop' }] }]),
      ),
  );
  try {
    const r = await deepSeekGateway({
      apiKey: 'test-only',
      model: 'test',
      baseUrl: 'https://api.deepseek.com',
      maxOutputTokens: 2048,
      jsonMode: false,
    }).complete([], new AbortController().signal);
    expect(r.calls).toEqual([]);
    expect(r.text).toBe(text);
  } finally {
    vi.unstubAllGlobals();
  }
});
