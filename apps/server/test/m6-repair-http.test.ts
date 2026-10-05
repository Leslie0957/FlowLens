import {expect,it} from 'vitest';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import request from 'supertest';
import {openDatabase,migrate,seed} from '../src/db.js';
import {createApp} from '../src/http.js';
import {LocalExecutionService} from '../src/local-execution.js';
import {LocalRepairService} from '../src/local-repair.js';

it('exposes isolated repair approval HTTP without accepting client patch, shell, or old fixture approval',async()=>{
  const folder=mkdtempSync(join(tmpdir(),'flowlens-repair-http-')),db=openDatabase(join(folder,'db.sqlite'));
  try{
    migrate(db);seed(db);
    const local=new LocalExecutionService(db,join(folder,'projects'));
    const repair=new LocalRepairService(db,local);
    const api=request(createApp(db,()=>{},local,repair));
    const project=local.createProject('sql-column-error','create');
    const failed=await local.waitFor(local.startExecution(project.id,'run').id);
    expect((await api.post(`/api/v1/local-executions/${failed.id}/repairs`).set('Idempotency-Key','bad').send({command:'echo x'})).status).toBe(400);
    const created=await api.post(`/api/v1/local-executions/${failed.id}/repairs`).set('Idempotency-Key','repair').send({});
    expect(created.status).toBe(202);
    const id=created.body.data.id as string;
    await repair.waitFor(id);
    const pending=await api.get(`/api/v1/local-repairs/${id}`);
    expect(pending.body.data.status).toBe('PENDING_APPROVAL');
    expect(pending.body.data.candidate.file_path).toBe('task.sql');
    expect(pending.body.data.provider_mode).toBe('MOCK');
    expect((await api.get(`/api/v1/local-executions/${failed.id}/repairs`)).body.data[0].id).toBe(id);
    expect((await api.post(`/api/v1/runs/${project.id}/retry-proposals`).set('Idempotency-Key','wrong').send({turn_id:id,reason:'repair'})).status).toBeGreaterThanOrEqual(400);
    expect((await api.post(`/api/v1/local-repairs/${id}/approve`).set('Idempotency-Key','bad-approve').send({sql:'SELECT 1'})).status).toBe(400);
    const approved=await api.post(`/api/v1/local-repairs/${id}/approve`).set('Idempotency-Key','approve').send({});
    expect(approved.status).toBe(200);
    const verificationId=approved.body.data.verification_execution_id as string;
    expect(verificationId).toBeTruthy();
    expect((await api.post(`/api/v1/local-repairs/${id}/approve`).set('Idempotency-Key','approve').send({})).body.data.verification_execution_id).toBe(verificationId);
    expect((await local.waitFor(verificationId)).status).toBe('SUCCEEDED');
    expect(local.getExecution(failed.id).status).toBe('FAILED');
  }finally{db.close();rmSync(folder,{recursive:true,force:true});}
});
