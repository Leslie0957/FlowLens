import { test, expect } from '@playwright/test';

test('lost commit acknowledgement recovers from the actual receipt, opens results and restores there without repeating writes on reload', async ({
  page,
  request,
}) => {
  const project = (
    await (
      await request.post('/api/v1/pipeline/projects', {
        headers: { 'Idempotency-Key': crypto.randomUUID() },
        data: { template_id: 'C' },
      })
    ).json()
  ).data;
  const endpoint = '/api/v1/pipeline/projects/' + project.id;
  await page.goto('/pipeline/projects/' + project.id);
  await page.getByRole('button', { name: '运行只读预检' }).click();
  await expect(page.getByRole('button', { name: '批准本次入库' })).toBeEnabled();
  let commits = 0;
  await page.route('**/commit', async (route) => {
    commits++;
    if (commits === 1) {
      await route.fetch();
      await route.abort();
    } else await route.continue();
  });
  await page.getByRole('button', { name: '批准本次入库' }).click();
  await expect(page.getByRole('heading', { name: '入库结果复查' })).toBeVisible();
  await expect(page.locator('.el-table__body')).toContainText('synthetic_segment_01');
  expect(commits).toBe(1);
  let state = (await (await request.get(endpoint)).json()).data;
  const committedRevision = state.revision;
  expect(state.target.row_count).toBe(4);
  expect(state.batches).toHaveLength(1);
  expect(state.operations.filter((op: { type: string }) => op.type === 'COMMIT')).toHaveLength(1);
  await page.reload();
  await expect(page.locator('.el-table__body')).toContainText('synthetic_segment_01');
  expect(commits).toBe(1);
  for (const width of [360, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
    ).toBe(true);
  }
  await page.getByRole('button', { name: '发现问题，只撤销本次数据' }).click();
  await expect(page.getByRole('region', { name: '确认数据撤销范围' })).toContainText(
    '入库前的 0 行',
  );
  await expect(page.getByRole('region', { name: '确认数据撤销范围' })).toContainText(
    '保留当前 SQL',
  );
  await page.getByRole('button', { name: '保留当前数据' }).click();
  expect((await (await request.get(endpoint)).json()).data.target.row_count).toBe(4);
  await page.getByRole('button', { name: '发现问题，只撤销本次数据' }).click();
  await page.getByRole('button', { name: '确认只撤销数据' }).click();
  await expect(page.getByRole('heading', { name: '本次数据已撤销' })).toBeVisible();
  await expect(page.getByText('查询成功，0 行', { exact: true })).toBeVisible();
  await expect(page.getByText('恢复凭证', { exact: false })).toBeVisible();
  await expect(page.getByRole('button', { name: '发现问题，只撤销本次数据' })).toHaveCount(0);
  state = (await (await request.get(endpoint)).json()).data;
  expect(state.target.row_count).toBe(0);
  expect(state.revision).toEqual(committedRevision);
  expect(state.project.current_revision_id).toBe(committedRevision.id);
  expect(state.batches).toHaveLength(1);
  expect(state.executions).toHaveLength(1);
  expect(state.batches[0].status).toBe('RESTORED');
  await page.reload();
  await expect(page.getByRole('heading', { name: '本次数据已撤销' })).toBeVisible();
  expect((await (await request.get(endpoint)).json()).data.operations).toHaveLength(2);
});

test('a rejected commit request stays on the approval screen and can be retried without a false success page', async ({
  page,
  request,
}) => {
  const project = (
    await (
      await request.post('/api/v1/pipeline/projects', {
        headers: { 'Idempotency-Key': crypto.randomUUID() },
        data: { template_id: 'C' },
      })
    ).json()
  ).data;
  const endpoint = '/api/v1/pipeline/projects/' + project.id;
  await page.goto('/pipeline/projects/' + project.id);
  await page.getByRole('button', { name: '运行只读预检' }).click();
  await expect(page.getByRole('button', { name: '批准本次入库' })).toBeEnabled();
  let first = true;
  await page.route('**/commit', async (route) => {
    if (first) {
      first = false;
      await route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ error: { message: 'temporary commit request failure' } }),
      });
    } else await route.continue();
  });
  await page.getByRole('button', { name: '批准本次入库' }).click();
  await expect(page.getByRole('alert')).toContainText('temporary commit request failure');
  await expect(page.getByRole('heading', { name: '入库结果复查' })).toHaveCount(0);
  expect((await (await request.get(endpoint)).json()).data.target.row_count).toBe(0);
  await page.getByRole('button', { name: '批准本次入库' }).click();
  await expect(page.getByRole('heading', { name: '入库结果复查' })).toBeVisible();
  await expect(page.locator('.el-table__body')).toContainText('synthetic_segment_01');
  expect((await (await request.get(endpoint)).json()).data.batches).toHaveLength(1);
});
