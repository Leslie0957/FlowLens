import {expect,it,vi} from 'vitest';
import {openDatabase,migrate,seed} from '../src/db.js';
import {createSession,submitMessage,snapshot,proposeRetry,resolveApproval} from '../src/diagnosis-store.js';
import {runDiagnosis} from '../src/diagnosis-agent.js';

function setup(runId:string,key:string){
 const db=openDatabase(':memory:');migrate(db);seed(db);
 const session=createSession(db,runId,key);
 return {db,session};
}
const answer=(summary:string,proposed_action:unknown=null)=>JSON.stringify({
 summary,findings:[],missing_information:[],next_steps:[],proposed_action
});

it('tells the model which diagnostic operations exist and whether this run may be retried',async()=>{
 const {db,session}=setup('seed_s05','m3-guidance-s05');
 const sent=submitMessage(db,session.id,'调取完整堆栈并开启更高日志级别','m3-guidance-question','MOCK','mock');
 let captured:Record<string,unknown>[]=[];
 await runDiagnosis(db,{turnId:sent.turn_id,sessionId:session.id,runId:'seed_s05',question:'调取完整堆栈并开启更高日志级别',mode:'MOCK',model:'mock',
  gateway:{async complete(messages){captured=messages;return {text:answer('当前演示数据没有完整堆栈，我不能提高日志级别。'),calls:[],finishReason:'stop'};}},logSink:()=>{}});
 const context=JSON.parse(String(captured.at(-1)?.content));
 expect(context.available_operations).toMatchObject({can_change_log_level:false,can_modify_task:false,can_fetch_unrecorded_stack:false});
 expect(context.retry_eligibility).toMatchObject({allowed:false,reason_code:'NOT_TRANSIENT_TIMEOUT'});
 expect(JSON.stringify(captured)).not.toContain('scenario_id');
 expect(String(captured[0]?.content)).toContain('Never claim an operation was performed unless a tool result in this turn confirms it');
 expect(snapshot(db,session.id).turns[0]).toMatchObject({status:'COMPLETED'});db.close();
});

it('repairs a retry proposal that conflicts with server eligibility and keeps S04 eligible',async()=>{
 const bad=setup('seed_s05','m3-guidance-repair');
 const sent=submitMessage(bad.db,bad.session.id,'批准后重试','m3-repair-turn','MOCK','mock');
 let calls=0,repairMessage='';
 await runDiagnosis(bad.db,{turnId:sent.turn_id,sessionId:bad.session.id,runId:'seed_s05',question:'批准后重试',mode:'MOCK',model:'mock',
  gateway:{async complete(messages){calls++;if(calls===2)repairMessage=String(messages.at(-1)?.content);return {text:calls===1?answer('批准后可重试',{type:'RETRY_RUN',run_id:'seed_s05',reason:'试试',evidence_ids:[]}):answer('该运行不具备模拟重试资格。'),calls:[],finishReason:'stop'};}},logSink:()=>{}});
 expect(calls).toBe(2);expect(repairMessage).toContain('retry_not_allowed');
 expect(snapshot(bad.db,bad.session.id).results[0]?.proposed_action_json).toBe('null');bad.db.close();

 const good=setup('seed_s04','m3-guidance-s04');
 const request=submitMessage(good.db,good.session.id,'能重试吗','m3-s04-turn','MOCK','mock');
 let prompt:Record<string,unknown>[]=[];
 await runDiagnosis(good.db,{turnId:request.turn_id,sessionId:good.session.id,runId:'seed_s04',question:'能重试吗',mode:'MOCK',model:'mock',
  gateway:{async complete(messages){prompt=messages;return {text:answer('符合模拟重试资格。',{type:'RETRY_RUN',run_id:'seed_s04',reason:'已知上游超时',evidence_ids:[]}),calls:[],finishReason:'stop'};}},logSink:()=>{}});
 expect(JSON.parse(String(prompt.at(-1)?.content)).retry_eligibility.allowed).toBe(true);
 expect(JSON.parse(snapshot(good.db,good.session.id).results[0]!.proposed_action_json!)).toMatchObject({type:'RETRY_RUN',run_id:'seed_s04'});good.db.close();
});

