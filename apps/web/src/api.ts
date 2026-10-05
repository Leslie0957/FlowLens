import {z} from 'zod';
import {historyItemSchema,localProjectSchema,localExecutionSchema,localLogSchema,localArtifactSchema,localRepairSchema,localRepairLoopSchema} from '@flowlens/contracts';
import {runSchema,taskLogSchema,scenarioSchema,capabilitiesSchema,sessionSchema,sessionSnapshotSchema,evidenceSchema,approvalSchema,pageResponse,dataResponse,type Run,type TaskLog} from '@flowlens/contracts';
export class ApiError extends Error {constructor(public code:string,public requestId:string,public status:number,message:string){super(message);}}
async function read<T extends z.ZodTypeAny>(path:string,schema:T,options:RequestInit={}):Promise<z.infer<T>> {
  const response=await fetch('/api/v1'+path,{...options,headers:{'Content-Type':'application/json',...options.headers}});
  const body:unknown=await response.json().catch(()=>null);
  if(!response.ok){
    const item=body as {error?:{code?:string;message?:string;request_id?:string}}|null;
    const requestId=item?.error?.request_id??response.headers.get('X-Request-Id')??'';
    throw new ApiError(item?.error?.code??'NETWORK_ERROR',requestId,response.status,(item?.error?.message??'本机服务请求失败')+'（HTTP '+response.status+(requestId?' · '+requestId:'')+'）');
  }
  return schema.parse(body);
}
export type RunQuery={page:number;limit:number;status?:string;q?:string;created_from?:string;created_to?:string};
export async function fetchRuns(query:RunQuery,signal?:AbortSignal){
  const p=new URLSearchParams({page:String(query.page),limit:String(query.limit)});
  if(query.status)p.set('status',query.status);if(query.q)p.set('q',query.q);
  if(query.created_from)p.set('created_from',query.created_from);if(query.created_to)p.set('created_to',query.created_to);
  return read('/runs?'+p,pageResponse(runSchema),{signal});
}
export async function fetchRun(id:string,signal?:AbortSignal):Promise<Run>{
  const response=await read('/runs/'+encodeURIComponent(id),dataResponse(runSchema),{signal});return response.data;
}
export async function fetchLogs(id:string,options:{query?:string;level?:string;before_seq?:number;after_seq?:number;limit?:number}={},signal?:AbortSignal):Promise<TaskLog[]>{
  const params=new URLSearchParams();for(const [key,value] of Object.entries(options))if(value!==undefined&&value!=='')params.set(key,String(value));
  const response=await read('/runs/'+encodeURIComponent(id)+'/logs?'+params,dataResponse(z.array(taskLogSchema)),{signal});
  return response.data;
}
export async function fetchScenarios(){const response=await read('/demo/scenarios',dataResponse(z.array(scenarioSchema)));return response.data;}
export async function fetchCapabilities(){const response=await read('/capabilities',dataResponse(capabilitiesSchema));return response.data;}
export async function createDemoRun(id:string,key:string):Promise<Run>{
  const response=await read('/demo/runs',dataResponse(runSchema),{method:'POST',headers:{'Idempotency-Key':key},body:JSON.stringify({scenario_id:id})});
  return response.data;
}
export async function fetchSessions(runId:string){return (await read('/sessions?run_id='+encodeURIComponent(runId),dataResponse(z.array(sessionSchema)))).data;}
export async function fetchHistory(query:{q?:string;page:number;limit:number},signal?:AbortSignal){const p=new URLSearchParams({page:String(query.page),limit:String(query.limit)});if(query.q)p.set('q',query.q);return read('/diagnoses?'+p,pageResponse(historyItemSchema),{signal});}
export async function createSession(runId:string,key:string){return (await read('/sessions',dataResponse(sessionSchema),{method:'POST',headers:{'Idempotency-Key':key},body:JSON.stringify({run_id:runId})})).data;}
export async function fetchSession(id:string){return (await read('/sessions/'+encodeURIComponent(id),dataResponse(sessionSnapshotSchema))).data;}
export async function sendMessage(id:string,content:string,key:string){return (await read('/sessions/'+encodeURIComponent(id)+'/messages',dataResponse(z.object({user_message_id:z.string(),turn_id:z.string()})),{method:'POST',headers:{'Idempotency-Key':key},body:JSON.stringify({content})})).data;}
export async function fetchEvidence(sessionId:string,id:string){return (await read('/sessions/'+encodeURIComponent(sessionId)+'/evidence/'+encodeURIComponent(id),dataResponse(evidenceSchema))).data;}
export async function fetchLogContext(runId:string,logId:string){return (await read('/runs/'+encodeURIComponent(runId)+'/logs/'+encodeURIComponent(logId)+'/context',dataResponse(z.object({log_id:z.string(),logs:z.array(taskLogSchema)})))).data;}
export async function fetchApprovals(runId:string){return (await read('/runs/'+encodeURIComponent(runId)+'/approvals',dataResponse(z.array(approvalSchema)))).data;}
export async function proposeRetry(runId:string,turnId:string,reason:string,key:string){return (await read('/runs/'+encodeURIComponent(runId)+'/retry-proposals',dataResponse(approvalSchema),{method:'POST',headers:{'Idempotency-Key':key},body:JSON.stringify({turn_id:turnId,reason})})).data;}
export async function resolveApproval(id:string,decision:'approve'|'reject',key:string){return (await read('/approvals/'+encodeURIComponent(id)+'/'+decision,dataResponse(approvalSchema),{method:'POST',headers:{'Idempotency-Key':key},body:'{}'})).data;}
export async function cancelTurn(id:string){return (await read('/turns/'+encodeURIComponent(id)+'/cancel',dataResponse(z.unknown()),{method:'POST',body:'{}'})).data;}

