import {test,expect} from '@playwright/test';

test('new validated diagnosis reveals gradually, refresh and execution reselection show history immediately',async({page,request})=>{
 const project=(await (await request.post('/api/v1/pipeline/projects',{headers:{'Idempotency-Key':crypto.randomUUID()},data:{template_id:'A'}})).json()).data;
 const endpoint='/api/v1/pipeline/projects/'+project.id;
 await page.goto('/pipeline/projects/'+project.id);await page.getByRole('button',{name:'运行只读预检'}).click();await expect(page.getByRole('button',{name:'Agent 取证并生成候选'})).toBeEnabled();
 const failed=(await (await request.get(endpoint)).json()).data.executions[0];
 await page.getByRole('button',{name:'Agent 取证并生成候选'}).click();const answer=page.locator('.pipeline-diagnosis-answer');await expect(answer).toHaveAttribute('aria-busy','true');await expect(page.getByText('结论已校验，正在逐步展示…')).toBeVisible();await expect(page.locator('.pipeline-diff')).toHaveCount(0);
 const snapshot=(await (await request.get(endpoint)).json()).data,diagnosis=snapshot.repairs[0].diagnosis;expect(snapshot.repairs[0].status).toBe('PENDING_APPROVAL');const partial=(await page.locator('.pipeline-diagnosis-text').innerText()).replace(/▍$/,'');expect(partial.length).toBeLessThan(diagnosis.length);expect(diagnosis.startsWith(partial)).toBe(true);
 // Reload during presentation restores the already verified server history.
 await page.reload();await expect(answer).toHaveAttribute('aria-busy','false');await expect(page.locator('.pipeline-diagnosis-text')).toHaveText(diagnosis);await expect(page.getByRole('button',{name:'批准修复并入库'})).toBeVisible();
 await page.getByRole('button',{name:'运行只读预检'}).click();await expect(page.getByRole('button',{name:'Agent 取证并生成候选'})).toBeEnabled();await expect(answer).toHaveCount(0);
 await page.getByRole('combobox',{name:'执行历史'}).press('ArrowDown');await page.getByRole('option',{name:new RegExp(failed.id.slice(0,8))}).click();await expect(answer).toHaveAttribute('aria-busy','false');await expect(page.locator('.pipeline-diagnosis-text')).toHaveText(diagnosis);
});