it('an S04 follow-up after a child run exists completes without proposing a second retry',async()=>{
 const {db,session}=setup('seed_s04','m3-followup-session');
 const first=submitMessage(db,session.id,'为什么失败','m3-followup-first','MOCK','mock');
 await runDiagnosis(db,{turnId:first.turn_id,sessionId:session.id,runId:'seed_s04',question:'为什么失败',mode:'MOCK',model:'mock',logSink:()=>{}});
 const proposal=proposeRetry(db,'seed_s04',first.turn_id,'模拟重试','m3-followup-proposal');
 resolveApproval(db,proposal.id,'approve','m3-followup-approve');
 const second=submitMessage(db,session.id,'现在还能重试吗','m3-followup-second','MOCK','mock');
 await runDiagnosis(db,{turnId:second.turn_id,sessionId:session.id,runId:'seed_s04',question:'现在还能重试吗',mode:'MOCK',model:'mock',logSink:()=>{}});
 const state=snapshot(db,session.id);
 expect(state.turns.at(-1)).toMatchObject({status:'COMPLETED'});
 expect(state.results).toHaveLength(2);
 expect(state.results.at(-1)?.proposed_action_json).toBe('null');db.close();
});

const findingAnswer=(cause:string)=>JSON.stringify({
 summary:'当前问题没有新证据，沿用已知运行状态。',
 findings:[{cause,explanation:'只查询了已保存的状态。',evidence_ids:[],evidence_status:'NEEDS_CONFIRMATION'}],
 missing_information:[],next_steps:[],proposed_action:null
});

it('repairs NONE on a failed run follow-up instead of persisting a false normal finding',async()=>{
 const {db,session}=setup('seed_s05','m3-none-followup');
 try{
  const first=submitMessage(db,session.id,'为什么失败','m3-none-first','MOCK','mock');
  await runDiagnosis(db,{turnId:first.turn_id,sessionId:session.id,runId:'seed_s05',question:'为什么失败',mode:'MOCK',model:'mock',logSink:()=>{}});
  const second=submitMessage(db,session.id,'现在能做什么','m3-none-second','MOCK','mock');
  let attempts=0;
  await runDiagnosis(db,{turnId:second.turn_id,sessionId:session.id,runId:'seed_s05',question:'现在能做什么',mode:'MOCK',model:'mock',
   gateway:{async complete(){return {text:findingAnswer(attempts++===0?'NONE':'UNKNOWN'),calls:[],finishReason:'stop'};}},logSink:()=>{}});
  const state=snapshot(db,session.id);
  expect(state.turns.at(-1)).toMatchObject({status:'COMPLETED'});
  expect(JSON.parse(String(state.results.at(-1)?.findings_json))[0].cause).toBe('UNKNOWN');
  const completed=state.turns.filter(t=>t.status==='COMPLETED');
  expect(completed).toHaveLength(2);
 }finally{db.close();}
});

it('fails without a saved diagnosis if a failed run still returns NONE after repair',async()=>{
 const {db,session}=setup('seed_s05','m3-none-invalid');
 try{
  const sent=submitMessage(db,session.id,'调取堆栈','m3-none-invalid-turn','MOCK','mock');
  const lines:string[]=[];
  await runDiagnosis(db,{turnId:sent.turn_id,sessionId:session.id,runId:'seed_s05',question:'调取堆栈',mode:'MOCK',model:'mock',
   gateway:{async complete(){return {text:findingAnswer('NONE'),calls:[],finishReason:'stop'};}},logSink:line=>lines.push(line)});
  const state=snapshot(db,session.id);
  expect(state.turns[0]).toMatchObject({status:'FAILED',error_code:'INVALID_RESULT'});
  expect(state.results).toHaveLength(0);
  expect(lines.map(line=>JSON.parse(line))).toContainEqual(expect.objectContaining({event:'result.invalid',validation_fields:'cause_not_allowed'}));
 }finally{db.close();}
});

it('continues to accept NONE for a successful run',async()=>{
 const {db,session}=setup('seed_s00','m3-none-normal');
 try{
  const sent=submitMessage(db,session.id,'运行正常吗','m3-none-normal-turn','MOCK','mock');
  await runDiagnosis(db,{turnId:sent.turn_id,sessionId:session.id,runId:'seed_s00',question:'运行正常吗',mode:'MOCK',model:'mock',
   gateway:{async complete(){return {text:findingAnswer('NONE'),calls:[],finishReason:'stop'};}},logSink:()=>{}});
  const state=snapshot(db,session.id);
  expect(state.turns[0]).toMatchObject({status:'COMPLETED'});
  expect(JSON.parse(String(state.results[0]?.findings_json))[0].cause).toBe('NONE');
 }finally{db.close();}
});

