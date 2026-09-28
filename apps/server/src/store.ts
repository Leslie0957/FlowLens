import { createHash,randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { Run, TaskLog } from '@flowlens/contracts';
import { runSchema,taskLogSchema } from '@flowlens/contracts';
import { transaction } from './db.js';
import { loadFixture,SCENARIOS } from './fixtures.js';

const initialSteps={read:'PENDING',validate:'PENDING',load:'PENDING',aggregate:'PENDING'};
type Row=Record<string,unknown>;
function parseRun(row:Row):Run {
  const started=row.started_at as string|null;const finished=row.finished_at as string|null;
  return runSchema.parse({
    id:row.id,task_id:row.task_id,task_name:row.task_name??'订单日报',data_source:row.data_source,
    scenario_id:row.scenario_id,scenario_instance_id:row.scenario_instance_id,parent_run_id:row.parent_run_id,
    status:row.status,step_states:JSON.parse(row.step_states_json as string),
    params:JSON.parse(row.params_json as string),created_at:row.created_at,started_at:started,finished_at:finished,
    duration_ms:started&&finished?Date.parse(finished)-Date.parse(started):null,
    error_code:row.error_code,error_message:row.error_message,summary:row.summary_json?JSON.parse(row.summary_json as string):null
  });
}
export function getRun(db:DatabaseSync,id:string):Run|undefined {
  const row=db.prepare('SELECT r.*, t.name task_name FROM task_run r JOIN task_definition t ON t.id=r.task_id WHERE r.id=?').get(id) as Row|undefined;
  return row?parseRun(row):undefined;
}
export function createRun(db:DatabaseSync,scenario:typeof SCENARIOS[number],key:string,now:number):Run {
  if(!SCENARIOS.includes(scenario))throw new Error('INVALID_SCENARIO');
  if(!key||key.length>128)throw new Error('INVALID_IDEMPOTENCY_KEY');
  const hash=createHash('sha256').update(JSON.stringify({scenario_id:scenario})).digest('hex');
  return transaction(db,()=>{
    const prior=db.prepare('SELECT request_hash,response_json FROM request_dedup WHERE scope=? AND idempotency_key=?').get('demo.runs',key) as {request_hash:string;response_json:string}|undefined;
    if(prior){if(prior.request_hash!==hash)throw new Error('IDEMPOTENCY_CONFLICT');return runSchema.parse(JSON.parse(prior.response_json));}
    const fixture=loadFixture(scenario),id=randomUUID(),instance=randomUUID(),iso=new Date(now).toISOString();
    db.prepare(`INSERT INTO task_run
      (id,task_id,data_source,scenario_id,scenario_instance_id,parent_run_id,status,step_states_json,params_json,created_at,started_at,finished_at,error_code,error_message,summary_json)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id,fixture.task_id,'FIXTURE',scenario,instance,null,'PENDING',JSON.stringify(initialSteps),JSON.stringify(fixture.params),iso,null,null,null,null,null);
    db.prepare('INSERT INTO simulation_state VALUES (?,?,?,?,?,?)').run(id,fixture.version,'initial',0,0,iso);
    const result=getRun(db,id)!;
    db.prepare('INSERT INTO request_dedup VALUES (?,?,?,?,?)').run('demo.runs',key,hash,JSON.stringify(result),iso);
    return result;
  });
}
export function advanceDue(db:DatabaseSync,now:number):void {
  const active=db.prepare(`SELECT r.id,r.status,r.scenario_id,r.step_states_json,r.started_at,s.fixture_version,s.timeline_variant,s.next_event_index,s.elapsed_ms,s.updated_at
    FROM task_run r JOIN simulation_state s ON s.run_id=r.id
    WHERE r.status IN ('PENDING','RUNNING') ORDER BY CASE r.status WHEN 'RUNNING' THEN 0 ELSE 1 END,r.created_at,r.rowid`).all() as Row[];
  let slots=2;
  for(const row of active){
    if(slots===0)break;
    slots--;
    const id=row.id as string,fixture=loadFixture(row.scenario_id as typeof SCENARIOS[number]);
    const timeline=row.timeline_variant==='retry'?(fixture.retry_timeline??[]):fixture.timeline;
    if(row.fixture_version!==fixture.version){transaction(db,()=>{db.prepare('UPDATE task_run SET status=?,error_code=?,error_message=?,finished_at=? WHERE id=?').run('FAILED','SIMULATION_INTERRUPTED','Fixture version changed',new Date(now).toISOString(),id);});continue;}
    const starting=row.status==='PENDING';
    const effectiveStart=starting?now:Date.parse(row.updated_at as string);
    const elapsed=(row.elapsed_ms as number)+Math.max(0,now-effectiveStart);
    const startTime=starting?new Date(now).toISOString():row.started_at as string;
    transaction(db,()=>{
      if(starting)db.prepare('UPDATE task_run SET status=?,started_at=? WHERE id=?').run('RUNNING',startTime,id);
      let index=row.next_event_index as number;let steps=JSON.parse(row.step_states_json as string) as Record<string,string>;
      while(index<timeline.length && timeline[index]!.offset_ms<=elapsed){
        const event=timeline[index]!;
        steps={...steps,[event.step]:event.step_status};
        if(event.run_status==='FAILED')for(const key of Object.keys(steps))if(steps[key]==='PENDING')steps[key]='SKIPPED';
        const eventTime=new Date(Date.parse(startTime)+event.offset_ms).toISOString();
        const nextSeq=(db.prepare('SELECT COALESCE(MAX(seq),0)+1 n FROM task_log WHERE run_id=?').get(id) as {n:number}).n;
        event.logs.forEach((log,offset)=>db.prepare('INSERT INTO task_log VALUES (?,?,?,?,?,?,?)').run(randomUUID(),id,nextSeq+offset,eventTime,log.level,event.step,log.message));
        db.prepare(`UPDATE task_run SET status=?,step_states_json=?,finished_at=?,error_code=?,error_message=?,summary_json=? WHERE id=?`).run(
          event.run_status??'RUNNING',JSON.stringify(steps),event.run_status==='FAILED'||event.run_status==='SUCCEEDED'?eventTime:null,
          event.error_code??null,event.error_message??null,event.summary?JSON.stringify(event.summary):null,id);
        index++;
      }
      db.prepare('UPDATE simulation_state SET next_event_index=?,elapsed_ms=?,updated_at=? WHERE run_id=?').run(index,elapsed,new Date(now).toISOString(),id);
      db.prepare(`UPDATE action_execution SET status=CASE WHEN ?='SUCCEEDED' THEN 'SUCCEEDED' WHEN ?='FAILED' THEN 'FAILED' ELSE 'RUNNING' END WHERE child_run_id=?`).run((db.prepare('SELECT status FROM task_run WHERE id=?').get(id) as {status:string}).status,(db.prepare('SELECT status FROM task_run WHERE id=?').get(id) as {status:string}).status,id);
    });
  }
}
export function listLogs(db:DatabaseSync,runId:string,options:{query?:string;level?:string;before_seq?:number;after_seq?:number;limit?:number}={}):TaskLog[] {
  const args:unknown[]=[runId];let sql='SELECT * FROM task_log WHERE run_id=?';
  if(options.query){sql+=' AND instr(lower(message),lower(?))>0';args.push(options.query);}
  if(options.level){sql+=' AND level=?';args.push(options.level);}
  if(options.before_seq!==undefined){sql+=' AND seq<?';args.push(options.before_seq);}
  if(options.after_seq!==undefined){sql+=' AND seq>?';args.push(options.after_seq);}
  sql+=' ORDER BY seq '+(options.after_seq!==undefined?'ASC':'DESC')+' LIMIT ?';args.push(options.limit??200);
  const rows=db.prepare(sql).all(...args as (string|number)[]) as Row[];
  return (options.after_seq!==undefined?rows:rows.reverse()).map(row=>taskLogSchema.parse(row));
}
export function listRuns(db:DatabaseSync,options:{status?:string;task_id?:string;q?:string;page:number;limit:number}):{data:Run[];total:number} {
  const where:string[]=[];const args:unknown[]=[];
  if(options.status){where.push('r.status=?');args.push(options.status);}
  if(options.task_id){where.push('r.task_id=?');args.push(options.task_id);}
  if(options.q){where.push('t.name LIKE ?');args.push('%'+options.q+'%');}
  const filter=where.length?' WHERE '+where.join(' AND '):'';
  const total=(db.prepare('SELECT count(*) n FROM task_run r JOIN task_definition t ON t.id=r.task_id'+filter).get(...args as (string|number)[]) as {n:number}).n;
  const rows=db.prepare('SELECT r.*,t.name task_name FROM task_run r JOIN task_definition t ON t.id=r.task_id'+filter+' ORDER BY r.created_at DESC,r.id DESC LIMIT ? OFFSET ?').all(...[...args,options.limit,(options.page-1)*options.limit] as (string|number)[]) as Row[];
  return {data:rows.map(parseRun),total};
}
