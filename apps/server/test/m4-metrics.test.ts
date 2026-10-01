import {expect,it,vi} from 'vitest';
import {deepSeekGateway} from '../src/model-gateway.js';
import {openDatabase,migrate,seed} from '../src/db.js';
import {createSession,submitMessage,snapshot} from '../src/diagnosis-store.js';
import {runDiagnosis} from '../src/diagnosis-agent.js';

it('reports the first provider delta once, including a tool delta before text',async()=>{
 const encoder=new TextEncoder();
 const packets=[
  {choices:[{delta:{role:'assistant'}}]},
  {choices:[{delta:{tool_calls:[{index:0,id:'call_1',function:{name:'get_task_logs',arguments:'{"run_id":'}}]}}]},
  {choices:[{delta:{tool_calls:[{index:0,function:{arguments:'"seed_s04"}'}}]},finish_reason:'tool_calls'}]},
 ];
 const body=new ReadableStream<Uint8Array>({start(controller){for(const packet of packets)controller.enqueue(encoder.encode('data: '+JSON.stringify(packet)+'\n\n'));controller.enqueue(encoder.encode('data: [DONE]\n\n'));controller.close();}});
 vi.stubGlobal('fetch',vi.fn().mockResolvedValue(new Response(body)));
 const first=vi.fn();
 try{
  const result=await deepSeekGateway({apiKey:'test-only',model:'test',baseUrl:'https://api.deepseek.com',maxOutputTokens:2048}).complete([],new AbortController().signal,undefined,first);
  expect(result.calls[0]?.arguments).toEqual({run_id:'seed_s04'});
  expect(first).toHaveBeenCalledTimes(1);
  const payload=JSON.parse(String(vi.mocked(fetch).mock.calls[0]?.[1]?.body)) as {response_format:unknown};
  expect(payload.response_format).toEqual({type:'json_object'});
 }finally{vi.unstubAllGlobals();}
});

it.each([false,true])('UNKNOWN is never persisted as a supported root cause (always invalid: %s)',async alwaysInvalid=>{
 const db=openDatabase(':memory:');migrate(db);seed(db);
 try{
  const session=createSession(db,'seed_s05','unknown-state-session'),sent=submitMessage(db,session.id,'根因确定了吗','unknown-state-turn','MOCK','mock');
  let calls=0;
  await runDiagnosis(db,{turnId:sent.turn_id,sessionId:session.id,runId:'seed_s05',question:'根因确定了吗',mode:'MOCK',model:'mock',logSink:()=>{},gateway:{async complete(messages){
   calls++;const context=JSON.parse(String(messages.find(m=>m.role==='user')?.content)) as {current_run_evidence_ids:string[]};
   return {text:JSON.stringify({summary:'根因尚不明确',findings:[{cause:'UNKNOWN',explanation:'缺少详细错误',evidence_ids:context.current_run_evidence_ids,evidence_status:alwaysInvalid||calls===1?'SUPPORTED':'NEEDS_CONFIRMATION'}],missing_information:['详细错误'],next_steps:[],proposed_action:null}),calls:[],finishReason:'stop'};
  }}});
  const state=snapshot(db,session.id);expect(calls).toBe(2);
  if(alwaysInvalid){expect(state.turns[0]).toMatchObject({status:'FAILED',error_code:'INVALID_RESULT'});expect(state.results).toHaveLength(0);}
  else {expect(state.turns[0]).toMatchObject({status:'COMPLETED'});expect(JSON.parse(state.results[0]!.findings_json as string)[0].evidence_status).toBe('NEEDS_CONFIRMATION');}
 }finally{db.close();}
});

