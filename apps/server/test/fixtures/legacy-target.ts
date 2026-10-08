import { DatabaseSync } from 'node:sqlite';
// Exact pre-maintenance target format, without incremental-history tables.
export function createLegacyTarget(path: string) {
  const db = new DatabaseSync(path);
  try {
    db.exec(`
      CREATE TABLE mining_results(task_id TEXT NOT NULL,dat TEXT NOT NULL,st INTEGER NOT NULL,et INTEGER NOT NULL,car_series TEXT NOT NULL,execution_id TEXT NOT NULL,UNIQUE(task_id,dat,st,et),CHECK(st<=et));
      CREATE TABLE data_state(id INTEGER PRIMARY KEY CHECK(id=1),data_version INTEGER NOT NULL,head_batch_id TEXT);
      INSERT INTO data_state VALUES(1,0,NULL);
      CREATE TABLE snapshots(id TEXT PRIMARY KEY,schema_version INTEGER NOT NULL,row_count INTEGER NOT NULL,hash TEXT NOT NULL,rows_json TEXT NOT NULL,created_at TEXT NOT NULL);
      CREATE TABLE batches(id TEXT PRIMARY KEY,execution_id TEXT NOT NULL UNIQUE,request_key TEXT NOT NULL UNIQUE,binding_hash TEXT NOT NULL,json TEXT NOT NULL);
      CREATE TABLE restores(id TEXT PRIMARY KEY,batch_id TEXT NOT NULL UNIQUE,request_key TEXT NOT NULL UNIQUE,json TEXT NOT NULL);
    `);
  } finally {
    db.close();
  }
}
