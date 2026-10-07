import {test,expect} from '@playwright/test';
import {mkdirSync} from 'node:fs';

test('Pipeline is primary and archived experiments remain reachable and fit narrow windows',async({page})=>{
 await page.setViewportSize({width:1440,height:1000});await page.goto('/pipeline');
 const archive=page.locator('.legacy-nav');await expect(archive).not.toHaveAttribute('open','');await expect(page.getByRole('link',{name:'本地执行实验'})).toBeHidden();
 await expect(page.getByRole('radiogroup',{name:'车辆任务模板'})).toBeVisible();await page.getByRole('radio',{name:'B · 输出契约错误'}).check();await expect(page.getByRole('radio',{name:'B · 输出契约错误'})).toBeChecked();
 mkdirSync('docs/demos',{recursive:true});await page.screenshot({path:'docs/demos/pipeline-overview-20261008.png',fullPage:true});
 await archive.locator('summary').focus();await page.keyboard.press('Enter');await expect(page.getByRole('link',{name:'本地执行实验'})).toBeVisible();await page.getByRole('link',{name:'本地执行实验'}).click();await expect(page.getByRole('heading',{name:'本地执行实验'})).toBeVisible();await expect(page.getByRole('link',{name:'运行监控'})).toBeVisible();
 for(const width of [360,768,1440]){await page.setViewportSize({width,height:900});await page.goto('/pipeline');expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth+1)).toBe(true);}
});

test('evidence opens real bound facts and next-step guidance follows the current version while history stays pinned',async({page,request})=>{
 mkdirSync('docs/demos',{recursive:true});
 const project=(await (await request.post('/api/v1/pipeline/projects',{headers:{'Idempotency-Key':crypto.randomUUID()},data:{template_id:'A'}})).json()).data;
 const endpoint='/api/v1/pipeline/projects/'+project.id;
 await page.setViewportSize({width:1440,height:1000});await page.goto('/pipeline/projects/'+project.id);await page.getByRole('button',{name:'运行只读预检'}).click();await page.getByRole('button',{name:'Agent 取证并生成候选'}).click();await expect(page.getByRole('button',{name:'批准修复并验证'})).toBeVisible();
 const state=(await (await request.get(endpoint)).json()).data,repair=state.repairs[0],failed=state.executions[0];expect(repair.provider_mode).toBe('MOCK');expect(repair.tools).toHaveLength(6);
 await expect(page.locator('.pipeline-next')).toContainText('修复候选已生成');await expect(page.getByRole('button',{name:'Agent 取证并生成候选'})).toBeDisabled();
 const chip=page.locator('.pipeline-evidence-links button').first();await chip.click();const dialog=page.getByRole('dialog',{name:'取证内容 · 执行信息'});await expect(dialog).toContainText(failed.id);await expect(dialog).toContainText('SQL_QUERY_FAILED');await page.keyboard.press('Escape');await expect(dialog).toBeHidden();await expect(chip).toBeFocused();
 await page.locator('.pipeline-tools summary').first().click();await expect(page.locator('.pipeline-tools details').first()).toContainText(failed.id);await page.locator('.pipeline-tools summary').first().click();
 await page.screenshot({path:'docs/demos/pipeline-workflow-20261008.png',fullPage:true});
 for(const width of [360,768,1440]){await page.setViewportSize({width,height:1000});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth+1)).toBe(true);}
 await page.getByRole('button',{name:'批准修复并验证'}).click();await expect(page.getByText('验证通过并已发布',{exact:false})).toBeVisible();await expect(page.locator('.pipeline-next')).toContainText('修复已验证');await expect(page.getByText('正在查看旧版本的执行',{exact:false})).toBeVisible();expect(new URL(page.url()).searchParams.get('execution')).toBe(failed.id);
 await page.getByRole('button',{name:'定位操作 ↓'}).click();await expect(page.getByRole('textbox',{name:'task.sql 编辑器'})).toBeFocused();await page.getByRole('button',{name:'运行只读预检'}).click();await expect(page.locator('.pipeline-next')).toContainText('预检通过');await expect(page.getByRole('button',{name:'批准本次入库'})).toBeEnabled();
 expect((await (await request.get(endpoint)).json()).data.target.row_count).toBe(0);
});
