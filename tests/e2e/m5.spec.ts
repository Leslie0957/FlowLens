import { test, expect } from '@playwright/test';

for (const item of [
  {
    id: 'S01',
    summary: '校验阶段缺少必填字段 amount',
    log: 'required=[order_id,amount], observed=[order_id]',
  },
  {
    id: 'S02',
    summary: '聚合阶段 SQL 引用了不存在的 order_total 列',
    log: 'no such column: order_total',
  },
  {
    id: 'S03',
    summary: '入库阶段订单主键唯一约束冲突',
    log: 'UNIQUE constraint failed: orders.order_id',
  },
])
  test(
    item.id + ' can be created, diagnosed, cited, followed up and restored without retry',
    async ({ page }) => {
      await page.goto('/runs');
      await page.getByRole('button', { name: '新建演示运行' }).click();
      await page
        .getByRole('dialog')
        .locator('.scene-option')
        .filter({ hasText: item.id })
        .getByRole('button', { name: '创建' })
        .click();
      await expect(page.locator('.heading-status')).toContainText('失败', { timeout: 12000 });
      await expect(page.getByText('MOCK 模型 · FIXTURE 数据')).toBeVisible();
      await page.getByRole('button', { name: '新建会话' }).click();
      await expect(page.getByText('本机消息通道已连接', { exact: true })).toBeVisible();
      for (const [index, question] of ['分析失败原因并给出证据', '帮我修复并重试'].entries()) {
        await page.getByRole('textbox', { name: '诊断问题' }).fill(question);
        await page.getByRole('button', { name: '发送', exact: true }).click();
        await expect(page.locator('.diagnosis-result')).toHaveCount(index + 1);
        await expect(page.locator('.diagnosis-result').last()).toHaveAttribute(
          'aria-busy',
          'false',
        );
        await expect(page.locator('.diagnosis-result').last()).toContainText(item.summary);
      }
      await expect(page.locator('.diagnosis-result')).toHaveCount(2);
      const cite = page
        .locator('.diagnosis-result')
        .last()
        .locator('.evidence-links button')
        .first();
      await cite.click();
      await expect(page.getByRole('dialog', { name: '证据详情' })).toContainText(item.log);
      await cite.click();
      await expect(page.getByRole('dialog', { name: '证据详情' })).toHaveCount(0);
      await expect(page.getByRole('button', { name: '申请重试', exact: true })).toHaveCount(0);
      await page.reload();
      await expect(page.locator('.diagnosis-result')).toHaveCount(2);
      await expect(page.locator('.diagnosis-result').last()).toContainText(item.summary);
      await expect(page.getByRole('button', { name: '申请重试', exact: true })).toHaveCount(0);
    },
  );
