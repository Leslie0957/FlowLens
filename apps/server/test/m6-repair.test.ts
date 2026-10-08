import { expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { openDatabase, migrate, seed } from '../src/db.js';
import { LocalExecutionService } from '../src/local-execution.js';
import { LocalRepairService } from '../src/local-repair.js';
import type { ModelGateway } from '../src/model-gateway.js';

function scripted(sql: string): ModelGateway {
  return {
    async complete(messages) {
      if (!messages.some((item) => item.role === 'tool'))
        return {
          text: '',
          finishReason: 'tool_calls',
          calls: [
            { id: 'state', name: 'get_local_execution', arguments: {} },
            { id: 'source', name: 'get_local_sql', arguments: {} },
            { id: 'logs', name: 'get_local_logs', arguments: {} },
          ],
        };
      const tools = messages
        .filter((item) => item.role === 'tool')
        .map(
          (item) =>
            JSON.parse(String(item.content)) as {
              output: Record<string, unknown>;
              evidence_ids: string[];
            },
        );
      return {
        text: JSON.stringify({
          diagnosis: 'order_total 列不存在，应使用 amount',
          evidence_ids: tools.flatMap((item) => item.evidence_ids),
          file_path: 'task.sql',
          base_hash: tools[1]!.output.revision_hash,
          new_content: sql,
        }),
        finishReason: 'stop',
        calls: [],
      };
    },
  };
}
const valid = 'SELECT COUNT(*) AS order_count, SUM(amount) AS total_amount FROM orders;';
const wrong = 'SELECT COUNT(*) AS order_count, SUM(order_id) AS total_amount FROM orders;';

it('binds model evidence to one failed local execution, then applies one approved revision and actually verifies 3/100', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'flowlens-repair-')),
    db = openDatabase(join(folder, 'db.sqlite'));
  try {
    migrate(db);
    seed(db);
    const local = new LocalExecutionService(db, join(folder, 'projects'));
    const project = local.createProject('sql-column-error', 'project');
    const failed = await local.waitFor(local.startExecution(project.id, 'failed').id);
    expect(failed.error_code).toBe('SQL_COLUMN_ERROR');
    const repair = new LocalRepairService(db, local, { gateway: scripted(valid) });
    const session = repair.create(failed.id, 'diagnose', 'MOCK', 'test');
    expect(repair.create(failed.id, 'diagnose', 'MOCK', 'test').id).toBe(session.id);
    await repair.waitFor(session.id);
    const pending = repair.get(session.id);
    expect(pending.status).toBe('PENDING_APPROVAL');
    expect(pending.provider_mode).toBe('MOCK');
    expect(pending.candidate?.diff).toContain('SUM(amount)');
    expect(
      pending.evidence.some(
        (item) => item.source_type === 'SQL' && item.source_version === failed.revision_hash,
      ),
    ).toBe(true);
    expect(
      pending.evidence.some(
        (item) => item.source_type === 'LOG' && item.excerpt.includes('no such column'),
      ),
    ).toBe(true);
    expect(local.getProject(project.id).current_revision_id).toBe(failed.revision_id);
    const applied = repair.approve(session.id, 'approve');
    expect(applied.status).toBe('APPROVED');
    expect(applied.verification_execution_id).toBeTruthy();
    expect(repair.approve(session.id, 'approve').verification_execution_id).toBe(
      applied.verification_execution_id,
    );
    const verified = await local.waitFor(applied.verification_execution_id!);
    expect(verified.status).toBe('SUCCEEDED');
    expect(verified.validation).toMatchObject({ passed: true, order_count: 3, total_amount: 100 });
    expect(local.getExecution(failed.id).status).toBe('FAILED');
    expect(local.getProject(project.id).revision).toMatchObject({
      sql_text: valid,
      parent_revision_id: failed.revision_id,
      created_source: 'AGENT_APPROVED',
    });
    expect(
      db.prepare('SELECT count(*) n FROM local_revision WHERE project_id=?').get(project.id),
    ).toMatchObject({ n: 2 });
  } finally {
    db.close();
    rmSync(folder, { recursive: true, force: true });
  }
});

