// Verify the exact README build/start commands against the isolated MOCK database.
import {spawn} from 'node:child_process';
import {writeFileSync,appendFileSync,mkdirSync} from 'node:fs';
import {join} from 'node:path';
import {createRequire} from 'node:module';
if(process.env.MODEL_MODE!=='MOCK'||process.env.MODEL_API_KEY||process.env.FLOWLENS_LIVE_APPROVED!=='0')throw Error('MOCK_ONLY');
const folder=join(process.cwd(),'logs/m4/start');mkdirSync(folder,{recursive:true});
const pnpm=process.env.npm_execpath;
if(!pnpm)throw Error('RUN_WITH_PNPM_RUN_CHECK_START');
const spawnPnpm=(name,args=[])=>{
 const executable=pnpm.toLowerCase().endsWith('.exe')?pnpm:process.execPath;
 const cliArgs=executable===pnpm?[name,...args]:[pnpm,name,...args];
 const child=spawn(executable,cliArgs,{cwd:process.cwd(),env:process.env,windowsHide:true,stdio:['ignore','pipe','pipe']});
 for(const stream of [child.stdout,child.stderr])stream.on('data',bytes=>appendFileSync(join(folder,name+'.txt'),bytes));return child;
};
const api=spawnPnpm('start'),web=spawnPnpm('preview',['--port','5177']);
const require=createRequire(import.meta.url),{chromium,expect}=require('@playwright/test');
let browser;
try{
 for(let i=0;i<100;i++){
  try{if((await fetch('http://127.0.0.1:4176/health')).ok&&(await fetch('http://127.0.0.1:5177/runs')).ok)break;}catch{/* isolated startup polling */}
  await new Promise(resolve=>setTimeout(resolve,200));
 }
 browser=await chromium.launch({channel:'chrome',headless:true});const page=await browser.newPage({viewport:{width:1440,height:900}});
 await page.goto('http://127.0.0.1:5177/runs/seed_s05');await expect(page.getByText('MOCK 模型 · FIXTURE 数据')).toBeVisible();
 await page.getByRole('button',{name:'新建会话'}).click();await page.getByRole('textbox',{name:'诊断问题'}).fill('当前证据能确定根因吗？');await page.getByRole('button',{name:'发送',exact:true}).click();
 await expect(page.locator('.diagnosis-result')).toContainText('当前信息不足');await page.reload();await expect(page.locator('.diagnosis-result')).toHaveCount(1);
 await page.screenshot({path:join(folder,'build-start.png'),fullPage:true});writeFileSync(join(folder,'report.json'),JSON.stringify({status:'PASSED',commands:['pnpm start','pnpm preview --port 5177'],browser:browser.version(),checks:['built frontend and backend start','MOCK fixture visible','diagnosis and refresh persist']},null,2));
}finally{
 await browser?.close();
 // pnpm spawns children; on Windows terminate only these known process trees.
 for(const child of [api,web])if(child.exitCode===null){if(process.platform==='win32')await new Promise(resolve=>spawn('taskkill',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'}).once('exit',resolve));else child.kill();}
}
