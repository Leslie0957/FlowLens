import {defineConfig} from '@playwright/test';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:net';
// A Windows outbound socket can bind the fixed UI test port without LISTENING.
// Ask the OS for an available loopback port; strictPort prevents silent fallback.
async function availableWebPort():Promise<number>{
 return new Promise((resolve,reject)=>{
  const probe=createServer();probe.once('error',reject);
  probe.listen(0,'127.0.0.1',()=>{const address=probe.address();if(!address||typeof address==='string'){probe.close();reject(new Error('TEST_PORT_UNAVAILABLE'));return;}probe.close(error=>error?reject(error):resolve(address.port));});
 });
}
const webPort=process.env.FLOWLENS_E2E_WEB_PORT===undefined?await availableWebPort():Number(process.env.FLOWLENS_E2E_WEB_PORT);
if(!Number.isInteger(webPort)||webPort<1||webPort>65535)throw new Error('INVALID_TEST_WEB_PORT');
// Workers reload this file. Inherit the runner's chosen port instead of picking
// a different baseURL in each worker process.
process.env.FLOWLENS_E2E_WEB_PORT=String(webPort);
const folder=mkdtempSync(join(tmpdir(),'flowlens-e2e-'));
const dbPath=join(folder,'test.sqlite');
// Loaded only by the E2E harness, against its freshly allocated temporary DB.
const {seedPressure}=await import('./tests/fixtures/m5-pressure.mjs');
seedPressure(dbPath);
process.on('exit',()=>{try{rmSync(folder,{recursive:true,force:true,maxRetries:10,retryDelay:100});}catch{/* Windows may release SQLite after process exit; temp files are isolated */}});
export default defineConfig({
  testDir:'tests/e2e',timeout:30000,expect:{timeout:10000},
  use:{baseURL:`http://127.0.0.1:${webPort}`,headless:true,browserName:'chromium',channel:'chrome'},
  webServer:[
    {command:'pnpm --filter @flowlens/server start',url:'http://127.0.0.1:4174/health',timeout:30000,reuseExistingServer:false,env:{APP_DB_PATH:dbPath,APP_PORT:'4174',MODEL_MODE:'MOCK',MODEL_API_KEY:'',MOCK_MODEL:'1',FLOWLENS_LIVE_APPROVED:'0'}},
    {command:`pnpm --filter @flowlens/web exec vite --host 127.0.0.1 --port ${webPort} --strictPort`,url:`http://127.0.0.1:${webPort}/runs`,timeout:30000,reuseExistingServer:false,env:{FLOWLENS_API_TARGET:'http://127.0.0.1:4174'}}
  ],reporter:[['list'],['json',{outputFile:`logs/m5/e2e-${new Date().toISOString().replace(/[:.]/g,'-')}.json`}]],workers:1
});