it('rejects cross-project tool reads, rejection and stale approval without changing source', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'flowlens-repair-guard-')),
    db = openDatabase(join(folder, 'db.sqlite'));
  try {
    migrate(db);
    seed(db);
    const local = new LocalExecutionService(db, join(folder, 'projects'));
    const project = local.createProject('sql-column-error', 'project');
    const failed = await local.waitFor(local.startExecution(project.id, 'failed').id);
    const other = local.createProject('sql-valid-control', 'other');
    const repair = new LocalRepairService(db, local, { gateway: scripted(wrong) });
    const first = repair.create(failed.id, 'first', 'MOCK', 'test');
    await repair.waitFor(first.id);
    expect(() => repair.readTool(first.id, 'get_local_sql', { project_id: other.id })).toThrow(
      'TOOL_SCOPE',
    );
    expect(repair.reject(first.id, 'reject').status).toBe('REJECTED');
    expect(() => repair.approve(first.id, 'approve')).toThrow('REPAIR_NOT_PENDING');
    const next = repair.create(failed.id, 'second', 'MOCK', 'test');
    await repair.waitFor(next.id);
    const changed = randomUUID();
    const current = local.getProject(project.id).revision;
    db.prepare('INSERT INTO local_revision VALUES (?,?,?,?,?,?,?,?)').run(
      changed,
      project.id,
      current.id,
      valid,
      current.input_json,
      createHash('sha256')
        .update(valid + '\n' + current.input_json)
        .digest('hex'),
      'TEST',
      new Date().toISOString(),
    );
    db.prepare('UPDATE local_project SET current_revision_id=? WHERE id=?').run(
      changed,
      project.id,
    );
    expect(() => repair.approve(next.id, 'stale')).toThrow('REPAIR_STALE');
    expect(
      db.prepare('SELECT count(*) n FROM local_revision WHERE project_id=?').get(project.id),
    ).toMatchObject({ n: 2 });
  } finally {
    db.close();
    rmSync(folder, { recursive: true, force: true });
  }
});

it('keeps a wrong but runnable model candidate as a real verification failure', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'flowlens-repair-wrong-')),
    db = openDatabase(join(folder, 'db.sqlite'));
  try {
    migrate(db);
    seed(db);
    const local = new LocalExecutionService(db, join(folder, 'projects'));
    const project = local.createProject('sql-column-error', 'project');
    const failed = await local.waitFor(local.startExecution(project.id, 'failed').id);
    const repair = new LocalRepairService(db, local, { gateway: scripted(wrong) });
    const session = repair.create(failed.id, 'diagnose', 'MOCK', 'test');
    await repair.waitFor(session.id);
    const approved = repair.approve(session.id, 'approve');
    const execution = await local.waitFor(approved.verification_execution_id!);
    expect(execution.exit_code).toBe(0);
    expect(execution.status).toBe('FAILED');
    expect(execution.error_code).toBe('RESULT_VALIDATION_FAILED');
    expect(repair.get(session.id).status).toBe('APPROVED');
  } finally {
    db.close();
    rmSync(folder, { recursive: true, force: true });
  }
});

it('fails a model candidate outside the fixed SQL policy without claiming repair', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'flowlens-repair-invalid-')),
    db = openDatabase(join(folder, 'db.sqlite'));
  try {
    migrate(db);
    seed(db);
    const local = new LocalExecutionService(db, join(folder, 'projects'));
    const project = local.createProject('sql-column-error', 'project');
    const failed = await local.waitFor(local.startExecution(project.id, 'failed').id);
    const repair = new LocalRepairService(db, local, { gateway: scripted('SELECT 1;') });
    const session = repair.create(failed.id, 'diagnose', 'MOCK', 'test');
    await repair.waitFor(session.id);
    const approval = repair.approve(session.id, 'approve');
    const execution = await local.waitFor(approval.verification_execution_id!);
    expect(execution.status).toBe('FAILED');
    expect(execution.error_code).toBe('SQL_POLICY_REJECTED');
    expect(repair.get(session.id).verification?.status).toBe('FAILED');
    expect(local.getExecution(failed.id).status).toBe('FAILED');
  } finally {
    db.close();
    rmSync(folder, { recursive: true, force: true });
  }
});

