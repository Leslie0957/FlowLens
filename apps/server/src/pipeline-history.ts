import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { DatabaseSync } from 'node:sqlite';
import type { PipelineRow } from '@flowlens/contracts';
import { transaction } from './db.js';
import {
  at,
  canonical,
  digestRows,
  rowKey,
  sha,
  state,
  targetRows,
  businessSchema,
} from './pipeline-data.js';
import { LocalError } from './local-execution.js';

type Baseline = {
  id: string;
  schema_version: number;
  row_count: number;
  hash: string;
  rows_json: string;
  data_version: number;
};
export type HistoryState = { baseline_id: string; last_seq: number; chain_hash: string };
type Event = {
  seq: number;
  baseline_id: string;
  batch_id: string;
  operation_id: string | null;
  type: 'INSERT' | 'UNDO_INSERT';
  row_key: string;
  row_json: string;
  previous_hash: string;
  event_hash: string;
};

// Only trusted writable connections migrate a project's independent target DB.
export function migrateTarget(db: DatabaseSync) {
  const version = Number(db.prepare('PRAGMA user_version').get()?.user_version);
  if (version > 2) throw new LocalError('TARGET_SCHEMA_TOO_NEW', 409);
  if (version === 2) return;
  transaction(db, () => {
    const lockedVersion = Number(db.prepare('PRAGMA user_version').get()?.user_version);
    if (lockedVersion === 2) return;
    if (lockedVersion > 2) throw new LocalError('TARGET_SCHEMA_TOO_NEW', 409);
    db.exec(`
      CREATE TABLE history_baselines(id TEXT PRIMARY KEY,schema_version INTEGER NOT NULL,row_count INTEGER NOT NULL,hash TEXT NOT NULL,rows_json TEXT NOT NULL,data_version INTEGER NOT NULL,created_at TEXT NOT NULL);
      CREATE TABLE history_state(id INTEGER PRIMARY KEY CHECK(id=1),baseline_id TEXT NOT NULL,last_seq INTEGER NOT NULL,chain_hash TEXT NOT NULL);
      CREATE TABLE change_events(seq INTEGER PRIMARY KEY,baseline_id TEXT NOT NULL,batch_id TEXT NOT NULL,operation_id TEXT,type TEXT NOT NULL CHECK(type IN ('INSERT','UNDO_INSERT')),row_key TEXT NOT NULL,row_json TEXT NOT NULL,previous_hash TEXT NOT NULL,event_hash TEXT NOT NULL);
      CREATE INDEX change_events_batch ON change_events(batch_id,type,seq);
      CREATE TABLE snapshot_metadata(id TEXT PRIMARY KEY,schema_version INTEGER NOT NULL,baseline_id TEXT NOT NULL,before_seq INTEGER NOT NULL,chain_hash TEXT NOT NULL,row_count INTEGER NOT NULL,hash TEXT NOT NULL,data_version INTEGER NOT NULL,created_at TEXT NOT NULL);
    `);
    const rows = targetRows(db),
      id = randomUUID(),
      hash = digestRows(rows);
    db.prepare('INSERT INTO history_baselines VALUES(?,?,?,?,?,?,?)').run(
      id,
      1,
      rows.length,
      hash,
      JSON.stringify(rows),
      state(db).data_version,
      at(),
    );
    db.prepare('INSERT INTO history_state VALUES(1,?,?,?)').run(id, 0, hash);
    db.exec('PRAGMA user_version=2');
  });
}

export function historyState(db: DatabaseSync): HistoryState {
  const s = db
    .prepare('SELECT baseline_id,last_seq,chain_hash FROM history_state WHERE id=1')
    .get() as HistoryState | undefined;
  if (!s || !Number.isSafeInteger(s.last_seq) || s.last_seq < 0)
    throw new LocalError('HISTORY_CORRUPT', 409);
  return s;
}
export function parseHistoryRows(json: string, count: number, hash: string): PipelineRow[] {
  let rows: PipelineRow[];
  try {
    rows = canonical(z.array(businessSchema).parse(JSON.parse(json)));
  } catch {
    throw new LocalError('SNAPSHOT_CORRUPT', 409);
  }
  if (
    rows.length !== count ||
    digestRows(rows) !== hash ||
    new Set(rows.map(rowKey)).size !== rows.length
  )
    throw new LocalError('SNAPSHOT_CORRUPT', 409);
  return rows;
}
function eventDigest(event: Omit<Event, 'event_hash'>) {
  return sha(
    JSON.stringify([
      event.seq,
      event.baseline_id,
      event.batch_id,
      event.operation_id,
      event.type,
      event.row_key,
      event.row_json,
      event.previous_hash,
    ]),
  );
}

