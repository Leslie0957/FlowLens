import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { loadFixture, SCENARIOS } from './fixtures.js';

export function openDatabase(path:string):DatabaseSync {
  if(path!==':memory:')mkdirSync(dirname(path),{recursive:true});
  const db=new DatabaseSync(path,{timeout:5000});
  db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000');
  if(path!==':memory:')db.exec('PRAGMA journal_mode=WAL');
  return db;
}
function transaction<T>(db:DatabaseSync,fn:()=>T):T {
  db.exec('BEGIN IMMEDIATE');
  try {const value=fn();db.exec('COMMIT');return value;}
  catch(error){db.exec('ROLLBACK');throw error;}
}
export {transaction};
export function migrate(db:DatabaseSync):void {
  const version=(db.prepare('PRAGMA user_version').get() as {user_version:number}).user_version;
  if(version>9)throw new Error('DB_SCHEMA_TOO_NEW');
  if(version<1)transaction(db,()=>{
    db.exec(`
      CREATE TABLE task_definition(id TEXT PRIMARY KEY,name TEXT NOT NULL,description TEXT NOT NULL,schema_version INTEGER NOT NULL,steps_json TEXT NOT NULL,created_at TEXT NOT NULL);
      CREATE TABLE task_run(
        id TEXT PRIMARY KEY,task_id TEXT NOT NULL REFERENCES task_definition(id),data_source TEXT NOT NULL CHECK(data_source='FIXTURE'),
        scenario_id TEXT NOT NULL,scenario_instance_id TEXT NOT NULL,parent_run_id TEXT REFERENCES task_run(id),
        status TEXT NOT NULL CHECK(status IN ('PENDING','RUNNING','SUCCEEDED','FAILED')),
        step_states_json TEXT NOT NULL,params_json TEXT NOT NULL,created_at TEXT NOT NULL,started_at TEXT,finished_at TEXT,
        error_code TEXT,error_message TEXT,summary_json TEXT
      );
      CREATE INDEX idx_task_run_created ON task_run(created_at DESC,id DESC);
      CREATE TABLE task_log(id TEXT PRIMARY KEY,run_id TEXT NOT NULL REFERENCES task_run(id),seq INTEGER NOT NULL,timestamp TEXT NOT NULL,
        level TEXT NOT NULL,step TEXT NOT NULL,message TEXT NOT NULL,UNIQUE(run_id,seq));
      CREATE INDEX idx_task_log_run_seq ON task_log(run_id,seq);
      PRAGMA user_version=1;
    `);
  });
  if(version<2)transaction(db,()=>{
    db.exec(`
      CREATE TABLE simulation_state(run_id TEXT PRIMARY KEY REFERENCES task_run(id),fixture_version TEXT NOT NULL,
        timeline_variant TEXT NOT NULL CHECK(timeline_variant IN ('initial','retry')),next_event_index INTEGER NOT NULL,
        elapsed_ms INTEGER NOT NULL,updated_at TEXT NOT NULL);
      CREATE TABLE request_dedup(scope TEXT NOT NULL,idempotency_key TEXT NOT NULL,request_hash TEXT NOT NULL,
        response_json TEXT NOT NULL,created_at TEXT NOT NULL,PRIMARY KEY(scope,idempotency_key));
      PRAGMA user_version=2;
    `);
  });
  if(version<3)transaction(db,()=>{
    db.exec(`
      ALTER TABLE simulation_state RENAME TO simulation_state_v2;
      CREATE TABLE simulation_state(run_id TEXT PRIMARY KEY REFERENCES task_run(id),fixture_version TEXT NOT NULL,
        timeline_variant TEXT NOT NULL CHECK(timeline_variant IN ('initial','retry')),next_event_index INTEGER NOT NULL,
        elapsed_ms INTEGER NOT NULL,updated_at TEXT NOT NULL);
      INSERT INTO simulation_state SELECT * FROM simulation_state_v2;
      DROP TABLE simulation_state_v2;
      CREATE TABLE diagnosis_session(id TEXT PRIMARY KEY,run_id TEXT NOT NULL REFERENCES task_run(id),title TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
      CREATE INDEX idx_session_run ON diagnosis_session(run_id,updated_at DESC);
      CREATE TABLE diagnosis_turn(id TEXT PRIMARY KEY,session_id TEXT NOT NULL REFERENCES diagnosis_session(id),status TEXT NOT NULL,provider_mode TEXT NOT NULL,model TEXT NOT NULL,prompt_version TEXT NOT NULL,error_code TEXT,created_at TEXT NOT NULL,started_at TEXT,finished_at TEXT);
      CREATE UNIQUE INDEX idx_one_active_turn ON diagnosis_turn(session_id) WHERE status IN ('QUEUED','RUNNING');
      CREATE TABLE message(id TEXT PRIMARY KEY,session_id TEXT NOT NULL REFERENCES diagnosis_session(id),turn_id TEXT NOT NULL REFERENCES diagnosis_turn(id),role TEXT NOT NULL,content TEXT NOT NULL,is_partial INTEGER NOT NULL,created_at TEXT NOT NULL);
      CREATE TABLE tool_call(id TEXT PRIMARY KEY,turn_id TEXT NOT NULL REFERENCES diagnosis_turn(id),name TEXT NOT NULL,args_json TEXT NOT NULL,status TEXT NOT NULL,result_summary_json TEXT,error_code TEXT,started_at TEXT NOT NULL,finished_at TEXT);
      CREATE TABLE evidence(id TEXT PRIMARY KEY,session_id TEXT NOT NULL REFERENCES diagnosis_session(id),turn_id TEXT NOT NULL REFERENCES diagnosis_turn(id),type TEXT NOT NULL,source_id TEXT NOT NULL,source_version TEXT NOT NULL,locator_json TEXT NOT NULL,excerpt TEXT NOT NULL,created_at TEXT NOT NULL);
      CREATE TABLE diagnosis_result(id TEXT PRIMARY KEY,turn_id TEXT NOT NULL UNIQUE REFERENCES diagnosis_turn(id),summary TEXT NOT NULL,findings_json TEXT NOT NULL,missing_information_json TEXT NOT NULL,next_steps_json TEXT NOT NULL,proposed_action_json TEXT,created_at TEXT NOT NULL);
      CREATE TABLE agent_event(id TEXT PRIMARY KEY,session_id TEXT NOT NULL REFERENCES diagnosis_session(id),turn_id TEXT NOT NULL REFERENCES diagnosis_turn(id),seq INTEGER NOT NULL,type TEXT NOT NULL,payload_json TEXT NOT NULL,created_at TEXT NOT NULL,UNIQUE(session_id,seq));
      CREATE TABLE approval_request(id TEXT PRIMARY KEY,run_id TEXT NOT NULL REFERENCES task_run(id),turn_id TEXT NOT NULL REFERENCES diagnosis_turn(id),status TEXT NOT NULL,action TEXT NOT NULL,args_hash TEXT NOT NULL,run_snapshot_hash TEXT NOT NULL,reason TEXT NOT NULL,expires_at TEXT NOT NULL,created_at TEXT NOT NULL,resolved_at TEXT);
      CREATE UNIQUE INDEX idx_approval_run_pending ON approval_request(run_id) WHERE status='PENDING';
      CREATE TABLE action_execution(id TEXT PRIMARY KEY,approval_id TEXT NOT NULL UNIQUE REFERENCES approval_request(id),status TEXT NOT NULL,child_run_id TEXT NOT NULL UNIQUE REFERENCES task_run(id),error TEXT,created_at TEXT NOT NULL);
      CREATE UNIQUE INDEX idx_child_parent ON task_run(parent_run_id) WHERE parent_run_id IS NOT NULL;
      PRAGMA user_version=3;
    `);
  });
  // Early v3 databases retained the initial-only v2 constraint. Never rely on
  // editing an already-applied migration to upgrade an existing installation.
  if(version<4)transaction(db,()=>{
    db.exec(`
      ALTER TABLE simulation_state RENAME TO simulation_state_before_v4;
      CREATE TABLE simulation_state(run_id TEXT PRIMARY KEY REFERENCES task_run(id),fixture_version TEXT NOT NULL,
        timeline_variant TEXT NOT NULL CHECK(timeline_variant IN ('initial','retry')),next_event_index INTEGER NOT NULL,
        elapsed_ms INTEGER NOT NULL,updated_at TEXT NOT NULL);
      INSERT INTO simulation_state SELECT run_id,fixture_version,timeline_variant,next_event_index,elapsed_ms,updated_at FROM simulation_state_before_v4;
      DROP TABLE simulation_state_before_v4;
      PRAGMA user_version=4;
    `);
  });
  if(version<5)transaction(db,()=>{
    db.exec(`
      CREATE TABLE local_project(id TEXT PRIMARY KEY,template_id TEXT NOT NULL,name TEXT NOT NULL,input_source TEXT NOT NULL CHECK(input_source='SYNTHETIC'),current_revision_id TEXT NOT NULL,created_at TEXT NOT NULL);
      CREATE TABLE local_revision(id TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES local_project(id),parent_revision_id TEXT,sql_text TEXT NOT NULL,input_json TEXT NOT NULL,sha256 TEXT NOT NULL,created_source TEXT NOT NULL,created_at TEXT NOT NULL);
      CREATE INDEX idx_local_revision_project ON local_revision(project_id,created_at);
      CREATE TABLE local_execution(id TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES local_project(id),revision_id TEXT NOT NULL REFERENCES local_revision(id),revision_hash TEXT NOT NULL,status TEXT NOT NULL CHECK(status IN ('PENDING','RUNNING','SUCCEEDED','FAILED','CANCELLED','INTERRUPTED')),created_at TEXT NOT NULL,started_at TEXT,finished_at TEXT,exit_code INTEGER,termination_reason TEXT,error_code TEXT,error_message TEXT,validation_json TEXT,runner_version TEXT NOT NULL,validator_version TEXT NOT NULL,work_dir TEXT NOT NULL);
      CREATE INDEX idx_local_execution_project ON local_execution(project_id,created_at DESC,id DESC);
      CREATE TABLE local_execution_log(id TEXT PRIMARY KEY,execution_id TEXT NOT NULL REFERENCES local_execution(id),seq INTEGER NOT NULL,timestamp TEXT NOT NULL,level TEXT NOT NULL,step TEXT NOT NULL,message TEXT NOT NULL,UNIQUE(execution_id,seq));
      CREATE TABLE local_artifact(id TEXT PRIMARY KEY,execution_id TEXT NOT NULL REFERENCES local_execution(id),name TEXT NOT NULL CHECK(name IN ('task.sql','input.json','result.json')),sha256 TEXT NOT NULL,size INTEGER NOT NULL,UNIQUE(execution_id,name));
      PRAGMA user_version=5;
    `);
  });
  if(version<6)transaction(db,()=>{
    db.exec(`
      CREATE TABLE local_repair_session(
        id TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES local_project(id),execution_id TEXT NOT NULL REFERENCES local_execution(id),
        base_revision_id TEXT NOT NULL REFERENCES local_revision(id),base_hash TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('QUEUED','RUNNING','PENDING_APPROVAL','NO_CANDIDATE','FAILED','CANCELLED','INTERRUPTED','APPROVED','REJECTED','EXPIRED','STALE','APPLY_FAILED')),
        provider_mode TEXT NOT NULL CHECK(provider_mode IN ('LIVE','MOCK')),model TEXT NOT NULL,
        diagnosis TEXT,candidate_sql TEXT,candidate_hash TEXT,diff_text TEXT,evidence_ids_json TEXT,
        verification_command_id TEXT NOT NULL DEFAULT 'orders-sql-v1',
        expires_at TEXT,approved_revision_id TEXT REFERENCES local_revision(id),verification_execution_id TEXT REFERENCES local_execution(id),
        error_code TEXT,model_requests INTEGER NOT NULL DEFAULT 0,usage_json TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL
      );
      CREATE INDEX idx_local_repair_execution ON local_repair_session(execution_id,created_at DESC);
      CREATE TABLE local_repair_tool(
        id TEXT PRIMARY KEY,session_id TEXT NOT NULL REFERENCES local_repair_session(id),seq INTEGER NOT NULL,
        name TEXT NOT NULL,args_json TEXT NOT NULL,result_json TEXT,error_code TEXT,created_at TEXT NOT NULL,UNIQUE(session_id,seq)
      );
      CREATE TABLE local_repair_evidence(
        id TEXT PRIMARY KEY,session_id TEXT NOT NULL REFERENCES local_repair_session(id),source_type TEXT NOT NULL,
        source_id TEXT NOT NULL,source_version TEXT NOT NULL,excerpt TEXT NOT NULL,created_at TEXT NOT NULL
      );
      PRAGMA user_version=6;
    `);
  });
  // Early v6 installations were created before this field was added to the
  // CREATE TABLE statement. Upgrade those databases without replacing rows.
  if(version<7)transaction(db,()=>{
    const columns=db.prepare('PRAGMA table_info(local_repair_session)').all() as {name:string}[];
    if(!columns.some(column=>column.name==='verification_command_id')){
      db.exec("ALTER TABLE local_repair_session ADD COLUMN verification_command_id TEXT NOT NULL DEFAULT 'orders-sql-v1'");
    }
    db.exec('PRAGMA user_version=7');
  });
  if(version<8)transaction(db,()=>{
    db.exec(`
      CREATE TABLE local_repair_loop(
        id TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES local_project(id),
        initial_execution_id TEXT NOT NULL REFERENCES local_execution(id),
        status TEXT NOT NULL CHECK(status IN ('ACTIVE','SUCCEEDED','FAILED','LIMIT_REACHED','TIMED_OUT','CANCELLED','INTERRUPTED')),
        provider_mode TEXT NOT NULL CHECK(provider_mode IN ('LIVE','MOCK')),model TEXT NOT NULL,
        max_rounds INTEGER NOT NULL CHECK(max_rounds=3),max_model_requests INTEGER NOT NULL CHECK(max_model_requests=36),
        writable_file TEXT NOT NULL CHECK(writable_file='task.sql'),verification_command_id TEXT NOT NULL CHECK(verification_command_id='orders-sql-v1'),
        deadline_at TEXT NOT NULL,current_execution_id TEXT NOT NULL REFERENCES local_execution(id),
        error_code TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,finished_at TEXT
      );
      CREATE UNIQUE INDEX idx_one_active_local_loop ON local_repair_loop(project_id) WHERE status='ACTIVE';
      CREATE INDEX idx_local_loop_project ON local_repair_loop(project_id,created_at DESC);
      CREATE TABLE local_repair_loop_round(
        loop_id TEXT NOT NULL REFERENCES local_repair_loop(id),round_no INTEGER NOT NULL CHECK(round_no BETWEEN 1 AND 3),
        repair_id TEXT NOT NULL UNIQUE REFERENCES local_repair_session(id),created_at TEXT NOT NULL,
        PRIMARY KEY(loop_id,round_no)
      );
      PRAGMA user_version=8;
    `);
  });
  if(version<9)transaction(db,()=>{
    db.exec("ALTER TABLE local_repair_loop ADD COLUMN cancel_requested_at TEXT; PRAGMA user_version=9;");
  });
}
const seedTime='2026-09-25T09:00:00.000Z';
export function seed(db:DatabaseSync):void {
  transaction(db,()=>{
    db.prepare('INSERT OR IGNORE INTO task_definition VALUES (?,?,?,?,?,?)').run('order_daily','订单日报','演示订单日报：读取、校验、入库和聚合。',1,JSON.stringify(['read','validate','load','aggregate']),seedTime);
    for(const id of SCENARIOS){
      const f=loadFixture(id);const runId='seed_'+id.toLowerCase();
      const final=f.timeline.at(-1)!;
      const steps:Record<string,string>={read:'PENDING',validate:'PENDING',load:'PENDING',aggregate:'PENDING'};
      for(const event of f.timeline)steps[event.step]=event.step_status;
      if(final.run_status==='FAILED')for(const key of Object.keys(steps))if(steps[key]==='PENDING')steps[key]='SKIPPED';
      const finished=new Date(Date.parse(seedTime)+final.offset_ms).toISOString();
      db.prepare(`INSERT OR IGNORE INTO task_run
        (id,task_id,data_source,scenario_id,scenario_instance_id,parent_run_id,status,step_states_json,params_json,created_at,started_at,finished_at,error_code,error_message,summary_json)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(runId,f.task_id,'FIXTURE',id,'seed_'+id.toLowerCase(),null,final.run_status!,JSON.stringify(steps),JSON.stringify(f.params),seedTime,seedTime,finished,final.error_code??null,final.error_message??null,final.summary?JSON.stringify(final.summary):null);
      let seq=0;
      for(const event of f.timeline)for(const log of event.logs){
        seq++;
        db.prepare('INSERT OR IGNORE INTO task_log VALUES (?,?,?,?,?,?,?)').run(runId+'_log_'+seq,runId,seq,new Date(Date.parse(seedTime)+event.offset_ms).toISOString(),log.level,event.step,log.message);
      }
    }
  });
}
