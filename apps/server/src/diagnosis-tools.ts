import { readFileSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { getRun, listLogs } from './store.js';
import { saveEvidence } from './diagnosis-store.js';
import { ProbeError } from './model-error.js';
import type { Run, TaskLog } from '@flowlens/contracts';
import { ToolRegistry } from './tool-registry.js';

export interface TaskBackend {
  getRun(id: string): Run | undefined;
  getDefinition(id: string): Record<string, unknown>;
  getLogs(
    id: string,
    query: { after_seq: number; limit: number; level?: string; query?: string },
  ): TaskLog[];
}
export interface RunbookChunk {
  id: string;
  version: string;
  title: string;
  category: string;
  text: string;
  updated_at: string;
}
export interface RunbookRetriever {
  search(query: string, category: string | undefined, limit: number): RunbookChunk[];
}

const definitions = [
  { id: 'task-overview', title: '订单日报任务总览', category: 'task' },
  { id: 'input-schema', title: '输入 Schema', category: 'schema' },
  { id: 'upstream-timeout', title: '上游读取超时', category: 'timeout' },
  { id: 'insufficient-information', title: '信息不足排查', category: 'unknown' },
  { id: 'missing-field', title: '输入缺少必填字段', category: 'schema' },
  { id: 'sql-column-error', title: '聚合 SQL 列引用错误', category: 'sql' },
  { id: 'duplicate-data', title: '重复订单与唯一约束', category: 'duplicate' },
] as const;
const docs = definitions.map((d) => ({
  ...d,
  version: '1',
  updated_at: '2026-09-26',
  text: readFileSync(new URL('../../../docs/runbooks/' + d.id + '.md', import.meta.url), 'utf8'),
}));
const defaultRetriever: RunbookRetriever = {
  search(query, category, limit) {
    const terms = query
      .toLowerCase()
      .split(/\s+|[，。？！、]+/)
      .filter(Boolean);
    return docs
      .filter((d) => !category || d.category === category)
      .map((d) => ({
        d,
        score: terms.reduce(
          (n, t) =>
            n +
            (d.title.toLowerCase().includes(t) ? 2 : 0) +
            (d.text.toLowerCase().includes(t) ? 1 : 0),
          0,
        ),
      }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score || a.d.id.localeCompare(b.d.id))
      .slice(0, limit)
      .map((x) => x.d);
  },
};
const schemas = {
  get_task_run: z.strictObject({ run_id: z.string() }),
  get_task_definition: z.strictObject({ task_id: z.string() }),
  get_task_logs: z.strictObject({
    run_id: z.string(),
    level: z.enum(['INFO', 'WARN', 'ERROR']).optional(),
    query: z.string().max(200).optional(),
    cursor: z.number().int().nonnegative().optional(),
    limit: z.number().int().min(1).max(100).optional(),
  }),
  search_runbook: z.strictObject({
    query: z.string().trim().min(1).max(200),
    category: z.string().optional(),
    top_k: z.number().int().min(1).max(5).optional(),
  }),
};
export const toolDescriptions = [
  {
    name: 'get_task_run',
    description: 'Read bound run state',
    parameters: {
      type: 'object',
      properties: { run_id: { type: 'string' } },
      required: ['run_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_task_definition',
    description: 'Read bound task definition',
    parameters: {
      type: 'object',
      properties: { task_id: { type: 'string' } },
      required: ['task_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_task_logs',
    description: 'Read bounded logs for bound run',
    parameters: {
      type: 'object',
      properties: {
        run_id: { type: 'string' },
        level: { type: 'string' },
        query: { type: 'string' },
        cursor: { type: 'integer' },
        limit: { type: 'integer' },
      },
      required: ['run_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'search_runbook',
    description: 'Search allowed runbooks',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        category: { type: 'string' },
        top_k: { type: 'integer' },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
] as const;
export type ToolContext = { runId: string; sessionId: string; turnId: string };
export function createTools(
  db: DatabaseSync,
  options: { backend?: TaskBackend; retriever?: RunbookRetriever } = {},
) {
  const backend: TaskBackend = options.backend ?? {
    getRun: (id) => getRun(db, id),
    getLogs: (id, query) => listLogs(db, id, query),
    getDefinition: (id) => {
      const row = db.prepare('SELECT * FROM task_definition WHERE id=?').get(id) as {
        id: string;
        description: string;
        schema_version: number;
        steps_json: string;
      };
      return {
        id: row.id,
        description: row.description,
        schema_version: row.schema_version,
        steps: JSON.parse(row.steps_json),
      };
    },
  };
  const retriever = options.retriever ?? defaultRetriever;
  const execute = async (name: string, raw: Record<string, unknown>, ctx: ToolContext) => {
    const schema = schemas[name as keyof typeof schemas];
    if (!schema) throw new ProbeError('TOOL_NOT_ALLOWED');
    const parsed = schema.safeParse(raw);
    if (!parsed.success) throw new ProbeError('INVALID_ARGUMENTS');
    const input = parsed.data as Record<string, unknown>;
    const run = backend.getRun(ctx.runId);
    if (!run) throw new ProbeError('TOOL_SCOPE');
    if ('run_id' in input && input.run_id !== run.id) throw new ProbeError('TOOL_SCOPE');
    if ('task_id' in input && input.task_id !== run.task_id) throw new ProbeError('TOOL_SCOPE');
    let output: Record<string, unknown>;
    let sources: {
      type: 'LOG' | 'RUNBOOK' | 'RUN_STATE';
      id: string;
      version: string;
      locator: Record<string, unknown>;
      excerpt: string;
    }[] = [];
    if (name === 'get_task_run') {
      output = {
        id: run.id,
        task_id: run.task_id,
        status: run.status,
        steps: run.step_states,
        error_code: run.error_code,
        error_message: run.error_message,
      };
      sources = [
        {
          type: 'RUN_STATE',
          id: run.id,
          version: run.finished_at ?? run.created_at,
          locator: { run_id: run.id, read_at: new Date().toISOString() },
          excerpt: `${run.status} ${run.error_code ?? ''} ${run.error_message ?? ''}`,
        },
      ];
    } else if (name === 'get_task_definition') {
      output = backend.getDefinition(run.task_id);
    } else if (name === 'get_task_logs') {
      const logs = backend.getLogs(run.id, {
        after_seq: Number(input.cursor ?? 0),
        limit: Number(input.limit ?? 100),
        level: input.level as string | undefined,
        query: input.query as string | undefined,
      });
      output = { logs, next_cursor: logs.at(-1)?.seq ?? null };
      sources = logs.map((log) => ({
        type: 'LOG',
        id: log.id,
        version: '1',
        locator: { run_id: run.id, log_id: log.id, seq: log.seq },
        excerpt: log.message,
      }));
    } else {
      const ranked = retriever.search(
        String(input.query),
        input.category as string | undefined,
        Math.min(3, Number(input.top_k ?? 3)),
      );
      output = {
        chunks: ranked.map((d) => ({
          document_id: d.id,
          version: d.version,
          title: d.title,
          category: d.category,
          updated_at: d.updated_at,
          chunk_id: d.id + '-1',
          heading: d.title,
          excerpt: d.text,
        })),
      };
      sources = ranked.map((d) => ({
        type: 'RUNBOOK',
        id: d.id,
        version: d.version,
        locator: {
          document_id: d.id,
          version: d.version,
          chunk_id: d.id + '-1',
          start_line: 1,
          end_line: d.text.split('\n').length,
        },
        excerpt: d.text,
      }));
    }
    if (Buffer.byteLength(JSON.stringify(output)) > 20 * 1024)
      throw new ProbeError('TOOL_OUTPUT_LIMIT');
    const evidence_ids = sources.map((s) =>
      saveEvidence(db, {
        sessionId: ctx.sessionId,
        turnId: ctx.turnId,
        type: s.type,
        sourceId: s.id,
        sourceVersion: s.version,
        locator: s.locator,
        excerpt: s.excerpt,
      }),
    );
    return { output, evidence_ids };
  };
  const registry = new ToolRegistry();
  for (const description of toolDescriptions)
    registry.register({
      description,
      schema: schemas[description.name],
      execute: (input, context) => execute(description.name, input, context),
    });
  return registry;
}
