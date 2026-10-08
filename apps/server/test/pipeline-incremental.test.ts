import { expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  commitBatch,
  restoreBatch,
  snapshotRows,
  targetRows,
  digestRows,
  migrateTarget,
  state,
  sha,
} from '../src/pipeline-data.js';
import { createLegacyTarget } from './fixtures/legacy-target.js';
import type { PipelineBatch, PipelineRow } from '@flowlens/contracts';

function setup(count = 3) {
  const root = mkdtempSync(join(tmpdir(), 'flowlens-incremental-')),
    path = join(root, 'target.sqlite');
  createLegacyTarget(path);
  const db = new DatabaseSync(path),
    projectId = randomUUID(),
    revisionId = randomUUID(),
    executionId = randomUUID();
  db.exec('BEGIN');
  for (let i = 0; i < count; i++)
    db.prepare('INSERT INTO mining_results VALUES(?,?,?,?,?,?)').run(
      projectId,
      `old-${i}`,
      i,
      i + 1,
      `OLD-${i}`,
      executionId,
    );
  db.exec('COMMIT');
  const before = targetRows(db);
  migrateTarget(db);
  const input = (rows: PipelineRow[], key = randomUUID()) => ({
    projectId,
    revisionId,
    executionId: randomUUID(),
    rows,
    key,
    binding: sha(key),
    version: state(db).data_version,
    targetHash: digestRows(targetRows(db)),
  });
  const add = (dat: string) =>
    commitBatch(db, input([{ dat, st: 100, et: 200, car_series: 'NEW' }]));
  return {
    db,
    before,
    input,
    add,
    projectId,
    revisionId,
    path,
    close() {
      db.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

it('one baseline with 2000 old rows stores only actual inserts and constant-size snapshot metadata', () => {
  const s = setup(2000);
  try {
    const a = s.add('A'),
      b = s.add('B');
    const zero = s.add('B');
    expect(a.snapshot_storage).toBe('INCREMENTAL');
    expect(zero.inserted).toBe(0);
    expect(s.db.prepare('SELECT count(*) n FROM snapshots').get()?.n).toBe(0);
    expect(s.db.prepare('SELECT count(*) n FROM history_baselines').get()?.n).toBe(1);
    expect(s.db.prepare('SELECT count(*) n FROM change_events').get()?.n).toBe(2);
    expect(s.db.prepare('SELECT count(*) n FROM snapshot_metadata').get()?.n).toBe(3);
    expect(
      s.db
        .prepare('PRAGMA table_info(snapshot_metadata)')
        .all()
        .map((c) => c.name),
    ).not.toContain('rows_json');
    expect(snapshotRows(s.db, a.id).rows).toEqual(s.before);
    expect(snapshotRows(s.db, b.id).rows).toHaveLength(2001);
    restoreBatch(s.db, b.id, 'undoB');
    restoreBatch(s.db, a.id, 'undoA');
    expect(targetRows(s.db)).toEqual(s.before);
    expect(snapshotRows(s.db, b.id).rows).toHaveLength(2001);
    expect(snapshotRows(s.db, zero.id).rows).toHaveLength(2002);
    expect(s.db.prepare('SELECT count(*) n FROM change_events').get()?.n).toBe(4);
    expect(s.db.prepare('SELECT count(*) n FROM history_baselines').get()?.n).toBe(1);
  } finally {
    s.close();
  }
});

it('replayed commits including restored executions never reinsert; restore receipts remain idempotent', () => {
  const s = setup();
  try {
    const args = s.input([{ dat: 'new', st: 100, et: 200, car_series: 'NEW' }]);
    const batch = commitBatch(s.db, args);
    expect(commitBatch(s.db, { ...args, key: 'new-request' }).id).toBe(batch.id);
    const receipt = restoreBatch(s.db, batch.id, 'undo');
    expect(restoreBatch(s.db, batch.id, 'undo-again')).toEqual(receipt);
    expect(commitBatch(s.db, { ...args, key: 'after-undo' }).status).toBe('RESTORED');
    expect(targetRows(s.db)).toEqual(s.before);
    expect(s.db.prepare('SELECT count(*) n FROM change_events').get()?.n).toBe(2);
    expect(() => commitBatch(s.db, { ...args, executionId: randomUUID() })).toThrow(
      'IDEMPOTENCY_CONFLICT',
    );
  } finally {
    s.close();
  }
});

it('a genuine second INSERT failure rolls back rows, events, snapshot metadata, batch, version and head', () => {
  const s = setup();
  try {
    const version = state(s.db);
    s.db.exec(
      "CREATE TRIGGER second_fail BEFORE INSERT ON mining_results WHEN NEW.dat='second' BEGIN SELECT RAISE(ABORT,'second insert failed'); END",
    );
    expect(() =>
      commitBatch(
        s.db,
        s.input([
          { dat: 'first', st: 100, et: 200, car_series: 'NEW' },
          { dat: 'second', st: 100, et: 200, car_series: 'NEW' },
        ]),
      ),
    ).toThrow('second insert failed');
    expect(targetRows(s.db)).toEqual(s.before);
    expect(state(s.db)).toEqual(version);
    for (const table of ['change_events', 'batches', 'snapshot_metadata'])
      expect(s.db.prepare(`SELECT count(*) n FROM ${table}`).get()?.n).toBe(0);
  } finally {
    s.close();
  }
});

it('post-deletion validation and later event failures roll back every deleted row and receipt', () => {
  const s = setup();
  try {
    const b = s.add('new'),
      current = targetRows(s.db),
      version = state(s.db);
    // The DELETE succeeds first; a trigger changes an old value so the independent hash must fail.
    s.db.exec(
      "CREATE TRIGGER corrupt_after_delete AFTER DELETE ON mining_results BEGIN UPDATE mining_results SET car_series='changed' WHERE dat='old-0'; END",
    );
    expect(() => restoreBatch(s.db, b.id, 'failed-check')).toThrow('RESTORE_VALIDATION_FAILED');
    expect(targetRows(s.db)).toEqual(current);
    s.db.exec('DROP TRIGGER corrupt_after_delete');
    s.db.exec(
      "CREATE TRIGGER fail_event BEFORE INSERT ON change_events WHEN NEW.type='UNDO_INSERT' BEGIN SELECT RAISE(ABORT,'undo event failed'); END",
    );
    expect(() => restoreBatch(s.db, b.id, 'failed-event')).toThrow('undo event failed');
    expect(targetRows(s.db)).toEqual(current);
    expect(state(s.db)).toEqual(version);
    expect(s.db.prepare('SELECT count(*) n FROM restores').get()?.n).toBe(0);
    expect(s.db.prepare('SELECT count(*) n FROM change_events').get()?.n).toBe(1);
  } finally {
    s.close();
  }
});

it('damaged or missing delta records, baseline and snapshot metadata reject restore/history rather than returning current data', () => {
  for (const kind of ['event', 'missing', 'baseline', 'metadata', 'delta-hash']) {
    const s = setup();
    try {
      const a = s.add('A'),
        b = s.add('B'),
        current = targetRows(s.db);
      if (kind === 'event') s.db.exec("UPDATE change_events SET row_json='{}' WHERE seq=1");
      if (kind === 'missing') s.db.exec('DELETE FROM change_events WHERE seq=1');
      if (kind === 'baseline') s.db.exec("UPDATE history_baselines SET rows_json='[]'");
      if (kind === 'metadata')
        s.db.prepare('UPDATE snapshot_metadata SET before_seq=99 WHERE id=?').run(b.snapshot_id);
      if (kind === 'delta-hash') {
        b.inserted_hash = sha('wrong');
        s.db.prepare('UPDATE batches SET json=? WHERE id=?').run(JSON.stringify(b), b.id);
      }
      expect(() => restoreBatch(s.db, b.id, 'bad')).toThrow();
      if (kind !== 'delta-hash') expect(() => snapshotRows(s.db, b.id)).toThrow();
      expect(targetRows(s.db)).toEqual(current);
      expect(state(s.db).head_batch_id).toBe(b.id);
      expect(s.db.prepare('SELECT count(*) n FROM restores').get()?.n).toBe(0);
      expect(a.inserted).toBe(1);
    } finally {
      s.close();
    }
  }
});

it('legacy full snapshots remain unchanged and legacy head restores by deleting only verified additions after an idempotent migration', () => {
  const root = mkdtempSync(join(tmpdir(), 'flowlens-legacy-')),
    path = join(root, 'target.sqlite');
  createLegacyTarget(path);
  const db = new DatabaseSync(path);
  try {
    const projectId = randomUUID(),
      executionId = randomUUID(),
      id = randomUUID(),
      snapshotId = randomUUID();
    const before = [
      {
        task_id: projectId,
        dat: 'old',
        st: 1,
        et: 2,
        car_series: 'OLD',
        execution_id: randomUUID(),
      },
    ];
    const added = {
      task_id: projectId,
      dat: 'new',
      st: 3,
      et: 4,
      car_series: 'NEW',
      execution_id: executionId,
    };
    for (const row of [...before, added])
      db.prepare('INSERT INTO mining_results VALUES(?,?,?,?,?,?)').run(
        row.task_id,
        row.dat,
        row.st,
        row.et,
        row.car_series,
        row.execution_id,
      );
    const full = JSON.stringify(before);
    db.prepare('INSERT INTO snapshots VALUES(?,?,?,?,?,?)').run(
      snapshotId,
      1,
      1,
      digestRows(before),
      full,
      '2026-10-01',
    );
    const batch = {
      id,
      execution_id: executionId,
      revision_id: randomUUID(),
      status: 'COMMITTED',
      created_at: '2026-10-01',
      snapshot_id: snapshotId,
      before_hash: digestRows(before),
      after_hash: digestRows(targetRows(db)),
      before_count: 1,
      after_count: 2,
      inserted: 1,
      skipped: 0,
      previous_head: null,
      data_version: 1,
      restored_at: null,
      restore_id: null,
      can_restore: true,
    };
    db.prepare('INSERT INTO batches VALUES(?,?,?,?,?)').run(
      id,
      executionId,
      'old-request',
      sha('old-binding'),
      JSON.stringify(batch),
    );
    db.prepare('UPDATE data_state SET data_version=1,head_batch_id=?').run(id);
    const current = targetRows(db);
    migrateTarget(db);
    migrateTarget(db);
    expect(targetRows(db)).toEqual(current);
    expect(db.prepare('SELECT count(*) n FROM history_baselines').get()?.n).toBe(1);
    expect(snapshotRows(db, id).rows).toEqual(before);
    db.exec(
      "CREATE TRIGGER no_reinsertion BEFORE INSERT ON mining_results BEGIN SELECT RAISE(ABORT,'must not reinsert old rows'); END",
    );
    restoreBatch(db, id, 'undo-legacy');
    expect(targetRows(db)).toEqual(before);
    db.exec('DROP TRIGGER no_reinsertion');
    const b: PipelineBatch = commitBatch(db, {
      projectId,
      executionId: randomUUID(),
      revisionId: randomUUID(),
      rows: [{ dat: 'after', st: 5, et: 6, car_series: 'NEW' }],
      key: 'new',
      binding: sha('new'),
      version: 2,
      targetHash: digestRows(before),
    });
    expect(snapshotRows(db, b.id).rows).toEqual(before);
    restoreBatch(db, b.id, 'undo-new');
    expect(snapshotRows(db, id).rows).toEqual(before);
    expect(
      db.prepare('SELECT rows_json FROM snapshots WHERE id=?').get(snapshotId)?.rows_json,
    ).toBe(full);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});
