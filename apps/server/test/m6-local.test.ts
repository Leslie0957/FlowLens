import {it,expect,vi} from 'vitest';
import {mkdtempSync,rmSync,readFileSync,existsSync,writeFileSync,rmdirSync,mkdirSync,symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {createHash,randomUUID} from 'node:crypto';
import type {DatabaseSync} from 'node:sqlite';
import {openDatabase,migrate,seed} from '../src/db.js';
import {LocalExecutionService} from '../src/local-execution.js';

function testRevision(db:DatabaseSync,service:LocalExecutionService,projectId:string,sql:string){
  const project=service.getProject(projectId),id=randomUUID(),input=project.revision.input_json;
  const digest=createHash('sha256').update(sql+'\n'+input).digest('hex');
  db.prepare('INSERT INTO local_revision VALUES (?,?,?,?,?,?,?,?)').run(id,projectId,project.current_revision_id,sql,input,digest,'TEST',new Date().toISOString());
  db.prepare('UPDATE local_project SET current_revision_id=? WHERE id=?').run(id,projectId);
  return {id};
}

it('runs real SQLite in a child process and keeps immutable failures and a validated control',async()=>{
  const folder=mkdtempSync(join(tmpdir(),'flowlens-m6-'));
  const db=openDatabase(join(folder,'test.sqlite'));
  try{
    migrate(db);seed(db);
    const service=new LocalExecutionService(db,join(folder,'projects'));
    const broken=service.createProject('sql-column-error','create-broken');
    expect(service.listExecutions(broken.id,1,20).data).toHaveLength(0);
    const first=service.startExecution(broken.id,'run-broken');
    const failed=await service.waitFor(first.id);
    expect(failed.status).toBe('FAILED');
    expect(failed.error_code).toBe('SQL_COLUMN_ERROR');
    expect(failed.exit_code).not.toBe(0);
    const again=await service.waitFor(service.startExecution(broken.id,'run-again').id);
    expect(again.id).not.toBe(first.id);
    expect(again.revision_hash).toBe(failed.revision_hash);
    expect(again.status).toBe('FAILED');
    expect(service.getExecution(first.id)).toEqual(failed);
    const control=service.createProject('sql-valid-control','create-control');
    const ok=await service.waitFor(service.startExecution(control.id,'run-control').id);
    expect(ok.status).toBe('SUCCEEDED');
    expect(ok.validation).toMatchObject({passed:true,order_count:3,total_amount:100});
    expect(service.cancel(ok.id).status).toBe('SUCCEEDED');
    const semantic=testRevision(db,service,control.id,'SELECT COUNT(*) AS order_count, SUM(order_id) AS total_amount FROM orders;');
    expect(()=>service.startExecution(control.id,'run-control')).toThrow('IDEMPOTENCY_CONFLICT');
    const wrong=await service.waitFor(service.startExecution(control.id,'run-wrong').id);
    expect(wrong.revision_id).toBe(semantic.id);
    expect(wrong.exit_code).toBe(0);
    expect(wrong.status).toBe('FAILED');
    expect(wrong.error_code).toBe('RESULT_VALIDATION_FAILED');
  }finally{db.close();rmSync(folder,{recursive:true,force:true});}
});

it('replays idempotency before busy checks, rejects changed requests, and actually stops children',async()=>{
  const folder=mkdtempSync(join(tmpdir(),'flowlens-m6-life-')),db=openDatabase(join(folder,'test.sqlite'));
  const runner=fileURLToPath(new URL('./fixtures/stall-runner.mjs',import.meta.url));
  const priorKey=process.env.MODEL_API_KEY,priorOptions=process.env.NODE_OPTIONS;
  process.env.MODEL_API_KEY='M6_SENTINEL';process.env.NODE_OPTIONS='--trace-warnings';
  let service:LocalExecutionService|undefined;
  try{
    migrate(db);service=new LocalExecutionService(db,join(folder,'projects'),{runnerPath:runner,timeoutMs:1000});
    const project=service.createProject('sql-column-error','same-create');
    expect(service.createProject('sql-column-error','same-create').id).toBe(project.id);
    expect(()=>service!.createProject('sql-valid-control','same-create')).toThrow('IDEMPOTENCY_CONFLICT');
    const first=service.startExecution(project.id,'same-run');
    expect(service.startExecution(project.id,'same-run').id).toBe(first.id);
    const second=service.createProject('sql-valid-control','other-create');
    expect(()=>service!.startExecution(second.id,'new-run')).toThrow('LOCAL_EXECUTION_BUSY');
    expect(()=>service!.startExecution(second.id,'same-run')).toThrow('IDEMPOTENCY_CONFLICT');
    const pidPath=join(folder,'projects',project.id,first.id,'child.pid');
    await vi.waitFor(()=>expect(existsSync(pidPath)).toBe(true));
    const pid=Number(readFileSync(pidPath,'utf8'));
    expect(service.cancel(first.id).status).toBe('RUNNING');
    expect((await service.waitFor(first.id)).status).toBe('CANCELLED');
    expect(service.cancel(first.id).status).toBe('CANCELLED');
    expect(()=>process.kill(pid,0)).toThrow();
    expect(service.logs(first.id,0,200)).toEqual(expect.arrayContaining([expect.objectContaining({message:expect.stringContaining('secrets_present=false')})]));
    const timed=service.startExecution(second.id,'timeout-run');
    const ended=await service.waitFor(timed.id);
    expect(ended.status).toBe('FAILED');expect(ended.error_code).toBe('LOCAL_EXECUTION_TIMEOUT');
    expect(ended.termination_reason).toBe('LOCAL_EXECUTION_TIMEOUT');
  }finally{await service?.stopAll();db.close();rmSync(folder,{recursive:true,force:true});if(priorKey===undefined)delete process.env.MODEL_API_KEY;else process.env.MODEL_API_KEY=priorKey;if(priorOptions===undefined)delete process.env.NODE_OPTIONS;else process.env.NODE_OPTIONS=priorOptions;}
},10000);

it('rejects extra SQL syntax before spawning and interrupts orphaned rows on restart',async()=>{
  const folder=mkdtempSync(join(tmpdir(),'flowlens-m6-policy-')),db=openDatabase(join(folder,'test.sqlite'));
  try{
    migrate(db);const service=new LocalExecutionService(db,join(folder,'projects'));
    const project=service.createProject('sql-column-error','create');
    for(const sql of [
      'SELECT COUNT(*) AS order_count, SUM(amount) AS total_amount FROM orders; ATTACH DATABASE x AS y;',
      'PRAGMA database_list;',
      'SELECT COUNT(*) AS order_count, SUM((SELECT amount FROM orders)) AS total_amount FROM orders;',
      'SELECT 3 AS order_count, 100 AS total_amount FROM orders;'
    ]){
      testRevision(db,service,project.id,sql);
      const result=service.startExecution(project.id,'policy-'+crypto.randomUUID());
      expect(result.status).toBe('FAILED');expect(result.error_code).toBe('SQL_POLICY_REJECTED');
      expect(result.started_at).toBeNull();
    }
    const active=service.startExecution(service.createProject('sql-valid-control','valid').id,'valid-run');
    await service.waitFor(active.id);
    db.prepare("UPDATE local_execution SET status='RUNNING',finished_at=NULL WHERE id=?").run(active.id);
    const restarted=new LocalExecutionService(db,join(folder,'projects'));restarted.recoverInterrupted();
    expect(restarted.getExecution(active.id).status).toBe('INTERRUPTED');
    expect(restarted.artifacts(active.id).length).toBeGreaterThan(0);
  }finally{db.close();rmSync(folder,{recursive:true,force:true});}
},10000);

it('fails on oversized process output and result artifacts without claiming success',async()=>{
  const folder=mkdtempSync(join(tmpdir(),'flowlens-m6-limit-')),db=openDatabase(join(folder,'test.sqlite'));
  try{
    migrate(db);
    for(const [name,runnerName,expected] of [
      ['log','oversize-log-runner.mjs','LOCAL_OUTPUT_LIMIT'],
      ['total','oversize-total-runner.mjs','LOCAL_OUTPUT_LIMIT'],
      ['artifact','oversize-artifact-runner.mjs','LOCAL_ARTIFACT_LIMIT'],
      ['missing','missing-result-runner.mjs','LOCAL_RUNNER_ERROR']
    ]){
      const service=new LocalExecutionService(db,join(folder,'projects'),{runnerPath:fileURLToPath(new URL('./fixtures/'+runnerName,import.meta.url)),timeoutMs:2000});
      const project=service.createProject('sql-valid-control','project-'+name);
      const result=await service.waitFor(service.startExecution(project.id,'run-'+name).id);
      expect(result.status).toBe('FAILED');expect(result.error_code).toBe(expected);
    }
  }finally{db.close();rmSync(folder,{recursive:true,force:true});}
},10000);

it('rejects a project junction escaping the experiment root before writing execution files',()=>{
  const folder=mkdtempSync(join(tmpdir(),'flowlens-m6-link-')),db=openDatabase(join(folder,'test.sqlite'));
  let link:string|undefined;
  try{
    migrate(db);const service=new LocalExecutionService(db,join(folder,'projects'));
    const project=service.createProject('sql-valid-control','create');
    const outside=join(folder,'outside');mkdirSync(outside);writeFileSync(join(outside,'marker'),'unchanged');
    link=join(folder,'projects',project.id);rmdirSync(link);symlinkSync(outside,link,'junction');
    expect(()=>service.startExecution(project.id,'run')).toThrow('LOCAL_PATH_REJECTED');
    expect(readFileSync(join(outside,'marker'),'utf8')).toBe('unchanged');
    expect((service.listExecutions(project.id,1,20).data)).toHaveLength(0);
  }finally{if(link&&existsSync(link))rmdirSync(link);db.close();rmSync(folder,{recursive:true,force:true});}
});

it('persists a failed execution when the trusted runner cannot start',async()=>{
  const folder=mkdtempSync(join(tmpdir(),'flowlens-m6-start-fail-')),db=openDatabase(join(folder,'test.sqlite'));
  try{
    migrate(db);const service=new LocalExecutionService(db,join(folder,'projects'),{runnerPath:join(folder,'missing-runner.mjs')});
    const project=service.createProject('sql-valid-control','create');
    const execution=await service.waitFor(service.startExecution(project.id,'run').id);
    expect(execution.status).toBe('FAILED');expect(execution.error_code).toBe('LOCAL_RUNNER_ERROR');
    expect(service.logs(execution.id,0,200).length).toBeGreaterThan(0);
  }finally{db.close();rmSync(folder,{recursive:true,force:true});}
});

it('stops a child after abnormal parent exit and marks the persisted run interrupted on restart',async()=>{
  const folder=mkdtempSync(join(tmpdir(),'flowlens-m6-crash-'));
  const fixture=fileURLToPath(new URL('./fixtures/lifecycle-parent.mjs',import.meta.url));
  const parent=spawn(process.execPath,['--import','tsx',fixture,folder],{cwd:fileURLToPath(new URL('../',import.meta.url)),windowsHide:true,stdio:['ignore','pipe','pipe']});
  let stderr='';parent.stderr.on('data',(chunk:Buffer)=>{stderr+=chunk.toString();});
  let db:ReturnType<typeof openDatabase>|undefined;
  try{
    const line=await new Promise<string>((resolve,reject)=>{
      let buffer='';const timeout=setTimeout(()=>reject(new Error('parent start timeout: '+stderr)),5000);
      parent.stdout.on('data',(chunk:Buffer)=>{buffer+=chunk.toString();if(buffer.includes('\n')){clearTimeout(timeout);resolve(buffer.split('\n')[0]!);}});
      parent.on('exit',code=>{clearTimeout(timeout);reject(new Error('parent exited early: '+code+' '+stderr));});
    });
    const info=JSON.parse(line) as {executionId:string;childPid:number};
    const exit=once(parent,'close');parent.kill('SIGKILL');await exit;
    await vi.waitFor(()=>expect(()=>process.kill(info.childPid,0)).toThrow(),{timeout:5000});
    db=openDatabase(join(folder,'test.sqlite'));
    const service=new LocalExecutionService(db,join(folder,'projects'));service.recoverInterrupted();
    expect(service.getExecution(info.executionId)).toMatchObject({status:'INTERRUPTED',error_code:'LOCAL_EXECUTION_INTERRUPTED'});
    expect(service.logs(info.executionId,0,200).length).toBeGreaterThan(0);
    expect(service.artifacts(info.executionId).length).toBe(2);
  }finally{if(parent.exitCode===null)parent.kill('SIGKILL');db?.close();rmSync(folder,{recursive:true,force:true});}
},15000);
