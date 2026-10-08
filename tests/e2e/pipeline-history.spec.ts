import { test, expect } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

test('actual rounds and evidence survive refresh; history distinguishes failure, combined candidate check and ordinary rerun', async ({
  page,
  request,
}) => {
  const headers = () => ({ 'Idempotency-Key': crypto.randomUUID() });
  const project = (
    await (
      await request.post('/api/v1/pipeline/projects', {
        headers: headers(),
        data: { template_id: 'A' },
      })
    ).json()
  ).data;
  const endpoint = '/api/v1/pipeline/projects/' + project.id;
  const snapshot = async () => (await (await request.get(endpoint)).json()).data;
  await page.goto('/pipeline/projects/' + project.id);
  await page.getByRole('button', { name: '运行只读预检' }).click();
  await expect(page.getByRole('button', { name: 'Agent 取证并生成候选' })).toBeEnabled();
  const failure = (await snapshot()).executions[0];
  await page.getByRole('button', { name: 'Agent 取证并生成候选' }).click();
  await expect(page.getByRole('button', { name: '批准修复并入库' })).toBeVisible();
  const round = page.locator('.pipeline-investigation-round');
  await expect(round).toHaveCount(3);
  await expect(round.nth(0)).toContainText('get_sql');
  await expect(round.nth(1)).toContainText('get_schema');
  await expect(round.nth(1)).toContainText('上一轮获得报错 SQL');
  await expect(round.nth(2)).toContainText('结论已校验');
  await expect(page.getByLabel('诊断与当前执行的关系')).toContainText('原始失败的诊断');
  await page.reload();
  await expect(round).toHaveCount(3);
  await page.getByRole('button', { name: '批准修复并入库' }).click();
  await expect(page.getByRole('heading', { name: '入库结果复查' })).toBeVisible();
  const state = await snapshot(),
    repair = state.repairs[0];
  await page.goto(
    '/pipeline/projects/' + project.id + '?execution=' + repair.verification_execution_id,
  );
  const context = page.getByLabel('诊断与当前执行的关系');
  expect(state.executions).toHaveLength(2);
  expect(repair.commit_approval.execution_id).toBe(repair.verification_execution_id);
  await expect(context).toContainText('该修复的校验与入库预检');
  await expect(context).toContainText(repair.verification_execution_id.slice(0, 8));
  await page.locator('.pipeline-round-evidence button').first().click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.getByRole('dialog').getByRole('button', { name: 'Close this dialog' }).click();
  const selectExecution = async (id: string) => {
    await page.getByRole('combobox', { name: '执行历史' }).press('ArrowDown');
    await page.getByRole('option', { name: new RegExp(id.slice(0, 8)) }).click();
  };
  await selectExecution(failure.id);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(context).toContainText('原始失败的诊断');
  await expect(context).toContainText(failure.id.slice(0, 8));
  await page.getByRole('button', { name: '运行只读预检' }).click();
  await expect(page.getByRole('button', { name: '批准本次入库' })).toBeEnabled();
  const rerun = (await snapshot()).executions[0];
  expect(rerun.revision_id).toBe(repair.approved_revision_id);
  await expect(page.locator('.pipeline-agent-card')).toHaveCount(0);
  await expect(page.locator('.pipeline-agent-empty')).toContainText(
    rerun.id.slice(0, 8) + ' 未生成关联诊断',
  );
  await page.getByRole('button', { name: '查看此 SQL 版本的原始修复诊断' }).click();
  await expect(context).toContainText('原始失败的诊断');
  await expect(context).toContainText(failure.id.slice(0, 8));
  for (const width of [360, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
    ).toBe(true);
  }
  mkdirSync(resolve('docs/demos'), { recursive: true });
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: 'docs/demos/pipeline-feedback-history.png', fullPage: true });
});

test('plain public assistant explanations survive restore without requiring a structured investigation note', async ({
  page,
  request,
}) => {
  const project = (
    await (
      await request.post('/api/v1/pipeline/projects', {
        headers: { 'Idempotency-Key': crypto.randomUUID() },
        data: { template_id: 'A' },
      })
    ).json()
  ).data;
  const endpoint = '/api/v1/pipeline/projects/' + project.id;
  await page.goto('/pipeline/projects/' + project.id);
  await page.getByRole('button', { name: '运行只读预检' }).click();
  await expect(page.getByRole('button', { name: 'Agent 取证并生成候选' })).toBeEnabled();
  await page.getByRole('button', { name: 'Agent 取证并生成候选' }).click();
  await expect(page.getByRole('button', { name: '批准修复并入库' })).toBeVisible();
  // Change only the response representation in this test's browser snapshot.
  // Actual MOCK tools still ran in the isolated database; no LIVE quality claim.
  const explanation =
    'The SQL references speed_kph. I need the actual schema to identify the existing column.';
  await page.route('**' + endpoint, async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    const turn = body.data.repairs[0].model_turns.find((t: { request: number }) => t.request === 2);
    turn.text = explanation;
    turn.investigation = null;
    await route.fulfill({ response, json: body });
  });
  await page.reload();
  const round = page.locator('.pipeline-investigation-round').nth(1);
  await expect(round).toContainText('模型调查说明（原文）');
  await expect(round).toContainText(explanation);
  await expect(round).not.toContainText('未返回可展示的调查说明');
  await expect(round).toContainText('get_schema');
});
