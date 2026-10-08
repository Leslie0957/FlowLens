import { it, expect } from 'vitest';
import request from 'supertest';
import { openDatabase, migrate, seed } from '../src/db.js';
import { createApp } from '../src/http.js';
import { createSession, submitMessage, markTurn, saveResult } from '../src/diagnosis-store.js';

it('filters persisted runs by inclusive canonical UTC creation bounds and rejects invalid ranges', async () => {
  const db = openDatabase(':memory:');
  try {
    migrate(db);
    seed(db);
    const app = createApp(db, () => {});
    db.prepare('UPDATE task_run SET created_at=? WHERE id=?').run(
      '2026-09-26T01:00:00.000Z',
      'seed_s01',
    );
    db.prepare('UPDATE task_run SET created_at=? WHERE id=?').run(
      '2026-09-26T02:00:00.000Z',
      'seed_s02',
    );
    const res = await request(app).get('/api/v1/runs').query({
      created_from: '2026-09-26T09:00:00+08:00',
      created_to: '2026-09-26T10:00:00+08:00',
      status: 'FAILED',
      limit: 1,
      page: 2,
    });
    expect(res.status).toBe(200);
    expect(res.body.page_info.total).toBe(2);
    expect(res.body.data.map((r: { id: string }) => r.id)).toEqual(['seed_s01']);
    for (const query of [
      { created_from: 'bad' },
      { created_from: '2026-09-27T00:00:00Z', created_to: '2026-09-26T00:00:00Z' },
    ]) {
      const bad = await request(app).get('/api/v1/runs').query(query);
      expect(bad.status).toBe(400);
      expect(bad.body.error.code).toBe('INVALID_ARGUMENTS');
    }
  } finally {
    db.close();
  }
});

it('paginates searchable history with the last turn summary without loading full messages or tools', async () => {
  const db = openDatabase(':memory:');
  try {
    migrate(db);
    seed(db);
    const base = Date.parse('2026-10-01T00:00:00Z');
    const a = createSession(db, 'seed_s04', 'history-a', base),
      b = createSession(db, 'seed_s05', 'history-b', base);
    const first = submitMessage(db, a.id, '历史超时诊断', 'first', 'MOCK', 'test', base + 1);
    markTurn(db, first.turn_id, 'RUNNING');
    saveResult(db, a.id, first.turn_id, {
      summary: '旧结论',
      findings: [],
      missing_information: [],
      next_steps: [],
      proposed_action: null,
    });
    const last = submitMessage(db, a.id, '审批后追问', 'second', 'MOCK', 'test', base + 2);
    markTurn(db, last.turn_id, 'FAILED', 'TEST_FAILURE');
    db.prepare('UPDATE diagnosis_session SET updated_at=? WHERE id IN (?,?)').run(
      '2026-10-01T01:00:00.000Z',
      a.id,
      b.id,
    );
    const app = createApp(db, () => {});
    const res = await request(app).get('/api/v1/diagnoses').query({ q: '历史超时', limit: 1 });
    expect(res.status).toBe(200);
    expect(res.body.page_info.total).toBe(1);
    expect(res.body.data[0]).toMatchObject({
      id: a.id,
      task_name: '订单日报',
      scenario_id: 'S04',
      last_status: 'FAILED',
      last_error_code: 'TEST_FAILURE',
      summary: null,
      turn_count: 2,
    });
    expect(res.body.data[0]).not.toHaveProperty('messages');
    expect(res.body.data[0]).not.toHaveProperty('tool_calls');
    const all = await request(app).get('/api/v1/diagnoses?limit=1&page=1');
    const next = await request(app).get('/api/v1/diagnoses?limit=1&page=2');
    expect(all.body.page_info.total).toBe(2);
    expect(all.body.data[0].id).not.toBe(next.body.data[0].id);
    const empty = await request(app).get('/api/v1/diagnoses?q=not-present');
    expect(empty.body.data).toEqual([]);
    expect((await request(app).get('/api/v1/diagnoses?limit=101')).status).toBe(400);
  } finally {
    db.close();
  }
});
