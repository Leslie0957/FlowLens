import {test,expect} from '@playwright/test';

test('local SQL execution keeps real failures, a preset control, history and FIXTURE isolation',async({page})=>{
  await page.goto('/local');
  await expect(page.getByRole('heading',{name:'本地执行实验'})).toBeVisible();
  await expect(page.getByText('本步骤未调用模型').first()).toBeVisible();
  await page.getByRole('button',{name:'创建故障项目'}).click();
  await expect(page.getByText('SUM(order_total)')).toBeVisible();
  await expect(page.getByText('尚未运行。创建项目不会启动任务。')).toBeVisible();
  await page.getByRole('button',{name:'运行任务'}).click();
  await expect(page.getByText('SQL_COLUMN_ERROR').first()).toBeVisible();
  await expect(page.getByText('no such column',{exact:false}).first()).toBeVisible();
  await expect(page.locator('.local-execution-list li').first()).toContainText('执行或验证失败');
  const first=page.url();
  await page.getByRole('button',{name:'运行任务'}).click();
  await expect(page.locator('.local-execution-list li')).toHaveCount(2);
  await expect.poll(()=>page.url()).not.toBe(first);
  await expect(page.getByText('SQL_COLUMN_ERROR').first()).toBeVisible();
  await page.reload();
  await expect(page.getByText('SQL_COLUMN_ERROR').first()).toBeVisible();
  const oldHref=await page.locator('.local-execution-list a').last().getAttribute('href');
  const oldId=new URL(oldHref!,'http://localhost').searchParams.get('execution')!;
  await page.route('**/api/v1/local-executions/'+oldId,async route=>{await new Promise(resolve=>setTimeout(resolve,700));await route.continue();});
  await page.locator('.local-execution-list a').last().click();
  await page.locator('.local-execution-list a').first().click();
  await expect(page.locator('.local-detail')).toContainText(new URL(page.url()).searchParams.get('execution')!);
  await page.waitForTimeout(900);
  await expect(page.locator('.local-detail')).toContainText(new URL(page.url()).searchParams.get('execution')!);
  await expect(page.getByText('SQL_COLUMN_ERROR').first()).toBeVisible();
  await page.getByRole('link',{name:'本地执行实验'}).first().click();
  await page.getByRole('button',{name:'创建正常对照'}).click();
  await expect(page.getByRole('heading',{name:'正常对照（预置）'})).toBeVisible();
  await page.getByRole('button',{name:'运行任务'}).click();
  await expect(page.getByText('独立业务验证：通过')).toBeVisible();
  await expect(page.getByText('实际 3 笔 / 100')).toBeVisible();
  await expect(page.locator('.local-execution-list li').first()).toContainText('验证通过');
  await expect(page.getByText('不代表 Agent 修复')).toBeVisible();
  await page.goto('/runs');
  await expect(page.getByText('FIXTURE').first()).toBeVisible();
});

for(const width of [360,768,1440])test(`local experiment fits ${width}px and keeps keyboard navigation`,async({page})=>{
  await page.setViewportSize({width,height:900});
  await page.goto('/local');
  await expect(page.getByRole('link',{name:'本地执行实验'})).toBeVisible();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth+1)).toBe(true);
  await page.keyboard.press('Tab');
  expect(await page.evaluate(()=>document.activeElement?.tagName)).toBe('A');
});
