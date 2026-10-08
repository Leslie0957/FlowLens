import { it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { openDatabase, migrate, seed } from '../src/db.js';
import { createApp } from '../src/http.js';
import { LocalExecutionService } from '../src/local-execution.js';

it('keeps local HTTP operations separate from fixture diagnosis and rejects arbitrary execution inputs', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'flowlens-m6-http-')),
    db = openDatabase(join(folder, 'test.sqlite'));
  try {
    migrate(db);
    seed(db);
    const service = new LocalExecutionService(db, join(folder, 'projects'));
    const api = request(createApp(db, () => {}, service));
    expect(
      (
        await api
          .post('/api/v1/local-projects')
          .set('Idempotency-Key', 'invalid')
          .send({ template_id: 'other' })
      ).status,
    ).toBe(400);
    expect(
      (
        await api
          .post('/api/v1/local-projects')
          .set('Idempotency-Key', 'invalid-2')
          .send({ template_id: 'sql-column-error', path: 'C:\\outside' })
      ).status,
    ).toBe(400);
    const created = await api
      .post('/api/v1/local-projects')
      .set('Idempotency-Key', 'create-one')
      .send({ template_id: 'sql-column-error' });
    expect(created.status).toBe(201);
    const id = created.body.data.id as string;
    expect(created.body.data.revision.sql_text).toContain('order_total');
    expect(created.body.data.input_source).toBe('SYNTHETIC');
    expect((await api.get(`/api/v1/local-projects/${id}/executions`)).body.data).toEqual([]);
    expect(
      (
        await api
          .post('/api/v1/local-projects')
          .set('Idempotency-Key', 'create-one')
          .send({ template_id: 'sql-column-error' })
      ).body.data.id,
    ).toBe(id);
    expect(
      (
        await api
          .post('/api/v1/local-projects')
          .set('Idempotency-Key', 'create-one')
          .send({ template_id: 'sql-valid-control' })
      ).body.error.code,
    ).toBe('IDEMPOTENCY_CONFLICT');
    for (const body of [
      { command: 'echo x' },
      { path: '..' },
      { env: { MODEL_API_KEY: 'x' } },
      { sql: 'SELECT 1' },
    ])
      expect(
        (
          await api
            .post(`/api/v1/local-projects/${id}/executions`)
            .set('Idempotency-Key', 'bad-' + Object.keys(body)[0])
            .send(body)
        ).status,
      ).toBe(400);
    const started = await api
      .post(`/api/v1/local-projects/${id}/executions`)
      .set('Idempotency-Key', 'run-one')
      .send({});
    expect(started.status).toBe(202);
    const executionId = started.body.data.id as string;
    expect(
      (
        await api
          .post(`/api/v1/local-projects/${id}/executions`)
          .set('Idempotency-Key', 'run-one')
          .send({})
      ).body.data.id,
    ).toBe(executionId);
    await service.waitFor(executionId);
    const detail = await api.get(`/api/v1/local-executions/${executionId}`);
    expect(detail.body.data).toMatchObject({
      project_id: id,
      status: 'FAILED',
      error_code: 'SQL_COLUMN_ERROR',
    });
    const logs = await api.get(`/api/v1/local-executions/${executionId}/logs`);
    expect(
      logs.body.data.some((row: { message: string }) => row.message.includes('no such column')),
    ).toBe(true);
    const artifacts = (await api.get(`/api/v1/local-executions/${executionId}/artifacts`)).body
      .data as { id: string; name: string }[];
    const snapshot = artifacts.find((x) => x.name === 'task.sql')!;
    expect(
      (await api.get(`/api/v1/local-executions/${executionId}/artifacts/${snapshot.id}`)).body.data
        .content,
    ).toContain('order_total');
    const other = service.createProject('sql-valid-control', 'other');
    const otherExecution = await service.waitFor(service.startExecution(other.id, 'other-run').id);
    const otherArtifact = (service.artifacts(otherExecution.id) as { id: string }[])[0]!;
    expect(
      (await api.get(`/api/v1/local-executions/${executionId}/artifacts/${otherArtifact.id}`))
        .status,
    ).toBe(404);
    expect(
      (
        await api
          .post('/api/v1/sessions')
          .set('Idempotency-Key', 'local-session')
          .send({ run_id: id })
      ).status,
    ).toBe(404);
    expect(
      (
        await api
          .post(`/api/v1/runs/${id}/retry-proposals`)
          .set('Idempotency-Key', 'local-retry')
          .send({ turn_id: 'x', reason: 'x' })
      ).status,
    ).toBeGreaterThanOrEqual(400);
    expect(
      (await api.get('/api/v1/runs')).body.data.some((row: { id: string }) => row.id === id),
    ).toBe(false);
    expect((await api.get('/api/v1/demo/scenarios')).body.data).toHaveLength(6);
  } finally {
    db.close();
    rmSync(folder, { recursive: true, force: true });
  }
}, 10000);
