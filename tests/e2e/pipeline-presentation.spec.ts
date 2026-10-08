import { test, expect } from '@playwright/test';
import { mkdirSync } from 'node:fs';

test('Pipeline is primary and archived experiments remain reachable and fit narrow windows', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/pipeline');
  const archive = page.locator('.legacy-nav');
  await expect(archive).not.toHaveAttribute('open', '');
  await expect(page.getByRole('link', { name: '本地执行实验' })).toBeHidden();
  await expect(page.getByRole('radiogroup', { name: '车辆任务模板' })).toBeVisible();
  await page.getByRole('radio', { name: 'B · 输出契约错误' }).check();
  await expect(page.getByRole('radio', { name: 'B · 输出契约错误' })).toBeChecked();
  mkdirSync('docs/demos', { recursive: true });
  await page.screenshot({ path: 'docs/demos/pipeline-overview-20261008.png', fullPage: true });
  await archive.locator('summary').focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('link', { name: '本地执行实验' })).toBeVisible();
  await page.getByRole('link', { name: '本地执行实验' }).click();
  await expect(page.getByRole('heading', { name: '本地执行实验' })).toBeVisible();
  await expect(page.getByRole('link', { name: '运行监控' })).toBeVisible();
  for (const width of [360, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/pipeline');
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
    ).toBe(true);
  }
});

test('evidence opens real bound facts and one repair approval reaches committed results while retaining history', async ({
  page,
  request,
}) => {
  mkdirSync('docs/demos', { recursive: true });
  const project = (
    await (
      await request.post('/api/v1/pipeline/projects', {
        headers: { 'Idempotency-Key': crypto.randomUUID() },
        data: { template_id: 'A' },
      })
    ).json()
  ).data;
  const endpoint = '/api/v1/pipeline/projects/' + project.id;
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/pipeline/projects/' + project.id);
  await page.getByRole('button', { name: '运行只读预检' }).click();
  await page.getByRole('button', { name: 'Agent 取证并生成候选' }).click();
  await expect(page.getByRole('button', { name: '批准修复并入库' })).toBeVisible();
  const state = (await (await request.get(endpoint)).json()).data,
    repair = state.repairs[0],
    failed = state.executions[0];
  expect(repair.provider_mode).toBe('MOCK');
  expect(repair.tools.map((t) => t.name)).toEqual(['get_sql', 'get_schema']);
  await expect(page.locator('.pipeline-next')).toContainText('修复候选已生成');
  await expect(page.getByRole('button', { name: 'Agent 取证并生成候选' })).toBeDisabled();
  const chip = page.locator('.pipeline-evidence-links button').first();
  await chip.click();
  const dialog = page.getByRole('dialog', { name: '取证内容 · 初始失败观测' });
  await expect(dialog).toContainText(failed.id);
  await expect(dialog).toContainText('SQL_QUERY_FAILED');
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(chip).toBeFocused();
  await page.locator('.pipeline-tools summary').first().click();
  await expect(page.locator('.pipeline-tools details').first()).toContainText(state.revision.sql);
  await page.locator('.pipeline-tools summary').first().click();
  await page.screenshot({ path: 'docs/demos/pipeline-workflow-20261008.png', fullPage: true });
  for (const width of [360, 768, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
    ).toBe(true);
  }
  await page.getByRole('button', { name: '批准修复并入库' }).click();
  await expect(page.getByRole('heading', { name: '入库结果复查' })).toBeVisible();
  const after = (await (await request.get(endpoint)).json()).data;
  expect(after.target.row_count).toBe(4);
  expect(after.executions).toHaveLength(2);
  expect(
    after.executions.some(
      (e: { id: string; status: string }) => e.id === failed.id && e.status === 'FAILED',
    ),
  ).toBe(true);
  expect(after.repairs[0].commit_approval).toMatchObject({
    status: 'COMMITTED',
    batch_id: after.batches[0].id,
  });
  await page.reload();
  await expect(page.locator('.el-table__body')).toContainText('synthetic_segment_01');
  expect((await (await request.get(endpoint)).json()).data.executions).toHaveLength(2);
  await page.getByRole('link', { name: '复查无误，完成' }).click();
  await page.getByRole('combobox', { name: '执行历史' }).press('ArrowDown');
  await page.getByRole('option', { name: new RegExp(failed.id.slice(0, 8)) }).click();
  await expect(page.getByText('正在查看旧版本的执行', { exact: false })).toBeVisible();
  await expect(page.locator('.pipeline-diff')).toContainText('speed_mps');
});

test('reload during repair approval follows the persisted backend approval through exactly one precheck and commit', async ({
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
    ).data,
    endpoint = '/api/v1/pipeline/projects/' + project.id;
  await page.goto('/pipeline/projects/' + project.id);
  await page.getByRole('button', { name: '运行只读预检' }).click();
  await page.getByRole('button', { name: 'Agent 取证并生成候选' }).click();
  await expect(page.getByRole('button', { name: '批准修复并入库' })).toBeVisible();
  let accepted = false,
    release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  await page.route('**/approve', async (route) => {
    await route.fetch();
    accepted = true;
    await held;
    try {
      await route.abort();
    } catch {
      /* old page request was cancelled */
    }
  });
  await page.getByRole('button', { name: '批准修复并入库' }).click();
  await expect.poll(() => accepted).toBe(true);
  await page.reload();
  release();
  await expect(page.getByRole('heading', { name: '入库结果复查' })).toBeVisible();
  const state = (await (await request.get(endpoint)).json()).data;
  expect(state.executions).toHaveLength(2);
  expect(
    state.executions.filter(
      (e: { kind: string; revision_id: string }) =>
        e.kind === 'CANDIDATE_CHECK' && e.revision_id === state.revision.id,
    ),
  ).toHaveLength(1);
  expect(state.target.row_count).toBe(4);
  expect(state.batches).toHaveLength(1);
  expect(state.operations.filter((op: { type: string }) => op.type === 'COMMIT')).toHaveLength(1);
});
