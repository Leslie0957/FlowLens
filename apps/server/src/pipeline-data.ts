import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { transaction } from './db.js';
import { LocalError } from './local-execution.js';
import type { PipelineRow, PipelineBatch } from '@flowlens/contracts';
import {
  migrateTarget,
  historyRows,
  parseHistoryRows,
  assertHistoryHead,
  appendChanges,
  insertedRows,
} from './pipeline-history.js';
export { migrateTarget } from './pipeline-history.js';
export const sha = (text: string) => createHash('sha256').update(text).digest('hex');
export const at = () => new Date().toISOString();
export const validSql =
  'SELECT dat, start_us AS st, end_us AS et, car_series FROM raw_vehicle_events WHERE speed_mps < 1 AND end_us - start_us >= 3000000;';
export const templates = [
  { id: 'A', name: 'A · SQL 列错误', sql: validSql.replace('speed_mps', 'speed_kph') },
  {
    id: 'B',
    name: 'B · 输出契约错误',
    sql: validSql.replace('car_series FROM', 'car_series AS vehicle_type FROM'),
  },
  { id: 'C', name: 'C · 正常与幂等重跑', sql: validSql },
];
export const contract = {
  rule: 'speed_mps < 1 且 end_us - start_us >= 3000000；仅为 Demo 规则',
  columns: ['dat', 'st', 'et', 'car_series'],
  business_key: ['task_id', 'dat', 'st', 'et'],
  writable_file: 'task.sql',
  runner: 'vehicle-select-v1',
  validator: 'vehicle-oracle-v1',
  input_version: 'synthetic-vehicles-v1',
};
export function createSource(path: string) {
  const db = new DatabaseSync(path);
  try {
    db.exec(
      'CREATE TABLE raw_vehicle_events(event_id INTEGER PRIMARY KEY,dat TEXT NOT NULL,start_us INTEGER NOT NULL,end_us INTEGER NOT NULL,speed_mps REAL NOT NULL,car_series TEXT NOT NULL)',
    );
    const insert = db.prepare('INSERT INTO raw_vehicle_events VALUES (?,?,?,?,?,?)');
    transaction(db, () => {
      const samples = [
        [0.2, 4000000],
        [0.8, 3000000],
        [1, 6000000],
        [8, 5000000],
        [0.1, 2999999],
        [0, 7000000],
        [0.9, 1000000],
        [0.99, 3000001],
        [2, 8000000],
        [0.4, 0],
      ];
      samples.forEach(([speed, duration], i) => {
        const start = 1700000000000000 + i * 10000000;
        insert.run(
          i + 1,
          'synthetic_segment_' + String(i + 1).padStart(2, '0'),
          start,
          start + duration!,
          speed!,
          'DEMO_' + (i % 2 === 0 ? 'ALPHA' : 'BETA'),
        );
      });
    });
  } finally {
    db.close();
  }
}
export function readSource(path: string) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return {
      rows: db
        .prepare(
          'SELECT event_id,dat,start_us,end_us,speed_mps,car_series FROM raw_vehicle_events ORDER BY event_id',
        )
        .all() as PipelineRow[],
      schema: db
        .prepare('PRAGMA table_info(raw_vehicle_events)')
        .all()
        .map((r) => ({ name: String(r.name), type: String(r.type) })),
    };
  } finally {
    db.close();
  }
}
export const businessSchema = z.strictObject({
  task_id: z.string().min(1),
  dat: z.string().min(1),
  st: z.number().int().safe(),
  et: z.number().int().safe(),
  car_series: z.string().min(1),
  execution_id: z.uuid(),
});
export const rowKey = (r: PipelineRow) => JSON.stringify([r.task_id, r.dat, r.st, r.et]);
export function canonical(rows: PipelineRow[]) {
  return rows
    .map((r) =>
      businessSchema.parse({
        task_id: r.task_id,
        dat: r.dat,
        st: r.st,
        et: r.et,
        car_series: r.car_series,
        execution_id: r.execution_id,
      }),
    )
    .sort((a, b) => rowKey(a).localeCompare(rowKey(b)));
}
export const digestRows = (rows: PipelineRow[]) => sha(JSON.stringify(canonical(rows)));
export function oracle(source: PipelineRow[], rows: PipelineRow[], columns: string[]) {
  const expected = source
    .filter((r) => Number(r.speed_mps) < 1 && Number(r.end_us) - Number(r.start_us) >= 3000000)
    .map((r) => ({ dat: r.dat!, st: r.start_us!, et: r.end_us!, car_series: r.car_series! }));
  const required = ['dat', 'st', 'et', 'car_series'];
  const shape =
    columns.length === 4 &&
    required.every((c) => columns.includes(c)) &&
    rows.every(
      (r) =>
        typeof r.dat === 'string' &&
        r.dat.length > 0 &&
        typeof r.car_series === 'string' &&
        r.car_series.length > 0 &&
        Number.isSafeInteger(r.st) &&
        Number.isSafeInteger(r.et) &&
        Number(r.st) <= Number(r.et),
    );
  const order = (data: PipelineRow[]) =>
    data.map((r) => JSON.stringify(required.map((c) => r[c]))).sort();
  const passed = shape && JSON.stringify(order(rows)) === JSON.stringify(order(expected));
  return {
    passed,
    expected_count: expected.length,
    actual_count: rows.length,
    message: !shape
      ? '输出契约要求 dat/st/et/car_series、非空正确类型及 st <= et'
      : passed
        ? '独立源数据规则、完整键集合与字段值一致'
        : 'SQL 可运行，但输出与独立业务规则不一致（含重复/漏行/错误字段值）',
  };
}
export function createTarget(path: string) {
  const db = new DatabaseSync(path);
  try {
    db.exec(`PRAGMA journal_mode=WAL;
  CREATE TABLE mining_results(task_id TEXT NOT NULL,dat TEXT NOT NULL,st INTEGER NOT NULL,et INTEGER NOT NULL,car_series TEXT NOT NULL,execution_id TEXT NOT NULL,UNIQUE(task_id,dat,st,et),CHECK(st<=et));
  CREATE TABLE data_state(id INTEGER PRIMARY KEY CHECK(id=1),data_version INTEGER NOT NULL,head_batch_id TEXT);
  INSERT INTO data_state VALUES(1,0,NULL);
  CREATE TABLE snapshots(id TEXT PRIMARY KEY,schema_version INTEGER NOT NULL,row_count INTEGER NOT NULL,hash TEXT NOT NULL,rows_json TEXT NOT NULL,created_at TEXT NOT NULL);
  CREATE TABLE batches(id TEXT PRIMARY KEY,execution_id TEXT NOT NULL UNIQUE,request_key TEXT NOT NULL UNIQUE,binding_hash TEXT NOT NULL,json TEXT NOT NULL);
  CREATE TABLE restores(id TEXT PRIMARY KEY,batch_id TEXT NOT NULL UNIQUE,request_key TEXT NOT NULL UNIQUE,json TEXT NOT NULL);`);
    migrateTarget(db);
  } finally {
    db.close();
  }
}
export function targetRows(db: DatabaseSync) {
  return canonical(
    db
      .prepare('SELECT task_id,dat,st,et,car_series,execution_id FROM mining_results')
      .all() as PipelineRow[],
  );
}
export function state(db: DatabaseSync) {
  return db.prepare('SELECT data_version,head_batch_id FROM data_state WHERE id=1').get() as {
    data_version: number;
    head_batch_id: string | null;
  };
}
function checkTargetSchema(db: DatabaseSync) {
  const actual = db
    .prepare('PRAGMA table_info(mining_results)')
    .all()
    .map((r) => [r.name, r.type, r.notnull]);
  if (
    JSON.stringify(actual) !==
    JSON.stringify([
      ['task_id', 'TEXT', 1],
      ['dat', 'TEXT', 1],
      ['st', 'INTEGER', 1],
      ['et', 'INTEGER', 1],
      ['car_series', 'TEXT', 1],
      ['execution_id', 'TEXT', 1],
    ])
  )
    throw new LocalError('TARGET_SCHEMA_CHANGED', 409);
}
export function preview(db: DatabaseSync, projectId: string, rows: PipelineRow[]) {
  const existing = new Map(targetRows(db).map((r) => [rowKey(r), r]));
  let inserted = 0,
    skipped = 0,
    conflicts = 0;
  for (const row of rows) {
    const previous = existing.get(rowKey({ ...row, task_id: projectId }));
    if (!previous) inserted++;
    else if (previous.car_series === row.car_series) skipped++;
    else conflicts++;
  }
  return { inserted, skipped, conflicts };
}
export function listBatches(db: DatabaseSync): PipelineBatch[] {
  const head = state(db).head_batch_id;
  return (
    db.prepare('SELECT json FROM batches ORDER BY rowid DESC LIMIT 100').all() as { json: string }[]
  ).map((r) => {
    const b = JSON.parse(r.json) as PipelineBatch;
    return {
      ...b,
      snapshot_storage: b.snapshot_storage ?? 'FULL',
      can_restore: b.id === head && b.status === 'COMMITTED' && b.inserted > 0,
    };
  });
}
export function snapshotRows(db: DatabaseSync, batchId: string) {
  checkTargetSchema(db);
  const b = db.prepare('SELECT json FROM batches WHERE id=?').get(batchId) as
    { json: string } | undefined;
  if (!b) throw new LocalError('BATCH_NOT_FOUND', 404);
  const batch = JSON.parse(b.json) as PipelineBatch;
  let rows: PipelineRow[], snapshot: { row_count: number; hash: string };
  if ((batch.snapshot_storage ?? 'FULL') === 'INCREMENTAL') {
    const metadata = db
      .prepare('SELECT * FROM snapshot_metadata WHERE id=?')
      .get(batch.snapshot_id) as
      | {
          schema_version: number;
          baseline_id: string;
          before_seq: number;
          chain_hash: string;
          row_count: number;
          hash: string;
          data_version: number;
        }
      | undefined;
    if (!metadata || metadata.schema_version !== 2)
      throw new LocalError('SNAPSHOT_SCHEMA_INVALID', 409);
    if (metadata.data_version !== batch.before_data_version)
      throw new LocalError('SNAPSHOT_CORRUPT', 409);
    rows = historyRows(db, metadata.baseline_id, metadata.before_seq, metadata.chain_hash);
    snapshot = metadata;
  } else {
    const full = db.prepare('SELECT * FROM snapshots WHERE id=?').get(batch.snapshot_id) as
      { schema_version: number; row_count: number; hash: string; rows_json: string } | undefined;
    if (!full || full.schema_version !== 1) throw new LocalError('SNAPSHOT_SCHEMA_INVALID', 409);
    rows = parseHistoryRows(full.rows_json, full.row_count, full.hash);
    snapshot = full;
  }
  if (
    rows.length !== snapshot.row_count ||
    digestRows(rows) !== snapshot.hash ||
    snapshot.hash !== batch.before_hash ||
    rows.length !== batch.before_count ||
    new Set(rows.map(rowKey)).size !== rows.length
  )
    throw new LocalError('SNAPSHOT_CORRUPT', 409);
  return { batch, rows, hash: snapshot.hash };
}
export function commitBatch(
  db: DatabaseSync,
  args: {
    projectId: string;
    executionId: string;
    revisionId: string;
    rows: PipelineRow[];
    key: string;
    binding: string;
    version: number;
    targetHash: string;
  },
) {
  const receipt = () => {
    const matches = db
      .prepare('SELECT binding_hash,json FROM batches WHERE request_key=? OR execution_id=?')
      .all(args.key, args.executionId) as { binding_hash: string; json: string }[];
    if (matches.length > 1) throw new LocalError('IDEMPOTENCY_CONFLICT', 409);
    const old = matches[0];
    if (!old) return null;
    if (
      old.binding_hash !== args.binding ||
      (JSON.parse(old.json) as PipelineBatch).execution_id !== args.executionId
    )
      throw new LocalError('IDEMPOTENCY_CONFLICT', 409);
    return JSON.parse(old.json) as PipelineBatch;
  };
  const old = receipt();
  if (old) return old;
  return transaction(db, () => {
    // Recheck after acquiring the write lock for concurrent process retries.
    const committed = receipt();
    if (committed) return committed;
    checkTargetSchema(db);
    const before = targetRows(db),
      s = state(db);
    if (s.data_version !== args.version || digestRows(before) !== args.targetHash)
      throw new LocalError('PRECHECK_TARGET_CHANGED', 409);
    const history = assertHistoryHead(db, before);
    const p = preview(db, args.projectId, args.rows);
    if (p.conflicts) throw new LocalError('BUSINESS_KEY_CONFLICT', 409);
    const id = randomUUID(),
      snapshotId = randomUUID(),
      created = at();
    db.prepare('INSERT INTO snapshot_metadata VALUES(?,?,?,?,?,?,?,?,?)').run(
      snapshotId,
      2,
      history.baseline_id,
      history.last_seq,
      history.chain_hash,
      before.length,
      digestRows(before),
      s.data_version,
      created,
    );
    const added: PipelineRow[] = [];
    const insert = db.prepare('INSERT INTO mining_results VALUES (?,?,?,?,?,?)'),
      keys = new Set(before.map(rowKey));
    for (const row of args.rows) {
      const value = businessSchema.parse({
        ...row,
        task_id: args.projectId,
        execution_id: args.executionId,
      });
      if (!keys.has(rowKey(value))) {
        insert.run(
          value.task_id,
          value.dat,
          value.st,
          value.et,
          value.car_series,
          value.execution_id,
        );
        keys.add(rowKey(value));
        added.push(value);
      }
    }
    const after = targetRows(db),
      version = s.data_version + (added.length > 0 ? 1 : 0);
    if (added.length !== p.inserted || after.length !== before.length + added.length)
      throw new LocalError('COMMIT_VALIDATION_FAILED', 409);
    appendChanges(db, id, null, 'INSERT', added);
    const batch: PipelineBatch = {
      id,
      execution_id: args.executionId,
      revision_id: args.revisionId,
      status: 'COMMITTED',
      created_at: created,
      snapshot_id: snapshotId,
      snapshot_storage: 'INCREMENTAL',
      before_data_version: s.data_version,
      inserted_hash: digestRows(added),
      before_hash: digestRows(before),
      after_hash: digestRows(after),
      before_count: before.length,
      after_count: after.length,
      inserted: added.length,
      skipped: p.skipped,
      previous_head: s.head_batch_id,
      data_version: version,
      restored_at: null,
      restore_id: null,
      can_restore: p.inserted > 0,
    };
    db.prepare('INSERT INTO batches VALUES (?,?,?,?,?)').run(
      id,
      args.executionId,
      args.key,
      args.binding,
      JSON.stringify(batch),
    );
    db.prepare('UPDATE data_state SET data_version=?,head_batch_id=? WHERE id=1').run(
      version,
      p.inserted > 0 ? id : s.head_batch_id,
    );
    return batch;
  });
}
export function restoreBatch(db: DatabaseSync, batchId: string, key: string) {
  const receipt = () => {
    const matches = db
      .prepare('SELECT batch_id,json FROM restores WHERE request_key=? OR batch_id=?')
      .all(key, batchId) as { batch_id: string; json: string }[];
    if (matches.length > 1) throw new LocalError('IDEMPOTENCY_CONFLICT', 409);
    const old = matches[0];
    if (!old) return null;
    if (old.batch_id !== batchId) throw new LocalError('IDEMPOTENCY_CONFLICT', 409);
    return JSON.parse(old.json) as {
      id: string;
      batch_id: string;
      data_version: number;
      hash: string;
      created_at: string;
    };
  };
  const old = receipt();
  if (old) return old;
  return transaction(db, () => {
    const receiptResult = receipt();
    if (receiptResult) return receiptResult;
    const { batch, rows, hash } = snapshotRows(db, batchId),
      s = state(db);
    if (batch.inserted === 0) throw new LocalError('BATCH_NO_CHANGE', 409);
    if (batch.status !== 'COMMITTED' || s.head_batch_id !== batch.id)
      throw new LocalError('BATCH_NOT_CURRENT_HEAD', 409);
    const current = targetRows(db);
    if (digestRows(current) !== batch.after_hash || current.length !== batch.after_count)
      throw new LocalError('TARGET_DATA_DRIFT', 409);
    assertHistoryHead(db, current);
    const previous = new Map(rows.map((row) => [rowKey(row), row]));
    const added = current.filter((row) => !previous.has(rowKey(row)));
    if (
      added.length !== batch.inserted ||
      added.some((row) => row.execution_id !== batch.execution_id) ||
      digestRows(current.filter((row) => previous.has(rowKey(row)))) !== digestRows(rows)
    )
      throw new LocalError('BATCH_DELTA_CORRUPT', 409);
    if (batch.snapshot_storage === 'INCREMENTAL') {
      const recorded = insertedRows(db, batch.id);
      if (
        recorded.length !== batch.inserted ||
        digestRows(recorded) !== batch.inserted_hash ||
        digestRows(added) !== batch.inserted_hash
      )
        throw new LocalError('BATCH_DELTA_CORRUPT', 409);
    }
    const remove = db.prepare(
      'DELETE FROM mining_results WHERE task_id=? AND dat=? AND st=? AND et=? AND execution_id=? AND car_series=?',
    );
    for (const row of added) {
      const removed = remove.run(
        row.task_id!,
        row.dat!,
        row.st!,
        row.et!,
        row.execution_id!,
        row.car_series!,
      );
      if (Number(removed.changes) !== 1) throw new LocalError('RESTORE_VALIDATION_FAILED', 409);
    }
    const restored = targetRows(db);
    if (restored.length !== batch.before_count || digestRows(restored) !== hash)
      throw new LocalError('RESTORE_VALIDATION_FAILED', 409);
    const result = {
      id: randomUUID(),
      batch_id: batch.id,
      data_version: s.data_version + 1,
      hash,
      created_at: at(),
    };
    appendChanges(db, batch.id, result.id, 'UNDO_INSERT', added);
    batch.status = 'RESTORED';
    batch.restored_at = result.created_at;
    batch.restore_id = result.id;
    batch.can_restore = false;
    db.prepare('UPDATE batches SET json=? WHERE id=?').run(JSON.stringify(batch), batch.id);
    db.prepare('UPDATE data_state SET data_version=?,head_batch_id=? WHERE id=1').run(
      result.data_version,
      batch.previous_head,
    );
    db.prepare('INSERT INTO restores VALUES (?,?,?,?)').run(
      result.id,
      batch.id,
      key,
      JSON.stringify(result),
    );
    return result;
  });
}
