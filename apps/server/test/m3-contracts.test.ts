import {expect,it} from 'vitest';
import {z} from 'zod';
import {openDatabase,migrate,seed} from '../src/db.js';
import {createSession,submitMessage,snapshot} from '../src/diagnosis-store.js';
import {createTools,type TaskBackend,type RunbookRetriever} from '../src/diagnosis-tools.js';
import {ToolRegistry} from '../src/tool-registry.js';
import {runDiagnosis} from '../src/diagnosis-agent.js';
import {getRun,listLogs} from '../src/store.js';

it('substitute backend and retriever preserve tool result/evidence contract and run scope',async()=>{
 const db=openDatabase(':memory:');migrate(db);seed(db);const s=createSession(db,'seed_s04','m3-contract-session'),t=submitMessage(db,s.id,'诊断','m3-contract-turn','MOCK','mock');
 const backend:TaskBackend={getRun:id=>getRun(db,id),getDefinition:id=>({id,steps:['read']}),getLogs:(id,q)=>listLogs(db,id,q)};
 const retriever:RunbookRetriever={search:()=>[{id:'test-doc',version:'v2',title:'测试文档',category:'timeout',text:'只读诊断依据',updated_at:'2026-09-27'}]};
 const tools=createTools(db,{backend,retriever}),context={runId:'seed_s04',sessionId:s.id,turnId:t.turn_id};
 expect(tools.describe().map(x=>x.name)).toContain('search_runbook');
 const found=await tools.call('search_runbook',{query:'超时'},context);
 expect(found.output.chunks).toMatchObject([{document_id:'test-doc',version:'v2'}]);
 expect(db.prepare('SELECT source_id,source_version FROM evidence WHERE id=?').get(found.evidence_ids[0])).toMatchObject({source_id:'test-doc',source_version:'v2'});
 await expect(tools.call('get_task_logs',{run_id:'seed_s05'},context)).rejects.toMatchObject({code:'TOOL_SCOPE'});db.close();
});
it('new trusted read-only tool runs through the unchanged agent loop and generic event contract',async()=>{
 const db=openDatabase(':memory:');migrate(db);seed(db);const s=createSession(db,'seed_s05','m3-custom-session'),t=submitMessage(db,s.id,'诊断','m3-custom-turn','MOCK','mock');
 const registry=new ToolRegistry().register({description:{name:'get_task_run',description:'Bound run',parameters:{type:'object'}},schema:z.strictObject({run_id:z.string()}),execute:async()=>({output:{id:'seed_s05'},evidence_ids:[]})})
  .register({description:{name:'read_test_signal',description:'Read test signal',parameters:{type:'object'}},schema:z.strictObject({}),execute:async()=>({output:{signal:'available'},evidence_ids:[]})});
 let calls=0;await runDiagnosis(db,{turnId:t.turn_id,sessionId:s.id,runId:'seed_s05',question:'诊断',mode:'MOCK',model:'mock',tools:registry,gateway:{async complete(){return calls++===0?{text:'',calls:[{id:'custom',name:'read_test_signal',arguments:{}}],finishReason:'tool_calls'}:{text:JSON.stringify({summary:'信息不足',findings:[],missing_information:[],next_steps:[],proposed_action:null}),calls:[],finishReason:'stop'};}},logSink:()=>{}});
 const state=snapshot(db,s.id);expect(state.turns[0]).toMatchObject({status:'COMPLETED'});expect(state.tool_calls[0]).toMatchObject({name:'read_test_signal',status:'SUCCEEDED'});
 expect(db.prepare("SELECT count(*) n FROM agent_event WHERE turn_id=? AND type='tool.completed'").get(t.turn_id)).toMatchObject({n:1});db.close();
});

it('empty backend logs produce an empty tool result without invented evidence',async()=>{
 const db=openDatabase(':memory:');migrate(db);seed(db);const s=createSession(db,'seed_s05','m3-empty-session'),t=submitMessage(db,s.id,'诊断','m3-empty-turn','MOCK','mock');
 const backend:TaskBackend={getRun:id=>getRun(db,id),getDefinition:id=>({id}),getLogs:()=>[]};
 const tools=createTools(db,{backend}),value=await tools.call('get_task_logs',{run_id:'seed_s05'}, {runId:'seed_s05',sessionId:s.id,turnId:t.turn_id});
 expect(value.output).toEqual({logs:[],next_cursor:null});expect(value.evidence_ids).toEqual([]);
 expect(db.prepare('SELECT count(*) n FROM evidence WHERE turn_id=?').get(t.turn_id)).toMatchObject({n:0});db.close();
});