it('provides explicit fixture retry semantics so simulated recovery cannot be used as real upstream evidence',async()=>{
 const {db,session}=setup('seed_s04','m3-simulation-boundary');
 try{
  const sent=submitMessage(db,session.id,'模拟重试能证明上游恢复吗','m3-simulation-turn','MOCK','mock');
  let context:Record<string,unknown>={},system='';
  await runDiagnosis(db,{turnId:sent.turn_id,sessionId:session.id,runId:'seed_s04',question:'模拟重试能证明上游恢复吗',mode:'MOCK',model:'mock',
   gateway:{async complete(messages){context=JSON.parse(String(messages.at(-1)?.content));system=String(messages[0]?.content);return {text:answer('不能；模拟结果不代表真实上游健康。'),calls:[],finishReason:'stop'};}},logSink:()=>{}});
  expect(context.execution_semantics).toMatchObject({task_data_source:'FIXTURE',retry_mode:'SIMULATED',retry_outcome_source:'FIXTURE',verifies_real_upstream:false});
  expect(system).toContain('A simulated retry cannot verify real upstream availability or recovery');
  expect(system).toContain('NONE is only valid when current_run.status is SUCCEEDED');
  expect(JSON.stringify(context)).not.toContain('retry_timeline');
  expect(JSON.stringify(context)).not.toContain('scenario_id');
 }finally{db.close();}
});

it.each(['LIVE','MOCK'] as const)('provides the current %s model source independently of fixture task data',async mode=>{
 const {db,session}=setup('seed_s05','m3-model-source-'+mode);
 vi.stubEnv('FLOWLENS_LIVE_APPROVED','1');vi.stubEnv('FLOWLENS_LIVE_MAX_REQUESTS','unlimited');
 try{
  const model=mode==='LIVE'?'deepseek-flash':'mock';
  const sent=submitMessage(db,session.id,'现在使用的是真实模型吗','m3-model-source-turn',mode,model);
  let context:Record<string,unknown>={};
  await runDiagnosis(db,{turnId:sent.turn_id,sessionId:session.id,runId:'seed_s05',question:'现在使用的是真实模型吗',mode,model,
   gateway:{async complete(messages){context=JSON.parse(String(messages.at(-1)?.content));return {text:answer('模型来源与任务数据来源分别说明。'),calls:[],finishReason:'stop'};}},logSink:()=>{}});
  expect(context.model_source).toEqual({provider_mode:mode,model});
  expect(context.execution_semantics).toMatchObject({task_data_source:'FIXTURE',retry_mode:'SIMULATED',verifies_real_upstream:false});
  expect(snapshot(db,session.id).turns[0]).toMatchObject({provider_mode:mode,status:'COMPLETED'});
 }finally{db.close();vi.unstubAllEnvs();}
});

it('explains the platform approval path without treating a chat retry request as approval',async()=>{
 const {db,session}=setup('seed_s04','m3-platform-retry');
 try{
  const question='执行一次模拟重试',sent=submitMessage(db,session.id,question,'m3-platform-retry-turn','MOCK','mock');
  let context:Record<string,unknown>={};
  await runDiagnosis(db,{turnId:sent.turn_id,sessionId:session.id,runId:'seed_s04',question,mode:'MOCK',model:'mock',logSink:()=>{},
   gateway:{async complete(messages){context=JSON.parse(String(messages.at(-1)?.content));return {text:answer('请点击申请重试，再点击批准模拟重试。',{type:'RETRY_RUN',run_id:'seed_s04',reason:'上游超时，等待人工批准',evidence_ids:[]}),calls:[],finishReason:'stop'};}}});
  expect(context.approval_workflow).toEqual({platform_can_execute_simulated_retry:true,agent_can_execute_retry:false,approval_method:'UI_BUTTONS',request_button:'申请重试',approve_button:'批准模拟重试',chat_message_is_approval:false});
  expect(context.available_operations).toMatchObject({can_execute_real_retry:false});
  expect(context.retry_eligibility).toMatchObject({allowed:true});
  expect(db.prepare('SELECT count(*) n FROM approval_request').get()?.n).toBe(0);
  expect(db.prepare('SELECT count(*) n FROM task_run WHERE parent_run_id=?').get('seed_s04')?.n).toBe(0);
  const proposal=proposeRetry(db,'seed_s04',sent.turn_id,'上游超时，等待人工批准','m3-platform-proposal');
  expect(proposal.status).toBe('PENDING');
  expect(db.prepare('SELECT count(*) n FROM task_run WHERE parent_run_id=?').get('seed_s04')?.n).toBe(0);
  resolveApproval(db,proposal.id,'approve','m3-platform-approve');
  expect(db.prepare('SELECT count(*) n FROM task_run WHERE parent_run_id=?').get('seed_s04')?.n).toBe(1);
 }finally{db.close();}
});
