import {createHash,randomUUID} from 'node:crypto';
import type {DatabaseSync} from 'node:sqlite';
import {transaction} from './db.js';
import {LocalError,LocalExecutionService} from './local-execution.js';
import {LocalRepairService} from './local-repair.js';
import {errorCode} from './model-error.js';
import {localRepairSchema,localExecutionSchema} from '@flowlens/contracts';

const now=()=>new Date().toISOString();
const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
const keyPattern=/^[A-Za-z0-9_-]{1,128}$/;
const terminal=new Set(['SUCCEEDED','FAILED','LIMIT_REACHED','TIMED_OUT','CANCELLED','INTERRUPTED']);
type LoopRow={id:string;project_id:string;initial_execution_id:string;status:string;provider_mode:'LIVE'|'MOCK';model:string;max_rounds:number;max_model_requests:number;writable_file:string;verification_command_id:string;deadline_at:string;current_execution_id:string;error_code:string|null;created_at:string;updated_at:string;finished_at:string|null;cancel_requested_at:string|null};

export class LocalRepairLoopService{
  private jobs=new Map<string,Promise<void>>();
  constructor(private readonly db:DatabaseSync,private readonly local:LocalExecutionService,private readonly repair:LocalRepairService,private readonly options:{durationMs?:number}={}){}
  private row(id:string){const row=this.db.prepare('SELECT * FROM local_repair_loop WHERE id=?').get(id) as LoopRow|undefined;if(!row)throw new LocalError('REPAIR_LOOP_NOT_FOUND',404);return row;}
  get(id:string){
    const row=this.row(id);
    const rounds=(this.db.prepare('SELECT round_no,repair_id,created_at FROM local_repair_loop_round WHERE loop_id=? ORDER BY round_no').all(id) as {round_no:number;repair_id:string;created_at:string}[]).map(item=>({round_no:item.round_no,created_at:item.created_at,repair:localRepairSchema.parse(this.repair.get(item.repair_id))}));
    const usage=rounds.reduce((value,item)=>({prompt_tokens:value.prompt_tokens+(item.repair.usage?.prompt_tokens??0),completion_tokens:value.completion_tokens+(item.repair.usage?.completion_tokens??0)}),{prompt_tokens:0,completion_tokens:0});
    return {...row,status:row.status==='ACTIVE'&&row.cancel_requested_at?'STOPPING':row.status,rounds,model_requests:rounds.reduce((count,item)=>count+item.repair.model_requests,0),usage};
  }
  list(executionId:string){this.local.getExecution(executionId);return (this.db.prepare('SELECT id FROM local_repair_loop WHERE initial_execution_id=? ORDER BY created_at DESC,id DESC LIMIT 20').all(executionId) as {id:string}[]).map(item=>this.get(item.id));}
  create(executionId:string,key:string,mode:'LIVE'|'MOCK',model:string,authorize:boolean){
    if(!keyPattern.test(key))throw new LocalError('INVALID_IDEMPOTENCY_KEY');
    if(authorize!==true)throw new LocalError('LOOP_AUTHORIZATION_REQUIRED',400);
    const digest=hash(JSON.stringify({executionId,mode,model,authorize}));
    const old=this.db.prepare("SELECT request_hash,response_json FROM request_dedup WHERE scope='local_repair_loop' AND idempotency_key=?").get(key) as {request_hash:string;response_json:string}|undefined;
    if(old){if(old.request_hash!==digest)throw new LocalError('IDEMPOTENCY_CONFLICT',409);return this.get(JSON.parse(old.response_json) as string);}
    const execution=this.local.getExecution(executionId);
    if(execution.status!=='FAILED')throw new LocalError('LOOP_REQUIRES_FAILED_EXECUTION',409);
    const project=this.local.getProject(execution.project_id);
    if(project.current_revision_id!==execution.revision_id||project.revision.sha256!==execution.revision_hash)throw new LocalError('REPAIR_STALE',409);
    if(mode==='LIVE'&&(!process.env.MODEL_API_KEY||process.env.FLOWLENS_LIVE_APPROVED!=='1'))throw new LocalError('MODEL_NOT_CONFIGURED',503);
    const active=this.db.prepare("SELECT id FROM local_repair_loop WHERE project_id=? AND status='ACTIVE'").get(project.id);
    if(active)throw new LocalError('REPAIR_LOOP_BUSY',409);
    const id=randomUUID(),at=now(),deadline=new Date(Date.now()+(this.options.durationMs??600000)).toISOString();
    transaction(this.db,()=>{
      this.db.prepare('INSERT INTO local_repair_loop (id,project_id,initial_execution_id,status,provider_mode,model,max_rounds,max_model_requests,writable_file,verification_command_id,deadline_at,current_execution_id,error_code,created_at,updated_at,finished_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(id,project.id,executionId,'ACTIVE',mode,model,3,36,'task.sql','orders-sql-v1',deadline,executionId,null,at,at,null);
      this.db.prepare('INSERT INTO request_dedup VALUES (?,?,?,?,?)').run('local_repair_loop',key,digest,JSON.stringify(id),at);
    });
    const job=Promise.resolve().then(()=>this.run(id)).finally(()=>this.jobs.delete(id));this.jobs.set(id,job);
    return this.get(id);
  }
  async waitFor(id:string){await this.jobs.get(id);return this.get(id);}
  private finish(id:string,status:string,error:string|null=null){
    if(!terminal.has(status))throw new Error('INVALID_LOOP_STATUS');
    this.db.prepare("UPDATE local_repair_loop SET status=?,error_code=?,updated_at=?,finished_at=? WHERE id=? AND status='ACTIVE'").run(status,error,now(),now(),id);
  }
  private active(id:string){
    const row=this.row(id);
    if(row.status!=='ACTIVE')return false;
    if(row.cancel_requested_at)return false;
    if(Date.now()>=Date.parse(row.deadline_at)){this.requestStop(id,'REPAIR_LOOP_TIMEOUT');return false;}
    return true;
  }
  private requestStop(id:string,code:'REPAIR_LOOP_TIMEOUT'|'REPAIR_LOOP_CANCELLED'){
    const at=now();
    const changed=this.db.prepare("UPDATE local_repair_loop SET cancel_requested_at=?,error_code=?,updated_at=? WHERE id=? AND status='ACTIVE' AND cancel_requested_at IS NULL").run(at,code,at,id);
    if(changed.changes===1)this.cancelWork(id);
  }
  private cancelWork(id:string){
    const last=this.db.prepare('SELECT repair_id FROM local_repair_loop_round WHERE loop_id=? ORDER BY round_no DESC LIMIT 1').get(id) as {repair_id:string}|undefined;
    if(!last)return;
    const item=this.repair.get(last.repair_id);
    if(item.status==='QUEUED'||item.status==='RUNNING')this.repair.cancel(last.repair_id);
    else if(item.status==='PENDING_APPROVAL')this.repair.reject(last.repair_id,'loop_cancel_'+id);
    if(item.verification_execution_id&&item.verification&&(item.verification.status==='PENDING'||item.verification.status==='RUNNING'))this.local.cancel(item.verification_execution_id);
  }
  async cancel(id:string){if(this.row(id).status==='ACTIVE')this.requestStop(id,'REPAIR_LOOP_CANCELLED');await this.jobs.get(id);return this.get(id);}
  interruptAll(){
    const rows=this.db.prepare("SELECT id FROM local_repair_loop WHERE status='ACTIVE'").all() as {id:string}[];
    for(const row of rows){this.finish(row.id,'INTERRUPTED','SERVER_STOPPED');this.cancelWork(row.id);}
  }
  async stopAll(){this.interruptAll();await Promise.all([...this.jobs.values()]);}
  private async run(id:string){
    const timeout=setTimeout(()=>this.requestStop(id,'REPAIR_LOOP_TIMEOUT'),Math.max(0,Date.parse(this.row(id).deadline_at)-Date.now()));
    try{
      for(let round=1;round<=3;round++){
        if(!this.active(id))return;
        const row=this.row(id);
        const requests=(this.db.prepare('SELECT COALESCE(SUM(s.model_requests),0) n FROM local_repair_loop_round r JOIN local_repair_session s ON s.id=r.repair_id WHERE r.loop_id=?').get(id) as {n:number}).n;
        if(requests>=row.max_model_requests){this.finish(id,'LIMIT_REACHED','REPAIR_LOOP_REQUEST_LIMIT');return;}
        const session=this.repair.create(row.current_execution_id,`loop_${id}_${round}`,row.provider_mode,row.model);
        this.db.prepare('INSERT INTO local_repair_loop_round VALUES (?,?,?,?)').run(id,round,session.id,now());
        await this.repair.waitFor(session.id);
        if(!this.active(id))return;
        const candidate=this.repair.get(session.id);
        if(candidate.status!=='PENDING_APPROVAL'){this.finish(id,'FAILED',candidate.error_code??'REPAIR_LOOP_NO_CANDIDATE');return;}
        const approved=this.repair.approve(session.id,`loop_approve_${id}_${round}`);
        if(!approved.verification_execution_id){this.finish(id,'FAILED',approved.error_code??'REPAIR_LOOP_APPLY_FAILED');return;}
        const result=localExecutionSchema.parse(await this.local.waitFor(approved.verification_execution_id));
        if(!this.active(id))return;
        this.db.prepare("UPDATE local_repair_loop SET current_execution_id=?,updated_at=? WHERE id=? AND status='ACTIVE'").run(result.id,now(),id);
        if(result.status==='SUCCEEDED'&&result.validation?.passed){this.finish(id,'SUCCEEDED');return;}
        if(result.status!=='FAILED'){this.finish(id,'FAILED',result.error_code??'REPAIR_LOOP_VERIFICATION_STOPPED');return;}
        if(round===3){this.finish(id,'LIMIT_REACHED','REPAIR_LOOP_ROUND_LIMIT');return;}
      }
    }catch(error){const row=this.row(id);if(row.status==='ACTIVE'&&!row.cancel_requested_at){this.cancelWork(id);this.finish(id,'FAILED',errorCode(error));}}
    finally{clearTimeout(timeout);const row=this.row(id);if(row.status==='ACTIVE'&&row.cancel_requested_at)this.finish(id,row.error_code==='REPAIR_LOOP_TIMEOUT'?'TIMED_OUT':'CANCELLED',row.error_code);}
  }
  recoverInterrupted(){this.db.prepare("UPDATE local_repair_loop SET status='INTERRUPTED',error_code='SERVER_RESTARTED',updated_at=?,finished_at=? WHERE status='ACTIVE'").run(now(),now());}
}
