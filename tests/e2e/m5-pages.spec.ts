import { test, expect } from '@playwright/test';

test('history opens an exact older session, survives refresh and rejects a mismatched run', async ({
  page,
  request,
}) => {
  const ids: string[] = [];
  for (const label of ['older', 'latest']) {
    const res = await request.post('/api/v1/sessions', {
      headers: { 'Idempotency-Key': 'm5-history-' + label },
      data: { run_id: 'seed_s00' },
    });
    expect(res.ok()).toBe(true);
    ids.push((await res.json()).data.id);
  }
  await page.goto('/runs/seed_s00?session=' + ids[0]);
  await expect(page.getByRole('combobox', { name: '诊断会话' })).toHaveValue(ids[0]!);
  await page.getByRole('textbox', { name: '诊断问题' }).fill('m5-history-older 成功了吗');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await expect(page.locator('.diagnosis-result')).toHaveAttribute('aria-busy', 'false');
  await page.goto('/diagnoses?q=m5-history-older');
  await expect(page.locator('.history-item')).toHaveCount(1);
  await page.locator('.history-title').click();
  await expect(page).toHaveURL(new RegExp('session=' + ids[0]));
  await expect(page.locator('.diagnosis-result')).toHaveCount(1);
  await page.reload();
  await expect(page.getByRole('combobox', { name: '诊断会话' })).toHaveValue(ids[0]!);
  await expect(page.locator('.diagnosis-result')).toHaveCount(1);
  await page.goto('/runs/seed_s05?session=' + ids[0]);
  await expect(page.getByText('该会话不属于当前运行，不能加载')).toBeVisible();
  await expect(page.locator('.diagnosis-result')).toHaveCount(0);
  await expect(page.getByRole('textbox', { name: '诊断问题' })).toHaveCount(0);
});

test('demo page lists six fixtures and creates a new persisted run', async ({ page }) => {
  await page.goto('/demo');
  await expect(page.locator('.scenario-card')).toHaveCount(6);
  await page.getByRole('button', { name: '创建 S00 演示运行' }).click();
  await expect(page).toHaveURL(/\/runs\/[0-9a-f-]{36}/);
  await expect(page.locator('.heading-status')).toContainText('已完成', { timeout: 12000 });
  await page.reload();
  await expect(page.locator('.heading-status')).toContainText('已完成');
});

test('creation time range composes with search and status, survives refresh and clears', async ({
  page,
}) => {
  await page.goto('/runs');
  await page.getByLabel('创建时间从', { exact: true }).fill('2026-09-25T00:00');
  await page.getByLabel('创建时间至', { exact: true }).fill('2026-09-26T23:59');
  await page.getByRole('button', { name: '应用时间筛选' }).click();
  await expect(page).toHaveURL(/created_from=/);
  await page.getByRole('button', { name: '已失败', exact: true }).click();
  await page.getByRole('textbox', { name: '搜索任务', exact: true }).fill('订单');
  await expect(page).toHaveURL(/q=/);
  await expect(page.locator('tbody tr')).toHaveCount(5);
  await page.reload();
  await expect(page.locator('tbody tr')).toHaveCount(5);
  await expect(page.getByLabel('创建时间从', { exact: true })).toHaveValue('2026-09-25T00:00');
  await page.getByLabel('创建时间从', { exact: true }).fill('2026-09-27T00:00');
  await page.getByRole('button', { name: '应用时间筛选' }).click();
  await expect(page.getByRole('alert')).toContainText('开始时间不能晚于结束时间');
  await page.getByRole('button', { name: '清除时间筛选' }).click();
  await expect(page).not.toHaveURL(/created_from=/);
  await expect(page).toHaveURL(/status=FAILED/);
});

test('10000 real stored logs and 200 stored tools stay bounded and evidence outside the page is reachable', async ({
  page,
  request,
}, testInfo) => {
  const start = Date.now();
  const res = await request.get('/api/v1/sessions?run_id=m5_pressure_run');
  const sessionId = (await res.json()).data[0].id;
  const snapshot = await request.get('/api/v1/sessions/' + sessionId);
  expect((await snapshot.json()).data.tool_calls).toHaveLength(200);
  const logs = await request.get('/api/v1/runs/m5_pressure_run/logs');
  expect((await logs.json()).data).toHaveLength(200);
  const replay = await request.get('/api/v1/sessions/' + sessionId + '/events?after_seq=0');
  expect((await replay.text()).match(/event: tool.completed/g)).toHaveLength(200);
  await page.goto('/runs/m5_pressure_run?session=' + sessionId);
  await expect(page.locator('.log-row')).toHaveCount(200);
  await expect(page.locator('.log-row').first()).toContainText('9801');
  await expect(page.locator('.tool-card')).toHaveCount(0);
  await page.locator('.tool-trace>summary').click();
  await expect(page.locator('.tool-card')).toHaveCount(20);
  await page.getByRole('button', { name: '较新工具' }).click();
  await expect(page.locator('.tool-card').first()).toContainText('pressure_tool_21');
  await page.getByRole('button', { name: '加载更早日志' }).click();
  await expect(page.locator('.log-row').first()).toContainText('9601');
  await expect(page.locator('.log-row')).toHaveCount(200);
  await page.getByRole('button', { name: '加载较新日志' }).click();
  await expect(page.locator('.log-row').first()).toContainText('9801');
  await page.getByRole('button', { name: '回到最新日志' }).click();
  await expect(page.locator('.log-row').last()).toContainText('10000');
  await page.locator('.evidence-links button').first().click();
  await expect(page.getByRole('dialog', { name: '证据详情' })).toContainText('pressure fixture');
  await expect(page.getByRole('dialog', { name: '证据详情' }).locator('.highlight')).toContainText(
    '50',
  );
  const metrics = await page.evaluate(() => ({
    log_rows: document.querySelectorAll('.log-row').length,
    tool_cards: document.querySelectorAll('.tool-card').length,
    dom_nodes: document.querySelectorAll('*').length,
    viewport: { width: innerWidth, height: innerHeight },
    user_agent: navigator.userAgent,
  }));
  await testInfo.attach('m5-pressure.json', {
    body: JSON.stringify({
      stored_logs: 10000,
      stored_tools: 200,
      elapsed_ms: Date.now() - start,
      ...metrics,
    }),
    contentType: 'application/json',
  });
});

test('pages remain within the viewport at 360, 768 and 1440 widths', async ({ page }, testInfo) => {
  for (const width of [360, 768, 1440])
    for (const path of ['/runs', '/diagnoses', '/demo', '/runs/seed_s04']) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(path);
      await expect(page.locator('h1')).toBeVisible();
      await page.waitForLoadState('networkidle');
      const size = await page.evaluate(() => ({
        scroll: document.documentElement.scrollWidth,
        viewport: innerWidth,
      }));
      expect(size.scroll, `${path} at ${width}px`).toBeLessThanOrEqual(size.viewport + 1);
      if (path === '/demo' || path === '/diagnoses')
        await testInfo.attach('m5-' + path.slice(1) + '-' + width + '.png', {
          body: await page.screenshot({ fullPage: true }),
          contentType: 'image/png',
        });
    }
});
