import {existsSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {openDatabase,migrate} from '../../src/db.ts';
import {LocalExecutionService} from '../../src/local-execution.ts';
const folder=process.argv[2];
const db=openDatabase(join(folder,'test.sqlite'));migrate(db);
const service=new LocalExecutionService(db,join(folder,'projects'),{runnerPath:fileURLToPath(new URL('./stall-runner.mjs',import.meta.url))});
const project=service.createProject('sql-valid-control','create');
const execution=service.startExecution(project.id,'run');
const pidPath=join(folder,'projects',project.id,execution.id,'child.pid');
const timer=setInterval(()=>{
  if(!existsSync(pidPath))return;
  clearInterval(timer);
  console.log(JSON.stringify({projectId:project.id,executionId:execution.id,childPid:Number(readFileSync(pidPath,'utf8'))}));
},10);
setInterval(()=>{},1000);
