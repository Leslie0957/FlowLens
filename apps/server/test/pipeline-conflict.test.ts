import { expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { openDatabase, migrate } from '../src/db.js';
import { PipelineService } from '../src/pipeline.js';
import { PipelineAgent } from '../src/pipeline-agent.js';
import { createApp } from '../src/http.js';
import { historyRows, historyState } from '../src/pipeline-history.js';
import { targetRows } from '../src/pipeline-data.js';

it('D07 creates a real isolated target baseline exactly once; actual SQL passes validation then fails precheck, and history survives restart', async () => {
  const root = mkdtempSync(join(tmpdir(), 'flowlens-conflict-'));
  const db = openDatabase(join(root, 'app.sqlite'));
  migrate(db);
  const pipeline = new PipelineService(db, join(root, 'projects'));
  const agent = new PipelineAgent(pipeline);
  const app = createApp(db, () => {}, undefined, undefined, undefined, pipeline, agent);
  const base = '/api/v1/pipeline/projects';
  vi.stubEnv('MODEL_MODE', 'MOCK');
  const network = vi.fn(() => {
    throw new Error('NETWORK_FORBIDDEN');
  });
  vi.stubGlobal('fetch', network);
  try {
    const control = pipeline.create('C', randomUUID());
    const controlBefore = pipeline.snapshot(control.id);
    const key = randomUUID();
    const made = await request(app)
      .post(base)
      .set('Idempotency-Key', key)
      .send({ template_id: 'D07' });
    expect(made.status).toBe(201);
    const id = made.body.data.id;
    const before = pipeline.snapshot(id);
    expect(before.target).toMatchObject({ row_count: 1, data_version: 0 });
    expect(before.executions).toHaveLength(0);
    expect(before.repairs).toHaveLength(0);
    expect(before.batches).toHaveLength(0);
    expect(before.target.preview[0]!.car_series).toBe('EXISTING_DIFFERENT_SERIES');
    pipeline.withTarget(
      id,
      (target) => {
        const h = historyState(target);
        expect(historyRows(target, h.baseline_id, h.last_seq, h.chain_hash)).toEqual(
          targetRows(target),
        );
        expect(target.prepare('SELECT row_count FROM history_baselines').get()?.row_count).toBe(1);
        expect(target.prepare('SELECT count(*) n FROM change_events').get()?.n).toBe(0);
      },
      true,
    );
    const replay = await request(app)
      .post(base)
      .set('Idempotency-Key', key)
      .send({ template_id: 'D07' });
    expect(replay.body.data.id).toBe(id);
    expect(pipeline.snapshot(id).cursor).toBe(before.cursor);
    const bad = await request(app)
      .post(base)
      .set('Idempotency-Key', randomUUID())
      .send({ template_id: 'D07', initialRows: [] });
    expect(bad.status).toBe(400);
    const e = await pipeline.waitFor(pipeline.start(id, randomUUID()).id);
    expect(e).toMatchObject({
      status: 'FAILED',
      failed_step: 'precheck',
      error_code: 'BUSINESS_KEY_CONFLICT',
      exit_code: 0,
      validation: { passed: true, expected_count: 4, actual_count: 4 },
      precheck: { inserted: 3, skipped: 0, conflicts: 1 },
    });
    const repair = await agent.waitFor(
      agent.create(id, e.id, randomUUID(), 'MOCK', 'test-mock').id,
    );
    expect(repair).toMatchObject({
      status: 'NO_CANDIDATE',
      action: 'MANUAL_REQUIRED',
      candidate: null,
      prompt_version: 'grounded-actions-v1',
    });
    expect(repair.tools.every((t) => t.transport === 'MCP' && t.status === 'COMPLETED')).toBe(true);
    const commit = pipeline.commit(id, e.id, randomUUID());
    expect(commit.status).toBe('FAILED');
    expect(pipeline.snapshot(id).target).toEqual(before.target);
    expect(pipeline.snapshot(control.id).target).toEqual(controlBefore.target);
    const restarted = new PipelineService(db, join(root, 'projects'));
    expect(restarted.snapshot(id).target).toEqual(before.target);
    expect(restarted.create('D07', key).id).toBe(id);
    expect(restarted.snapshot(id).executions).toHaveLength(1);
    expect(network).not.toHaveBeenCalled();
  } finally {
    await agent.stopAll();
    await pipeline.stopAll();
    db.close();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  }
});
