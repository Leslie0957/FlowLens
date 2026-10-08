import {z} from 'zod';
const id=z.uuid(),hash=z.string().regex(/^[a-f0-9]{64}$/);
export const pipelineRevisionSchema=z.object({id,project_id:id,parent_id:id.nullable(),sql:z.string(),hash,input_hash:hash,source:z.string(),created_at:z.string()});
export const pipelineLogSchema=z.object({at:z.string(),step:z.string(),level:z.string(),message:z.string()});
export const pipelineRowSchema=z.record(z.string(),z.union([z.string(),z.number(),z.null()]));
export const pipelineExecutionSchema=z.object({id,project_id:id,revision_id:id,revision_hash:hash,input_hash:hash,kind:z.enum(['PRECHECK','VERIFICATION']),status:z.string(),created_at:z.string(),finished_at:z.string().nullable(),logs:z.array(pipelineLogSchema),columns:z.array(z.string()),rows:z.array(pipelineRowSchema),error_code:z.string().nullable(),error_message:z.string().nullable(),failed_step:z.string().nullable(),exit_code:z.number().nullable(),validation:z.object({passed:z.boolean(),expected_count:z.number(),actual_count:z.number(),message:z.string()}).nullable(),precheck:z.object({target_version:z.number(),target_hash:hash,output_hash:hash,inserted:z.number(),skipped:z.number(),conflicts:z.number(),expires_at:z.string()}).nullable(),verification:z.object({inserted:z.number(),rerun_skipped:z.number(),passed:z.boolean()}).nullable()});
export const pipelineEvidenceSchema=z.object({id,type:z.string(),source_id:z.string(),source_version:z.string(),excerpt:z.string()});
export const pipelineDiagnosisLimitsSchema=z.object({
  max_requests:z.number().int().positive(),
  max_tool_calls:z.number().int().positive(),
  timeout_ms:z.number().int().positive(),
  max_stall_rounds:z.number().int().positive(),
  max_context_bytes:z.number().int().positive()
});
export type PipelineDiagnosisLimits=z.infer<typeof pipelineDiagnosisLimitsSchema>;
export const pipelineToolSchema=z.object({id,request:z.number().int().positive().optional(),call_id:z.string().optional(),name:z.string(),status:z.string(),args:z.record(z.string(),z.unknown()),result:z.unknown().nullable(),error_code:z.string().nullable()});
export const pipelineRepairSchema=z.object({
  id,
  project_id:id,
  execution_id:id,
  base_revision_id:id,
  base_hash:hash,
  input_hash:hash,
  status:z.string(),
  provider_mode:z.enum(['MOCK','LIVE']),
  model:z.string(),
  created_at:z.string(),
  expires_at:z.string().nullable(),
  tools:z.array(pipelineToolSchema),
  evidence:z.array(pipelineEvidenceSchema),
  diagnosis:z.string().nullable(),
  action:z.string().nullable(),
  failed_step:z.string().nullable(),
  evidence_ids:z.array(id),
  candidate:z.object({file_path:z.literal('task.sql'),sql:z.string(),hash,diff:z.string()}).nullable(),
  approved_revision_id:id.nullable(),
  verification_execution_id:id.nullable(),
  error_code:z.string().nullable(),
  error_message:z.string().nullable().default(null),
  diagnosis_limits:pipelineDiagnosisLimitsSchema.nullable().default(null),
  model_turns:z.array(z.object({request:z.number().int().positive(),text:z.string(),finish_reason:z.string(),calls:z.array(z.object({id:z.string(),name:z.string(),arguments:z.record(z.string(),z.unknown())}))})).default([]),
  commit_approval:z.object({approved_at:z.string(),target_version:z.number(),target_hash:hash,status:z.enum(['APPROVED','PRECHECKING','COMMITTING','COMMITTED','FAILED','INTERRUPTED']),execution_id:id.nullable(),operation_id:id.nullable(),batch_id:id.nullable(),error_code:z.string().nullable(),error_message:z.string().nullable()}).nullable().default(null),
  response_checks:z.array(z.object({request:z.number().int().positive(),code:z.string(),message:z.string(),response_text:z.string().optional()})).default([]),
  model_requests:z.number(),
  usage:z.object({prompt_tokens:z.number(),completion_tokens:z.number()})});
export const pipelineBatchSchema=z.object({id,execution_id:id,revision_id:id,status:z.string(),created_at:z.string(),snapshot_id:id,before_hash:hash,after_hash:hash,before_count:z.number(),after_count:z.number(),inserted:z.number(),skipped:z.number(),previous_head:id.nullable(),data_version:z.number(),restored_at:z.string().nullable(),restore_id:id.nullable(),can_restore:z.boolean()});
export const pipelineProjectSchema=z.object({id,name:z.string(),template:z.string(),input_source:z.literal('SYNTHETIC'),input_hash:hash,current_revision_id:id,created_at:z.string()});
export const pipelineSnapshotSchema=z.object({project:pipelineProjectSchema,revision:pipelineRevisionSchema,revisions:z.array(pipelineRevisionSchema),executions:z.array(pipelineExecutionSchema),repairs:z.array(pipelineRepairSchema),batches:z.array(pipelineBatchSchema),operations:z.array(z.object({id,type:z.string(),status:z.string(),execution_id:z.string().nullable(),batch_id:z.string().nullable(),error_code:z.string().nullable(),error_message:z.string().nullable().default(null),created_at:z.string()})),target:z.object({data_version:z.number(),head_batch_id:id.nullable(),hash,row_count:z.number(),preview:z.array(pipelineRowSchema)}),cursor:z.number()});
export const pipelineEventSchema=z.object({project_id:id,seq:z.number().int().positive(),type:z.string(),entity_id:z.string(),created_at:z.string()});
export const pipelineQuerySchema=z.strictObject({scope:z.enum(['source','target','snapshot']),batch_id:id.optional(),sql:z.string().min(1).max(8192),limit:z.number().int().min(1).max(500).default(200)});
export const pipelineDatabaseSchema=z.object({source:z.array(z.object({name:z.string(),type:z.string()})),target:z.array(z.object({name:z.string(),type:z.string()})),contract:z.object({rule:z.string(),columns:z.array(z.string()),business_key:z.array(z.string()),writable_file:z.string(),runner:z.string(),validator:z.string(),input_version:z.string()})});
export const pipelineQueryResultSchema=z.object({project_id:id,scope:z.string(),batch_id:id.nullable(),data_version:z.number(),data_hash:hash,columns:z.array(z.string()),rows:z.array(pipelineRowSchema),row_count:z.number(),truncated:z.boolean(),elapsed_ms:z.number(),schema:z.array(z.object({name:z.string(),type:z.string()}))});
export type PipelineRevision=z.infer<typeof pipelineRevisionSchema>;
export type PipelineExecution=z.infer<typeof pipelineExecutionSchema>;
export type PipelineRepair=z.infer<typeof pipelineRepairSchema>;
export type PipelineSnapshot=z.infer<typeof pipelineSnapshotSchema>;
export type PipelineRow=z.infer<typeof pipelineRowSchema>;
export type PipelineBatch=z.infer<typeof pipelineBatchSchema>;
