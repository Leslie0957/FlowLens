import { expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase,migrate,seed } from '../src/db.js';
import { createRun,advanceDue,getRun,listLogs } from '../src/store.js';
function isolated(run:(path:string)=>void){const dir=mkdtempSync(join(tmpdir(),'flowlens-m1-'));try{run(join(dir,'test.sqlite'));}finally{rmSync(dir,{recursive:true,force:true,maxRetries:10,retryDelay:100});}}
it('migrates and seeds S00/S04/S05 twice without replacing a created run',()=>isolated(path=>{
 const db=openDatabase(path);migrate(db);seed(db);seed(db);
 expect(db.prepare('SELECT count(*) n FROM task_run').get()).toMatchObject({n:3});
 const run=createRun(db,'S04','idem-a',Date.parse('2026-09-26T00:00:00Z'));
 expect(run.status).toBe('PENDING');seed(db);
 expect(db.prepare('SELECT count(*) n FROM task_run').get()).toMatchObject({n:4});db.close();
 const reopened=openDatabase(path);migrate(reopened);expect(getRun(reopened,run.id)?.status).toBe('PENDING');reopened.close();
}));
it('advances S04 through persisted read timeout and skips later stages',()=>isolated(path=>{
 const db=openDatabase(path);migrate(db);seed(db);const t=Date.parse('2026-09-26T00:00:00Z');
 const run=createRun(db,'S04','idem-b',t);advanceDue(db,t);advanceDue(db,t+6000);
 expect(getRun(db,run.id)).toMatchObject({status:'FAILED',error_code:'UPSTREAM_TIMEOUT',step_states:{read:'FAILED',validate:'SKIPPED',load:'SKIPPED',aggregate:'SKIPPED'}});
 expect(listLogs(db,run.id).map(l=>l.seq)).toEqual([1,2]);db.close();
}));
it('same idempotency key returns one run; changed scenario conflicts',()=>isolated(path=>{
 const db=openDatabase(path);migrate(db);seed(db);const t=Date.now();
 const a=createRun(db,'S00','idem-c',t);const b=createRun(db,'S00','idem-c',t+1000);
 expect(b.id).toBe(a.id);expect(()=>createRun(db,'S04','idem-c',t+2000)).toThrow('IDEMPOTENCY_CONFLICT');db.close();
}));

import request from 'supertest';
import { createApp } from '../src/http.js';
it('serves versioned runs from SQLite and returns safe correlated errors',async()=>{
 const db=openDatabase(':memory:');migrate(db);seed(db);const lines:string[]=[];
 const app=createApp(db,line=>lines.push(line));
 const list=await request(app).get('/api/v1/runs?status=FAILED&page=1&limit=20');
 expect(list.status).toBe(200);expect(list.body.data.map((run:{scenario_id:string})=>run.scenario_id).sort()).toEqual(['S04','S05']);
 const missing=await request(app).get('/api/v1/runs/no_such_run');
 expect(missing.status).toBe(404);expect(missing.body.error.request_id).toBeTruthy();
 expect(lines.some(line=>JSON.parse(line).request_id===missing.body.error.request_id)).toBe(true);
 expect(lines.map(line=>JSON.parse(line)).find(line=>line.event==='request.failed')?.outcome).toBe('failure');
 expect(JSON.stringify(lines)).not.toContain('MODEL_API_KEY');db.close();
});
it('API creates one demo run for a repeated key and rejects changed payload',async()=>{
 const db=openDatabase(':memory:');migrate(db);seed(db);const app=createApp(db,()=>{});
 const first=await request(app).post('/api/v1/demo/runs').set('Idempotency-Key','same-key').send({scenario_id:'S04'});
 const repeat=await request(app).post('/api/v1/demo/runs').set('Idempotency-Key','same-key').send({scenario_id:'S04'});
 const conflict=await request(app).post('/api/v1/demo/runs').set('Idempotency-Key','same-key').send({scenario_id:'S05'});
 expect(first.status).toBe(202);expect(repeat.body.data.id).toBe(first.body.data.id);expect(conflict.status).toBe(409);
 expect(db.prepare('SELECT count(*) n FROM task_run').get()).toMatchObject({n:4});db.close();
});

