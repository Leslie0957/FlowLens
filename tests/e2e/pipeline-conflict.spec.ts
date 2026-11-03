import { test, expect } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

test('D07 card creates real conflict data and uses actual MCP for a durable non-modification diagnosis', async ({
  page,
  request,
}) => {
  await page.goto('/pipeline');
  await expect(page.getByRole('radio')).toHaveCount(4);
  await page.getByRole('radio', { name: 'D07 · 目标数据冲突', exact: true }).check();
  await page.getByRole('button', { name: '创建车辆任务', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'D07 · 目标数据冲突' })).toBeVisible();
  const endpoint = '/api/v1' + new URL(page.url()).pathname;
  const before = (await (await request.get(endpoint)).json()).data;
  expect(before.target.row_count).toBe(1);
  expect(before.executions).toHaveLength(0);
  expect(before.repairs).toHaveLength(0);
  await page.getByRole('button', { name: '运行只读预检', exact: true }).click();
  await expect(page.getByText('BUSINESS_KEY_CONFLICT', { exact: false }).first()).toBeVisible();
  await expect(page.locator('.pipeline-validation-note')).toContainText('通过');
  const failed = (await (await request.get(endpoint)).json()).data.executions[0];
  expect(failed).toMatchObject({
    status: 'FAILED',
    failed_step: 'precheck',
    validation: { passed: true },
    precheck: { conflicts: 1 },
  });
  await page.getByRole('button', { name: 'Agent 取证并生成候选', exact: true }).click();
  await expect(page.getByText('需要人工处理', { exact: true })).toBeVisible();
  await expect(page.getByText('需要人工核对，未修改数据', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '批准修复并入库', exact: true })).toHaveCount(0);
  await expect(page.locator('.pipeline-diff')).toHaveCount(0);
  let snapshot = (await (await request.get(endpoint)).json()).data;
  expect(snapshot.repairs[0]).toMatchObject({
    provider_mode: 'MOCK',
    action: 'MANUAL_REQUIRED',
    candidate: null,
    prompt_version: 'grounded-actions-v1',
  });
  expect(
    snapshot.repairs[0].tools.every(
      (t: { transport: string; status: string }) =>
        t.transport === 'MCP' && t.status === 'COMPLETED',
    ),
  ).toBe(true);
  expect(snapshot.target).toEqual(before.target);
  await page.reload();
  await expect(page.getByText('需要人工处理', { exact: true })).toBeVisible();
  snapshot = (await (await request.get(endpoint)).json()).data;
  expect(snapshot.executions).toHaveLength(1);
  expect(snapshot.repairs).toHaveLength(1);
  expect(snapshot.target).toEqual(before.target);
  const rows = (
    await (
      await request.post(endpoint + '/query', {
        data: { scope: 'target', sql: 'SELECT * FROM mining_results;' },
      })
    ).json()
  ).data;
  expect(rows.row_count).toBe(1);
  expect(rows.rows[0].car_series).toBe('EXISTING_DIFFERENT_SERIES');
  mkdirSync(resolve('logs/pipeline/d07-browser'), { recursive: true });
  await page.screenshot({ path: 'logs/pipeline/d07-browser/diagnosis.png', fullPage: true });
  await page.goto('/pipeline');
  for (const width of [1440, 768, 360]) {
    await page.setViewportSize({ width, height: 900 });
    await expect(
      page.getByRole('radio', { name: 'D07 · 目标数据冲突', exact: true }),
    ).toBeVisible();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
    ).toBe(true);
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.screenshot({ path: 'logs/pipeline/d07-browser/scenarios.png', fullPage: true });
});
