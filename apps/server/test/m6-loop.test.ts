import {expect,it,vi} from 'vitest';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import request from 'supertest';
import {openDatabase,migrate,seed} from '../src/db.js';
import {LocalExecutionService} from '../src/local-execution.js';
import {LocalRepairService} from '../src/local-repair.js';
import {LocalRepairLoopService} from '../src/local-repair-loop.js';
import {createApp} from '../src/http.js';
import type {ModelGateway} from '../src/model-gateway.js';

const wrong='SELECT COUNT(*) AS order_count, SUM(order_id) AS total_amount FROM orders;';
const valid='SELECT COUNT(*) AS order_count, SUM(amount) AS total_amount FROM orders;';
function model(candidates:string[]):ModelGateway{
  let round=0;
  return {async complete(messages){
    if(!messages.some(item=>item.role==='tool'))return {text:'',finishReason:'tool_calls',calls:[
      {id:'execution',name:'get_local_execution',arguments:{}},
      {id:'sql',name:'get_local_sql',arguments:{}},
      {id:'logs',name:'get_local_logs',arguments:{}}
    ]};
    const tools=messages.filter(item=>item.role==='tool').map(item=>JSON.parse(String(item.content)) as {output:Record<string,unknown>;evidence_ids:string[]});
    const next=candidates[round++]??wrong;
    return {text:JSON.stringify({diagnosis:'Use the recorded failure and current SQL',evidence_ids:tools.flatMap(item=>item.evidence_ids),file_path:'task.sql',base_hash:tools[1]!.output.revision_hash,new_content:next}),finishReason:'stop',calls:[],usage:{promptTokens:11,completionTokens:7}};
  }};
}
function fixture(candidates:string[]){
  const folder=mkdtempSync(join(tmpdir(),'flowlens-loop-'));
  const db=openDatabase(join(folder,'db.sqlite'));migrate(db);seed(db);
  const local=new LocalExecutionService(db,join(folder,'projects'));
  const repair=new LocalRepairService(db,local,{gateway:model(candidates)});
  const loop=new LocalRepairLoopService(db,local,repair);
  return {folder,db,local,repair,loop,close(){db.close();rmSync(folder,{recursive:true,force:true});}};
}

