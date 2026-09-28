import {defineConfig} from '@playwright/test';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const folder=mkdtempSync(join(tmpdir(),'flowlens-e2e-'));
const dbPath=join(folder,'test.sqlite');
process.on('exit',()=>{try{rmSync(folder,{recursive:true,force:true,maxRetries:10,retryDelay:100});}catch{/* Windows may release SQLite after process exit; temp files are isolated */}});
export default defineConfig({
  testDir:'tests/e2e',timeout:30000,expect:{timeout:10000},
  use:{baseURL:'http://127.0.0.1:5174',headless:true,browserName:'chromium',channel:'chrome'},
  webServer:[
    {command:'pnpm --filter @flowlens/server start',url:'http://127.0.0.1:4174/health',timeout:30000,reuseExistingServer:false,env:{APP_DB_PATH:dbPath,APP_PORT:'4174',MODEL_MODE:'MOCK',MODEL_API_KEY:'',MOCK_MODEL:'1',FLOWLENS_LIVE_APPROVED:'0'}},
    {command:'pnpm --filter @flowlens/web exec vite --host 127.0.0.1 --port 5174',url:'http://127.0.0.1:5174/runs',timeout:30000,reuseExistingServer:false,env:{FLOWLENS_API_TARGET:'http://127.0.0.1:4174'}}
  ],reporter:'list',workers:1
});