it('does not apply a tampered, expired, or out-of-scope candidate', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'flowlens-repair-policy-')),
    db = openDatabase(join(folder, 'db.sqlite'));
  try {
    migrate(db);
    seed(db);
    const local = new LocalExecutionService(db, join(folder, 'projects'));
    const project = local.createProject('sql-column-error', 'project');
    const failed = await local.waitFor(local.startExecution(project.id, 'failed').id);
    const repair = new LocalRepairService(db, local, { gateway: scripted(valid) });
    const session = repair.create(failed.id, 'candidate', 'MOCK', 'test');
    await repair.waitFor(session.id);
    const original = repair.get(session.id).candidate!.new_content;
    const originalDiff = repair.get(session.id).candidate!.diff;
    db.prepare('UPDATE local_repair_session SET candidate_sql=? WHERE id=?').run(wrong, session.id);
    expect(() => repair.approve(session.id, 'tampered')).toThrow('REPAIR_CANDIDATE_CHANGED');
    db.prepare('UPDATE local_repair_session SET candidate_sql=?,diff_text=? WHERE id=?').run(
      original,
      'forged diff',
      session.id,
    );
    expect(() => repair.approve(session.id, 'tampered-diff')).toThrow('REPAIR_CANDIDATE_CHANGED');
    db.prepare('UPDATE local_repair_session SET diff_text=?,expires_at=? WHERE id=?').run(
      originalDiff,
      '2000-01-01T00:00:00.000Z',
      session.id,
    );
    expect(() => repair.approve(session.id, 'expired')).toThrow('REPAIR_EXPIRED');
    expect(repair.get(session.id).status).toBe('EXPIRED');
    expect(local.getProject(project.id).current_revision_id).toBe(failed.revision_id);
    const invalid: ModelGateway = {
      async complete(messages) {
        if (!messages.some((item) => item.role === 'tool'))
          return {
            text: '',
            finishReason: 'tool_calls',
            calls: [
              { id: 'sql', name: 'get_local_sql', arguments: {} },
              { id: 'log', name: 'get_local_logs', arguments: {} },
            ],
          };
        const responses = messages
          .filter((item) => item.role === 'tool')
          .map(
            (item) =>
              JSON.parse(String(item.content)) as {
                output: Record<string, unknown>;
                evidence_ids: string[];
              },
          );
        return {
          text: JSON.stringify({
            diagnosis: 'modify input',
            evidence_ids: responses.flatMap((item) => item.evidence_ids),
            file_path: 'input.json',
            base_hash: responses[0]!.output.revision_hash,
            new_content: '[]',
          }),
          finishReason: 'stop',
          calls: [],
        };
      },
    };
    const unsafe = new LocalRepairService(db, local, { gateway: invalid });
    const attempt = unsafe.create(failed.id, 'unsafe', 'MOCK', 'test');
    await unsafe.waitFor(attempt.id);
    expect(unsafe.get(attempt.id)).toMatchObject({
      status: 'FAILED',
      error_code: 'INVALID_REPAIR_CANDIDATE',
    });
    expect(
      db.prepare('SELECT count(*) n FROM local_revision WHERE project_id=?').get(project.id),
    ).toMatchObject({ n: 1 });
  } finally {
    db.close();
    rmSync(folder, { recursive: true, force: true });
  }
});

it('cancels a pending model call and marks restart gaps without continuing or applying again', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'flowlens-repair-recovery-')),
    db = openDatabase(join(folder, 'db.sqlite'));
  try {
    migrate(db);
    seed(db);
    const local = new LocalExecutionService(db, join(folder, 'projects'));
    const project = local.createProject('sql-column-error', 'project');
    const failed = await local.waitFor(local.startExecution(project.id, 'failed').id);
    const hanging: ModelGateway = { complete: async () => new Promise(() => {}) };
    const repair = new LocalRepairService(db, local, { gateway: hanging });
    const session = repair.create(failed.id, 'cancel', 'MOCK', 'test');
    await vi.waitFor(() => expect(repair.get(session.id).status).toBe('RUNNING'));
    expect(repair.cancel(session.id).status).toBe('CANCELLED');
    await repair.waitFor(session.id);
    expect(repair.get(session.id).candidate).toBeNull();
    const ready = new LocalRepairService(db, local, { gateway: scripted(valid) });
    const second = ready.create(failed.id, 'restart', 'MOCK', 'test');
    await ready.waitFor(second.id);
    db.prepare("UPDATE local_repair_session SET status='RUNNING' WHERE id=?").run(second.id);
    ready.recoverInterrupted();
    expect(ready.get(second.id).status).toBe('INTERRUPTED');
    db.prepare(
      "UPDATE local_repair_session SET status='APPROVED',verification_execution_id=NULL WHERE id=?",
    ).run(second.id);
    ready.recoverInterrupted();
    expect(ready.get(second.id)).toMatchObject({
      status: 'APPLY_FAILED',
      error_code: 'SERVER_RESTARTED',
    });
    expect(local.getProject(project.id).current_revision_id).toBe(failed.revision_id);
  } finally {
    db.close();
    rmSync(folder, { recursive: true, force: true });
  }
});

