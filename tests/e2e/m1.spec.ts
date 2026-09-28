import {test,expect} from '@playwright/test';
test('shows persisted fixture runs and opens S04 detail with server logs',async({page})=>{
  await page.goto('/runs');
  await expect(page.getByRole('heading',{name:'运行监控'})).toBeVisible();
  await expect(page.getByText('演示任务数据').first()).toBeVisible();
  await expect(page.locator('tbody tr').filter({hasText:'seed_s00'})).toHaveCount(1);
  await page.locator('tbody tr').filter({hasText:'S04'}).click();
  await expect(page).toHaveURL(/\/runs\/seed_s04/);
  await expect(page.getByText('ReadTimeout: upstream request exceeded 5s').first()).toBeVisible();
  await expect(page.getByText('SKIPPED').first()).toBeVisible();
});
test('creates a new S04 demo run and observes its persisted terminal state',async({page})=>{
  await page.goto('/runs');
  await page.getByRole('button',{name:'新建演示运行'}).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.getByRole('dialog').locator('.scene-option').filter({hasText:'S04'}).getByRole('button',{name:'创建'}).click();
  await expect(page).toHaveURL(/\/runs\/[0-9a-f-]{36}$/);
  await expect(page.locator('.heading-status')).toContainText('已失败',{timeout:12000});
  await expect(page.getByText('ReadTimeout: upstream request exceeded 5s').first()).toBeVisible();
});

test('keeps list filters in the URL and shows a clear unknown-run state',async({page})=>{
  await page.goto('/runs');
  await page.getByRole('button',{name:'已失败'}).click();
  await expect(page).toHaveURL(/status=FAILED/);
  await expect(page.locator('tbody tr').filter({hasText:'seed_s04'})).toHaveCount(1);
  await expect(page.locator('tbody tr').filter({hasText:'seed_s05'})).toHaveCount(1);
  const statuses=await page.locator('tbody tr .status').allTextContents();
  expect(statuses.length).toBeGreaterThanOrEqual(2);expect(statuses.every(text=>text.includes('已失败'))).toBe(true);
  await page.goto('/runs/no_such_run');
  await expect(page.getByRole('heading',{name:'无法打开运行'})).toBeVisible();
  await expect(page.getByText('运行不存在')).toBeVisible();
});

test('expands and collapses a multiline server log',async({page})=>{
  await page.route('**/api/v1/runs/seed_s04/logs*',async route=>{
    await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({data:[{id:'multiline_log',run_id:'seed_s04',seq:1,timestamp:'2026-09-25T09:00:00.000Z',level:'ERROR',step:'read',message:'ReadTimeout\nline two\nline three'}]})});
  });
  await page.goto('/runs/seed_s04');
  await expect(page.getByRole('button',{name:'展开全文'})).toBeVisible();
  await page.getByRole('button',{name:'展开全文'}).click();
  await expect(page.getByRole('button',{name:'收起'})).toBeVisible();
});
