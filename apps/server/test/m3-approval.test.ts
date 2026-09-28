import {expect,it} from 'vitest';
import request from 'supertest';
import {openDatabase,migrate,seed} from '../src/db.js';
import {createApp} from '../src/http.js';
import {createSession,submitMessage,proposeRetry} from '../src/diagnosis-store.js';
import {runDiagnosis} from '../src/diagnosis-agent.js';

it('competing approvals and retries create one execution and preserve an immutable source run',async()=>{
 const db=openDatabase(':memory:');migrate(db);seed(db);const s=createSession(db,'seed_s04','m3-approval-session'),t=submitMessage(db,s.id,'诊断','m3-approval-turn','MOCK','mock');
 await runDiagnosis(db,{turnId:t.turn_id,sessionId:s.id,runId:'seed_s04',question:'诊断',mode:'MOCK',model:'mock',logSink:()=>{}});
 const p=proposeRetry(db,'seed_s04',t.turn_id,'上游超时','m3-approval-proposal'),app=createApp(db,()=>{});
 const original=db.prepare('SELECT * FROM task_run WHERE id=?').get('seed_s04');
 const replies=await Promise.all(Array.from({length:8},(_,n)=>request(app).post(`/api/v1/approvals/${p.id}/approve`).set('Idempotency-Key','m3-approve-'+n).send({})));
 expect(replies.every(x=>x.status===200)).toBe(true);
 expect(new Set(replies.map(x=>x.body.data.child_run_id)).size).toBe(1);
 expect(db.prepare('SELECT count(*) n FROM action_execution WHERE approval_id=?').get(p.id)).toMatchObject({n:1});
 expect(db.prepare('SELECT count(*) n FROM task_run WHERE parent_run_id=?').get('seed_s04')).toMatchObject({n:1});
 expect(db.prepare('SELECT * FROM task_run WHERE id=?').get('seed_s04')).toEqual(original);
 const reject=await request(app).post(`/api/v1/approvals/${p.id}/reject`).set('Idempotency-Key','m3-reject-late').send({});
 expect(reject.status).toBe(409);db.close();
});
it('approve and reject racing on one pending request cannot both succeed',async()=>{
 const db=openDatabase(':memory:');migrate(db);seed(db);const s=createSession(db,'seed_s04','m3-race-session'),t=submitMessage(db,s.id,'诊断','m3-race-turn','MOCK','mock');
 await runDiagnosis(db,{turnId:t.turn_id,sessionId:s.id,runId:'seed_s04',question:'诊断',mode:'MOCK',model:'mock',logSink:()=>{}});
 const p=proposeRetry(db,'seed_s04',t.turn_id,'竞争测试','m3-race-proposal'),app=createApp(db,()=>{});
 const [approve,reject]=await Promise.all([
  request(app).post(`/api/v1/approvals/${p.id}/approve`).set('Idempotency-Key','m3-race-approve').send({}),
  request(app).post(`/api/v1/approvals/${p.id}/reject`).set('Idempotency-Key','m3-race-reject').send({})
 ]);
 expect([approve.status,reject.status].sort()).toEqual([200,409]);
 const status=(db.prepare('SELECT status FROM approval_request WHERE id=?').get(p.id) as {status:string}).status;
 expect(['APPROVED','REJECTED']).toContain(status);
 expect(db.prepare('SELECT count(*) n FROM action_execution WHERE approval_id=?').get(p.id)).toMatchObject({n:status==='APPROVED'?1:0});db.close();
});

it('S05 information-poor failure cannot request a retry even after a completed diagnosis',async()=>{
 const db=openDatabase(':memory:');migrate(db);seed(db);const s=createSession(db,'seed_s05','m3-s05-session'),t=submitMessage(db,s.id,'诊断','m3-s05-turn','MOCK','mock');
 await runDiagnosis(db,{turnId:t.turn_id,sessionId:s.id,runId:'seed_s05',question:'诊断',mode:'MOCK',model:'mock',logSink:()=>{}});
 const app=createApp(db,()=>{});
 const response=await request(app).post('/api/v1/runs/seed_s05/retry-proposals').set('Idempotency-Key','m3-s05-proposal').send({turn_id:t.turn_id,reason:'要求重试'});
 expect(response.status).toBe(409);expect(response.body.error.code).toBe('RETRY_NOT_ALLOWED');
 expect(db.prepare("SELECT count(*) n FROM approval_request WHERE run_id='seed_s05'").get()).toMatchObject({n:0});db.close();
});
