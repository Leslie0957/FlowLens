import { z } from 'zod';
import {
  logReadArgsSchema,
  logReadOutputSchema,
  pipelineExecutionSchema,
  pipelineDatabaseSchema,
  pipelineRowSchema,
} from '@flowlens/contracts';

export const toolSchemas = {
  get_execution: z.strictObject({}),
  get_sql: z.strictObject({}),
  get_schema: z.strictObject({}),
  get_logs: logReadArgsSchema,
  get_output_preview: z.strictObject({}),
  get_task_contract: z.strictObject({}),
};
export type PipelineToolName = keyof typeof toolSchemas;
const descriptions: Record<PipelineToolName, string> = {
  get_execution: '读取绑定执行的状态及实际失败信息',
  get_sql: '读取当前基础版本的 task.sql 和内容哈希',
  get_schema: '读取源库与目标库的实际 SQLite 表结构，同时包含当前任务契约',
  get_logs:
    '按需读取执行日志。默认最近20条，按原始seq升序；has_more时用next_before_seq作before_seq继续向前翻页，可保持step/level筛选。空页正常；证据充分即可结束，无须读完。',
  get_output_preview: '读取实际输出字段、行数据及独立校验结果',
  get_task_contract: '读取任务业务规则、输出要求和可写范围',
};
export const pipelineTools = Object.entries(toolSchemas).map(([name, schema]) => ({
  name,
  description: descriptions[name as PipelineToolName],
  parameters: z.toJSONSchema(schema, { target: 'draft-7' }),
}));

const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const toolScopeSchema = z.strictObject({
  app_db_path: z.string().min(1),
  project_dir: z.string().min(1),
  repair_id: z.uuid(),
  project_id: z.uuid(),
  execution_id: z.uuid(),
  revision_id: z.uuid(),
  revision_hash: hash,
  input_hash: hash,
  logs_hash: hash,
  execution_hash: hash,
});
export type PipelineToolScope = z.infer<typeof toolScopeSchema>;
export const toolSourceSchema = toolScopeSchema.omit({ app_db_path: true, project_dir: true });
export const outputSchemas = {
  get_execution: z.strictObject({
    id: z.uuid(),
    status: z.string(),
    failed_step: z.string().nullable(),
    error_code: z.string().nullable(),
    error_message: z.string().nullable(),
    revision_hash: hash,
    input_hash: hash,
  }),
  get_sql: z.strictObject({ file_path: z.literal('task.sql'), sql: z.string(), base_hash: hash }),
  get_schema: pipelineDatabaseSchema.strict(),
  get_logs: logReadOutputSchema,
  get_output_preview: z.strictObject({
    columns: z.array(z.string()),
    rows: z.array(pipelineRowSchema),
    validation: pipelineExecutionSchema.shape.validation,
    precheck: pipelineExecutionSchema.shape.precheck,
  }),
  get_task_contract: pipelineDatabaseSchema.shape.contract.strict(),
};
export function toolResponseSchema(name: PipelineToolName) {
  return z.strictObject({ output: outputSchemas[name], source: toolSourceSchema });
}
export function toolSource(scope: PipelineToolScope) {
  return toolSourceSchema.strip().parse(scope);
}
