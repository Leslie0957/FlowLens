import {test,expect} from '@playwright/test';

test('AC01 creates a normal fixture run and shows persisted success and summary',async({page})=>{
 await page.goto('/runs');await page.getByRole('button',{name:'新建演示运行'}).click();
 await page.getByRole('dialog').locator('.scene-option').filter({hasText:'S00'}).getByRole('button',{name:'创建'}).click();
 await expect(page).toHaveURL(/\/runs\/[0-9a-f-]{36}$/);
 await expect(page.locator('.heading-status')).toContainText('已完成',{timeout:12000});
 await expect(page.locator('.summary-note')).toContainText('1000');await expect(page.locator('.summary-note')).toContainText('FIXTURE');
 await expect(page.getByText('Report generated (fixture)').first()).toBeVisible();
 await page.reload();await expect(page.locator('.summary-note')).toContainText('1000');
});

test('AC23 displays an unfamiliar read-only tool name through the generic snapshot renderer',async({page})=>{
 await page.goto('/runs/seed_s05');await page.getByRole('button',{name:'新建会话'}).click();
 await page.getByRole('textbox',{name:'诊断问题'}).fill('现有证据够吗');await page.getByRole('button',{name:'发送',exact:true}).click();
 await expect(page.locator('.diagnosis-result')).toHaveCount(1);
 await page.locator('.tool-trace > summary').click();
 const logs=page.locator('.tool-card').filter({hasText:'get_task_logs'});await logs.getByText('参数与查询结果',{exact:true}).click();
 await expect(logs).toContainText('调用 ID：');await expect(logs).toContainText('ms');await expect(logs.locator('pre').last()).toContainText('diagnostic detail unavailable');
 await page.route('**/api/v1/sessions/*',async route=>{
  if(route.request().method()!=='GET'||!route.request().url().match(/\/sessions\/[^/?]+$/)){await route.continue();return;}
  const response=await route.fetch(),body=await response.json();body.data.tool_calls[0].name='read_test_signal';await route.fulfill({response,json:body});
 });
 await page.reload();await page.locator('.tool-trace > summary').click();
 await expect(page.locator('.tool-card').filter({hasText:'read_test_signal'})).toContainText('SUCCEEDED');
 const restored=page.locator('.tool-card').filter({hasText:'read_test_signal'});await restored.getByText('参数与查询结果',{exact:true}).click();await expect(restored.locator('pre').last()).toContainText('diagnostic detail unavailable');
 await expect(page.locator('.diagnosis-result')).toHaveCount(1);
});

test('creating a new session prevents editing the outgoing composer until the new snapshot is ready',async({page})=>{
 await page.goto('/runs/seed_s05');
 const initialResponse=page.waitForResponse(r=>r.request().method()==='POST'&&r.url().endsWith('/api/v1/sessions'));
 await page.getByRole('button',{name:'新建会话'}).click();const initialId=(await (await initialResponse).json()).data.id;
 await expect(page.getByRole('combobox',{name:'诊断会话'})).toHaveValue(initialId);
 await expect(page.getByRole('textbox',{name:'诊断问题'})).toBeVisible();
 let release!:()=>void,requested=false;const gate=new Promise<void>(resolve=>release=resolve);
 await page.route('**/api/v1/sessions',async route=>{if(route.request().method()==='POST'){requested=true;await gate;}await route.continue();});
 const response=page.waitForResponse(r=>r.request().method()==='POST'&&r.url().endsWith('/api/v1/sessions'));
 try{
  await page.getByRole('button',{name:'新建会话'}).click();await expect.poll(()=>requested).toBe(true);
  await expect(page.getByRole('textbox',{name:'诊断问题'})).toBeDisabled();
  release();const id=(await (await response).json()).data.id;
  await expect(page.getByRole('combobox',{name:'诊断会话'})).toHaveValue(id);
  const compose=page.getByRole('textbox',{name:'诊断问题'});await expect(compose).toBeEnabled();await compose.fill('保留这段输入');await expect(compose).toHaveValue('保留这段输入');
 }finally{release();await response.catch(()=>null);}
});
