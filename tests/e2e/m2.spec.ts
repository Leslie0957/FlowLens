import { test, expect } from '@playwright/test';

test('mock diagnosis shows evidence, follow-up, approval, and one simulated child run', async ({
  page,
}) => {
  await page.goto('/runs/seed_s04');
  await expect(page.getByRole('heading', { name: '诊断工作台' })).toBeVisible();
  await expect(page.getByText('MOCK 模型 · FIXTURE 数据')).toBeVisible();
  await page.getByRole('button', { name: '新建会话' }).click();
  await expect(page.getByText('本机消息通道已连接', { exact: true })).toBeVisible({
    timeout: 5000,
  });
  await page.getByRole('textbox', { name: '诊断问题' }).fill('这次运行为什么失败？');
  await page.getByRole('button', { name: '发送' }).click();
  await expect(page.getByRole('heading', { name: '诊断结论' })).toBeVisible();
  await expect(page.locator('.diagnosis-result')).toContainText('读取阶段上游超时');
  await page.screenshot({ path: 'logs/m2/diagnosis-desktop.png', fullPage: true });
  await page.reload();
  await expect(page.locator('.diagnosis-result')).toContainText('读取阶段上游超时');
  await page.locator('.evidence-links button').first().click();
  await expect(page.getByRole('dialog', { name: '证据详情' })).toBeVisible();
  await expect(page.getByRole('heading', { name: /证据/ })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: '证据详情' })).toHaveCount(0);
  await page.locator('.evidence-links button').first().click();
  await page.getByRole('button', { name: '关闭引用' }).click();
  await page.getByRole('textbox', { name: '诊断问题' }).fill('重试有用吗？');
  await page.getByRole('button', { name: '发送' }).click();
  await expect(page.locator('.diagnosis-message.user')).toHaveCount(2);
  await page.getByRole('button', { name: '申请重试' }).click();
  await expect(page.getByRole('heading', { name: /人工审批 · PENDING/ })).toBeVisible();
  await page.getByRole('button', { name: '批准模拟重试' }).click();
  await expect(page.getByRole('link', { name: /查看模拟重试运行/ })).toBeVisible();
  await expect(page.getByText('模拟重试成功', { exact: true })).toBeVisible({ timeout: 12000 });
  await page.getByRole('link', { name: /查看模拟重试运行/ }).click();
  await expect(page.locator('.heading-status')).toContainText('已完成', { timeout: 15000 });
  await expect(page.getByText('Report generated (simulated recovery)').first()).toBeVisible();
});

test('diagnosis panel stays accessible without whole-page horizontal overflow', async ({
  page,
}) => {
  for (const width of [1440, 768, 360]) {
    await page.setViewportSize({ width, height: 760 });
    await page.goto('/runs/seed_s05');
    await expect(page.getByRole('heading', { name: '诊断工作台' })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      width,
    );
    if (width === 360)
      await page.screenshot({ path: 'logs/m2/diagnosis-mobile.png', fullPage: true });
  }
});
