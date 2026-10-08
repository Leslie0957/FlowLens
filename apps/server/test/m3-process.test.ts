import { expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, migrate, seed } from '../src/db.js';
import { createSession, submitMessage } from '../src/diagnosis-store.js';
import { proposeRetry, resolveApproval } from '../src/diagnosis-store.js';
import { runDiagnosis } from '../src/diagnosis-agent.js';
import { advanceDue } from '../src/store.js';

async function freePort() {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const value = server.address();
  const port = typeof value === 'object' && value ? value.port : 0;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}
it('a separate service process recovers an unfinished turn after restart', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'flowlens-m3-process-'));
  let processHandle: ReturnType<typeof spawn> | undefined;
  try {
    const dbPath = join(folder, 'db.sqlite'),
      port = await freePort();
    let db = openDatabase(dbPath);
    migrate(db);
    seed(db);
    const session = createSession(db, 'seed_s04', 'process-session'),
      sent = submitMessage(db, session.id, '中断的问题', 'process-turn', 'MOCK', 'mock');
    db.prepare("UPDATE diagnosis_turn SET status='RUNNING' WHERE id=?").run(sent.turn_id);
    db.close();
    processHandle = spawn(process.execPath, ['--import', 'tsx', 'src/main.ts'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        APP_DB_PATH: dbPath,
        APP_PORT: String(port),
        MODEL_MODE: 'MOCK',
        MODEL_API_KEY: '',
        FLOWLENS_LIVE_APPROVED: '0',
      },
      stdio: 'ignore',
      windowsHide: true,
    });
    const url = `http://127.0.0.1:${port}`;
    let ready = false;
    for (let i = 0; i < 60; i++) {
      try {
        if ((await fetch(url + '/health')).ok) {
          ready = true;
          break;
        }
      } catch {
        /* startup */
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(ready).toBe(true);
    const response = await fetch(url + '/api/v1/sessions/' + session.id),
      body = (await response.json()) as {
        data: { turns: { id: string; status: string; error_code: string }[] };
      };
    expect(response.status).toBe(200);
    expect(body.data.turns[0]).toMatchObject({
      id: sent.turn_id,
      status: 'INTERRUPTED',
      error_code: 'SERVER_RESTARTED',
    });
    processHandle.kill();
    await new Promise<void>((resolve) => processHandle!.once('exit', () => resolve()));
    processHandle = undefined;
    db = openDatabase(dbPath);
    expect(
      db
        .prepare("SELECT count(*) n FROM agent_event WHERE turn_id=? AND type='turn.finished'")
        .get(sent.turn_id),
    ).toMatchObject({ n: 1 });
    db.close();
  } finally {
    if (processHandle) processHandle.kill();
    try {
      rmSync(folder, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    } catch {
      /* Windows may retain a closing SQLite handle */
    }
  }
}, 20000);

it('a simulated child resumes in a service process and does not duplicate logs on a second start', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'flowlens-m3-child-'));
  let childProcess: ReturnType<typeof spawn> | undefined;
  try {
    const dbPath = join(folder, 'db.sqlite'),
      port = await freePort();
    let db = openDatabase(dbPath);
    migrate(db);
    seed(db);
    const session = createSession(db, 'seed_s04', 'child-session'),
      sent = submitMessage(db, session.id, '诊断', 'child-turn', 'MOCK', 'mock');
    await runDiagnosis(db, {
      turnId: sent.turn_id,
      sessionId: session.id,
      runId: 'seed_s04',
      question: '诊断',
      mode: 'MOCK',
      model: 'mock',
      logSink: () => {},
    });
    const proposal = proposeRetry(db, 'seed_s04', sent.turn_id, '模拟恢复', 'child-proposal');
    const approved = resolveApproval(db, proposal.id, 'approve', 'child-approve');
    const childId = String(approved.child_run_id);
    const start = Date.now() - 3000;
    advanceDue(db, start);
    advanceDue(db, start + 2500);
    db.close();
    const url = `http://127.0.0.1:${port}`;
    const launch = () =>
      spawn(process.execPath, ['--import', 'tsx', 'src/main.ts'], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          APP_DB_PATH: dbPath,
          APP_PORT: String(port),
          MODEL_MODE: 'MOCK',
          MODEL_API_KEY: '',
          FLOWLENS_LIVE_APPROVED: '0',
        },
        stdio: 'ignore',
        windowsHide: true,
      });
    childProcess = launch();
    let succeeded = false;
    for (let i = 0; i < 100; i++) {
      try {
        const response = await fetch(url + '/api/v1/runs/' + childId);
        if (
          response.ok &&
          ((await response.json()) as { data: { status: string } }).data.status === 'SUCCEEDED'
        ) {
          succeeded = true;
          break;
        }
      } catch {
        /* startup */
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(succeeded).toBe(true);
    childProcess.kill();
    await new Promise<void>((resolve) => childProcess!.once('exit', () => resolve()));
    childProcess = undefined;
    db = openDatabase(dbPath);
    const before = (
      db.prepare('SELECT count(*) n FROM task_log WHERE run_id=?').get(childId) as { n: number }
    ).n;
    expect(before).toBeGreaterThan(0);
    db.close();
    childProcess = launch();
    for (let i = 0; i < 60; i++) {
      try {
        if ((await fetch(url + '/health')).ok) break;
      } catch {
        /* startup */
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    childProcess.kill();
    await new Promise<void>((resolve) => childProcess!.once('exit', () => resolve()));
    childProcess = undefined;
    db = openDatabase(dbPath);
    expect(db.prepare('SELECT count(*) n FROM task_log WHERE run_id=?').get(childId)).toMatchObject(
      { n: before },
    );
    expect(
      db.prepare('SELECT count(*) n FROM task_run WHERE parent_run_id=?').get('seed_s04'),
    ).toMatchObject({ n: 1 });
    db.close();
  } finally {
    if (childProcess) childProcess.kill();
    try {
      rmSync(folder, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    } catch {
      /* Windows may retain a closing SQLite handle */
    }
  }
}, 20000);
