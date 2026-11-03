import { expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import request from 'supertest';
import { openDatabase, migrate } from '../src/db.js';
import { PipelineService } from '../src/pipeline.js';
import { PipelineAgent } from '../src/pipeline-agent.js';
import { createApp } from '../src/http.js';
import * as mock from '../src/pipeline-mock.js';
import { pipelineDefaultPrompt, pipelinePromptVersion } from '../src/pipeline-prompts.js';

it('the actual web repair endpoint sends the promoted default Prompt and persists its version for snapshots', async () => {
  const root = mkdtempSync(join(tmpdir(), 'flowlens-web-prompt-'));
  const db = openDatabase(join(root, 'app.sqlite'));
  migrate(db);
  const pipeline = new PipelineService(db, join(root, 'projects'));
  const agent = new PipelineAgent(pipeline);
  const observed: unknown[] = [];
  vi.stubEnv('MODEL_MODE', 'MOCK');
  vi.spyOn(mock, 'pipelineMock').mockImplementation(() => ({
    async complete(messages) {
      observed.push(structuredClone(messages));
      expect(messages[0]!.content).toBe(pipelineDefaultPrompt);
      const context = JSON.parse(String(messages.find((m) => m.role === 'user')!.content));
      return {
        text: JSON.stringify({
          diagnosis: '受控 HTTP 测试：原始失败已确认，交接人工核对。',
          failed_step: context.failure.failed_step,
          action: 'MANUAL_REQUIRED',
          candidate: null,
          evidence_ids: [context.failure.evidence_id],
        }),
        calls: [],
        finishReason: 'stop',
      };
    },
  }));
  const app = createApp(db, () => {}, undefined, undefined, undefined, pipeline, agent);
  const base = '/api/v1/pipeline/projects';
  try {
    const p = pipeline.create('A', randomUUID());
    const e = await pipeline.waitFor(pipeline.start(p.id, randomUUID()).id);
    const res = await request(app)
      .post(`${base}/${p.id}/executions/${e.id}/repairs`)
      .set('Idempotency-Key', randomUUID())
      .send({});
    expect(res.status).toBe(202);
    expect(res.body.data.prompt_version).toBe(pipelinePromptVersion);
    const expectedHash = createHash('sha256').update(pipelineDefaultPrompt).digest('hex');
    expect(res.body.data.prompt_sha256).toBe(expectedHash);
    const repair = await agent.waitFor(res.body.data.id);
    expect(repair.status).toBe('NO_CANDIDATE');
    const saved = (await request(app).get(`${base}/${p.id}`)).body.data.repairs[0];
    expect(saved.prompt_version).toBe('grounded-actions-v1');
    expect(saved.prompt_sha256).toBe(expectedHash);
    expect(observed).toHaveLength(1);
    expect(pipeline.snapshot(p.id).target.row_count).toBe(0);
  } finally {
    await agent.stopAll();
    await pipeline.stopAll();
    db.close();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  }
});
