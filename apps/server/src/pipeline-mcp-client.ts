import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { fileURLToPath } from 'node:url';
import { canonical } from './pipeline-diag-config.js';
import { LocalError } from './local-execution.js';
import { TOOL_OUTPUT_BYTES } from './pipeline-logs.js';
import { sha } from './pipeline-data.js';
import {
  pipelineTools,
  toolSchemas,
  toolSource,
  toolResponseSchema,
  type PipelineToolScope,
  type PipelineToolName,
} from './pipeline-tools.js';
import type { ToolDescription } from './tool-registry.js';

export type McpOptions = { entryPath?: string; entryArgs?: string[]; timeoutMs?: number };
function normalizedSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizedSchema);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => key !== '$schema')
        .map(([key, item]) => [key, normalizedSchema(item)]),
    );
  return value;
}
export class PipelineMcpClient {
  readonly client = new Client(
    { name: 'flowlens-pipeline-agent', version: '1.0.0' },
    { versionNegotiation: { mode: { pin: '2026-07-28' } } },
  );
  readonly transport: StdioClientTransport;
  private closed = false;
  private protocolError = false;
  private disposing = false;
  private tools: ToolDescription[] = [];
  private timeoutMs: number;
  constructor(
    readonly scope: PipelineToolScope,
    options: McpOptions = {},
  ) {
    this.timeoutMs = options.timeoutMs ?? 5000;
    const development = import.meta.url.endsWith('.ts');
    const entry =
      options.entryPath ??
      fileURLToPath(
        new URL(
          development ? './pipeline-mcp-server.ts' : './pipeline-mcp-server.js',
          import.meta.url,
        ),
      );
    this.transport = new StdioClientTransport({
      command: process.execPath,
      args: [
        ...(entry.endsWith('.ts') ? ['--import', 'tsx'] : []),
        entry,
        ...(options.entryArgs ?? []),
      ],
      env: { FLOWLENS_MCP_SCOPE: Buffer.from(JSON.stringify(scope)).toString('base64') },
      stderr: 'pipe',
      maxBufferSize: 128 * 1024,
    });
    // Drain diagnostic stderr without propagating model credentials or logging paths.
    this.transport.stderr?.on('data', () => {});
    this.client.onclose = () => {
      this.closed = true;
    };
    this.client.onerror = () => {
      if (!this.disposing) this.protocolError = true;
    };
  }
  get pid() {
    return this.transport.pid;
  }
  private failure(error: unknown, signal: AbortSignal | undefined, fallback: string): never {
    if (error instanceof LocalError) throw error;
    if (signal?.aborted) throw new LocalError('MCP_CANCELLED', 409);
    if (this.closed && !this.disposing) throw new LocalError('MCP_PROCESS_EXITED', 502);
    const message = error instanceof Error ? error.message : '';
    if (this.protocolError) throw new LocalError('MCP_PROTOCOL_ERROR', 502);
    if (/timeout|timed out/i.test(message)) throw new LocalError('MCP_TIMEOUT', 504);
    throw new LocalError(fallback, 502);
  }
  async connect(signal?: AbortSignal) {
    try {
      await this.client.connect(this.transport, { signal, timeout: this.timeoutMs });
    } catch (e) {
      await this.close();
      this.failure(e, signal, 'MCP_CONNECT_FAILED');
    }
    try {
      const descriptions: ToolDescription[] = [],
        cursors = new Set<string>();
      let cursor: string | undefined;
      do {
        const result = await this.client.listTools(cursor ? { cursor } : undefined, {
          signal,
          timeout: this.timeoutMs,
        });
        for (const tool of result.tools) {
          const allowed = pipelineTools.find((t) => t.name === tool.name);
          if (
            !allowed ||
            descriptions.some((t) => t.name === tool.name) ||
            canonical(normalizedSchema(tool.inputSchema)) !==
              canonical(normalizedSchema(allowed.parameters)) ||
            !tool.description ||
            tool.description.length > 2000
          )
            throw new LocalError('MCP_TOOL_DEFINITION_INVALID', 502);
          descriptions.push({
            name: tool.name,
            description: tool.description,
            parameters: tool.inputSchema,
          });
        }
        cursor = result.nextCursor;
        if (cursor) {
          if (cursors.has(cursor) || cursors.size >= 32)
            throw new LocalError('MCP_DISCOVERY_FAILED', 502);
          cursors.add(cursor);
        }
      } while (cursor);
      if (descriptions.length !== pipelineTools.length)
        throw new LocalError('MCP_TOOLS_MISSING', 502);
      this.tools = descriptions;
    } catch (e) {
      await this.close();
      this.failure(e, signal, 'MCP_DISCOVERY_FAILED');
    }
    return this;
  }
  describe() {
    return this.tools;
  }
  async call(name: string, args: Record<string, unknown>, signal?: AbortSignal) {
    if (!(name in toolSchemas) || !Object.hasOwn(toolSchemas, name))
      throw new LocalError('TOOL_NOT_ALLOWED', 403);
    const toolName = name as PipelineToolName;
    if (!toolSchemas[toolName].safeParse(args).success)
      throw new LocalError('INVALID_ARGUMENTS', 400);
    if (signal?.aborted) throw new LocalError('MCP_CANCELLED', 409);
    if (this.closed) throw new LocalError('MCP_PROCESS_EXITED', 502);
    try {
      const result = await this.client.callTool(
        { name, arguments: args },
        { signal, timeout: this.timeoutMs },
      );
      if (signal?.aborted) throw new LocalError('MCP_CANCELLED', 409);
      if (Buffer.byteLength(JSON.stringify(result), 'utf8') > TOOL_OUTPUT_BYTES)
        throw new LocalError('TOOL_OUTPUT_LIMIT', 409);
      if (result.isError) {
        const block = result.content?.find((b) => b.type === 'text');
        let code = 'MCP_TOOL_ERROR';
        if (block?.type === 'text') {
          try {
            const value = JSON.parse(block.text);
            if (
              typeof value.error_code === 'string' &&
              /^[A-Z][A-Z_]{1,80}$/.test(value.error_code)
            )
              code = value.error_code;
          } catch {
            /* SDK input errors remain explicit tool failures. */
          }
        }
        throw new LocalError(code, 409);
      }
      const parsed = toolResponseSchema(toolName).safeParse(result.structuredContent);
      if (!parsed.success) throw new LocalError('MCP_RESULT_INVALID', 502);
      if (canonical(parsed.data.source) !== canonical(toolSource(this.scope)))
        throw new LocalError('MCP_SOURCE_INVALID', 403);
      if (name === 'get_sql') {
        const output = parsed.data.output as { sql: string; base_hash: string };
        if (
          output.base_hash !== this.scope.revision_hash ||
          sha(output.sql) !== this.scope.revision_hash
        )
          throw new LocalError('MCP_SOURCE_INVALID', 403);
      }
      if (name === 'get_execution') {
        const output = parsed.data.output as {
          id: string;
          revision_hash: string;
          input_hash: string;
        };
        if (
          output.id !== this.scope.execution_id ||
          output.revision_hash !== this.scope.revision_hash ||
          output.input_hash !== this.scope.input_hash
        )
          throw new LocalError('MCP_SOURCE_INVALID', 403);
      }
      return parsed.data;
    } catch (e) {
      this.failure(e, signal, 'MCP_PROTOCOL_ERROR');
    }
  }
  async close() {
    this.disposing = true;
    try {
      await this.client.close();
    } finally {
      await this.transport.close();
      this.closed = true;
    }
  }
}
