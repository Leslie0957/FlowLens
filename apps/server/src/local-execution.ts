import {spawn,type ChildProcessWithoutNullStreams} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {existsSync,lstatSync,mkdirSync,readFileSync,realpathSync,writeFileSync} from 'node:fs';
import {dirname,join,resolve,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import type {DatabaseSync} from 'node:sqlite';
import {transaction} from './db.js';

const input=JSON.stringify([{order_id:101,amount:20},{order_id:102,amount:30},{order_id:103,amount:50}]);
const templates={
  'sql-column-error':{name:'SQL 列错误',sql:'SELECT COUNT(*) AS order_count, SUM(order_total) AS total_amount FROM orders;'},
  'sql-valid-control':{name:'正常对照（预置）',sql:'SELECT COUNT(*) AS order_count, SUM(amount) AS total_amount FROM orders;'}
} as const;
const sqlGrammar=/^\s*SELECT\s+COUNT\s*\(\s*\*\s*\)\s+AS\s+order_count\s*,\s*SUM\s*\(\s*([A-Za-z_][A-Za-z_0-9]*)\s*\)\s+AS\s+total_amount\s+FROM\s+orders\s*;?\s*$/i;
const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
const now=()=>new Date().toISOString();
const keyPattern=/^[A-Za-z0-9_-]{1,128}$/;
const terminal=new Set(['SUCCEEDED','FAILED','CANCELLED','INTERRUPTED']);
export class LocalError extends Error{constructor(public code:string,public status=400){super(code);}}
type ProjectRow={id:string;template_id:string;name:string;input_source:string;current_revision_id:string;created_at:string};
type RevisionRow={id:string;project_id:string;parent_revision_id:string|null;sql_text:string;input_json:string;sha256:string;created_source:string;created_at:string};
export type ExecutionRow={id:string;project_id:string;revision_id:string;revision_hash:string;status:string;created_at:string;started_at:string|null;finished_at:string|null;exit_code:number|null;termination_reason:string|null;error_code:string|null;error_message:string|null;validation_json:string|null;runner_version:string;validator_version:string;work_dir:string};
type Active={child:ChildProcessWithoutNullStreams;done:Promise<void>;stopReason:string|null};
export class LocalExecutionService{
  private readonly root:string;
  private readonly runner:string;
  private readonly timeoutMs:number;
  private readonly active=new Map<string,Active>();
  hasActive(){return this.active.size>0;}
  constructor(private readonly db:DatabaseSync,root:string,options:{runnerPath?:string;timeoutMs?:number}={}){
    this.root=resolve(root);this.runner=options.runnerPath??fileURLToPath(new URL('./local-runner.mjs',import.meta.url));this.timeoutMs=options.timeoutMs??30000;
    mkdirSync(this.root,{recursive:true});
    if(lstatSync(this.root).isSymbolicLink())throw new LocalError('LOCAL_PATH_REJECTED');
    this.root=realpathSync.native(this.root);
  }
  private safePath(projectId:string,executionId?:string):string{
    if(!/^[0-9a-f-]{36}$/.test(projectId)||executionId&&!/^[0-9a-f-]{36}$/.test(executionId))throw new LocalError('LOCAL_PATH_REJECTED');
    const path=executionId?join(this.root,projectId,executionId):join(this.root,projectId);
    if(!resolve(path).startsWith(this.root+sep))throw new LocalError('LOCAL_PATH_REJECTED');
    const project=join(this.root,projectId);
    for(const item of [project,executionId?path:null])if(item&&existsSync(item)){
      if(lstatSync(item).isSymbolicLink()||!realpathSync.native(item).startsWith(this.root+sep))throw new LocalError('LOCAL_PATH_REJECTED');
    }
    return path;
  }
  private requireKey(key:string){if(!keyPattern.test(key))throw new LocalError('INVALID_IDEMPOTENCY_KEY');}
  private dedup(scope:string,key:string,digest:string):string|null{
    const row=this.db.prepare('SELECT request_hash,response_json FROM request_dedup WHERE scope=? AND idempotency_key=?').get(scope,key) as {request_hash:string;response_json:string}|undefined;
    if(!row)return null;
    if(row.request_hash!==digest)throw new LocalError('IDEMPOTENCY_CONFLICT',409);
    return JSON.parse(row.response_json) as string;
  }
  private remember(scope:string,key:string,digest:string,id:string){this.db.prepare('INSERT INTO request_dedup VALUES (?,?,?,?,?)').run(scope,key,digest,JSON.stringify(id),now());}
  listProjects(page:number,limit:number){
    const total=(this.db.prepare('SELECT count(*) n FROM local_project').get() as {n:number}).n;
    const data=this.db.prepare('SELECT * FROM local_project ORDER BY created_at DESC,id DESC LIMIT ? OFFSET ?').all(limit,(page-1)*limit) as ProjectRow[];
    return {data,total};
  }
  createProject(templateId:string,key:string){
    this.requireKey(key);
    if(!(templateId in templates))throw new LocalError('LOCAL_TEMPLATE_NOT_FOUND');
    const digest=hash(templateId),old=this.dedup('local_project',key,digest);if(old)return this.getProject(old);
    const id=randomUUID(),revisionId=randomUUID(),template=templates[templateId as keyof typeof templates];
    const dir=this.safePath(id);mkdirSync(dir);
    return transaction(this.db,()=>{
      const again=this.dedup('local_project',key,digest);if(again)return this.getProject(again);
      this.db.prepare('INSERT INTO local_project VALUES (?,?,?,?,?,?)').run(id,templateId,template.name,'SYNTHETIC',revisionId,now());
      this.db.prepare('INSERT INTO local_revision VALUES (?,?,?,?,?,?,?,?)').run(revisionId,id,null,template.sql,input,hash(template.sql+'\n'+input),'TEMPLATE',now());
      this.remember('local_project',key,digest,id);
      return this.getProject(id);
    });
  }
  getProject(id:string){
    const row=this.db.prepare('SELECT * FROM local_project WHERE id=?').get(id) as ProjectRow|undefined;
    if(!row)throw new LocalError('LOCAL_PROJECT_NOT_FOUND',404);
    const revision=this.db.prepare('SELECT * FROM local_revision WHERE id=? AND project_id=?').get(row.current_revision_id,id) as RevisionRow;
    return {...row,revision};
  }
  listExecutions(projectId:string,page:number,limit:number){
    this.getProject(projectId);
    const total=(this.db.prepare('SELECT count(*) n FROM local_execution WHERE project_id=?').get(projectId) as {n:number}).n;
    const data=this.db.prepare('SELECT * FROM local_execution WHERE project_id=? ORDER BY created_at DESC,id DESC LIMIT ? OFFSET ?').all(projectId,limit,(page-1)*limit) as ExecutionRow[];
    return {data:data.map(x=>this.publicExecution(x)),total};
  }
  getExecution(id:string){const row=this.db.prepare('SELECT * FROM local_execution WHERE id=?').get(id) as ExecutionRow|undefined;if(!row)throw new LocalError('LOCAL_EXECUTION_NOT_FOUND',404);return this.publicExecution(row);}
  private publicExecution(row:ExecutionRow){const {work_dir,validation_json,...safe}=row;void work_dir;return {...safe,validation:validation_json?JSON.parse(validation_json) as unknown:null};}
  startExecution(projectId:string,key:string){
    this.requireKey(key);
    const project=this.getProject(projectId),revision=project.revision;
    const digest=hash(projectId+'\n'+revision.id+'\n'+revision.sha256),old=this.dedup('local_execution',key,digest);
    if(old)return this.getExecution(old);
    if(this.active.size>=1)throw new LocalError('LOCAL_EXECUTION_BUSY',409);
    const id=randomUUID(),dir=this.safePath(projectId,id);
    const result=transaction(this.db,()=>{
      const again=this.dedup('local_execution',key,digest);if(again)return {id:again,new:false};
      this.db.prepare('INSERT INTO local_execution VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(id,projectId,revision.id,revision.sha256,'PENDING',now(),null,null,null,null,null,null,null,'sql-runner-v1','orders-oracle-v1',dir);
      this.remember('local_execution',key,digest,id);
      return {id,new:true};
    });
    if(!result.new)return this.getExecution(result.id);
    try{
      mkdirSync(dir);
      writeFileSync(join(dir,'task.sql'),revision.sql_text,{flag:'wx'});
      writeFileSync(join(dir,'input.json'),revision.input_json,{flag:'wx'});
      this.registerArtifact(id,'task.sql',revision.sql_text);
      this.registerArtifact(id,'input.json',revision.input_json);
      if(!sqlGrammar.test(revision.sql_text)){this.fail(id,'SQL_POLICY_REJECTED','SQL 不在限定聚合查询范围内',null);return this.getExecution(id);}
      this.launch(id,dir);
    }catch(error){this.fail(id,'LOCAL_RUNNER_ERROR',error instanceof Error?error.message:'启动失败',null);}
    return this.getExecution(id);
  }
  private launch(id:string,dir:string){
    const env:NodeJS.ProcessEnv={FLOWLENS_LOCAL_RUNNER:'1'};
    if(process.env.SystemRoot)env.SystemRoot=process.env.SystemRoot;
    const child=spawn(process.execPath,[this.runner,dir],{cwd:dir,env,shell:false,windowsHide:true,stdio:['pipe','pipe','pipe']});
    this.db.prepare("UPDATE local_execution SET status='RUNNING',started_at=? WHERE id=?").run(now(),id);
    this.log(id,'INFO','process','Node 子进程已启动');
    let resolveDone!:()=>void;const done=new Promise<void>(resolve=>{resolveDone=resolve;});
    const active:Active={child,done,stopReason:null};this.active.set(id,active);
    let outputBytes=0,stdout='',stderr='';
    const timer=setTimeout(()=>this.stopProcess(id,'LOCAL_EXECUTION_TIMEOUT'),this.timeoutMs);
    const consume=(chunk:Buffer,level:'INFO'|'ERROR')=>{
      outputBytes+=chunk.length;
      if(outputBytes>200*1024){this.stopProcess(id,'LOCAL_OUTPUT_LIMIT');return;}
      const value=chunk.toString('utf8');
      if(level==='INFO')stdout+=value;else stderr+=value;
      const lines=(level==='INFO'?stdout:stderr).split(/\r?\n/);
      if(level==='INFO')stdout=lines.pop()??'';else stderr=lines.pop()??'';
      if(Buffer.byteLength(level==='INFO'?stdout:stderr)>2048){this.stopProcess(id,'LOCAL_OUTPUT_LIMIT');return;}
      for(const line of lines){if(Buffer.byteLength(line)>2048){this.stopProcess(id,'LOCAL_OUTPUT_LIMIT');return;}if(line)this.log(id,level,'sqlite',line);}
    };
    child.stdout.on('data',(chunk:Buffer)=>consume(chunk,'INFO'));
    child.stderr.on('data',(chunk:Buffer)=>consume(chunk,'ERROR'));
    child.on('error',error=>{this.log(id,'ERROR','process',error.message.slice(0,2048));active.stopReason='LOCAL_RUNNER_ERROR';});
    child.on('close',(code,signal)=>{
      clearTimeout(timer);
      for(const [value,level] of [[stdout,'INFO'],[stderr,'ERROR']] as const)if(value)this.log(id,level,'sqlite',value.slice(0,2048));
      this.finish(id,dir,code,signal,active.stopReason);
      this.active.delete(id);resolveDone();
    });
  }
  private log(id:string,level:string,step:string,message:string){
    const seq=(this.db.prepare('SELECT coalesce(max(seq),0)+1 n FROM local_execution_log WHERE execution_id=?').get(id) as {n:number}).n;
    this.db.prepare('INSERT INTO local_execution_log VALUES (?,?,?,?,?,?,?)').run(randomUUID(),id,seq,now(),level,step,message.slice(0,2048));
  }
  private registerArtifact(id:string,name:'task.sql'|'input.json'|'result.json',content:string){
    const size=Buffer.byteLength(content);if(size>64*1024)throw new LocalError('LOCAL_ARTIFACT_LIMIT');
    this.db.prepare('INSERT INTO local_artifact VALUES (?,?,?,?,?)').run(randomUUID(),id,name,hash(content),size);
  }
  private finish(id:string,dir:string,code:number|null,signal:string|null,reason:string|null){
    const row=this.db.prepare('SELECT status FROM local_execution WHERE id=?').get(id) as {status:string};
    if(terminal.has(row.status))return;
    let errorCode=reason,errorMessage:string|null=reason,validation:unknown=null,status='FAILED';
    try{
      const resultPath=join(dir,'result.json');
      if(existsSync(resultPath)){
        const content=readFileSync(resultPath,'utf8');this.registerArtifact(id,'result.json',content);
        const parsed=JSON.parse(content) as {rows?:unknown};
        const rows=parsed.rows;
        if(!Array.isArray(rows)||rows.length!==1||typeof rows[0]!=='object'||rows[0]===null)throw new Error('结果结构无效');
        const value=rows[0] as Record<string,unknown>;
        const passed=value.order_count===3&&value.total_amount===100;
        validation={passed,order_count:value.order_count,total_amount:value.total_amount,expected:{order_count:3,total_amount:100}};
        if(!reason&&code===0){status=passed?'SUCCEEDED':'FAILED';errorCode=passed?null:'RESULT_VALIDATION_FAILED';errorMessage=passed?null:'结果不满足 3 笔订单、总额 100';}
      }
      else if(!reason&&code===0){errorCode='LOCAL_RUNNER_ERROR';errorMessage='子进程未生成结果产物';}
    }catch(error){if(!reason){errorCode=error instanceof LocalError?error.code:'LOCAL_RUNNER_ERROR';errorMessage=error instanceof Error?error.message:'结果读取失败';}}
    if(!reason&&code!==0){
      const last=this.db.prepare("SELECT message FROM local_execution_log WHERE execution_id=? AND level='ERROR' ORDER BY seq DESC LIMIT 1").get(id) as {message:string}|undefined;
      errorCode=code===2?'SQL_COLUMN_ERROR':code===3?'SQL_POLICY_REJECTED':'LOCAL_RUNNER_ERROR';errorMessage=last?.message??'子进程执行失败';
    }
    if(reason==='LOCAL_EXECUTION_CANCELLED')status='CANCELLED';
    if(reason==='LOCAL_EXECUTION_INTERRUPTED')status='INTERRUPTED';
    this.log(id,status==='SUCCEEDED'?'INFO':'ERROR','validation',status==='SUCCEEDED'?'独立业务验证通过':`${errorCode??'LOCAL_RUNNER_ERROR'}: ${errorMessage??'执行失败'}`);
    this.db.prepare('UPDATE local_execution SET status=?,finished_at=?,exit_code=?,termination_reason=?,error_code=?,error_message=?,validation_json=? WHERE id=?').run(status,now(),code,reason??signal,errorCode,errorMessage,validation?JSON.stringify(validation):null,id);
  }
  private fail(id:string,code:string,message:string,exitCode:number|null){
    this.log(id,'ERROR','process',message.slice(0,2048));
    this.db.prepare("UPDATE local_execution SET status='FAILED',finished_at=?,exit_code=?,error_code=?,error_message=? WHERE id=?").run(now(),exitCode,code,message.slice(0,2048),id);
  }
  private stopProcess(id:string,reason:string){const item=this.active.get(id);if(!item||item.stopReason)return;item.stopReason=reason;item.child.kill();}
  cancel(id:string){const row=this.getExecution(id);if(terminal.has(row.status))return row;this.stopProcess(id,'LOCAL_EXECUTION_CANCELLED');return this.getExecution(id);}
  async waitFor(id:string){const item=this.active.get(id);if(item)await item.done;return this.getExecution(id);}
  async stopAll(){const items=[...this.active.entries()];for(const [id] of items)this.stopProcess(id,'LOCAL_EXECUTION_INTERRUPTED');await Promise.all(items.map(([,item])=>item.done));}
  recoverInterrupted(){this.db.prepare("UPDATE local_execution SET status='INTERRUPTED',finished_at=?,termination_reason='LOCAL_EXECUTION_INTERRUPTED',error_code='LOCAL_EXECUTION_INTERRUPTED',error_message='服务重启时执行中断' WHERE status IN ('PENDING','RUNNING')").run(now());}
  logs(id:string,afterSeq:number,limit:number){this.getExecution(id);return this.db.prepare('SELECT id,execution_id,seq,timestamp,level,step,message FROM local_execution_log WHERE execution_id=? AND seq>? ORDER BY seq LIMIT ?').all(id,afterSeq,limit);}
  artifacts(id:string){this.getExecution(id);return this.db.prepare('SELECT id,execution_id,name,sha256,size FROM local_artifact WHERE execution_id=? ORDER BY name').all(id);}
  artifact(id:string,artifactId:string){
    const execution=this.db.prepare('SELECT * FROM local_execution WHERE id=?').get(id) as ExecutionRow|undefined;if(!execution)throw new LocalError('LOCAL_EXECUTION_NOT_FOUND',404);
    const item=this.db.prepare('SELECT * FROM local_artifact WHERE id=? AND execution_id=?').get(artifactId,id) as {name:'task.sql'|'input.json'|'result.json';sha256:string;size:number}|undefined;
    if(!item)throw new LocalError('LOCAL_ARTIFACT_NOT_FOUND',404);
    const dir=this.safePath(execution.project_id,id);if(dir!==execution.work_dir)throw new LocalError('LOCAL_PATH_REJECTED');
    const path=join(dir,item.name);if(lstatSync(path).isSymbolicLink())throw new LocalError('LOCAL_PATH_REJECTED');
    const content=readFileSync(path,'utf8');if(Buffer.byteLength(content)!==item.size||hash(content)!==item.sha256)throw new LocalError('LOCAL_ARTIFACT_CHANGED',409);
    return {name:item.name,content};
  }
}
export const localTemplates=Object.entries(templates).map(([id,value])=>({id,name:value.name}));
export function localRootForDatabase(dbPath:string){return join(dirname(dbPath),'local-projects');}
