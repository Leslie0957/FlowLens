// The oracle stays in this runner. Only each natural-language question reaches the app.
import {readFileSync,mkdirSync,writeFileSync,appendFileSync,mkdtempSync} from 'node:fs';
import {join,dirname} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
const root=fileURLToPath(new URL('../',import.meta.url));
const cases=JSON.parse(readFileSync(join(root,'fixtures/evals/m4-p0.json'),'utf8'));
const args=process.argv.slice(2),live=args.includes('--execute-live'),mock=args.includes('--mock');
if(args.some(x=>!['--execute-live','--mock'].includes(x))||live&&mock){console.error('Use no flag for plan, --execute-live for paid evaluation, or --mock for offline smoke.');process.exitCode=2;}
else if(!live&&!mock){console.log(JSON.stringify({status:'PLAN_ONLY_NO_REQUESTS',cases,execute:'pnpm build; pnpm eval:live --execute-live'},null,2));}
else if(live&&(process.env.MODEL_MODE!=='LIVE'||process.env.FLOWLENS_LIVE_APPROVED!=='1'||!process.env.MODEL_API_KEY||!(process.env.FLOWLENS_LIVE_MAX_REQUESTS==='unlimited'||Number.isSafeInteger(Number(process.env.FLOWLENS_LIVE_MAX_REQUESTS))&&Number(process.env.FLOWLENS_LIVE_MAX_REQUESTS)>0)||Number(process.env.MODEL_MAX_OUTPUT_TOKENS)!==2048)){
 console.error('LIVE_NOT_APPROVED: require LIVE, local key, explicit approved budget, and output limit 2048. No requests sent.');process.exitCode=2;
}else{
 // Explicit MOCK overrides inherited LIVE variables, even on the developer machine.
 if(mock){process.env.MODEL_MODE='MOCK';process.env.MODEL_API_KEY='';process.env.FLOWLENS_LIVE_APPROVED='0';process.env.FLOWLENS_LIVE_MAX_REQUESTS='0';}
 const parent=join(root,'logs/m4');mkdirSync(parent,{recursive:true});
 const folder=mkdtempSync(join(parent,live?'live-':'mock-'));
 const {openDatabase,migrate,seed}=await import('../apps/server/dist/db.js');
 const {createApp}=await import('../apps/server/dist/http.js');
 const {advanceDue}=await import('../apps/server/dist/store.js');
 const require=createRequire(pathToFileURL(join(root,'package.json'))),{chromium,expect}=require('@playwright/test');
 const webRequire=createRequire(pathToFileURL(join(root,'apps/web/package.json')));
 const vite=join(dirname(webRequire.resolve('vite/package.json')),'bin/vite.js');
 const db=openDatabase(join(folder,'evaluation.sqlite'));migrate(db);seed(db);
 const entries=[],report={started_at:new Date().toISOString(),mode:live?'LIVE':'MOCK',task_data_mode:'FIXTURE',model:live?(process.env.MODEL_NAME??'deepseek-flash'):'deterministic-mock',node:process.version,platform:process.platform,max_output_tokens:live?2048:null,oracle_sha256:createHash('sha256').update(JSON.stringify(cases)).digest('hex'),source_sha256:createHash('sha256').update(readFileSync(join(root,'apps/server/src/diagnosis-agent.ts'))).digest('hex'),turns:[],checks:[],status:'RUNNING'};
 const sink=line=>{appendFileSync(join(folder,'server.jsonl'),line+'\n');entries.push(JSON.parse(line));};
 const server=await new Promise((resolve,reject)=>{const s=createApp(db,sink).listen(0,'127.0.0.1',()=>resolve(s));s.on('error',reject);});
 const api='http://127.0.0.1:'+server.address().port;
 const port=Number(process.env.FLOWLENS_EVAL_WEB_PORT??5175),base='http://127.0.0.1:'+port;
 const tick=setInterval(()=>advanceDue(db,Date.now()),250);
 const web=spawn(process.execPath,[vite,'preview','--host','127.0.0.1','--port',String(port),'--strictPort'],{cwd:join(root,'apps/web'),env:{...process.env,FLOWLENS_API_TARGET:api,MODEL_API_KEY:''},windowsHide:true,stdio:['ignore','pipe','pipe']});
 for(const stream of [web.stdout,web.stderr])stream.on('data',bytes=>appendFileSync(join(folder,'preview.txt'),bytes));
 let browser,context,page;
 const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
 function save(){
  const completed=entries.filter(e=>e.event==='model.completed');
  report.model_gateway_calls=entries.filter(e=>e.event==='model.started').length;
  report.model_requests=live?report.model_gateway_calls:0;
  report.usage_tokens=completed.reduce((sum,e)=>sum+(e.usage??0),0);
  report.usage_missing_requests=completed.filter(e=>e.usage===undefined).length;
  report.finished_at=new Date().toISOString();writeFileSync(join(folder,'report.json'),JSON.stringify(report,null,2)+'\n');
 }
 async function data(path){const response=await fetch(api+'/api/v1'+path);if(!response.ok)throw Error('LOCAL_READ_'+response.status);return (await response.json()).data;}
 function grade(item,result,evidence){
  const findings=result?.findings??[],ids=[...findings.flatMap(f=>f.evidence_ids),...(result?.proposed_action?.evidence_ids??[])];
  const fact=evidence.some(e=>e.type==='RUN_STATE'||e.type==='LOG');
  const minimum=item.cause==='UPSTREAM_TIMEOUT'?evidence.some(e=>e.type==='LOG'&&/ReadTimeout|UPSTREAM_TIMEOUT|upstream request exceeded/i.test(e.excerpt)):
   evidence.some(e=>/SUCCEEDED/.test(e.excerpt)&&(e.type==='RUN_STATE'||e.type==='LOG'))&&item.cause==='NONE'||evidence.some(e=>/UNKNOWN_FAILURE|detail unavailable/.test(e.excerpt)&&(e.type==='RUN_STATE'||e.type==='LOG'))&&item.cause==='UNKNOWN';
  return {cause_correct:findings.length>0&&findings.every(f=>f.cause===item.cause),citation_valid:ids.length>0&&ids.every(id=>evidence.some(e=>e.id===id))&&fact,minimum_evidence:minimum,retry_correct:Boolean(result?.proposed_action)===item.retry,abstention:item.cause==='UNKNOWN'?findings.length>0&&findings.every(f=>f.cause==='UNKNOWN'&&f.evidence_status==='NEEDS_CONFIRMATION')&&result.missing_information.length>0:null,semantic_review:'REQUIRED: compare actual wording with the independent forbidden behaviors'};
 }
 async function ask(item){
  const sessionId=await page.getByRole('combobox',{name:'诊断会话'}).inputValue();
  const posted=page.waitForResponse(r=>r.request().method()==='POST'&&r.url().endsWith('/sessions/'+sessionId+'/messages'));
  await page.getByRole('textbox',{name:'诊断问题'}).fill(item.question);
  await page.evaluate(question=>{
   window.__evalFeedback=null;
   const observer=new MutationObserver(()=>{if([...document.querySelectorAll('.diagnosis-message.user')].some(el=>el.textContent.includes(question))){window.__evalFeedback=performance.timeOrigin+performance.now();observer.disconnect();}});
   observer.observe(document.body,{childList:true,subtree:true});
  },item.question);
  const started=Date.now();await page.getByRole('button',{name:'发送',exact:true}).click();
  const response=await posted;expect(response.status()).toBe(202);const sent=(await response.json()).data;
  let state,turn;
  for(let i=0;i<450;i++){state=await data('/sessions/'+sessionId);turn=state.turns.find(t=>t.id===sent.turn_id);if(turn&&!['QUEUED','RUNNING'].includes(turn.status))break;await wait(300);}
  const row=state.results.find(r=>r.turn_id===sent.turn_id);
  const result=row?{summary:row.summary,findings:JSON.parse(row.findings_json),missing_information:JSON.parse(row.missing_information_json),next_steps:JSON.parse(row.next_steps_json),proposed_action:JSON.parse(row.proposed_action_json??'null')}:null;
  const ids=[...new Set([...(result?.findings.flatMap(f=>f.evidence_ids)??[]),...(result?.proposed_action?.evidence_ids??[])])],evidence=[];
  for(const id of ids){const e=await data('/sessions/'+sessionId+'/evidence/'+id);let source_valid=false;
   if(e.type==='LOG'){const log=db.prepare('SELECT message,run_id FROM task_log WHERE id=?').get(e.source_id);source_valid=log?.run_id==='seed_'+item.scenario_id.toLowerCase()&&log.message.startsWith(e.excerpt);}
   if(e.type==='RUN_STATE')source_valid=e.source_id==='seed_'+item.scenario_id.toLowerCase();
   if(e.type==='RUNBOOK'){try{source_valid=readFileSync(join(root,'docs/runbooks',e.source_id+'.md'),'utf8').startsWith(e.excerpt);}catch{source_valid=false;}}
   evidence.push({...e,source_valid});
  }
  const logs=entries.filter(e=>e.turn_id===sent.turn_id),tools=state.tool_calls.filter(t=>t.turn_id===sent.turn_id);
  const feedbackAt=await page.evaluate(()=>window.__evalFeedback);
  const record={id:item.id,scenario_id:item.scenario_id,question:item.question,session_id:sessionId,turn_id:sent.turn_id,status:turn?.status,error_code:turn?.error_code,prompt_version:turn?.prompt_version,result,evidence,tools,elapsed_ms:Date.now()-started,user_message_visible_ms:feedbackAt===null?null:Math.round(feedbackAt-started),model_gateway_calls:logs.filter(e=>e.event==='model.started').length,model_requests:live?logs.filter(e=>e.event==='model.started').length:0,first_provider_delta_ms:logs.filter(e=>e.event==='model.first_delta').map(e=>({model_request:e.model_request,ms:e.duration_ms})),usage_tokens:logs.filter(e=>e.event==='model.completed').reduce((sum,e)=>sum+(e.usage??0),0),checks:grade(item,result,evidence)};
  record.raw_assistant_messages=state.messages.filter(m=>m.turn_id===sent.turn_id&&m.role==='assistant').map(m=>m.content);
  record.checks.provenance_valid=evidence.length>0&&evidence.every(e=>e.source_valid);report.turns.push(record);save();
  if(row){
   await expect(page.locator('.diagnosis-result')).toHaveCount(state.results.length);
   // The validated card now reveals progressively. Wait for this turn's text,
   // otherwise .last() can still identify a citation in the previous turn.
   await expect(page.locator('.diagnosis-result').last()).toHaveAttribute('aria-busy','false');
   record.final_answer_visible_ms=Date.now()-started;save();
  }
  await page.screenshot({path:join(folder,item.id+'.png'),fullPage:true});
  console.log(JSON.stringify({case:item.id,status:turn?.status,model_requests:record.model_requests,elapsed_ms:record.elapsed_ms}));
  return record;
 }
 try{
  let ready=false;for(let i=0;i<100;i++){try{ready=(await fetch(base+'/runs')).ok;}catch{ready=false;}if(ready)break;await wait(200);}if(!ready)throw Error('PREVIEW_START_FAILED');
  browser=await chromium.launch({channel:'chrome',headless:true});report.browser=browser.version();
  context=await browser.newContext({viewport:{width:1440,height:900},recordVideo:{dir:join(folder,'video'),size:{width:1440,height:900}}});page=await context.newPage();
  for(const scenario of ['S00','S04','S05']){
   await page.goto(base+'/runs/seed_'+scenario.toLowerCase());await expect(page.getByText((live?'LIVE':'MOCK')+' 模型 · FIXTURE 数据')).toBeVisible();
   await page.getByRole('button',{name:'新建会话'}).click();await expect(page.getByText('本机消息通道已连接',{exact:true})).toBeVisible();
   let last;
   for(const item of cases.filter(c=>c.scenario_id===scenario))last=await ask(item);
   if(last.result){const button=page.locator('.diagnosis-result').last().locator('.evidence-links button').last();await button.click();await expect(page.getByRole('dialog',{name:'证据详情'})).toBeVisible();await wait(600);await button.click();await expect(page.getByRole('dialog',{name:'证据详情'})).toHaveCount(0);}
   if(scenario==='S04'&&last.result?.proposed_action){
    expect(Number(db.prepare('SELECT count(*) n FROM task_run WHERE parent_run_id=?').get('seed_s04').n)).toBe(0);
    await page.getByRole('button',{name:'申请重试',exact:true}).click();await expect(page.getByRole('heading',{name:'人工审批 · PENDING'})).toBeVisible();
    expect(Number(db.prepare('SELECT count(*) n FROM task_run WHERE parent_run_id=?').get('seed_s04').n)).toBe(0);
    await page.getByRole('button',{name:'批准模拟重试',exact:true}).click();await expect(page.getByText('模拟重试成功',{exact:true})).toBeVisible({timeout:15000});
    const follow=await ask({id:'S04-approved-extra',scenario_id:'S04',question:'我已经点了批准模拟重试。原运行还能重试吗？怎么查看这次模拟结果？',cause:'UPSTREAM_TIMEOUT',retry:false});expect(follow.result?.proposed_action).toBeNull();
    await page.reload();await expect(page.locator('.diagnosis-result')).toHaveCount(3);await expect(page.getByText('模拟重试成功',{exact:true})).toBeVisible();
    report.checks.push('S04 chat did not execute; UI approval created one child; post-approval no new proposal; refresh retained three turns');
    await page.getByRole('link',{name:/查看模拟重试运行/}).click();await expect(page.locator('.heading-status')).toContainText('已完成');await expect(page.getByText('Report generated (simulated recovery)').first()).toBeVisible();await page.screenshot({path:join(folder,'child.png'),fullPage:true});await wait(800);
   }
   if(scenario==='S05'){await expect(page.getByRole('button',{name:'申请重试',exact:true})).toHaveCount(0);await page.reload();await expect(page.locator('.diagnosis-result')).toHaveCount(report.turns.filter(t=>t.scenario_id==='S05'&&t.result).length);report.checks.push('S05 existing turns persisted, no retry button');}
  }
  report.child_count=Number(db.prepare('SELECT count(*) n FROM task_run WHERE parent_run_id=?').get('seed_s04').n);report.execution_count=Number(db.prepare('SELECT count(*) n FROM action_execution').get().n);
  expect(report.child_count).toBe(1);expect(report.execution_count).toBe(1);
  const primary=report.turns.filter(t=>!t.id.includes('extra'));
  report.metrics={questions:primary.length,cause_correct:primary.filter(t=>t.checks.cause_correct).length,citation_valid:primary.filter(t=>t.checks.citation_valid&&t.checks.provenance_valid).length,minimum_evidence:primary.filter(t=>t.checks.minimum_evidence).length,tool_succeeded:primary.flatMap(t=>t.tools).filter(t=>t.status==='SUCCEEDED').length,tool_total:primary.flatMap(t=>t.tools).length,abstention_correct:primary.filter(t=>t.checks.abstention===true).length,abstention_total:primary.filter(t=>t.checks.abstention!==null).length};
  report.status=primary.length===6&&primary.every(t=>t.status==='COMPLETED'&&Object.values(t.checks).every(v=>v!==false))?'MECHANICAL_CHECKS_PASSED_SEMANTIC_REVIEW_REQUIRED':'MECHANICAL_CHECKS_FAILED';
  if(report.status==='MECHANICAL_CHECKS_FAILED')process.exitCode=1;
 }catch(error){report.status='FAILED';report.error=error instanceof Error?error.message:String(error);process.exitCode=1;}
 finally{
  if(context){const video=page?.video();await context.close();if(video)report.video=await video.path();}await browser?.close();web.kill();clearInterval(tick);
  await new Promise(resolve=>{server.closeAllConnections();server.close(resolve);});save();db.close();console.log(JSON.stringify({status:report.status,artifact_folder:folder,model_requests:report.model_requests,usage_tokens:report.usage_tokens,metrics:report.metrics}));
 }
}
