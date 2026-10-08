import { test, expect } from '@playwright/test';

test('an explicitly authorized bounded loop performs one real verification and restores its history', async ({
  page,
}) => {
  await page.goto('/local');
  await page.getByRole('button', { name: '创建故障项目' }).click();
  await page.getByRole('button', { name: '运行任务' }).click();
  await expect(page.getByText('SQL_COLUMN_ERROR').first()).toBeVisible();
  const initial = new URL(page.url()).searchParams.get('execution');
  const authorize = page.getByRole('button', { name: '批准有限修复循环' });
  await expect(authorize).toBeDisabled();
  await page.getByRole('checkbox', { name: '我批准当前合成项目在上述范围内自动继续修复' }).check();
  await authorize.click();
  await expect(page.locator('p').filter({ hasText: '循环状态：' })).toContainText('SUCCEEDED');
  await expect(page.getByText('1 / 3 轮', { exact: false })).toBeVisible();
  await expect(page.getByText('3 笔 / 100 通过')).toBeVisible();
  await page.reload();
  await expect(page.locator('p').filter({ hasText: '循环状态：' })).toContainText('SUCCEEDED');
  await page.getByRole('link', { name: '查看本轮执行与日志' }).click();
  await expect(page.getByText('独立业务验证：通过')).toBeVisible();
  expect(new URL(page.url()).searchParams.get('execution')).not.toBe(initial);
});
