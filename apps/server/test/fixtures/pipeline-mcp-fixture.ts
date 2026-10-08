import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { z } from 'zod';
import {
  pipelineTools,
  toolSchemas,
  toolScopeSchema,
  type PipelineToolName,
} from '../../src/pipeline-tools.js';
import { readPipelineTool } from '../../src/pipeline-tool-reader.js';

const scope = toolScopeSchema.parse(
  JSON.parse(Buffer.from(process.env.FLOWLENS_MCP_SCOPE!, 'base64').toString()),
);
const mode = process.argv[2];
if (process.env.MODEL_API_KEY || process.env.MODEL_BASE_URL || process.env.NODE_OPTIONS)
  throw new Error('UNEXPECTED_INHERITED_SECRET_OR_NODE_OPTIONS');
const handle = serveStdio(
  () => {
    const server = new McpServer({ name: 'flowlens-pipeline-readonly', version: '1.0.0' });
    for (const tool of pipelineTools) {
      if (mode === 'missing' && tool.name === 'get_logs') continue;
      const name = tool.name as PipelineToolName;
      server.registerTool(
        name,
        {
          description: tool.description,
          inputSchema:
            mode === 'schema' && name === 'get_sql'
              ? z.object({ path: z.string().optional() })
              : toolSchemas[name],
        },
        async (raw: unknown, ctx) => {
          if (mode === 'exit') process.exit(73);
          if (mode === 'protocol') {
            process.stdout.write('not JSON-RPC\n');
            return new Promise(() => {});
          }
          if (mode === 'stall')
            return new Promise((_, reject) =>
              ctx.mcpReq.signal.addEventListener('abort', () => reject(new Error('cancelled')), {
                once: true,
              }),
            );
          if (mode === 'business')
            return {
              isError: true,
              content: [
                {
                  type: 'text' as const,
                  text: JSON.stringify({ error_code: 'TEST_TOOL_FAILURE' }),
                },
              ],
            };
          const result = readPipelineTool(scope, name, toolSchemas[name].parse(raw));
          if (mode === 'late') await new Promise((resolve) => setTimeout(resolve, 300));
          if (mode === 'source')
            result.source.execution_id = '00000000-0000-4000-8000-000000000000';
          if (mode === 'shape')
            return {
              content: [],
              structuredContent: { output: { unexpected: true }, source: result.source },
            };
          if (mode === 'oversize')
            return {
              content: [{ type: 'text' as const, text: 'x'.repeat(25 * 1024) }],
              structuredContent: result,
            };
          return { content: [], structuredContent: result };
        },
      );
    }
    if (mode === 'extra')
      server.registerTool('shell', { inputSchema: z.strictObject({}) }, async () => ({
        content: [],
      }));
    if (mode === 'paginated')
      server.server.setRequestHandler('tools/list', async (request) => ({
        tools: pipelineTools
          .slice(
            request.params?.cursor === 'second' ? 3 : 0,
            request.params?.cursor === 'second' ? 6 : 3,
          )
          .map((tool) => ({
            name: tool.name,
            description: tool.description,
            inputSchema: tool.parameters,
          })),
        ...(request.params?.cursor === 'second' ? {} : { nextCursor: 'second' }),
      }));
    return server;
  },
  { legacy: 'reject' },
);
process.stdin.once('end', () => {
  void handle.close();
});
