import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdirSync, appendFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

// A separate persistent acceptance database; the normal application DB is untouched.
const folder = resolve('data/pipeline-demo');
const apiPort = Number(process.env.FLOWLENS_DEMO_API_PORT ?? 4180),
  webPort = Number(process.env.FLOWLENS_DEMO_WEB_PORT ?? 5180);
const pnpm = process.env.npm_execpath;
if (!pnpm || !existsSync('apps/server/dist/main.js') || !existsSync('apps/web/dist/index.html'))
  throw new Error('Run pnpm build, then pnpm demo:pipeline');
if (
  ![apiPort, webPort].every((p) => Number.isInteger(p) && p > 0 && p <= 65535) ||
  apiPort === webPort
)
  throw new Error('INVALID_DEMO_PORT');
for (const port of [apiPort, webPort])
  await new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', () => reject(new Error('DEMO_PORT_OCCUPIED: ' + port)));
    probe.listen(port, '127.0.0.1', () => probe.close(resolve));
  });
mkdirSync(folder, { recursive: true });
const apiUrl = 'http://127.0.0.1:' + apiPort,
  webUrl = 'http://127.0.0.1:' + webPort;
const start = (name, args, extra) => {
  const exe = pnpm.toLowerCase().endsWith('.exe') ? pnpm : process.execPath;
  const child = spawn(exe, exe === pnpm ? [name, ...args] : [pnpm, name, ...args], {
    cwd: process.cwd(),
    windowsHide: true,
    env: { ...process.env, ...extra },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  for (const stream of [child.stdout, child.stderr])
    stream.on('data', (bytes) => appendFileSync(join(folder, name + '.txt'), bytes));
  return child;
};
const children = [
  start('start', [], { APP_PORT: String(apiPort), APP_DB_PATH: join(folder, 'app.sqlite') }),
  start('preview', ['--port', String(webPort)], { FLOWLENS_API_TARGET: apiUrl }),
];
let stopping = false;
async function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children)
    if (child.exitCode === null) {
      if (process.platform === 'win32')
        await new Promise((resolve) =>
          spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
            windowsHide: true,
            stdio: 'ignore',
          }).once('exit', resolve),
        );
      else child.kill();
    }
  process.exit(code);
}
process.on('SIGINT', () => void stop());
process.on('SIGTERM', () => void stop());
for (const child of children) {
  child.once('error', (e) => {
    console.error(e.message);
    void stop(1);
  });
  child.once('exit', (code) => {
    if (!stopping) {
      console.error('Demo service exited: ' + code);
      void stop(1);
    }
  });
}
const read = async (path, body, key) => {
  const response = await fetch(apiUrl + '/api/v1/pipeline' + path, {
    ...(body ? { method: 'POST', body: JSON.stringify(body) } : {}),
    headers: { 'Content-Type': 'application/json', ...(key ? { 'Idempotency-Key': key } : {}) },
  });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error?.message ?? 'DEMO_REQUEST_FAILED');
  return value.data;
};
try {
  let healthy = false;
  for (let i = 0; i < 150; i++) {
    try {
      if ((await fetch(apiUrl + '/health')).ok && (await fetch(webUrl + '/pipeline')).ok) {
        healthy = true;
        break;
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  if (!healthy) throw new Error('DEMO_START_TIMEOUT');
  const existing = await read('/projects'),
    projects = [];
  for (const template of ['A', 'B', 'C']) {
    const project =
      existing.find((p) => p.template === template) ??
      (await read('/projects', { template_id: template }, 'demo-create-' + template));
    let snapshot = await read('/projects/' + project.id);
    // Create a real failure to inspect immediately, without contacting the model.
    if (template !== 'C' && snapshot.executions.length === 0) {
      const execution = await read(
        '/projects/' + project.id + '/executions',
        {},
        'demo-failure-' + template,
      );
      for (let i = 0; i < 100; i++) {
        snapshot = await read('/projects/' + project.id);
        if (snapshot.executions.find((e) => e.id === execution.id)?.status !== 'RUNNING') break;
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    projects.push({
      template,
      id: project.id,
      url: webUrl + '/pipeline/projects/' + project.id,
      status: snapshot.executions[0]?.status ?? 'NOT_RUN',
    });
  }
  const manifest = {
    prepared_at: new Date().toISOString(),
    database: join(folder, 'app.sqlite'),
    model_mode: process.env.MODEL_MODE === 'LIVE' ? 'LIVE' : 'MOCK',
    api_url: apiUrl,
    url: webUrl + '/pipeline',
    projects,
  };
  writeFileSync(join(folder, 'manifest.json'), JSON.stringify(manifest, null, 2));
  console.log(JSON.stringify({ ready: true, ...manifest }, null, 2));
  console.log('Demo ready. Ctrl+C stops both services. Restart preserves this isolated history.');
} catch (e) {
  console.error(e.message);
  await stop(1);
}
