import { z } from 'zod';

export const CONTRACT_VERSION = 1;
export const runStatus = z.enum(['PENDING','RUNNING','SUCCEEDED','FAILED']);
export const stepStatus = z.enum(['PENDING','RUNNING','SUCCEEDED','FAILED','SKIPPED']);
export const logLevel = z.enum(['DEBUG','INFO','WARN','ERROR']);
export const runSchema = z.object({
  id:z.string(),task_id:z.string(),task_name:z.string(),data_source:z.literal('FIXTURE'),
  scenario_id:z.enum(['S00','S04','S05']),scenario_instance_id:z.string(),
  parent_run_id:z.string().nullable(),status:runStatus,
  step_states:z.record(z.string(),stepStatus),params:z.record(z.string(),z.unknown()),
  created_at:z.string(),started_at:z.string().nullable(),finished_at:z.string().nullable(),
  duration_ms:z.number().nullable(),error_code:z.string().nullable(),error_message:z.string().nullable(),
  summary:z.record(z.string(),z.unknown()).nullable(),
  retry_eligibility:z.object({allowed:z.boolean(),reason_code:z.string().nullable(),message:z.string()}).optional(),
  child_run_id:z.string().nullable().optional(),
});
export type Run = z.infer<typeof runSchema>;
export const taskLogSchema=z.object({id:z.string(),run_id:z.string(),seq:z.number().int(),timestamp:z.string(),level:logLevel,step:z.string(),message:z.string()});
export type TaskLog=z.infer<typeof taskLogSchema>;
export const scenarioSchema=z.object({id:z.enum(['S00','S04','S05']),display_name:z.string(),description:z.string()});
export type Scenario=z.infer<typeof scenarioSchema>;
export const capabilitiesSchema=z.object({provider_mode:z.enum(['LIVE','MOCK','UNCONFIGURED']),model_configured:z.boolean(),retry_enabled:z.boolean(),task_data_mode:z.literal('FIXTURE')});
export type Capabilities=z.infer<typeof capabilitiesSchema>;
export const listQuerySchema=z.object({
  status:runStatus.optional(),task_id:z.string().max(80).optional(),q:z.string().max(200).optional(),
  page:z.coerce.number().int().min(1).default(1),limit:z.coerce.number().int().min(1).max(100).default(20)
});
export const logQuerySchema=z.object({
  query:z.string().max(200).optional(),level:logLevel.optional(),
  before_seq:z.coerce.number().int().min(0).optional(),after_seq:z.coerce.number().int().min(0).optional(),
  limit:z.coerce.number().int().min(1).max(200).default(200)
}).refine(v=>!(v.before_seq!==undefined && v.after_seq!==undefined),{message:'before_seq and after_seq are mutually exclusive'});
export const createRunSchema=z.object({scenario_id:z.enum(['S00','S04','S05'])}).strict();
export const errorSchema=z.object({error:z.object({code:z.string(),message:z.string(),retryable:z.boolean(),request_id:z.string()})});
export const dataResponse=<T extends z.ZodTypeAny>(schema:T)=>z.object({data:schema});
export const pageResponse=<T extends z.ZodTypeAny>(schema:T)=>z.object({data:z.array(schema),page_info:z.object({page:z.number(),limit:z.number(),total:z.number(),has_more:z.boolean()})});

export const sessionSchema=z.object({id:z.string(),run_id:z.string(),title:z.string(),created_at:z.string(),updated_at:z.string()});
export const createSessionSchema=z.strictObject({run_id:z.string().min(1).max(128)});
export const submitMessageSchema=z.strictObject({content:z.string().trim().min(1).max(2000)});
export const retryProposalSchema=z.strictObject({turn_id:z.string().min(1).max(128),reason:z.string().trim().min(1).max(2000)});
export type DiagnosisSession=z.infer<typeof sessionSchema>;
export const turnSchema=z.object({id:z.string(),session_id:z.string(),status:z.enum(['QUEUED','RUNNING','COMPLETED','FAILED','CANCELLED','INTERRUPTED']),provider_mode:z.enum(['LIVE','MOCK']),model:z.string(),prompt_version:z.string(),error_code:z.string().nullable(),created_at:z.string(),started_at:z.string().nullable(),finished_at:z.string().nullable()});
export const messageSchema=z.object({id:z.string(),session_id:z.string(),turn_id:z.string(),role:z.enum(['user','assistant']),content:z.string(),is_partial:z.number(),created_at:z.string()});
export const toolCallSchema=z.object({id:z.string(),turn_id:z.string(),name:z.string(),args_json:z.string(),status:z.enum(['RUNNING','SUCCEEDED','FAILED','CANCELLED']),result_summary_json:z.string().nullable(),error_code:z.string().nullable(),started_at:z.string(),finished_at:z.string().nullable()});
export const findingSchema=z.strictObject({cause:z.enum(['NONE','SCHEMA_MISMATCH','SQL_COLUMN_ERROR','DUPLICATE_DATA','UPSTREAM_TIMEOUT','UNKNOWN']),explanation:z.string(),evidence_ids:z.array(z.string()),evidence_status:z.enum(['SUPPORTED','NEEDS_CONFIRMATION'])});
export const diagnosisResultSchema=z.strictObject({summary:z.string().min(1),findings:z.array(findingSchema),missing_information:z.array(z.string()),next_steps:z.array(z.string()),proposed_action:z.union([z.null(),z.strictObject({type:z.literal('RETRY_RUN'),run_id:z.string(),reason:z.string(),evidence_ids:z.array(z.string())})])});
export const resultRowSchema=z.object({id:z.string(),turn_id:z.string(),summary:z.string(),findings_json:z.string(),missing_information_json:z.string(),next_steps_json:z.string(),proposed_action_json:z.string().nullable(),created_at:z.string()});
export const sessionSnapshotSchema=z.object({schema_version:z.literal(1),session:sessionSchema,turns:z.array(turnSchema),messages:z.array(messageSchema),tool_calls:z.array(toolCallSchema),results:z.array(resultRowSchema),last_event_seq:z.number().int()});
export const evidenceSchema=z.object({id:z.string(),session_id:z.string(),turn_id:z.string(),type:z.enum(['LOG','RUNBOOK','RUN_STATE']),source_id:z.string(),source_version:z.string(),locator:z.record(z.string(),z.unknown()),excerpt:z.string(),created_at:z.string()});
export const approvalSchema=z.object({id:z.string(),run_id:z.string(),turn_id:z.string(),status:z.enum(['PENDING','APPROVED','REJECTED','EXPIRED','STALE']),action:z.literal('RETRY_RUN'),reason:z.string(),params:z.record(z.string(),z.unknown()),expires_at:z.string(),created_at:z.string(),child_run_id:z.string().nullable()});
export const agentEventSchema=z.object({schema_version:z.literal(1),event_id:z.string(),seq:z.number().int(),session_id:z.string(),turn_id:z.string(),timestamp:z.string(),type:z.string(),payload:z.record(z.string(),z.unknown())});