export async function fetchLocalProjects(signal?:AbortSignal,page=1){return read('/local-projects?page='+page,pageResponse(localProjectSchema),{signal});}
export async function createLocalProject(templateId:'sql-column-error'|'sql-valid-control',key:string){return (await read('/local-projects',dataResponse(localProjectSchema),{method:'POST',headers:{'Idempotency-Key':key},body:JSON.stringify({template_id:templateId})})).data;}
export async function fetchLocalProject(id:string,signal?:AbortSignal){return (await read('/local-projects/'+encodeURIComponent(id),dataResponse(localProjectSchema),{signal})).data;}
export async function fetchLocalExecutions(projectId:string,signal?:AbortSignal,page=1){return read('/local-projects/'+encodeURIComponent(projectId)+'/executions?page='+page,pageResponse(localExecutionSchema),{signal});}
export async function startLocalExecution(projectId:string,key:string){return (await read('/local-projects/'+encodeURIComponent(projectId)+'/executions',dataResponse(localExecutionSchema),{method:'POST',headers:{'Idempotency-Key':key},body:'{}'})).data;}
export async function fetchLocalExecution(id:string,signal?:AbortSignal){return (await read('/local-executions/'+encodeURIComponent(id),dataResponse(localExecutionSchema),{signal})).data;}
export async function fetchLocalLogs(id:string,signal?:AbortSignal){return (await read('/local-executions/'+encodeURIComponent(id)+'/logs',dataResponse(z.array(localLogSchema)),{signal})).data;}
export async function fetchLocalArtifacts(id:string,signal?:AbortSignal){return (await read('/local-executions/'+encodeURIComponent(id)+'/artifacts',dataResponse(z.array(localArtifactSchema)),{signal})).data;}
export async function fetchLocalArtifact(id:string,artifactId:string,signal?:AbortSignal){return (await read('/local-executions/'+encodeURIComponent(id)+'/artifacts/'+encodeURIComponent(artifactId),dataResponse(z.object({name:z.string(),content:z.string()})),{signal})).data;}
export async function cancelLocalExecution(id:string){return (await read('/local-executions/'+encodeURIComponent(id)+'/cancel',dataResponse(localExecutionSchema),{method:'POST',body:'{}'})).data;}
export async function fetchLocalRepairs(executionId:string,signal?:AbortSignal){return (await read('/local-executions/'+encodeURIComponent(executionId)+'/repairs',dataResponse(z.array(localRepairSchema)),{signal})).data;}
export async function fetchLocalRepair(id:string,signal?:AbortSignal){return (await read('/local-repairs/'+encodeURIComponent(id),dataResponse(localRepairSchema),{signal})).data;}
export async function requestLocalRepair(executionId:string,key:string){return (await read('/local-executions/'+encodeURIComponent(executionId)+'/repairs',dataResponse(localRepairSchema),{method:'POST',headers:{'Idempotency-Key':key},body:'{}'})).data;}
export async function decideLocalRepair(id:string,decision:'approve'|'reject',key:string){return (await read('/local-repairs/'+encodeURIComponent(id)+'/'+decision,dataResponse(localRepairSchema),{method:'POST',headers:{'Idempotency-Key':key},body:'{}'})).data;}
export async function cancelLocalRepair(id:string){return (await read('/local-repairs/'+encodeURIComponent(id)+'/cancel',dataResponse(localRepairSchema),{method:'POST',body:'{}'})).data;}
export async function fetchLocalLoops(executionId:string,signal?:AbortSignal){return (await read('/local-executions/'+encodeURIComponent(executionId)+'/loops',dataResponse(z.array(localRepairLoopSchema)),{signal})).data;}
export async function fetchLocalLoop(id:string,signal?:AbortSignal){return (await read('/local-repair-loops/'+encodeURIComponent(id),dataResponse(localRepairLoopSchema),{signal})).data;}
export async function startLocalLoop(executionId:string,key:string){return (await read('/local-executions/'+encodeURIComponent(executionId)+'/loops',dataResponse(localRepairLoopSchema),{method:'POST',headers:{'Idempotency-Key':key},body:JSON.stringify({authorize:true})})).data;}
export async function cancelLocalLoop(id:string){return (await read('/local-repair-loops/'+encodeURIComponent(id)+'/cancel',dataResponse(localRepairLoopSchema),{method:'POST',body:'{}'})).data;}
