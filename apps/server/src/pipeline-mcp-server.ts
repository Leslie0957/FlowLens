import { McpServer, type ServerContext } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import {
  pipelineTools,
  toolSchemas,
  toolScopeSchema,
  type PipelineToolName,
} from './pipeline-tools.js';
import { readPipelineTool } from './pipeline-tool-reader.js';
import { errorCode } from './model-error.js';
import { LocalError } from './local-execution.js';

const scope = toolScopeSchema.parse(
  JSON.parse(Buffer.from(process.env.FLOWLENS_MCP_SCOPE ?? '', 'base64').toString('utf8')),
);
const handle = serveStdio(
  () => {
    const server = new McpServer({ name: 'flowlens-pipeline-readonly', version: '1.0.0' });
    for (const tool of pipelineTools) {
      const name = tool.name as PipelineToolName;
      server.registerTool(
        name,
        {
          description: tool.description,
          inputSchema: toolSchemas[name],
          annotations: {
            readOnlyHint: true,
            destructiveHint: false,
            idempotentHint: true,
            openWorldHint: false,
          },
        },
        async (args: unknown, context: ServerContext) => {
          try {
            if (context.mcpReq.signal.aborted) throw new LocalError('MCP_CANCELLED', 409);
            return {
              content: [],
              structuredContent: readPipelineTool(scope, name, toolSchemas[name].parse(args)),
            };
          } catch (e) {
            const code = errorCode(e);
            return {
              isError: true,
              content: [
                {
                  type: 'text' as const,
                  text: JSON.stringify({ error_code: code, message: code }),
                },
              ],
            };
          }
        },
      );
    }
    return server;
  },
  { legacy: 'reject', onerror: (e) => console.error('MCP_PROTOCOL_ERROR', errorCode(e)) },
);
// Pipe EOF also covers abrupt parent exit. No diagnostic state lives here.
process.stdin.once('end', () => {
  void handle.close();
});
for (const signal of ['SIGTERM', 'SIGINT'] as const)
  process.once(signal, () => {
    void handle.close().finally(() => process.exit(0));
  });
