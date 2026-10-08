import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { ProbeError } from './error.js';

export type ToolContext = { runId: string; sessionId: string; turnId: string };
export type Evidence = {
  id: string;
  sessionId: string;
  turnId: string;
  type: 'LOG' | 'RUNBOOK' | 'RUN_STATE';
  sourceId: string;
  excerpt: string;
};
const runs = new Map([
  [
    'run_1',
    {
      id: 'run_1',
      task_id: 'order_daily',
      status: 'FAILED',
      steps: ['read:FAILED', 'validate:SKIPPED', 'load:SKIPPED', 'aggregate:SKIPPED'],
      error: 'ReadTimeout',
    },
  ],
]);
const logs = [
  { id: 'log_1', run_id: 'run_1', seq: 1, level: 'INFO', message: 'Starting read step' },
  {
    id: 'log_2',
    run_id: 'run_1',
    seq: 2,
    level: 'ERROR',
    message: 'ReadTimeout: upstream request exceeded 5s',
  },
];
const docs = [
  {
    id: 'upstream-timeout',
    version: '1',
    text: '上游超时：先核对读取阶段超时日志，再检查上游可用性。仅在符合服务端重试策略并人工批准后模拟重试。',
  },
  { id: 'schema', version: '1', text: '订单日报输入字段：order_id、created_at、amount、status。' },
];
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
    query: z.string().min(1).max(200),
    category: z.string().optional(),
    top_k: z.number().int().min(1).max(5).optional(),
  }),
};
export const toolDescriptions = [
  {
    name: 'get_task_run',
    description: 'Read current run state',
    parameters: {
      type: 'object',
      properties: { run_id: { type: 'string' } },
      required: ['run_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_task_definition',
    description: 'Read task schema for current run',
    parameters: {
      type: 'object',
      properties: { task_id: { type: 'string' } },
      required: ['task_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_task_logs',
    description: 'Read bounded logs for current run',
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
export function createTools() {
  const evidence = new Map<string, Evidence>();
  return {
    evidence,
    async call(name: string, raw: Record<string, unknown>, ctx: ToolContext) {
      if (!(name in schemas)) throw new ProbeError('TOOL_NOT_ALLOWED');
      const schema = schemas[name as keyof typeof schemas];
      const parsed = schema.safeParse(raw);
      if (!parsed.success) throw new ProbeError('INVALID_ARGUMENTS');
      const input = parsed.data as Record<string, unknown>;
      const run = runs.get(ctx.runId);
      if (!run) throw new ProbeError('TOOL_SCOPE');
      if ('run_id' in input && input.run_id !== ctx.runId) throw new ProbeError('TOOL_SCOPE');
      if ('task_id' in input && input.task_id !== run.task_id) throw new ProbeError('TOOL_SCOPE');
      let output: Record<string, unknown>;
      let source: { type: Evidence['type']; id: string; excerpt: string }[] = [];
      switch (name) {
        case 'get_task_run':
          output = {
            id: run.id,
            task_id: run.task_id,
            status: run.status,
            steps: run.steps,
            error: run.error,
          };
          source = [{ type: 'RUN_STATE', id: run.id, excerpt: run.status + ' ' + run.error }];
          break;
        case 'get_task_definition':
          output = {
            id: run.task_id,
            description: '订单日报',
            fields: ['order_id', 'created_at', 'amount', 'status'],
            steps: ['read', 'validate', 'load', 'aggregate'],
          };
          break;
        case 'get_task_logs': {
          let items = logs.filter(
            (l) => l.run_id === ctx.runId && l.seq > Number(input.cursor ?? 0),
          );
          if (input.level) items = items.filter((l) => l.level === input.level);
          if (input.query)
            items = items.filter((l) =>
              l.message.toLowerCase().includes(String(input.query).toLowerCase()),
            );
          items = items.slice(0, Number(input.limit ?? 100));
          output = { logs: items, next_cursor: items.at(-1)?.seq ?? null };
          source = items.map((l) => ({ type: 'LOG' as const, id: l.id, excerpt: l.message }));
          break;
        }
        case 'search_runbook': {
          const query = String(input.query).toLowerCase();
          const items = docs
            .filter((d) => d.text.toLowerCase().includes(query) || d.id.includes(query))
            .slice(0, Number(input.top_k ?? 3));
          output = { chunks: items };
          source = items.map((d) => ({ type: 'RUNBOOK' as const, id: d.id, excerpt: d.text }));
          break;
        }
        default:
          throw new ProbeError('TOOL_NOT_ALLOWED');
      }
      if (Buffer.byteLength(JSON.stringify(output)) > 20 * 1024)
        throw new ProbeError('TOOL_OUTPUT_LIMIT');
      const evidenceIds = source.map((s) => {
        const id = randomUUID();
        evidence.set(id, {
          id,
          sessionId: ctx.sessionId,
          turnId: ctx.turnId,
          type: s.type,
          sourceId: s.id,
          excerpt: s.excerpt,
        });
        return id;
      });
      return { output, evidenceIds };
    },
  };
}
