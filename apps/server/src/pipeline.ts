import {spawn,type ChildProcessWithoutNullStreams} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {mkdirSync,lstatSync,realpathSync,existsSync,writeFileSync} from 'node:fs';
import {join,resolve,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
import {pipelineExecutionSchema,pipelineRevisionSchema,pipelineRepairSchema,pipelineProjectSchema,pipelineQuerySchema,type PipelineExecution,type PipelineRevision,type PipelineRepair,type PipelineRow} from '@flowlens/contracts';
import {transaction} from './db.js';
import {LocalError} from './local-execution.js';
import {checkSql as parseSql} from './pipeline-sql.mjs';
import {at,sha,templates,contract,createSource,readSource,createTarget,targetRows,state,digestRows,preview,listBatches,snapshotRows,commitBatch,restoreBatch,oracle} from './pipeline-data.js';

type QueryOutput={columns:string[];rows:PipelineRow[];truncated:boolean;schema:{name:string;type:string}[];elapsed_ms:number};
type Active={child:ChildProcessWithoutNullStreams;projectId:string;cancel:()=>void};
type Operation={id:string;project_id:string;type:string;status:string;execution_id:string|null;batch_id:string|null;error_code:string|null;error_message:string|null;created_at:string};
function checkSql(sql:string,table:string,task=false){try{return parseSql(sql,table,task);}catch(e){throw new LocalError(e instanceof Error?e.message:'SQL_POLICY_REJECTED');}}
export class PipelineService{
 private root:string;
 private jobs=new Map<string,Promise<void>>();
 private active=new Map<string,Active>();
 private writes=new Set<string>();
 constructor(public readonly db:DatabaseSync,root:string,private options:{runnerPath?:string;timeoutMs?:number}={}){mkdirSync(root,{recursive:true});if(lstatSync(root).isSymbolicLink())throw new LocalError('PIPELINE_PATH_REJECTED');this.root=realpathSync.native(resolve(root));}
 path(projectId:string,file:'source.sqlite'|'target.sqlite'|''){if(!/^[a-f0-9-]{36}$/.test(projectId))throw new LocalError('INVALID_PROJECT_ID');const dir=join(this.root,projectId);if(existsSync(dir)&&(lstatSync(dir).isSymbolicLink()||!realpathSync.native(dir).startsWith(this.root+sep)))throw new LocalError('PIPELINE_PATH_REJECTED');const path=file?join(dir,file):dir;if(existsSync(path)&&lstatSync(path).isSymbolicLink())throw new LocalError('PIPELINE_PATH_REJECTED');return path;}
 get<T>(kind:string,id:string):T{const r=this.db.prepare('SELECT json FROM pipeline_entity WHERE kind=? AND id=?').get(kind,id) as {json:string}|undefined;if(!r)throw new LocalError('PIPELINE_'+kind.toUpperCase()+'_NOT_FOUND',404);return JSON.parse(r.json) as T;}
 list<T>(kind:string,projectId?:string,limit=100):T[]{return (projectId?this.db.prepare('SELECT json FROM pipeline_entity WHERE kind=? AND project_id=? ORDER BY rowid DESC LIMIT ?').all(kind,projectId,limit):this.db.prepare('SELECT json FROM pipeline_entity WHERE kind=? ORDER BY rowid DESC LIMIT ?').all(kind,limit)).map(r=>JSON.parse(String(r.json)) as T);}
 put(kind:string,item:{id:string;project_id:string}|{id:string},projectId?:string){const pid=projectId??('project_id' in item?item.project_id:item.id);transaction(this.db,()=>{this.db.prepare('INSERT INTO pipeline_entity VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET json=excluded.json').run(item.id,pid,kind,JSON.stringify(item));this.event(pid,kind+'.changed',item.id);});}
 event(projectId:string,type:string,entityId:string){this.db.prepare('INSERT INTO pipeline_event SELECT ?,coalesce(max(seq),0)+1,?,?,? FROM pipeline_event WHERE project_id=?').run(projectId,type,entityId,at(),projectId);}
 events(projectId:string,after:number){this.project(projectId);return this.db.prepare('SELECT * FROM pipeline_event WHERE project_id=? AND seq>? ORDER BY seq LIMIT 500').all(projectId,after);}
 requireKey(key:string){if(!/^[A-Za-z0-9_-]{1,128}$/.test(key))throw new LocalError('INVALID_IDEMPOTENCY_KEY');}
 dedup(scope:string,key:string,input:unknown){this.requireKey(key);const r=this.db.prepare('SELECT request_hash,response_json FROM request_dedup WHERE scope=? AND idempotency_key=?').get('pipeline_'+scope,key) as {request_hash:string;response_json:string}|undefined;if(!r)return null;if(r.request_hash!==sha(JSON.stringify(input)))throw new LocalError('IDEMPOTENCY_CONFLICT',409);return JSON.parse(r.response_json) as string;}
 remember(scope:string,key:string,input:unknown,id:string){this.db.prepare('INSERT INTO request_dedup VALUES(?,?,?,?,?)').run('pipeline_'+scope,key,sha(JSON.stringify(input)),JSON.stringify(id),at());}
 project(id:string){return pipelineProjectSchema.parse(this.get('project',id));}
 revision(id:string){return pipelineRevisionSchema.parse(this.get('revision',id));}
 execution(id:string){return pipelineExecutionSchema.parse(this.get('execution',id));}
 repair(id:string){return pipelineRepairSchema.parse(this.get('repair',id));}
 publishVerified(r:PipelineRepair){transaction(this.db,()=>{const p=this.project(r.project_id);if(p.current_revision_id!==r.base_revision_id)throw new LocalError('REPAIR_STALE',409);p.current_revision_id=r.approved_revision_id!;r.status='VERIFIED';this.db.prepare('UPDATE pipeline_entity SET json=? WHERE id=?').run(JSON.stringify(p),p.id);this.db.prepare('UPDATE pipeline_entity SET json=? WHERE id=?').run(JSON.stringify(r),r.id);this.event(p.id,'revision.published',p.current_revision_id);this.event(p.id,'repair.verified',r.id);});}
 source(projectId:string){const p=this.project(projectId),source=readSource(this.path(projectId,'source.sqlite'));if(sha(JSON.stringify(source.rows))!==p.input_hash)throw new LocalError('SOURCE_DATA_CHANGED',409);return source;}
 withTarget<T>(id:string,fn:(db:DatabaseSync)=>T,readOnly=false){this.project(id);const db=new DatabaseSync(this.path(id,'target.sqlite'),{readOnly,timeout:1000});try{return fn(db);}finally{db.close();}}
 busy(id:string){return this.writes.has(id)||[...this.active.values()].some(a=>a.projectId===id);}
 private write<T>(id:string,fn:()=>T){if(this.busy(id))throw new LocalError('PIPELINE_BUSY',409);this.writes.add(id);try{return fn();}finally{this.writes.delete(id);}}
 create(templateId:string,key:string){const old=this.dedup('project',key,{templateId});if(old)return this.project(old);const template=templates.find(t=>t.id===templateId);if(!template)throw new LocalError('TEMPLATE_NOT_FOUND');const id=randomUUID(),rid=randomUUID();mkdirSync(this.path(id,''));createSource(this.path(id,'source.sqlite'));createTarget(this.path(id,'target.sqlite'));const inputHash=sha(JSON.stringify(readSource(this.path(id,'source.sqlite')).rows));const project={id,name:template.name,template:templateId,input_source:'SYNTHETIC' as const,input_hash:inputHash,current_revision_id:rid,created_at:at()};const revision:PipelineRevision={id:rid,project_id:id,parent_id:null,sql:template.sql,hash:sha(template.sql),input_hash:inputHash,source:'TEMPLATE',created_at:at()};
  transaction(this.db,()=>{this.db.prepare('INSERT INTO pipeline_entity VALUES (?,?,?,?)').run(id,id,'project',JSON.stringify(project));this.db.prepare('INSERT INTO pipeline_entity VALUES (?,?,?,?)').run(rid,id,'revision',JSON.stringify(revision));this.remember('project',key,{templateId},id);this.event(id,'project.created',id);});return project;
 }
 save(projectId:string,baseId:string,sql:string,key:string){const input={projectId,baseId,sql},old=this.dedup('revision',key,input);if(old)return this.revision(old);const p=this.project(projectId);if(p.current_revision_id!==baseId)throw new LocalError('REVISION_STALE',409);if(this.busy(projectId))throw new LocalError('PIPELINE_BUSY',409);checkSql(sql,'raw_vehicle_events',true);const r:PipelineRevision={id:randomUUID(),project_id:projectId,parent_id:baseId,sql,hash:sha(sql),input_hash:p.input_hash,source:'USER',created_at:at()};transaction(this.db,()=>{this.db.prepare('INSERT INTO pipeline_entity VALUES (?,?,?,?)').run(r.id,projectId,'revision',JSON.stringify(r));p.current_revision_id=r.id;this.db.prepare('UPDATE pipeline_entity SET json=? WHERE id=?').run(JSON.stringify(p),p.id);this.remember('revision',key,input,r.id);this.event(projectId,'revision.saved',r.id);});return r;}
 snapshot(projectId:string){return transaction(this.db,()=>{const project=this.project(projectId);const target=this.withTarget(projectId,db=>{db.exec('BEGIN');try{const rows=targetRows(db),s=state(db),batches=listBatches(db);db.exec('COMMIT');return {batches,target:{...s,hash:digestRows(rows),row_count:rows.length,preview:rows.slice(0,20)}};}catch(e){db.exec('ROLLBACK');throw e;}},true);return {project,revision:this.revision(project.current_revision_id),revisions:this.list<PipelineRevision>('revision',projectId),executions:this.list<PipelineExecution>('execution',projectId,50),repairs:this.list<PipelineRepair>('repair',projectId,30),operations:this.list('operation',projectId,100),...target,cursor:Number(this.db.prepare('SELECT coalesce(max(seq),0) n FROM pipeline_event WHERE project_id=?').get(projectId)?.n)};});}
 schema(projectId:string){return {source:this.source(projectId).schema,target:this.withTarget(projectId,db=>db.prepare('PRAGMA table_info(mining_results)').all().map(r=>({name:String(r.name),type:String(r.type)})),true),contract};}
 private runQuery(id:string,projectId:string,request:Record<string,unknown>,signal?:AbortSignal):Promise<QueryOutput>{
  return new Promise((resolve,reject)=>{
   const env:NodeJS.ProcessEnv={};if(process.env.SystemRoot)env.SystemRoot=process.env.SystemRoot;
   const child=spawn(process.execPath,[this.options.runnerPath??fileURLToPath(new URL('./pipeline-runner.mjs',import.meta.url))],{env,windowsHide:true,shell:false,stdio:['pipe','pipe','pipe']});
   let output='',reason:string|null=null,bytes=0,stderr='';const stop=(code:string)=>{if(!reason){reason=code;child.kill();}};
   const onAbort=()=>stop('QUERY_CANCELLED');signal?.addEventListener('abort',onAbort,{once:true});if(signal?.aborted)onAbort();
   this.active.set(id,{child,projectId,cancel:()=>stop('EXECUTION_CANCELLED')});
   const timer=setTimeout(()=>stop('QUERY_TIMEOUT'),this.options.timeoutMs??10000);
   child.stdout.on('data',(chunk:Buffer)=>{bytes+=chunk.length;if(bytes>256*1024)stop('QUERY_OUTPUT_LIMIT');else output+=chunk.toString();});
   child.stderr.on('data',(chunk:Buffer)=>{stderr=(stderr+chunk.toString()).slice(0,2000);});
   child.on('error',()=>stop('RUNNER_START_FAILED'));child.stdin.on('error',()=>{});
   child.on('close',(code)=>{clearTimeout(timer);this.active.delete(id);signal?.removeEventListener('abort',onAbort);if(reason)return reject(new LocalError(reason,409));try{const r=JSON.parse(output) as QueryOutput&{error_code?:string;error_message?:string};if(code!==0||r.error_code)throw new Error(r.error_message??stderr??'RUNNER_FAILED');resolve(r);}catch(e){reject(e);}});
   child.stdin.end(JSON.stringify(request));
  });
 }
 start(projectId:string,key:string,revisionId?:string,kind:'PRECHECK'|'VERIFICATION'='PRECHECK'){
  const input={projectId,revisionId:revisionId??null,kind},old=this.dedup('execution',key,input);if(old)return this.execution(old);
  const p=this.project(projectId),r=this.revision(revisionId??p.current_revision_id);if(r.project_id!==projectId||r.input_hash!==p.input_hash||r.hash!==sha(r.sql))throw new LocalError('EXECUTION_SCOPE',403);
  if(this.active.size||this.writes.size)throw new LocalError('PIPELINE_BUSY',409);this.source(projectId);
  const e:PipelineExecution={id:randomUUID(),project_id:projectId,revision_id:r.id,revision_hash:r.hash,input_hash:r.input_hash,kind,status:'RUNNING',created_at:at(),finished_at:null,logs:[],columns:[],rows:[],error_code:null,error_message:null,failed_step:null,exit_code:null,validation:null,precheck:null,verification:null};
  transaction(this.db,()=>{this.db.prepare('INSERT INTO pipeline_entity VALUES(?,?,?,?)').run(e.id,projectId,'execution',JSON.stringify(e));this.remember('execution',key,input,e.id);this.event(projectId,'execution.started',e.id);});
  const job=this.run(e,r).finally(()=>{this.jobs.delete(e.id);});this.jobs.set(e.id,job);return this.execution(e.id);
 }
 private log(e:PipelineExecution,step:string,message:string,level='INFO'){e.logs.push({at:at(),step,level,message:message.slice(0,2000)});this.put('execution',e);}
 private async run(e:PipelineExecution,r:PipelineRevision){let step='query';
  try{
   this.log(e,step,'启动固定 Node 子进程，使用只读源库执行 task.sql');checkSql(r.sql,'raw_vehicle_events',true);
   const result=await this.runQuery(e.id,e.project_id,{sql:r.sql,table:'raw_vehicle_events',task:true,source_path:this.path(e.project_id,'source.sqlite'),limit:200});
   e.exit_code=0;e.columns=result.columns;e.rows=result.rows;this.log(e,step,`SQLite 查询完成：${result.rows.length} 行，${result.elapsed_ms.toFixed(1)} ms`);
   step='validate';if(result.truncated)throw new LocalError('TASK_OUTPUT_LIMIT',422);
   e.validation=oracle(this.source(e.project_id).rows,result.rows,result.columns);this.log(e,step,e.validation.message,e.validation.passed?'INFO':'ERROR');
   if(!e.validation.passed)throw new LocalError('OUTPUT_VALIDATION_FAILED',422);
   step='precheck';const view=this.withTarget(e.project_id,db=>({version:state(db).data_version,hash:digestRows(targetRows(db)),...preview(db,e.project_id,e.rows)}),true);
   e.precheck={target_version:view.version,target_hash:view.hash,output_hash:sha(JSON.stringify(e.rows)),inserted:view.inserted,skipped:view.skipped,conflicts:view.conflicts,expires_at:new Date(Date.now()+600000).toISOString()};
   if(view.conflicts)throw new LocalError('BUSINESS_KEY_CONFLICT',409);
   this.log(e,step,`只读预检：预计新增 ${view.inserted}、跳过 ${view.skipped}、冲突 ${view.conflicts}；目标版本 ${view.version}`);
   if(e.kind==='VERIFICATION'){
    step='verification';const dir=join(this.path(e.project_id,''),'verify-'+e.id);mkdirSync(dir);const path=join(dir,'target.sqlite');createTarget(path);
    const initial=this.withTarget(e.project_id,db=>targetRows(db),true),vdb=new DatabaseSync(path);
    try{
     const insert=vdb.prepare('INSERT INTO mining_results VALUES(?,?,?,?,?,?)');transaction(vdb,()=>{for(const row of initial)insert.run(row.task_id,row.dat,row.st,row.et,row.car_series,row.execution_id);});
     const binding=sha(e.revision_hash+e.input_hash+JSON.stringify(e.rows));
     const first=commitBatch(vdb,{projectId:e.project_id,executionId:e.id,revisionId:r.id,rows:e.rows,key:'verify1',binding,version:0,targetHash:digestRows(initial)});
     const second=commitBatch(vdb,{projectId:e.project_id,executionId:randomUUID(),revisionId:r.id,rows:e.rows,key:'verify2',binding,version:state(vdb).data_version,targetHash:digestRows(targetRows(vdb))});
     e.verification={inserted:first.inserted,rerun_skipped:second.skipped,passed:second.inserted===0&&second.skipped===e.rows.length&&digestRows(targetRows(vdb))===first.after_hash};
     writeFileSync(join(dir,'verification.json'),JSON.stringify({input_hash:e.input_hash,initial_target_hash:digestRows(initial),result:e.verification}));
     if(!e.verification.passed)throw new LocalError('IDEMPOTENCY_VERIFICATION_FAILED',422);
    }finally{vdb.close();}
    this.log(e,step,'隔离目标库实际提交并重跑，独立规则及无重复入库验证通过');e.status='SUCCEEDED';
   }else e.status='PRECHECK_PASSED';
  }catch(error){const message=error instanceof Error?error.message:String(error);e.status=message==='EXECUTION_CANCELLED'?'CANCELLED':'FAILED';e.error_code=error instanceof LocalError?error.code:step==='query'?'SQL_QUERY_FAILED':'PIPELINE_FAILED';e.error_message=message.slice(0,2000);e.failed_step=step;if(e.exit_code===null)e.exit_code=2;this.log(e,step,e.error_message,'ERROR');}
  e.finished_at=at();this.put('execution',e);
 }
 async waitFor(id:string){await this.jobs.get(id);return this.execution(id);}
 cancel(id:string){const e=this.execution(id);this.active.get(id)?.cancel();return e;}
 async stopAll(){for(const item of this.active.values())item.cancel();await Promise.all(this.jobs.values());}
 recover(){for(const e of this.list<PipelineExecution>('execution',undefined,100000)){if(e.status==='RUNNING'){e.status='INTERRUPTED';e.error_code='SERVER_RESTARTED';e.finished_at=at();this.put('execution',e);}}for(const r of this.list<PipelineRepair>('repair',undefined,100000)){if(['QUEUED','RUNNING','VERIFYING'].includes(r.status)){r.status='INTERRUPTED';r.error_code='SERVER_RESTARTED';this.put('repair',r);}}
  // Target receipts are authoritative; reading snapshots always reconciles batches.
  for(const op of this.list<Operation>('operation',undefined,100000)){if(op.status==='RUNNING'){this.reconcileOperation(op);if(op.status==='RUNNING'){op.status='INTERRUPTED';op.error_code='SERVER_RESTARTED';op.error_message='服务器重启，目标库没有已提交凭证';this.put('operation',op);}}}
 }
 private reconcileOperation(op:Operation){if(op.status!=='RUNNING')return op;const receipt=this.withTarget(op.project_id,db=>op.type==='COMMIT'?db.prepare('SELECT json FROM batches WHERE execution_id=?').get(op.execution_id):db.prepare('SELECT json FROM restores WHERE batch_id=?').get(op.batch_id),true);if(receipt){if(op.type==='COMMIT')op.batch_id=String(JSON.parse(String(receipt.json)).id);op.status='SUCCEEDED';op.error_code=null;op.error_message=null;this.put('operation',op);}return op;}
 private operation(projectId:string,type:string,executionId:string|null,batchId:string|null,key:string,perform:()=>unknown){const input={projectId,type,executionId,batchId},old=this.dedup('operation',key,input);if(old)return this.reconcileOperation(this.get<Operation>('operation',old));const op:Operation={id:randomUUID(),project_id:projectId,type,status:'RUNNING',execution_id:executionId,batch_id:batchId,error_code:null,error_message:null,created_at:at()};this.put('operation',op);this.remember('operation',key,input,op.id);try{const result=perform() as {id?:string}|undefined;if(type==='COMMIT'&&result?.id)op.batch_id=result.id;op.status='SUCCEEDED';}catch(e){op.status='FAILED';op.error_code=e instanceof LocalError?e.code:'TRANSACTION_ROLLED_BACK';op.error_message=e instanceof Error?e.message.slice(0,2000):'事务失败，已回滚';}this.put('operation',op);return op;}
 commit(projectId:string,executionId:string,key:string){this.requireKey(key);const e=this.execution(executionId);if(e.project_id!==projectId)throw new LocalError('EXECUTION_SCOPE',403);const old=this.dedup('operation',key,{projectId,type:'COMMIT',executionId,batchId:null});if(old)return this.reconcileOperation(this.get<Operation>('operation',old));return this.write(projectId,()=>this.operation(projectId,'COMMIT',executionId,null,key,()=>this.withTarget(projectId,db=>{
   const binding=sha(JSON.stringify({projectId,executionId,revision_hash:e.revision_hash,input_hash:e.input_hash,precheck:e.precheck}));
   const receipt=db.prepare('SELECT binding_hash,json FROM batches WHERE execution_id=?').get(e.id) as {binding_hash:string;json:string}|undefined;if(receipt){if(receipt.binding_hash!==binding)throw new LocalError('COMMIT_BINDING_CHANGED',409);return JSON.parse(receipt.json) as unknown;}
   const p=this.project(projectId),r=this.revision(p.current_revision_id);this.source(projectId);
   if(e.status!=='PRECHECK_PASSED'||!e.precheck||!e.validation?.passed)throw new LocalError('PRECHECK_REQUIRED',409);
   if(e.revision_id!==r.id||e.revision_hash!==r.hash||sha(r.sql)!==e.revision_hash||e.input_hash!==p.input_hash||e.precheck.output_hash!==sha(JSON.stringify(e.rows)))throw new LocalError('PRECHECK_STALE',409);
   if(Date.parse(e.precheck.expires_at)<=Date.now())throw new LocalError('PRECHECK_EXPIRED',409);
   return commitBatch(db,{projectId,executionId:e.id,revisionId:e.revision_id,rows:e.rows,key,binding,version:e.precheck.target_version,targetHash:e.precheck.target_hash});
  })));
 }
 restore(projectId:string,batchId:string,key:string){this.requireKey(key);const old=this.dedup('operation',key,{projectId,type:'RESTORE',executionId:null,batchId});if(old)return this.reconcileOperation(this.get<Operation>('operation',old));return this.write(projectId,()=>this.operation(projectId,'RESTORE',null,batchId,key,()=>this.withTarget(projectId,db=>restoreBatch(db,batchId,key))));}
 async query(projectId:string,raw:unknown,signal?:AbortSignal){const q=pipelineQuerySchema.parse(raw);this.project(projectId);if(this.writes.has(projectId))throw new LocalError('PIPELINE_BUSY',409);const table=q.scope==='source'?'raw_vehicle_events':'mining_results';checkSql(q.sql,table);let request:Record<string,unknown>,version:number,dataHash:string;
  if(q.scope==='source'){const source=this.source(projectId);version=1;dataHash=sha(JSON.stringify(source.rows));request={source_path:this.path(projectId,'source.sqlite')};}
  else{const view=this.withTarget(projectId,db=>{db.exec('BEGIN');try{const s=state(db),selected=q.scope==='snapshot'?snapshotRows(db,q.batch_id??''):null,rows=selected?selected.rows:targetRows(db);db.exec('COMMIT');return {version:selected?selected.batch.data_version:s.data_version,rows,hash:digestRows(rows)};}catch(e){db.exec('ROLLBACK');throw e;}},true);version=view.version;dataHash=view.hash;request={rows:view.rows};}
  let r:QueryOutput;try{r=await this.runQuery('query-'+randomUUID(),projectId,{...request,table,sql:q.sql,task:false,limit:q.limit},signal);}catch(e){if(e instanceof LocalError)throw e;const failure=new LocalError('SQL_QUERY_FAILED',422);failure.message=e instanceof Error?e.message.slice(0,2000):'SQLite 查询失败';throw failure;}
  return {...r,project_id:projectId,scope:q.scope,batch_id:q.scope==='snapshot'?q.batch_id??null:null,data_version:version,data_hash:dataHash,row_count:r.rows.length};
 }
}