it('records an execution launch failure after approval without false success or duplicate application', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'flowlens-repair-launch-')),
    db = openDatabase(join(folder, 'db.sqlite'));
  try {
    migrate(db);
    seed(db);
    const local = new LocalExecutionService(db, join(folder, 'projects'));
    const project = local.createProject('sql-column-error', 'project');
    const failed = await local.waitFor(local.startExecution(project.id, 'failed').id);
    const repair = new LocalRepairService(db, local, { gateway: scripted(valid) });
    const session = repair.create(failed.id, 'candidate', 'MOCK', 'test');
    await repair.waitFor(session.id);
    db.exec(
      "CREATE TRIGGER reject_repair_write BEFORE INSERT ON local_revision BEGIN SELECT RAISE(ABORT,'simulated write failure'); END;",
    );
    expect(() => repair.approve(session.id, 'blocked-write')).toThrow('simulated write failure');
    expect(repair.get(session.id).status).toBe('PENDING_APPROVAL');
    expect(local.getProject(project.id).current_revision_id).toBe(failed.revision_id);
    db.exec('DROP TRIGGER reject_repair_write');
    vi.spyOn(local, 'startExecution').mockImplementationOnce(() => {
      throw new Error('simulated launch failure');
    });
    const result = repair.approve(session.id, 'approval');
    expect(result).toMatchObject({
      status: 'APPLY_FAILED',
      error_code: 'INTERNAL_ERROR',
      verification_execution_id: null,
    });
    expect(result.approved_revision_id).toBeTruthy();
    expect(repair.approve(session.id, 'approval').approved_revision_id).toBe(
      result.approved_revision_id,
    );
    expect(
      db.prepare('SELECT count(*) n FROM local_revision WHERE project_id=?').get(project.id),
    ).toMatchObject({ n: 2 });
    expect(local.listExecutions(project.id, 1, 20).total).toBe(1);
  } finally {
    db.close();
    rmSync(folder, { recursive: true, force: true });
  }
});

it('rejects a model claim with no bound log and SQL evidence', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'flowlens-repair-evidence-')),
    db = openDatabase(join(folder, 'db.sqlite'));
  try {
    migrate(db);
    seed(db);
    const local = new LocalExecutionService(db, join(folder, 'projects'));
    const project = local.createProject('sql-column-error', 'project');
    const failed = await local.waitFor(local.startExecution(project.id, 'failed').id);
    const invented: ModelGateway = {
      async complete() {
        return {
          text: JSON.stringify({
            diagnosis: 'already repaired',
            evidence_ids: [randomUUID(), randomUUID()],
            file_path: 'task.sql',
            base_hash: failed.revision_hash,
            new_content: valid,
          }),
          finishReason: 'stop',
          calls: [],
        };
      },
    };
    const repair = new LocalRepairService(db, local, { gateway: invented });
    const session = repair.create(failed.id, 'claim', 'MOCK', 'test');
    await repair.waitFor(session.id);
    expect(repair.get(session.id)).toMatchObject({
      status: 'FAILED',
      error_code: 'REPAIR_EVIDENCE_INVALID',
      candidate: null,
    });
    expect(local.getProject(project.id).current_revision_id).toBe(failed.revision_id);
  } finally {
    db.close();
    rmSync(folder, { recursive: true, force: true });
  }
});

it('stops after one failed citation correction without applying a revision or starting verification', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'flowlens-repair-citation-limit-')),
    db = openDatabase(join(folder, 'db.sqlite'));
  try {
    migrate(db);
    seed(db);
    const local = new LocalExecutionService(db, join(folder, 'projects'));
    const project = local.createProject('sql-column-error', 'project');
    const failed = await local.waitFor(local.startExecution(project.id, 'failed').id);
    const invalid: ModelGateway = {
      async complete(messages) {
        if (!messages.some((item) => item.role === 'tool'))
          return {
            text: '',
            finishReason: 'tool_calls',
            calls: [
              { id: 'sql', name: 'get_local_sql', arguments: {} },
              { id: 'logs', name: 'get_local_logs', arguments: {} },
            ],
          };
        const tools = messages
          .filter((item) => item.role === 'tool')
          .map(
            (item) =>
              JSON.parse(String(item.content)) as {
                output: Record<string, unknown>;
                evidence_ids: string[];
              },
          );
        return {
          text: JSON.stringify({
            diagnosis: 'invalid citations',
            evidence_ids: [tools[0]!.evidence_ids[0], randomUUID()],
            file_path: 'task.sql',
            base_hash: tools[0]!.output.revision_hash,
            new_content: valid,
          }),
          finishReason: 'stop',
          calls: [],
        };
      },
    };
    const repair = new LocalRepairService(db, local, { gateway: invalid });
    const session = repair.create(failed.id, 'bad-citations', 'MOCK', 'test');
    await repair.waitFor(session.id);
    expect(repair.get(session.id)).toMatchObject({
      status: 'FAILED',
      error_code: 'REPAIR_EVIDENCE_INVALID',
      model_requests: 3,
      candidate: null,
    });
    expect(local.getProject(project.id).current_revision_id).toBe(failed.revision_id);
    expect(local.listExecutions(project.id, 1, 20).total).toBe(1);
    expect(
      db.prepare('SELECT count(*) n FROM local_revision WHERE project_id=?').get(project.id),
    ).toMatchObject({ n: 1 });
  } finally {
    db.close();
    rmSync(folder, { recursive: true, force: true });
  }
});
