import { test, expect } from '@playwright/test';

test('a real execution finishes on screen without reload even when the open SSE stream loses its events', async ({
  page,
  request,
}) => {
  const project = (
    await (
      await request.post('/api/v1/pipeline/projects', {
        headers: { 'Idempotency-Key': crypto.randomUUID() },
        data: { template_id: 'A' },
      })
    ).json()
  ).data;
  const endpoint = '/api/v1/pipeline/projects/' + project.id,
    initial = (await (await request.get(endpoint)).json()).data;
  let submits = 0,
    started: unknown,
    heldStartingSnapshot = false;
  // Keep the genuine event stream open, but deliver only its connection/heartbeat
  // frames. The actual child query and saved execution are not mocked.
  await page.addInitScript(() => {
    const original = window.fetch.bind(window);
    window.fetch = async (input, init) => {
      const url = String(input);
      const response = await original(input, init);
      if (!url.includes('/events?') || !response.body) return response;
      return new Response(
        response.body.pipeThrough(
          new TransformStream<Uint8Array, Uint8Array>({
            transform(_chunk, controller) {
              controller.enqueue(new TextEncoder().encode(': heartbeat\n\n'));
            },
          }),
        ),
        { status: response.status, headers: response.headers },
      );
    };
  });
  await page.route('**' + endpoint + '/executions', async (route) => {
    const response = await route.fetch();
    started = (await response.json()).data;
    await route.fulfill({ response });
  });
  // Deliver the genuine starting execution once, as if its snapshot was captured
  // before the child finished and arrived late. Later GETs read the real server.
  await page.route('**' + endpoint, async (route) => {
    if (started && !heldStartingSnapshot) {
      heldStartingSnapshot = true;
      await route.fulfill({
        json: { data: { ...initial, executions: [started], cursor: initial.cursor + 1 } },
      });
    } else await route.continue();
  });
  page.on('request', (req) => {
    if (req.method() === 'POST' && req.url().endsWith(endpoint + '/executions')) submits++;
  });
  await page.goto('/pipeline/projects/' + project.id);
  await expect(page.getByText('实时连接', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '运行只读预检' }).click();
  await expect(page.getByText('no such column: speed_kph', { exact: false }).first()).toBeVisible();
  await expect(page.getByRole('button', { name: '取消执行' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Agent 取证并生成候选' })).toBeEnabled();
  expect(heldStartingSnapshot).toBe(true);
  expect(submits).toBe(1);
  const snapshot = (await (await request.get(endpoint)).json()).data;
  expect(snapshot.executions).toHaveLength(1);
  expect(snapshot.executions[0].status).toBe('FAILED');
  expect(snapshot.repairs).toHaveLength(0);
  expect(snapshot.target.row_count).toBe(0);
});