it('requires explicit loop authorization, feeds failed real verification into the next round, and stops only on 3/100',async()=>{
  const f=fixture([wrong,valid]);
  try{
    const project=f.local.createProject('sql-column-error','project');
    const original=await f.local.waitFor(f.local.startExecution(project.id,'original').id);
    const api=request(createApp(f.db,()=>{},f.local,f.repair,f.loop));
    expect((await api.get(`/api/v1/local-executions/${original.id}/loops`)).body.data).toEqual([]);
    const invalid=await api.post(`/api/v1/local-executions/${original.id}/loops`).set('Idempotency-Key','invalid').send({max_rounds:99});
    expect(invalid.status,JSON.stringify(invalid.body)).toBe(400);
    expect(f.local.getProject(project.id).current_revision_id).toBe(original.revision_id);
    const created=await api.post(`/api/v1/local-executions/${original.id}/loops`).set('Idempotency-Key','loop').send({authorize:true});
    expect(created.status).toBe(202);
    const id=created.body.data.id as string;
    expect((await api.post(`/api/v1/local-executions/${original.id}/loops`).set('Idempotency-Key','loop').send({authorize:true})).body.data.id).toBe(id);
    await f.loop.waitFor(id);
    const result=f.loop.get(id);
    expect(result.status,JSON.stringify({error_code:result.error_code,rounds:result.rounds.map(item=>({status:item.repair.status,error_code:item.repair.error_code,requests:item.repair.model_requests}))})).toBe('SUCCEEDED');
    expect(result.rounds).toHaveLength(2);
    expect(result.rounds[0]!.repair.verification).toMatchObject({status:'FAILED',exit_code:0,error_code:'RESULT_VALIDATION_FAILED'});
    expect(result.rounds[1]!.repair.evidence.some(item=>item.source_type==='LOG'&&item.excerpt.includes('RESULT_VALIDATION_FAILED'))).toBe(true);
    expect(result.rounds[1]!.repair.verification).toMatchObject({status:'SUCCEEDED',validation:{passed:true,order_count:3,total_amount:100}});
    expect(result.model_requests).toBe(4);
    expect(result.usage).toEqual({prompt_tokens:22,completion_tokens:14});
    expect((await api.post(`/api/v1/local-repairs/${result.rounds[0]!.repair.id}/approve`).set('Idempotency-Key','old-approval').send({})).body.error.code).toBe('LOOP_CANDIDATE_MANAGED');
    expect((await api.post(`/api/v1/runs/${id}/retry-proposals`).set('Idempotency-Key','old-fixture').send({turn_id:id,reason:'loop'})).status).toBeGreaterThanOrEqual(400);
    expect(f.local.getExecution(original.id).status).toBe('FAILED');
    expect(f.db.prepare('SELECT count(*) n FROM local_revision WHERE project_id=?').get(project.id)).toMatchObject({n:3});
    expect((await api.get(`/api/v1/local-repair-loops/${id}`)).body.data.status).toBe('SUCCEEDED');
    expect(f.db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  }finally{f.close();}
});

it('corrects one invalid evidence citation within the same round before applying and really verifying SQL',async()=>{
  const folder=mkdtempSync(join(tmpdir(),'flowlens-loop-citation-'));
  const db=openDatabase(join(folder,'db.sqlite'));migrate(db);seed(db);
  const local=new LocalExecutionService(db,join(folder,'projects'));
  let candidateCalls=0;
  const gateway:ModelGateway={async complete(messages){
    if(!messages.some(item=>item.role==='tool'))return {text:'',finishReason:'tool_calls',calls:[
      {id:'execution',name:'get_local_execution',arguments:{}},
      {id:'sql',name:'get_local_sql',arguments:{}},
      {id:'logs',name:'get_local_logs',arguments:{}}
    ],usage:{promptTokens:10,completionTokens:5}};
    const tools=messages.filter(item=>item.role==='tool').map(item=>JSON.parse(String(item.content)) as {output:Record<string,unknown>;evidence_ids:string[]});
    candidateCalls++;
    if(candidateCalls===2){
      expect(messages.at(-1)).toMatchObject({role:'user'});
      const feedback=JSON.parse(String(messages.at(-1)?.content)) as {error_code:string;required_sql_evidence_ids:string[];required_log_evidence_ids:string[]};
      expect(feedback.error_code).toBe('REPAIR_EVIDENCE_INVALID');
      expect(feedback.required_sql_evidence_ids).toContain(tools[1]!.evidence_ids[0]);
      expect(feedback.required_log_evidence_ids).toEqual(expect.arrayContaining(tools[2]!.evidence_ids));
      expect(local.getProject(project.id).current_revision_id).toBe(original.revision_id);
      expect(local.listExecutions(project.id,1,20).total).toBe(1);
    }
    return {text:JSON.stringify({diagnosis:'The failed SQL uses a nonexistent column',evidence_ids:candidateCalls===1?[tools[0]!.evidence_ids[0],tools[1]!.evidence_ids[0]]:[tools[1]!.evidence_ids[0],tools[2]!.evidence_ids.at(-1)],file_path:'task.sql',base_hash:tools[1]!.output.revision_hash,new_content:valid}),finishReason:'stop',calls:[],usage:{promptTokens:10,completionTokens:5}};
  }};
  const repair=new LocalRepairService(db,local,{gateway}),loop=new LocalRepairLoopService(db,local,repair);
  const project=local.createProject('sql-column-error','project');
  const original=await local.waitFor(local.startExecution(project.id,'original').id);
  try{
    const started=loop.create(original.id,'correct-citation','MOCK','test',true);
    await loop.waitFor(started.id);
    const result=loop.get(started.id);
    expect(result.status,JSON.stringify({error_code:result.error_code,rounds:result.rounds.map(item=>({status:item.repair.status,error_code:item.repair.error_code,requests:item.repair.model_requests}))})).toBe('SUCCEEDED');
    expect(result.rounds).toHaveLength(1);
    expect(result.model_requests).toBe(3);
    expect(result.usage).toEqual({prompt_tokens:30,completion_tokens:15});
    expect(result.rounds[0]!.repair.verification).toMatchObject({status:'SUCCEEDED',validation:{passed:true,order_count:3,total_amount:100}});
    expect(local.getExecution(original.id).status).toBe('FAILED');
    expect(db.prepare('SELECT count(*) n FROM local_revision WHERE project_id=?').get(project.id)).toMatchObject({n:2});
  }finally{db.close();rmSync(folder,{recursive:true,force:true});}
});

it('stops after three real failed validations and does not reset cumulative limits',async()=>{
  const f=fixture([wrong,'SELECT COUNT(*) AS order_count, SUM(order_total) AS total_amount FROM orders;',wrong]);
  try{
    const project=f.local.createProject('sql-column-error','project');
    const original=await f.local.waitFor(f.local.startExecution(project.id,'original').id);
    const started=f.loop.create(original.id,'three','MOCK','test',true);
    await f.loop.waitFor(started.id);
    const result=f.loop.get(started.id);
    expect(result.status).toBe('LIMIT_REACHED');
    expect(result.rounds).toHaveLength(3);
    expect(result.rounds.every(item=>item.repair.verification?.status==='FAILED')).toBe(true);
    expect(result.model_requests).toBe(6);
    expect(result.rounds[2]!.repair.verification?.status).toBe('FAILED');
    expect(f.db.prepare('SELECT count(*) n FROM local_revision WHERE project_id=?').get(project.id)).toMatchObject({n:4});
  }finally{f.close();}
});

it('cancels a running loop and marks an interrupted loop on restart without applying a candidate',async()=>{
  const f=fixture([]);
  try{
    const project=f.local.createProject('sql-column-error','project');
    const original=await f.local.waitFor(f.local.startExecution(project.id,'original').id);
    const hanging:ModelGateway={complete:async()=>new Promise(()=>{})};
    const repair=new LocalRepairService(f.db,f.local,{gateway:hanging});
    const loop=new LocalRepairLoopService(f.db,f.local,repair);
    const started=loop.create(original.id,'cancel','MOCK','test',true);
    await vi.waitFor(()=>expect(loop.get(started.id).rounds).toHaveLength(1));
    expect(()=>loop.create(original.id,'parallel','MOCK','test',true)).toThrow('REPAIR_LOOP_BUSY');
    expect(loop.create(original.id,'cancel','MOCK','test',true).id).toBe(started.id);
    const stopping=loop.cancel(started.id);
    expect(loop.get(started.id).status).toBe('STOPPING');
    expect((await stopping).status).toBe('CANCELLED');
    await loop.waitFor(started.id);
    expect(loop.get(started.id).status).toBe('CANCELLED');
    const api=request(createApp(f.db,()=>{},f.local,repair,loop));
    const viaHttp=loop.create(original.id,'cancel-http','MOCK','test',true);
    await vi.waitFor(()=>expect(loop.get(viaHttp.id).rounds).toHaveLength(1));
    const response=await api.post(`/api/v1/local-repair-loops/${viaHttp.id}/cancel`).send({});
    expect(response.status).toBe(200);
    expect(response.body.data.status).toBe('CANCELLED');
    expect(f.local.getProject(project.id).current_revision_id).toBe(original.revision_id);
    f.db.prepare("UPDATE local_repair_loop SET status='ACTIVE' WHERE id=?").run(started.id);
    loop.recoverInterrupted();
    expect(loop.get(started.id).status).toBe('INTERRUPTED');
    expect(f.db.prepare('SELECT count(*) n FROM local_revision WHERE project_id=?').get(project.id)).toMatchObject({n:1});
  }finally{f.close();}
});

it('enforces an entire-loop deadline and leaves the original revision intact',async()=>{
  const f=fixture([]);
  try{
    const project=f.local.createProject('sql-column-error','project');
    const original=await f.local.waitFor(f.local.startExecution(project.id,'original').id);
    const hanging:ModelGateway={complete:async()=>new Promise(()=>{})};
    const repair=new LocalRepairService(f.db,f.local,{gateway:hanging});
    const loop=new LocalRepairLoopService(f.db,f.local,repair,{durationMs:100});
    const started=loop.create(original.id,'deadline','MOCK','test',true);
    await loop.waitFor(started.id);
    expect(loop.get(started.id)).toMatchObject({status:'TIMED_OUT',error_code:'REPAIR_LOOP_TIMEOUT'});
    expect(f.local.getProject(project.id).current_revision_id).toBe(original.revision_id);
    expect(f.db.prepare('SELECT count(*) n FROM local_revision WHERE project_id=?').get(project.id)).toMatchObject({n:1});
  }finally{f.close();}
});
