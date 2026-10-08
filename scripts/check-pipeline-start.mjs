import {spawn} from 'node:child_process';
import {mkdirSync,appendFileSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {createServer} from 'node:net';
import {chromium,expect} from '@playwright/test';

const live=process.argv.includes('--execute-live');
if(live&&(!process.argv.includes('--approve-test-candidate')||!process.env.MODEL_API_KEY||process.env.FLOWLENS_LIVE_APPROVED!=='1'))throw new Error('EXPLICIT_LIVE_AUTHORIZATION_REQUIRED');
const evalCap=Number(process.env.FLOWLENS_PIPELINE_EVAL_LIVE_MAX_REQUESTS??8);
if(!Number.isSafeInteger(evalCap)||evalCap<1)throw new Error('INVALID_EVAL_BUDGET');
const cap=process.env.FLOWLENS_LIVE_MAX_REQUESTS==='unlimited'?evalCap:Math.min(evalCap,Number(process.env.FLOWLENS_LIVE_MAX_REQUESTS??0));
if(live&&(!Number.isInteger(cap)||cap<1))throw new Error('LIVE_BUDGET_UNAVAILABLE');
const modelEnv=live?{MODEL_MODE:'LIVE',FLOWLENS_LIVE_MAX_REQUESTS:String(cap)}:{MODEL_MODE:'MOCK',MODEL_API_KEY:'',FLOWLENS_LIVE_APPROVED:'0'};
const folder=resolve('logs/pipeline/'+(live?'live-browser-':'build-start-')+new Date().toISOString().replace(/[:.]/g,'-'));
mkdirSync(folder,{recursive:true});
const pnpm=process.env.npm_execpath;
if(!pnpm)throw new Error('RUN_WITH_PNPM_CHECK_PIPELINE_START');
async function availablePort(){
  const server=createServer();
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  const port=server.address().port;
  await new Promise(resolve=>server.close(resolve));
  return port;
}
const apiPort=await availablePort();
let webPort=await availablePort();
while(webPort===apiPort)webPort=await availablePort();
const apiRoot='http://127.0.0.1:'+apiPort,webRoot='http://127.0.0.1:'+webPort;
const start=(name,args,extra={})=>{
  const exe=pnpm.toLowerCase().endsWith('.exe')?pnpm:process.execPath;
  const child=spawn(exe,exe===pnpm?[name,...args]:[pnpm,name,...args],{cwd:process.cwd(),windowsHide:true,env:{...process.env,APP_PORT:String(apiPort),APP_DB_PATH:join(folder,'app.sqlite'),...modelEnv,...extra},stdio:['ignore','pipe','pipe']});
  for(const stream of [child.stdout,child.stderr])stream.on('data',bytes=>appendFileSync(join(folder,name+'.txt'),bytes));
  return child;
};
const api=start('start',[]),web=start('preview',['--port',String(webPort)],{FLOWLENS_API_TARGET:apiRoot});
let browser;
const report={at:new Date().toISOString(),mode:live?'LIVE':'MOCK',isolated_db:true,request_cap:live?cap:0,approval:'automated browser test approval in isolated DB',commands:['pnpm start','pnpm preview --port '+webPort],apiPort,webPort,status:'FAILED'};
try{
  let ready=false;
  for(let i=0;i<100;i++){
    if(api.exitCode!==null||web.exitCode!==null)throw new Error('TEST_SERVICE_EXITED');
    try{if((await fetch(apiRoot+'/health')).ok&&(await fetch(webRoot+'/pipeline')).ok){ready=true;break;}}catch{/* startup */}
    await new Promise(r=>setTimeout(r,200));
  }
  if(!ready)throw new Error('TEST_SERVICE_NOT_READY');
  browser=await chromium.launch({channel:'chrome',headless:true});
  const page=await browser.newPage({viewport:{width:1440,height:1000},...(live?{recordVideo:{dir:join(folder,'video'),size:{width:1440,height:1000}}}:{})});
  const consoleErrors=[];
  page.on('pageerror',e=>consoleErrors.push(e.message));
  await page.goto(webRoot+'/');
  await expect(page).toHaveURL(/\/pipeline$/);
  await page.getByRole('button',{name:'创建车辆任务'}).click();
  await page.getByRole('button',{name:'运行只读预检'}).click();
  await expect(page.getByText('no such column: speed_kph',{exact:false}).first()).toBeVisible();
  report.project_id=new URL(page.url()).pathname.split('/')[3];
  const snapshot=async()=>(await (await fetch(apiRoot+'/api/v1/pipeline/projects/'+report.project_id)).json()).data;
  const started=Date.now();
  await page.getByRole('button',{name:'Agent 取证并生成候选'}).click();
  await expect(page.getByRole('button',{name:'批准修复并入库'})).toBeVisible({timeout:920000});
  report.diagnosis_elapsed_ms=Date.now()-started;
  await expect(page.getByText(live?'LIVE':'MOCK',{exact:true})).toBeVisible();
  const candidate=await snapshot(),repair=candidate.repairs[0];
  await expect(page.locator('.pipeline-tools details')).toHaveCount(repair.tools.length);
  expect(repair.evidence_ids.length).toBeGreaterThan(0);
  expect(candidate.target.row_count).toBe(0);
  expect(candidate.executions).toHaveLength(1);
  await page.screenshot({path:join(folder,'candidate-diff.png'),fullPage:true});
  await page.getByRole('button',{name:'批准修复并入库'}).click();
  await expect(page.getByRole('heading',{name:'入库结果复查'})).toBeVisible();
  await expect(page.locator('.el-table__body')).toContainText('synthetic_segment_01');
  const committed=await snapshot();
  expect(committed.target.row_count).toBe(4);
  expect(committed.executions).toHaveLength(3);
  expect(committed.repairs[0].commit_approval.status).toBe('COMMITTED');
  await page.screenshot({path:join(folder,'built-query.png'),fullPage:true});
  await page.getByRole('button',{name:'发现问题，撤销本次入库'}).click();
  await page.getByRole('button',{name:'确认撤销并恢复'}).click();
  await expect(page.getByRole('heading',{name:'本次入库已撤销'})).toBeVisible();
  await expect(page.getByText('查询成功，0 行',{exact:true})).toBeVisible();
  await page.reload();
  await expect(page.getByText('恢复凭证',{exact:false})).toBeVisible();
  await page.screenshot({path:join(folder,'built-restored.png'),fullPage:true});
  const final=await snapshot();
  expect(final.target.row_count).toBe(0);
  writeFileSync(join(folder,'case-A.json'),JSON.stringify(final,null,2));
  report.model=final.repairs.map(r=>({provider_mode:r.provider_mode,model:r.model,requests:r.model_requests,diagnosis_limits:r.diagnosis_limits,usage:r.usage,status:r.status,tools:r.tools,evidence:r.evidence,response_checks:r.response_checks}));
  report.target=final.target;
  report.batches=final.batches;
  expect(consoleErrors).toEqual([]);
  report.status='PASSED';
  report.browser=browser.version();
  report.checks=['built frontend default /pipeline','real child SQLite failure','actual variable tool trace and valid evidence','no writes before approval','single bound approval verifies, prechecks and commits COUNT=4','real restore COUNT=0 and receipt after refresh','no browser pageerror'];
}catch(e){report.error=e.message;process.exitCode=1;}
finally{
  await browser?.close();
  for(const child of [api,web])if(child.exitCode===null){
    if(process.platform==='win32')await new Promise(r=>spawn('taskkill',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'}).once('exit',r));
    else child.kill();
  }
  writeFileSync(join(folder,'report.json'),JSON.stringify(report,null,2));
  console.log(JSON.stringify({report:join(folder,'report.json'),status:report.status,error:report.error,project_id:report.project_id}));
}