it('queues a third simulation until one of two active runs finishes',()=>{
 const db=openDatabase(':memory:');migrate(db);seed(db);const t=Date.parse('2026-09-26T00:00:00Z');
 const ids=['a','b','c'].map(key=>createRun(db,'S04','queue-'+key,t).id);
 advanceDue(db,t);
 expect(ids.map(id=>getRun(db,id)?.status)).toEqual(['RUNNING','RUNNING','PENDING']);
 advanceDue(db,t+6000);advanceDue(db,t+6001);
 expect(ids.map(id=>getRun(db,id)?.status)).toEqual(['FAILED','FAILED','RUNNING']);
 db.close();
});
it('upgrades a version-one database without replacing existing run rows',()=>isolated(path=>{
 const db=openDatabase(path);
 db.exec("CREATE TABLE task_definition(id TEXT PRIMARY KEY,name TEXT NOT NULL,description TEXT NOT NULL,schema_version INTEGER NOT NULL,steps_json TEXT NOT NULL,created_at TEXT NOT NULL);CREATE TABLE task_run(id TEXT PRIMARY KEY,task_id TEXT NOT NULL,data_source TEXT NOT NULL,scenario_id TEXT NOT NULL,scenario_instance_id TEXT NOT NULL,parent_run_id TEXT,status TEXT NOT NULL,step_states_json TEXT NOT NULL,params_json TEXT NOT NULL,created_at TEXT NOT NULL,started_at TEXT,finished_at TEXT,error_code TEXT,error_message TEXT,summary_json TEXT);CREATE TABLE task_log(id TEXT PRIMARY KEY,run_id TEXT NOT NULL,seq INTEGER NOT NULL,timestamp TEXT NOT NULL,level TEXT NOT NULL,step TEXT NOT NULL,message TEXT NOT NULL);PRAGMA user_version=1;");
 db.prepare('INSERT INTO task_definition VALUES (?,?,?,?,?,?)').run('order_daily','旧任务','保留',1,'[]','2026-01-01T00:00:00Z');
 db.prepare('INSERT INTO task_run VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run('old-run','order_daily','FIXTURE','S00','old-instance',null,'SUCCEEDED',JSON.stringify({read:'SUCCEEDED',validate:'SUCCEEDED',load:'SUCCEEDED',aggregate:'SUCCEEDED'}),'{}','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z','2026-01-01T00:00:01Z',null,null,'{}');
 migrate(db);expect(getRun(db,'old-run')?.status).toBe('SUCCEEDED');
 expect(db.prepare('PRAGMA user_version').get()).toMatchObject({user_version:4});db.close();
}));
it('rejects invalid list/log query boundaries without returning internal details',async()=>{
 const db=openDatabase(':memory:');migrate(db);seed(db);const app=createApp(db,()=>{});
 const bad=await request(app).get('/api/v1/runs?limit=101');
 expect(bad.status).toBe(400);expect(bad.body.error.code).toBe('INVALID_ARGUMENTS');
 const both=await request(app).get('/api/v1/runs/seed_s04/logs?before_seq=2&after_seq=1');
 expect(both.status).toBe(400);expect(both.body.error.request_id).toBeTruthy();
 const logs=await request(app).get('/api/v1/runs/seed_s04/logs?level=ERROR');
 expect(logs.status).toBe(200);expect(logs.body.data).toHaveLength(1);expect(logs.body.data[0].message).toContain('ReadTimeout');
 db.close();
});

it('S00 succeeds with fixture summary while S05 fails without invented root cause',()=>{
 const db=openDatabase(':memory:');migrate(db);seed(db);const t=Date.parse('2026-09-26T00:00:00Z');
 const normal=createRun(db,'S00','normal',t),unknown=createRun(db,'S05','unknown',t);
 advanceDue(db,t);advanceDue(db,t+6000);
 expect(getRun(db,normal.id)).toMatchObject({status:'SUCCEEDED',summary:{rows:1000,data_source:'FIXTURE'}});
 expect(getRun(db,unknown.id)).toMatchObject({status:'FAILED',error_code:'UNKNOWN_FAILURE'});
 expect(listLogs(db,unknown.id).map(log=>log.message).join(' ')).not.toContain('root cause');db.close();
});
it('resumes a running simulation from the saved event index after reopen',()=>isolated(path=>{
 const t=Date.parse('2026-09-26T00:00:00Z');let db=openDatabase(path);migrate(db);seed(db);
 const run=createRun(db,'S04','resume',t);advanceDue(db,t);
 expect(listLogs(db,run.id)).toHaveLength(1);db.close();
 db=openDatabase(path);migrate(db);advanceDue(db,t+6000);
 expect(getRun(db,run.id)?.status).toBe('FAILED');expect(listLogs(db,run.id).map(log=>log.seq)).toEqual([1,2]);db.close();
}));
it('concurrent duplicate HTTP creates are serialized by SQLite idempotency',async()=>{
 const db=openDatabase(':memory:');migrate(db);seed(db);const app=createApp(db,()=>{});
 const [a,b]=await Promise.all([request(app).post('/api/v1/demo/runs').set('Idempotency-Key','concurrent-key').send({scenario_id:'S04'}),request(app).post('/api/v1/demo/runs').set('Idempotency-Key','concurrent-key').send({scenario_id:'S04'})]);
 expect(a.status).toBe(202);expect(b.status).toBe(202);expect(a.body.data.id).toBe(b.body.data.id);
 expect(db.prepare('SELECT count(*) n FROM task_run').get()).toMatchObject({n:4});db.close();
});

import {loadFixture} from '../src/fixtures.js';
it('resolves checked-in fixture independently of process working directory',()=>{
 const previous=process.cwd(),folder=mkdtempSync(join(tmpdir(),'flowlens-cwd-'));
 try{process.chdir(folder);expect(loadFixture('S00').scenario_id).toBe('S00');}
 finally{process.chdir(previous);rmSync(folder,{recursive:true,force:true});}
});

it('rejects a fixture with nonincreasing event offsets',()=>{
 const folder=mkdtempSync(join(tmpdir(),'flowlens-fixture-'));
 try{
  const original=loadFixture('S00');const invalid={...original,timeline:original.timeline.map((event,index)=>index===1?{...event,offset_ms:0}:event)};
  requireWriteFixture(folder,invalid);
  expect(()=>loadFixture('S00',folder)).toThrow('FIXTURE_TIME_ORDER');
 }finally{rmSync(folder,{recursive:true,force:true});}
});
function requireWriteFixture(folder:string,value:unknown){writeFileSync(join(folder,'S00.json'),JSON.stringify(value));}
it('supports before_seq and after_seq log windows without duplicate rows',async()=>{
 const db=openDatabase(':memory:');migrate(db);seed(db);const app=createApp(db,()=>{});
 const before=await request(app).get('/api/v1/runs/seed_s04/logs?before_seq=2');
 const after=await request(app).get('/api/v1/runs/seed_s04/logs?after_seq=1');
 expect(before.body.data.map((item:{seq:number})=>item.seq)).toEqual([1]);
 expect(after.body.data.map((item:{seq:number})=>item.seq)).toEqual([2]);db.close();
});
