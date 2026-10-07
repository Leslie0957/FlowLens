import {expect,it} from 'vitest';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import request from 'supertest';
import {openDatabase,migrate,seed} from '../src/db.js';
import {createApp} from '../src/http.js';
import {LocalExecutionService} from '../src/local-execution.js';
import {LocalRepairService} from '../src/local-repair.js';

it('upgrades early v6 repair records missing verification command and keeps diagnosis usable',async()=>{
  const folder=mkdtempSync(join(tmpdir(),'flowlens-migration-v6-'));
  const db=openDatabase(join(folder,'db.sqlite'));
  try{
    migrate(db);seed(db);
    const local=new LocalExecutionService(db,join(folder,'projects'));
    const repair=new LocalRepairService(db,local);
    const api=request(createApp(db,()=>{},local,repair));
    const project=local.createProject('sql-column-error','migration-project');
    const failed=await local.waitFor(local.startExecution(project.id,'migration-run').id);
    expect(failed.status).toBe('FAILED');
    const previous=repair.create(failed.id,'previous-repair','MOCK','mock');
    await repair.waitFor(previous.id);
    const oldStatus=repair.get(previous.id).status;
    const oldLogs=db.prepare('SELECT * FROM local_execution_log WHERE execution_id=? ORDER BY seq').all(failed.id);

    db.exec('DROP TABLE pipeline_entity; DROP TABLE pipeline_event; DROP TABLE local_repair_loop_round; DROP TABLE local_repair_loop; ALTER TABLE local_repair_session DROP COLUMN verification_command_id; PRAGMA user_version=6');
    expect(db.prepare('PRAGMA table_info(local_repair_session)').all()).not.toContainEqual(expect.objectContaining({name:'verification_command_id'}));

    migrate(db);migrate(db);
    expect(db.prepare('PRAGMA user_version').get()).toMatchObject({user_version:10});
    expect(db.prepare('SELECT verification_command_id FROM local_repair_session WHERE id=?').get(previous.id)).toMatchObject({verification_command_id:'orders-sql-v1'});
    expect(repair.get(previous.id).status).toBe(oldStatus);
    expect(db.prepare('SELECT * FROM local_execution_log WHERE execution_id=? ORDER BY seq').all(failed.id)).toEqual(oldLogs);
    expect((await api.get(`/api/v1/local-executions/${failed.id}/repairs`)).status).toBe(200);
    const created=await api.post(`/api/v1/local-executions/${failed.id}/repairs`).set('Idempotency-Key','new-repair').send({});
    expect(created.status).toBe(202);
    expect(created.body.data.verification_command_id).toBe('orders-sql-v1');
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  }finally{db.close();rmSync(folder,{recursive:true,force:true});}
});

it('upgrades an existing v7 repair database to v8 without changing its saved candidate',async()=>{
  const db=openDatabase(':memory:');
  try{
    migrate(db);seed(db);
    db.exec('DROP TABLE pipeline_entity; DROP TABLE pipeline_event; DROP TABLE local_repair_loop_round; DROP TABLE local_repair_loop; PRAGMA user_version=7');
    db.prepare('INSERT INTO local_project VALUES (?,?,?,?,?,?)').run('project','sql-column-error','old','SYNTHETIC','revision','2026-10-05T00:00:00Z');
    db.prepare('INSERT INTO local_revision VALUES (?,?,?,?,?,?,?,?)').run('revision','project',null,'SELECT 1','[]','oldhash','TEMPLATE','2026-10-05T00:00:00Z');
    db.prepare('INSERT INTO local_execution VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run('execution','project','revision','oldhash','FAILED','2026-10-05T00:00:00Z',null,null,1,null,'SQL_COLUMN_ERROR','old error',null,'v1','v1','old-directory');
    db.prepare('INSERT INTO local_repair_session (id,project_id,execution_id,base_revision_id,base_hash,status,provider_mode,model,diagnosis,candidate_sql,candidate_hash,diff_text,evidence_ids_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run('repair','project','execution','revision','oldhash','PENDING_APPROVAL','LIVE','deepseek','old diagnosis','SELECT 2','candidatehash','old diff','[]','2026-10-05T00:00:00Z','2026-10-05T00:00:00Z');
    migrate(db);migrate(db);
    expect(db.prepare('PRAGMA user_version').get()).toMatchObject({user_version:10});
    expect(db.prepare('SELECT diagnosis,candidate_sql,verification_command_id FROM local_repair_session WHERE id=?').get('repair')).toMatchObject({diagnosis:'old diagnosis',candidate_sql:'SELECT 2',verification_command_id:'orders-sql-v1'});
    expect(db.prepare('SELECT count(*) n FROM local_repair_loop').get()).toMatchObject({n:0});
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  }finally{db.close();}
});

it('upgrades an existing v8 loop without erasing its authorization or round history',async()=>{
  const db=openDatabase(':memory:');
  try{
    migrate(db);
    db.exec('DROP TABLE pipeline_entity; DROP TABLE pipeline_event; ALTER TABLE local_repair_loop DROP COLUMN cancel_requested_at; PRAGMA user_version=8');
    db.prepare('INSERT INTO local_project VALUES (?,?,?,?,?,?)').run('project','sql-column-error','old','SYNTHETIC','revision','2026-10-05T00:00:00Z');
    db.prepare('INSERT INTO local_revision VALUES (?,?,?,?,?,?,?,?)').run('revision','project',null,'SELECT 1','[]','oldhash','TEMPLATE','2026-10-05T00:00:00Z');
    db.prepare('INSERT INTO local_execution VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run('execution','project','revision','oldhash','FAILED','2026-10-05T00:00:00Z',null,null,1,null,'SQL_COLUMN_ERROR','old error',null,'v1','v1','old-directory');
    db.prepare('INSERT INTO local_repair_loop VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run('loop','project','execution','ACTIVE','MOCK','test',3,36,'task.sql','orders-sql-v1','2026-10-05T00:10:00Z','execution',null,'2026-10-05T00:00:00Z','2026-10-05T00:00:00Z',null);
    migrate(db);migrate(db);
    expect(db.prepare('PRAGMA user_version').get()).toMatchObject({user_version:10});
    expect(db.prepare('SELECT id,status,max_rounds,max_model_requests,cancel_requested_at FROM local_repair_loop WHERE id=?').get('loop')).toMatchObject({id:'loop',status:'ACTIVE',max_rounds:3,max_model_requests:36,cancel_requested_at:null});
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  }finally{db.close();}
});
