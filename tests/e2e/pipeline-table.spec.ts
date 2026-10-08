import { test, expect, type Locator } from '@playwright/test';
import { mkdirSync } from 'node:fs';

async function expectAlignedScroll(table: Locator) {
  const wrap = table.locator('.el-table__body-wrapper .el-scrollbar__wrap');
  // The rendered width and the component's scroll state must agree. Otherwise
  // browser overflow can move rows without activating the header synchronizer.
  await expect
    .poll(() =>
      table.evaluate((el) => {
        const scroll = el.querySelector('.el-table__body-wrapper .el-scrollbar__wrap')!;
        return (
          scroll.scrollWidth > scroll.clientWidth + 1 ===
          el.classList.contains('el-table--scrollable-x')
        );
      }),
    )
    .toBe(true);
  for (const left of [120, 0]) {
    await wrap.evaluate((el, left) => {
      el.scrollLeft = left;
      el.dispatchEvent(new Event('scroll'));
    }, left);
    await expect
      .poll(() =>
        table.evaluate((el) => {
          const headers = [...el.querySelectorAll('.el-table__header-wrapper thead th')];
          const cells = [...el.querySelectorAll('.el-table__body-wrapper tbody tr:first-child td')];
          return Math.max(
            ...headers.map((h, i) =>
              Math.abs(h.getBoundingClientRect().left - cells[i]!.getBoundingClientRect().left),
            ),
          );
        }),
      )
      .toBeLessThan(2);
  }
}

test('actual output and SQL query tables align headers while scrolling, reopening and resizing', async ({
  page,
  request,
}) => {
  const project = (
    await (
      await request.post('/api/v1/pipeline/projects', {
        headers: { 'Idempotency-Key': crypto.randomUUID() },
        data: { template_id: 'C' },
      })
    ).json()
  ).data;
  const endpoint = '/api/v1/pipeline/projects/' + project.id;
  const execution = (
    await (
      await request.post(endpoint + '/executions', {
        headers: { 'Idempotency-Key': crypto.randomUUID() },
        data: {},
      })
    ).json()
  ).data;
  await expect
    .poll(async () => {
      const snapshot = (await (await request.get(endpoint)).json()).data;
      return snapshot.executions.find((e: { id: string }) => e.id === execution.id)?.status;
    })
    .toBe('PRECHECK_PASSED');
  await page.setViewportSize({ width: 1920, height: 1000 });
  await page.goto('/pipeline/projects/' + project.id);
  const output = page
    .locator('details')
    .filter({ has: page.locator('summary', { hasText: '实际输出（4 行）' }) });
  await output.locator('summary').click();
  const table = output.locator('.el-table');
  await expect(table.locator('.el-table__body tbody tr')).toHaveCount(4);
  for (const width of [1920, 1440, 768, 360]) {
    await page.setViewportSize({ width, height: 1000 });
    await expectAlignedScroll(table);
  }
  await output.locator('summary').click();
  await page.setViewportSize({ width: 1440, height: 1000 });
  await output.locator('summary').click();
  await expectAlignedScroll(table);
  await request.post(endpoint + '/executions/' + execution.id + '/commit', {
    headers: { 'Idempotency-Key': crypto.randomUUID() },
    data: {},
  });
  await page.goto('/pipeline/projects/' + project.id + '/database?scope=target');
  await page.getByRole('button', { name: '执行只读查询' }).click();
  const queryTable = page.locator('.el-table');
  await expect(queryTable.locator('.el-table__body tbody tr')).toHaveCount(4);
  await page.locator('.pipeline-schema-details summary').click();
  const schema = page.getByRole('table', { name: '本次查询的实际表结构' });
  await expect(schema.getByRole('columnheader', { name: '字段名' })).toBeVisible();
  await expect(schema.locator('tbody tr')).toHaveCount(6);
  await expect(schema.getByRole('row').filter({ hasText: 'car_series' })).toContainText('TEXT');
  for (const width of [1920, 768, 360]) {
    await page.setViewportSize({ width, height: 1000 });
    await expectAlignedScroll(queryTable);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
    ).toBe(true);
  }
  await page.setViewportSize({ width: 1440, height: 1100 });
  mkdirSync('docs/demos', { recursive: true });
  await page
    .locator('.pipeline-query-result')
    .screenshot({ path: 'docs/demos/pipeline-query-result-20261008.png' });
});
