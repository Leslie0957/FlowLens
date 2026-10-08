import { Router, type Request } from 'express';
import { z } from 'zod';
import {
  pipelineSnapshotSchema,
  pipelineExecutionSchema,
  pipelineRepairSchema,
  pipelineQueryResultSchema,
  pipelineDatabaseSchema,
} from '@flowlens/contracts';
import { LocalError } from './local-execution.js';
import { PipelineService } from './pipeline.js';
import { PipelineAgent } from './pipeline-agent.js';
import { templates } from './pipeline-data.js';
export function pipelineRouter(p: PipelineService, a: PipelineAgent) {
  const router = Router();
  const id = (req: Request, name = 'projectId') => z.uuid().parse(req.params[name]);
  const key = (req: Request) => {
    const key = req.header('Idempotency-Key') ?? '';
    p.requireKey(key);
    return key;
  };
  const empty = z.strictObject({});
  router.get('/templates', (_req, res) =>
    res.json({ data: templates.map(({ id, name }) => ({ id, name })) }),
  );
  router.get('/projects', (_req, res) => res.json({ data: p.list('project') }));
  router.post('/projects', (req, res) => {
    const b = z.strictObject({ template_id: z.enum(['A', 'B', 'C']) }).parse(req.body);
    res.status(201).json({ data: p.create(b.template_id, key(req)) });
  });
  router.get('/projects/:projectId', (req, res) =>
    res.json({ data: pipelineSnapshotSchema.parse(p.snapshot(id(req))) }),
  );
  router.get('/projects/:projectId/schema', (req, res) =>
    res.json({ data: pipelineDatabaseSchema.parse(p.schema(id(req))) }),
  );
  router.post('/projects/:projectId/revisions', (req, res) => {
    const b = z
      .strictObject({ base_revision_id: z.uuid(), sql: z.string().min(1).max(8192) })
      .parse(req.body);
    res.json({ data: p.save(id(req), b.base_revision_id, b.sql, key(req)) });
  });
  router.post('/projects/:projectId/executions', (req, res) => {
    empty.parse(req.body);
    res.status(202).json({ data: pipelineExecutionSchema.parse(p.start(id(req), key(req))) });
  });
  router.post('/projects/:projectId/executions/:executionId/cancel', (req, res) => {
    empty.parse(req.body);
    const e = p.execution(id(req, 'executionId'));
    if (e.project_id !== id(req)) throw new LocalError('EXECUTION_SCOPE', 403);
    res.json({ data: p.cancel(e.id) });
  });
  router.post('/projects/:projectId/executions/:executionId/commit', (req, res) => {
    empty.parse(req.body);
    res.json({ data: p.commit(id(req), id(req, 'executionId'), key(req)) });
  });
  router.post('/projects/:projectId/batches/:batchId/restore', (req, res) => {
    empty.parse(req.body);
    res.json({ data: p.restore(id(req), id(req, 'batchId'), key(req)) });
  });
  router.post('/projects/:projectId/executions/:executionId/repairs', (req, res) => {
    empty.parse(req.body);
    res.status(202).json({
      data: pipelineRepairSchema.parse(
        a.create(
          id(req),
          id(req, 'executionId'),
          key(req),
          process.env.MODEL_MODE === 'LIVE' ? 'LIVE' : 'MOCK',
          process.env.MODEL_NAME ?? 'deepseek-flash',
        ),
      ),
    });
  });
  router.post('/projects/:projectId/repairs/:repairId/:decision', (req, res) => {
    const d = z.enum(['approve', 'reject', 'cancel']).parse(req.params.decision);
    const body =
      d === 'approve'
        ? z.strictObject({ commit_on_success: z.boolean().default(false) }).parse(req.body)
        : empty.parse(req.body);
    const projectId = id(req),
      repairId = id(req, 'repairId');
    res.json({
      data: pipelineRepairSchema.parse(
        d === 'cancel'
          ? a.cancel(projectId, repairId)
          : a.decide(
              projectId,
              repairId,
              d,
              key(req),
              'commit_on_success' in body && body.commit_on_success === true,
            ),
      ),
    });
  });
  router.post('/projects/:projectId/query', async (req, res) => {
    const controller = new AbortController();
    res.on('close', () => {
      if (!res.writableEnded) controller.abort();
    });
    const result = await p.query(id(req), req.body, controller.signal);
    res.json({ data: pipelineQueryResultSchema.parse(result) });
  });
  router.get('/projects/:projectId/events', (req, res) => {
    const projectId = id(req);
    p.project(projectId);
    const after = z.coerce
      .number()
      .int()
      .min(0)
      .parse(req.query.after_seq ?? 0);
    let cursor = after,
      heartbeat = Date.now();
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.flushHeaders();
    res.write(': connected\n\n');
    const flush = () => {
      try {
        for (const e of p.events(projectId, cursor)) {
          if (!res.write(`id: ${e.seq}\nevent: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`)) {
            res.end();
            clearInterval(timer);
            return;
          }
          cursor = Number(e.seq);
        }
        if (Date.now() - heartbeat >= 15000) {
          res.write(': heartbeat\n\n');
          heartbeat = Date.now();
        }
      } catch {
        clearInterval(timer);
        res.end();
      }
    };
    const timer = setInterval(flush, 200);
    timer.unref();
    res.on('close', () => clearInterval(timer));
    flush();
  });
  return router;
}