it.each(['seed_s00','seed_s05'])('MOCK cites the actual terminal state for %s rather than a startup log',async runId=>{
 const db=openDatabase(':memory:');migrate(db);seed(db);
 try{
  const session=createSession(db,runId,'terminal-state-session'),sent=submitMessage(db,session.id,'检查本次运行','terminal-state-turn','MOCK','mock');
  await runDiagnosis(db,{turnId:sent.turn_id,sessionId:session.id,runId,question:'检查本次运行',mode:'MOCK',model:'mock',logSink:()=>{}});
  const result=snapshot(db,session.id).results[0]!;
  const findings=JSON.parse(result.findings_json as string) as {evidence_ids:string[]}[];
  const citations=findings.flatMap(f=>f.evidence_ids).map(id=>db.prepare('SELECT type,source_id,excerpt FROM evidence WHERE id=?').get(id));
  expect(citations).toContainEqual(expect.objectContaining({type:'RUN_STATE',source_id:runId,excerpt:expect.stringContaining(runId==='seed_s00'?'SUCCEEDED':'UNKNOWN_FAILURE')}));
 }finally{db.close();}
});

it('a known failure requires log evidence and can repair by dynamically querying logs',async()=>{
 const db=openDatabase(':memory:');migrate(db);seed(db);
 try{
  const session=createSession(db,'seed_s04','known-log-session'),sent=submitMessage(db,session.id,'为什么失败','known-log-turn','MOCK','mock');
  let calls=0;
  await runDiagnosis(db,{turnId:sent.turn_id,sessionId:session.id,runId:'seed_s04',question:'为什么失败',mode:'MOCK',model:'mock',logSink:()=>{},gateway:{async complete(messages){
   calls++;if(calls===2)return {text:'',calls:[{id:'read-logs',name:'get_task_logs',arguments:{run_id:'seed_s04',level:'ERROR'}}],finishReason:'tool_calls'};
   const context=JSON.parse(String(messages.find(m=>m.role==='user')?.content)) as {current_run_evidence_ids:string[]};
   const evidenceIds=calls===1?context.current_run_evidence_ids:JSON.parse(String(messages.at(-1)?.content)).evidence_ids;
   return {text:JSON.stringify({summary:'读取超时',findings:[{cause:'UPSTREAM_TIMEOUT',explanation:'超时记录',evidence_ids:evidenceIds,evidence_status:'SUPPORTED'}],missing_information:[],next_steps:[],proposed_action:null}),calls:[],finishReason:'stop'};
  }}});
  const state=snapshot(db,session.id);expect(calls).toBe(3);expect(state.turns[0]).toMatchObject({status:'COMPLETED'});
  expect(state.tool_calls).toContainEqual(expect.objectContaining({name:'get_task_logs',status:'SUCCEEDED'}));
  const findings=JSON.parse(state.results[0]!.findings_json as string) as {evidence_ids:string[]}[];
  expect(db.prepare('SELECT type,excerpt FROM evidence WHERE id=?').get(findings[0]!.evidence_ids[0])).toMatchObject({type:'LOG',excerpt:expect.stringContaining('ReadTimeout')});
 }finally{db.close();}
});

it('tool query output is saved and replayed without losing the evidence identifiers',async()=>{
 const db=openDatabase(':memory:');migrate(db);seed(db);
 try{
  const session=createSession(db,'seed_s04','trace-output-session'),sent=submitMessage(db,session.id,'分析失败','trace-output-turn','MOCK','mock');
  await runDiagnosis(db,{turnId:sent.turn_id,sessionId:session.id,runId:'seed_s04',question:'分析失败',mode:'MOCK',model:'mock',logSink:()=>{}});
  const row=snapshot(db,session.id).tool_calls.find(t=>t.name==='get_task_logs')!;
  const result=JSON.parse(row.result_summary_json as string) as {output:{logs:{message:string}[]};evidence_ids:string[]};
  expect(result.output.logs).toContainEqual(expect.objectContaining({message:'ReadTimeout: upstream request exceeded 5s'}));expect(result.evidence_ids).toHaveLength(2);
  const event=db.prepare("SELECT payload_json FROM agent_event WHERE turn_id=? AND type='tool.completed' ORDER BY seq LIMIT 1").get(sent.turn_id) as {payload_json:string};
  expect(JSON.parse(event.payload_json)).toMatchObject({output:result.output,evidence_ids:result.evidence_ids});
 }finally{db.close();}
});
