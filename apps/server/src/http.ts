import express,{type Request,type Response,type NextFunction} from 'express';
import type { DatabaseSync } from 'node:sqlite';
import { ZodError } from 'zod';
import { listQuerySchema,logQuerySchema,createRunSchema,capabilitiesSchema,createSessionSchema,submitMessageSchema,retryProposalSchema,sessionSchema,sessionSnapshotSchema } from '@flowlens/contracts';
import { getRun,listRuns,listLogs,createRun } from './store.js';
import {loadFixture,SCENARIOS} from './fixtures.js';
import {createLogger,requestId} from './log.js';
import {DomainError,createSession,getSession,listSessions,snapshot,submitMessage,eventsAfter,getEvidence,proposeRetry,getApproval,listApprovals,resolveApproval,retryEligibility,turn} from './diagnosis-store.js';
import {runDiagnosis,cancelTurn} from './diagnosis-agent.js';
import {historyQuerySchema,historyItemSchema,localCreateProjectSchema,localEmptyBodySchema,localPageQuerySchema,localLogQuerySchema,localIdSchema,localProjectSchema,localExecutionSchema,localLogSchema,localArtifactSchema} from '@flowlens/contracts';
import {listHistory} from './diagnosis-store.js';
import {LocalExecutionService,LocalError,localTemplates,localRootForDatabase} from './local-execution.js';
import {LocalRepairService} from './local-repair.js';
import {localRepairSchema,localLoopAuthorizeSchema,localRepairLoopSchema} from '@flowlens/contracts';
import {LocalRepairLoopService} from './local-repair-loop.js';
import {databasePath} from './runtime.js';

