import { test, expect } from '@playwright/test';

test('one approved local Agent candidate creates a real verified revision while old failure remains', async ({
  page,
}) => {
  await page.goto('/local');
  await page.getByRole('button', { name: '创建故障项目' }).click();
  await page.getByRole('button', { name: '运行任务' }).click();
  await expect(page.getByText('SQL_COLUMN_ERROR').first()).toBeVisible();
  const oldExecution = new URL(page.url()).searchParams.get('execution');
  await page.getByRole('button', { name: '诊断并生成候选' }).click();
  await expect(page.getByText('PENDING_APPROVAL').first()).toBeVisible();
  await expect(page.getByText('MOCK ·', { exact: false }).first()).toBeVisible();
  await expect(page.getByText('get_local_sql').first()).toBeVisible();
  await expect(page.getByText('no such column', { exact: false }).last()).toBeVisible();
  await expect(page.getByText('SUM(amount)', { exact: false }).last()).toBeVisible();
  await page.reload();
  await expect(page.getByRole('button', { name: '批准并实际验证' })).toBeVisible();
  await page.getByRole('button', { name: '批准并实际验证' }).click();
  await expect(page.getByText('独立业务验证 通过')).toBeVisible();
  await expect(page.getByText('SQL_COLUMN_ERROR').first()).toBeVisible();
  await expect(page.locator('.local-execution-list li')).toHaveCount(2);
  await page.getByRole('link', { name: '查看验证执行与日志' }).click();
  await expect(page.getByText('独立业务验证：通过')).toBeVisible();
  expect(new URL(page.url()).searchParams.get('execution')).not.toBe(oldExecution);
});
