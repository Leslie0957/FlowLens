import {expect,it} from 'vitest';
import request from 'supertest';
import {openDatabase,migrate,seed} from '../src/db.js';
import {createApp} from '../src/http.js';
import {advanceDue,getRun,listLogs} from '../src/store.js';
import {createSession,submitMessage,retryEligibility,proposeRetry} from '../src/diagnosis-store.js';
import {runDiagnosis} from '../src/diagnosis-agent.js';

const examples=[
 {id:'S01',cause:'SCHEMA_MISMATCH',step:'validate',message:'required=[order_id,amount], observed=[order_id]',steps:{read:'SUCCEEDED',validate:'FAILED',load:'SKIPPED',aggregate:'SKIPPED'}},
 {id:'S02',cause:'SQL_COLUMN_ERROR',step:'aggregate',message:'no such column: order_total',steps:{read:'SUCCEEDED',validate:'SUCCEEDED',load:'SUCCEEDED',aggregate:'FAILED'}},
 {id:'S03',cause:'DUPLICATE_DATA',step:'load',message:'UNIQUE constraint failed: orders.order_id',steps:{read:'SUCCEEDED',validate:'SUCCEEDED',load:'FAILED',aggregate:'SKIPPED'}},
];
it.each(examples)('$id creates, persists, diagnoses from the failure log and refuses retry',async item=>{
 const db=openDatabase(':memory:');migrate(db);seed(db);const app=createApp(db,()=>{});
 try{
  const catalog=await request(app).get('/api/v1/demo/scenarios');
  expect(catalog.body.data.some((s:{id:string})=>s.id===item.id)).toBe(true);
  const response=await request(app).post('/api/v1/demo/runs').set('Idempotency-Key','m5-'+item.id).send({scenario_id:item.id});
  expect(response.status).toBe(202);const id=response.body.data.id as string;
  const now=Date.now();advanceDue(db,now);advanceDue(db,now+10000);
  expect(getRun(db,id)).toMatchObject({status:'FAILED',error_code:item.cause,step_states:item.steps});
  const logs=listLogs(db,id),failure=logs.find(l=>l.level==='ERROR');
  expect(failure).toMatchObject({step:item.step});expect(failure?.message).toContain(item.message);
  const old=JSON.stringify(getRun(db,'seed_s04'));seed(db);seed(db);
  expect(JSON.stringify(getRun(db,'seed_s04'))).toBe(old);expect(getRun(db,id)?.status).toBe('FAILED');
  const session=createSession(db,id,'m5-session-'+item.id);
  for(const [index,question] of ['分析失败原因并给出证据','帮我修复并重试'].entries()){
   const sent=submitMessage(db,session.id,question,'m5-turn-'+index,'MOCK','mock');
   await runDiagnosis(db,{turnId:sent.turn_id,sessionId:session.id,runId:id,question,mode:'MOCK',model:'mock',logSink:()=>{}});
   const row=db.prepare('SELECT * FROM diagnosis_result WHERE turn_id=?').get(sent.turn_id) as Record<string,string>|undefined;
   expect(row).toBeTruthy();const findings=JSON.parse(row!.findings_json!);
   expect(findings[0]).toMatchObject({cause:item.cause,evidence_status:'SUPPORTED'});
   const sources=(findings[0].evidence_ids as string[]).map(e=>db.prepare('SELECT * FROM evidence WHERE id=? AND session_id=?').get(e,session.id));
   expect(sources.some(e=>e?.type==='LOG'&&e.source_id===failure?.id)).toBe(true);
   expect(JSON.parse(row!.proposed_action_json!)).toBeNull();
   expect(retryEligibility(db,id).allowed).toBe(false);
   expect(()=>proposeRetry(db,id,sent.turn_id,'retry','blocked-'+index)).toThrow();
  }
  expect(db.prepare('SELECT count(*) n FROM approval_request WHERE run_id=?').get(id)).toMatchObject({n:0});
  expect(db.prepare('SELECT count(*) n FROM task_run WHERE parent_run_id=?').get(id)).toMatchObject({n:0});
 }finally{db.close();}
});