export function historyRows(
  db: DatabaseSync,
  baselineId: string,
  beforeSeq: number,
  expectedChain: string,
) {
  const baseline = db.prepare('SELECT * FROM history_baselines WHERE id=?').get(baselineId) as
    Baseline | undefined;
  if (
    !baseline ||
    baseline.schema_version !== 1 ||
    !Number.isSafeInteger(beforeSeq) ||
    beforeSeq < 0 ||
    !Number.isSafeInteger(baseline.data_version) ||
    baseline.data_version < 0
  )
    throw new LocalError('HISTORY_CORRUPT', 409);
  const head = historyState(db);
  if (head.baseline_id !== baselineId || beforeSeq > head.last_seq)
    throw new LocalError('HISTORY_CORRUPT', 409);
  const rows = new Map(
    parseHistoryRows(baseline.rows_json, baseline.row_count, baseline.hash).map((r) => [
      rowKey(r),
      r,
    ]),
  );
  const events = db
    .prepare('SELECT * FROM change_events WHERE seq<=? ORDER BY seq')
    .all(beforeSeq) as Event[];
  let seq = 0,
    chain = baseline.hash;
  for (const event of events) {
    if (
      event.seq !== ++seq ||
      event.baseline_id !== baselineId ||
      event.previous_hash !== chain ||
      eventDigest(event) !== event.event_hash
    )
      throw new LocalError('HISTORY_CORRUPT', 409);
    let row: PipelineRow;
    try {
      row = businessSchema.parse(JSON.parse(event.row_json));
    } catch {
      throw new LocalError('HISTORY_CORRUPT', 409);
    }
    if (rowKey(row) !== event.row_key) throw new LocalError('HISTORY_CORRUPT', 409);
    if (event.type === 'INSERT') {
      if (rows.has(event.row_key) || event.operation_id !== null)
        throw new LocalError('HISTORY_CORRUPT', 409);
      rows.set(event.row_key, row);
    } else if (event.type === 'UNDO_INSERT') {
      const original = rows.get(event.row_key);
      if (!event.operation_id || !original || digestRows([original]) !== digestRows([row]))
        throw new LocalError('HISTORY_CORRUPT', 409);
      rows.delete(event.row_key);
    } else throw new LocalError('HISTORY_CORRUPT', 409);
    chain = event.event_hash;
  }
  if (seq !== beforeSeq || chain !== expectedChain) throw new LocalError('HISTORY_CORRUPT', 409);
  return canonical([...rows.values()]);
}

export function assertHistoryHead(db: DatabaseSync, current: PipelineRow[]) {
  const h = historyState(db);
  const max = Number(db.prepare('SELECT coalesce(max(seq),0) n FROM change_events').get()?.n);
  if (
    max !== h.last_seq ||
    digestRows(historyRows(db, h.baseline_id, h.last_seq, h.chain_hash)) !== digestRows(current)
  )
    throw new LocalError('HISTORY_CORRUPT', 409);
  return h;
}
export function appendChanges(
  db: DatabaseSync,
  batchId: string,
  operationId: string | null,
  type: Event['type'],
  rows: PipelineRow[],
) {
  const h = historyState(db);
  const insert = db.prepare('INSERT INTO change_events VALUES(?,?,?,?,?,?,?,?,?)');
  for (const row of canonical(rows)) {
    const event: Omit<Event, 'event_hash'> = {
      seq: ++h.last_seq,
      baseline_id: h.baseline_id,
      batch_id: batchId,
      operation_id: operationId,
      type,
      row_key: rowKey(row),
      row_json: JSON.stringify(row),
      previous_hash: h.chain_hash,
    };
    h.chain_hash = eventDigest(event);
    insert.run(
      event.seq,
      event.baseline_id,
      event.batch_id,
      event.operation_id,
      event.type,
      event.row_key,
      event.row_json,
      event.previous_hash,
      h.chain_hash,
    );
  }
  db.prepare('UPDATE history_state SET last_seq=?,chain_hash=? WHERE id=1').run(
    h.last_seq,
    h.chain_hash,
  );
}
export function insertedRows(db: DatabaseSync, batchId: string): PipelineRow[] {
  const events = db
    .prepare("SELECT row_json FROM change_events WHERE batch_id=? AND type='INSERT' ORDER BY seq")
    .all(batchId);
  try {
    return canonical(events.map((e) => JSON.parse(String(e.row_json))));
  } catch {
    throw new LocalError('BATCH_DELTA_CORRUPT', 409);
  }
}