class HttpError extends Error {constructor(public status:number,public code:string,public safeMessage:string){super(code);}}
type Handler=(req:Request,res:Response)=>unknown;
const wrap=(fn:Handler)=>(req:Request,res:Response,next:NextFunction)=>{try{return fn(req,res);}catch(error){next(error);}};
export function createApp(db:DatabaseSync,sink?:(line:string)=>void,localService?:LocalExecutionService,repairService?:LocalRepairService,loopService?:LocalRepairLoopService):express.Express {
  const app=express();const log=createLogger(sink);
  let local=localService;const getLocal=()=>local??(local=new LocalExecutionService(db,localRootForDatabase(databasePath())));
  let repair=repairService;const getRepair=()=>repair??(repair=new LocalRepairService(db,getLocal()));
  let loop=loopService;const getLoop=()=>loop??(loop=new LocalRepairLoopService(db,getLocal(),getRepair()));
  app.disable('x-powered-by');app.use(express.json({limit:'32kb'}));
  app.use((req,res,next)=>{
    const id=requestId(req.header('X-Request-Id'));res.locals.requestId=id;res.setHeader('X-Request-Id',id);
    const started=Date.now();
    res.on('finish',()=>log('request.finished',{request_id:id,method:req.method,route:req.route?.path??req.path,status:res.statusCode,duration_ms:Date.now()-started},res.statusCode>=500?'error':res.statusCode>=400?'warn':'info'));
    next();
  });
  app.get('/health',(_req,res)=>res.json({data:{status:'ok'}}));
  app.get('/api/v1/capabilities',(_req,res)=>{
    const configured=!!process.env.MODEL_API_KEY;
    const mode=process.env.MODEL_MODE==='LIVE'?(configured&&process.env.FLOWLENS_LIVE_APPROVED==='1'?'LIVE':'UNCONFIGURED'):'MOCK';
    res.json({data:capabilitiesSchema.parse({provider_mode:mode,model_configured:configured,retry_enabled:true,task_data_mode:'FIXTURE'})});
  });
  app.get('/api/v1/tasks',wrap((_req,res)=>{
    const data=db.prepare('SELECT id,name,description,schema_version,steps_json,created_at FROM task_definition ORDER BY id').all().map(row=>({...row,steps:JSON.parse(row.steps_json as string),steps_json:undefined}));
    res.json({data});
  }));
  app.get('/api/v1/runs',wrap((req,res)=>{
    const query=listQuerySchema.parse(req.query);
    const result=listRuns(db,query);
    res.json({data:result.data,page_info:{page:query.page,limit:query.limit,total:result.total,has_more:query.page*query.limit<result.total}});
  }));
  app.get('/api/v1/runs/:id',wrap((req,res)=>{
    const run=getRun(db,req.params.id as string);if(!run)throw new HttpError(404,'RUN_NOT_FOUND','运行不存在');
    const child=db.prepare('SELECT id FROM task_run WHERE parent_run_id=?').get(run.id) as {id:string}|undefined;
    res.json({data:{...run,retry_eligibility:retryEligibility(db,run.id),child_run_id:child?.id??null}});
  }));
  app.get('/api/v1/runs/:id/logs',wrap((req,res)=>{
    const id=req.params.id as string;if(!getRun(db,id))throw new HttpError(404,'RUN_NOT_FOUND','运行不存在');
    const query=logQuerySchema.parse(req.query);const logs=listLogs(db,id,query);
    res.json({data:logs,page_info:{limit:query.limit,has_more:logs.length===query.limit}});
  }));
  app.get('/api/v1/demo/scenarios',wrap((_req,res)=>{
    res.json({data:SCENARIOS.map(id=>{const f=loadFixture(id);return {id,display_name:f.display_name,description:f.description};})});
  }));
  app.post('/api/v1/demo/runs',wrap((req,res)=>{
    const body=createRunSchema.parse(req.body);const key=req.header('Idempotency-Key');
    if(!key)throw new HttpError(400,'IDEMPOTENCY_KEY_REQUIRED','缺少 Idempotency-Key');
    if(!/^[A-Za-z0-9_-]{1,128}$/.test(key))throw new HttpError(400,'INVALID_IDEMPOTENCY_KEY','无效 Idempotency-Key');
    const run=createRun(db,body.scenario_id,key,Date.now());
    log('run.created',{request_id:res.locals.requestId,run_id:run.id,scenario_id:body.scenario_id});
    res.status(202).json({data:getRun(db,run.id)});
  }));
  const key=(req:Request)=>{const value=req.header('Idempotency-Key');if(!value)throw new DomainError('IDEMPOTENCY_KEY_REQUIRED',400);return value;};
  app.get('/api/v1/runs/:id/logs/:logId/context',wrap((req,res)=>{
    const id=req.params.id as string,logId=req.params.logId as string;
    const row=db.prepare('SELECT seq FROM task_log WHERE id=? AND run_id=?').get(logId,id) as {seq:number}|undefined;
    if(!row)throw new DomainError('LOG_NOT_FOUND',404);
    const logs=db.prepare('SELECT * FROM task_log WHERE run_id=? AND seq BETWEEN ? AND ? ORDER BY seq').all(id,Math.max(0,row.seq-20),row.seq+20);
    res.json({data:{log_id:logId,logs}});
  }));
  app.get('/api/v1/diagnoses',wrap((req,res)=>{const query=historyQuerySchema.parse(req.query),result=listHistory(db,query);res.json({data:result.data.map(row=>historyItemSchema.parse(row)),page_info:{page:query.page,limit:query.limit,total:result.total,has_more:query.page*query.limit<result.total}});}));
  app.get('/api/v1/sessions',wrap((req,res)=>{const runId=String(req.query.run_id??'');if(!runId)throw new DomainError('INVALID_ARGUMENTS',400);res.json({data:listSessions(db,runId)});}));
  app.post('/api/v1/sessions',wrap((req,res)=>{const body=createSessionSchema.parse(req.body);res.status(201).json({data:sessionSchema.parse(createSession(db,body.run_id,key(req)))});}));
  app.get('/api/v1/sessions/:id',wrap((req,res)=>res.json({data:sessionSnapshotSchema.parse(snapshot(db,req.params.id as string))})));
  app.post('/api/v1/sessions/:id/messages',wrap((req,res)=>{
    const id=req.params.id as string,session=getSession(db,id);if(!session)throw new DomainError('SESSION_NOT_FOUND',404);
    const {content}=submitMessageSchema.parse(req.body);
    const mode=process.env.MODEL_MODE==='LIVE'?'LIVE':'MOCK';
    if(mode==='LIVE'&&(!process.env.MODEL_API_KEY||process.env.FLOWLENS_LIVE_APPROVED!=='1'))throw new DomainError('MODEL_NOT_CONFIGURED',503);
    const model=process.env.MODEL_NAME??'deepseek-flash';
    const result=submitMessage(db,id,content,key(req),mode,model);
    if(turn(db,result.turn_id)?.status==='QUEUED')queueMicrotask(()=>{void runDiagnosis(db,{turnId:result.turn_id,sessionId:id,runId:session.run_id as string,question:content.trim(),mode,model,requestId:res.locals.requestId,logSink:sink}).catch(()=>log('agent.unexpected_failure',{request_id:res.locals.requestId,turn_id:result.turn_id,error_code:'INTERNAL_ERROR'},'error'));});
    res.status(202).json({data:result});
  }));
  app.get('/api/v1/sessions/:id/events',wrap((req,res)=>{
    const id=req.params.id as string;if(!getSession(db,id))throw new DomainError('SESSION_NOT_FOUND',404);
    const after=Number(req.query.after_seq??0);if(!Number.isInteger(after)||after<0)throw new DomainError('INVALID_ARGUMENTS',400);
    res.setHeader('Content-Type','text/event-stream; charset=utf-8');res.setHeader('Cache-Control','no-cache, no-transform');res.setHeader('Connection','keep-alive');
    let cursor=after,lastHeartbeat=Date.now();
    res.flushHeaders();
    res.write(': connected\n\n');
    log('stream.opened',{request_id:res.locals.requestId,session_id:id,seq:after});
    const flush=()=>{const entries=eventsAfter(db,id,cursor);for(const entry of entries){res.write(`id: ${entry.seq}\nevent: ${entry.type}\ndata: ${JSON.stringify(entry)}\n\n`);cursor=entry.seq as number;}
      if(Date.now()-lastHeartbeat>=15000){res.write(': heartbeat\n\n');lastHeartbeat=Date.now();}
      const state=db.prepare('SELECT status FROM diagnosis_turn WHERE session_id=? ORDER BY created_at DESC LIMIT 1').get(id) as {status:string}|undefined;
      if(state&&entries.length<500&&['COMPLETED','FAILED','CANCELLED','INTERRUPTED'].includes(state.status)){clearInterval(timer);res.end();}};
    const timer=setInterval(flush,200);timer.unref();res.on('close',()=>{clearInterval(timer);log('stream.closed',{request_id:res.locals.requestId,session_id:id,seq:cursor});});flush();
  }));
  app.get('/api/v1/sessions/:id/evidence/:evidenceId',wrap((req,res)=>{const value=getEvidence(db,req.params.id as string,req.params.evidenceId as string);if(!value)throw new DomainError('EVIDENCE_NOT_FOUND',404);res.json({data:value});}));
  app.post('/api/v1/turns/:id/cancel',wrap((req,res)=>{const value=cancelTurn(db,req.params.id as string);res.json({data:value});}));
  app.post('/api/v1/runs/:id/retry-proposals',wrap((req,res)=>{const runId=req.params.id as string;const body=retryProposalSchema.parse(req.body);res.status(201).json({data:proposeRetry(db,runId,body.turn_id,body.reason,key(req))});}));
  app.get('/api/v1/runs/:id/approvals',wrap((req,res)=>res.json({data:listApprovals(db,req.params.id as string)})));
  app.get('/api/v1/approvals/:id',wrap((req,res)=>{const value=getApproval(db,req.params.id as string);if(!value)throw new DomainError('APPROVAL_NOT_FOUND',404);res.json({data:value});}));
  app.post('/api/v1/approvals/:id/approve',wrap((req,res)=>res.json({data:resolveApproval(db,req.params.id as string,'approve',key(req))})));
  app.post('/api/v1/approvals/:id/reject',wrap((req,res)=>res.json({data:resolveApproval(db,req.params.id as string,'reject',key(req))})));
  app.get('/api/v1/local-templates',wrap((_req,res)=>res.json({data:localTemplates})));
  app.get('/api/v1/local-projects',wrap((req,res)=>{const q=localPageQuerySchema.parse(req.query),r=getLocal().listProjects(q.page,q.limit);res.json({data:r.data.map(x=>localProjectSchema.parse(x)),page_info:{page:q.page,limit:q.limit,total:r.total,has_more:q.page*q.limit<r.total}});}));
  app.post('/api/v1/local-projects',wrap((req,res)=>{const body=localCreateProjectSchema.parse(req.body);const item=getLocal().createProject(body.template_id,key(req));log('local.project_created',{request_id:res.locals.requestId,project_id:item.id,revision_id:item.revision.id});res.status(201).json({data:localProjectSchema.parse(item)});}));
  app.get('/api/v1/local-projects/:id',wrap((req,res)=>{const id=localIdSchema.parse(req.params.id);res.json({data:localProjectSchema.parse(getLocal().getProject(id))});}));
  app.get('/api/v1/local-projects/:id/executions',wrap((req,res)=>{const id=localIdSchema.parse(req.params.id),q=localPageQuerySchema.parse(req.query),r=getLocal().listExecutions(id,q.page,q.limit);res.json({data:r.data.map(x=>localExecutionSchema.parse(x)),page_info:{page:q.page,limit:q.limit,total:r.total,has_more:q.page*q.limit<r.total}});}));
  app.post('/api/v1/local-projects/:id/executions',wrap((req,res)=>{const id=localIdSchema.parse(req.params.id);localEmptyBodySchema.parse(req.body??{});const item=getLocal().startExecution(id,key(req));log('local.execution_started',{request_id:res.locals.requestId,project_id:id,execution_id:item.id,revision_id:item.revision_id,status:item.status});res.status(202).json({data:localExecutionSchema.parse(item)});}));
  app.get('/api/v1/local-executions/:id',wrap((req,res)=>{const id=localIdSchema.parse(req.params.id);res.json({data:localExecutionSchema.parse(getLocal().getExecution(id))});}));
  app.get('/api/v1/local-executions/:id/logs',wrap((req,res)=>{const id=localIdSchema.parse(req.params.id),q=localLogQuerySchema.parse(req.query),rows=getLocal().logs(id,q.after_seq,q.limit);res.json({data:rows.map(x=>localLogSchema.parse(x)),page_info:{limit:q.limit,has_more:rows.length===q.limit}});}));
  app.get('/api/v1/local-executions/:id/artifacts',wrap((req,res)=>{const id=localIdSchema.parse(req.params.id);res.json({data:getLocal().artifacts(id).map(x=>localArtifactSchema.parse(x))});}));
  app.get('/api/v1/local-executions/:id/artifacts/:artifactId',wrap((req,res)=>{const id=localIdSchema.parse(req.params.id),artifactId=localIdSchema.parse(req.params.artifactId);res.json({data:getLocal().artifact(id,artifactId)});}));
  app.post('/api/v1/local-executions/:id/cancel',wrap((req,res)=>{const id=localIdSchema.parse(req.params.id);localEmptyBodySchema.parse(req.body??{});res.json({data:localExecutionSchema.parse(getLocal().cancel(id))});}));
  app.get('/api/v1/local-executions/:id/repairs',wrap((req,res)=>{const id=localIdSchema.parse(req.params.id);res.json({data:getRepair().list(id).map(item=>localRepairSchema.parse(item))});}));
  app.post('/api/v1/local-executions/:id/repairs',wrap((req,res)=>{
    const id=localIdSchema.parse(req.params.id);localEmptyBodySchema.parse(req.body??{});
    const mode=process.env.MODEL_MODE==='LIVE'?'LIVE':'MOCK',model=process.env.MODEL_NAME??'deepseek-flash';
    const item=getRepair().create(id,key(req),mode,model);
    log('local.repair_requested',{request_id:res.locals.requestId,execution_id:id,repair_id:item.id,provider_mode:mode});
    res.status(202).json({data:localRepairSchema.parse(item)});
  }));
  app.get('/api/v1/local-repairs/:id',wrap((req,res)=>{const id=localIdSchema.parse(req.params.id);res.json({data:localRepairSchema.parse(getRepair().get(id))});}));
  app.post('/api/v1/local-repairs/:id/approve',wrap((req,res)=>{const id=localIdSchema.parse(req.params.id);localEmptyBodySchema.parse(req.body??{});if(db.prepare('SELECT loop_id FROM local_repair_loop_round WHERE repair_id=?').get(id))throw new LocalError('LOOP_CANDIDATE_MANAGED',409);const item=getRepair().approve(id,key(req));log('local.repair_approved',{request_id:res.locals.requestId,repair_id:id,revision_id:item.approved_revision_id,execution_id:item.verification_execution_id,status:item.status});res.json({data:localRepairSchema.parse(item)});}));
  app.post('/api/v1/local-repairs/:id/reject',wrap((req,res)=>{const id=localIdSchema.parse(req.params.id);localEmptyBodySchema.parse(req.body??{});res.json({data:localRepairSchema.parse(getRepair().reject(id,key(req)))});}));
  app.post('/api/v1/local-repairs/:id/cancel',wrap((req,res)=>{const id=localIdSchema.parse(req.params.id);localEmptyBodySchema.parse(req.body??{});res.json({data:localRepairSchema.parse(getRepair().cancel(id))});}));
  app.get('/api/v1/local-executions/:id/loops',wrap((req,res)=>{const id=localIdSchema.parse(req.params.id);res.json({data:getLoop().list(id).map(item=>localRepairLoopSchema.parse(item))});}));
  app.post('/api/v1/local-executions/:id/loops',wrap((req,res)=>{
    const id=localIdSchema.parse(req.params.id),body=localLoopAuthorizeSchema.parse(req.body??{});
    const mode=process.env.MODEL_MODE==='LIVE'?'LIVE':'MOCK',model=process.env.MODEL_NAME??'deepseek-flash';
    const item=getLoop().create(id,key(req),mode,model,body.authorize);
    log('local.loop_authorized',{request_id:res.locals.requestId,loop_id:item.id,execution_id:id,provider_mode:mode,max_rounds:3,max_model_requests:36});
    res.status(202).json({data:localRepairLoopSchema.parse(item)});
  }));
  app.get('/api/v1/local-repair-loops/:id',wrap((req,res)=>{const id=localIdSchema.parse(req.params.id);res.json({data:localRepairLoopSchema.parse(getLoop().get(id))});}));
  app.post('/api/v1/local-repair-loops/:id/cancel',wrap(async(req,res)=>{const id=localIdSchema.parse(req.params.id);localEmptyBodySchema.parse(req.body??{});res.json({data:localRepairLoopSchema.parse(await getLoop().cancel(id))});}));
  app.use((req,res)=>res.status(404).json({error:{code:'NOT_FOUND',message:'接口不存在',retryable:false,request_id:res.locals.requestId??requestId()}}));
  app.use((error:unknown,_req:Request,res:Response,_next:NextFunction)=>{
    void _next;
    const status=error instanceof HttpError||error instanceof DomainError||error instanceof LocalError?error.status:error instanceof ZodError||error instanceof SyntaxError?400:error instanceof Error&&error.message==='IDEMPOTENCY_CONFLICT'?409:500;
    const code=error instanceof HttpError||error instanceof DomainError||error instanceof LocalError?error.code:error instanceof ZodError?'INVALID_ARGUMENTS':error instanceof SyntaxError?'INVALID_JSON':status===409?'IDEMPOTENCY_CONFLICT':'INTERNAL_ERROR';
    const message=error instanceof HttpError?error.safeMessage:error instanceof DomainError||error instanceof LocalError?'操作未完成：'+code:status===500?'服务暂时不可用':status===409?'幂等键对应不同请求':'请求参数无效';
    log('request.failed',{request_id:res.locals.requestId,error_code:code,status},status===500?'error':'warn');
    res.status(status).json({error:{code,message,retryable:status>=500,request_id:res.locals.requestId??requestId()}});
  });
  return app;
}
