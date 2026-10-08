import { test, expect } from '@playwright/test';

test('only the verified answer is revealed once across reset, snapshot replay and refresh', async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.goto('/runs/seed_s04');
  await page.getByRole('button', { name: '新建会话' }).click();
  await expect(page.getByText('本机消息通道已连接', { exact: true })).toBeVisible();
  const sessionId = await page.getByRole('combobox', { name: '诊断会话' }).inputValue();
  const response = await page.request.get('http://127.0.0.1:4174/api/v1/sessions/' + sessionId),
    state = (await response.json()).data;
  const turnId = crypto.randomUUID(),
    userId = crypto.randomUUID(),
    assistantId = crypto.randomUUID(),
    now = new Date().toISOString();
  const summary = '最终已核对日志：读取请求超时。'.repeat(20);
  const result = {
    summary,
    findings: [
      {
        cause: 'UPSTREAM_TIMEOUT',
        explanation: '日志记录了读取超时。',
        evidence_ids: ['test-evidence'],
        evidence_status: 'SUPPORTED',
      },
    ],
    missing_information: ['真实上游状态仍需人工确认'],
    next_steps: ['检查真实上游状态'],
    proposed_action: null,
  };
  const row = {
    id: 'snapshot-result-id',
    turn_id: turnId,
    summary,
    findings_json: JSON.stringify(result.findings),
    missing_information_json: JSON.stringify(result.missing_information),
    next_steps_json: JSON.stringify(result.next_steps),
    proposed_action_json: 'null',
    created_at: now,
  };
  const draft = '这段被拒绝的初稿不应显示';
  let released = false,
    release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const active = {
    ...state,
    turns: [
      {
        id: turnId,
        session_id: sessionId,
        status: 'RUNNING',
        provider_mode: 'MOCK',
        model: 'mock',
        prompt_version: 'test',
        error_code: null,
        created_at: now,
        started_at: now,
        finished_at: null,
      },
    ],
    messages: [
      {
        id: userId,
        session_id: sessionId,
        turn_id: turnId,
        role: 'user',
        content: '测试最终答案展示',
        is_partial: 0,
        created_at: now,
      },
      {
        id: assistantId,
        session_id: sessionId,
        turn_id: turnId,
        role: 'assistant',
        content: JSON.stringify({ summary: draft }),
        is_partial: 1,
        created_at: now,
      },
    ],
    last_event_seq: 1,
  };
  const event = (seq: number, type: string, payload: Record<string, unknown>) => ({
    schema_version: 1,
    event_id: crypto.randomUUID(),
    seq,
    session_id: sessionId,
    turn_id: turnId,
    timestamp: now,
    type,
    payload,
  });
  await page.route('**/api/v1/sessions/' + sessionId, async (route) => {
    const snapshot = released
      ? {
          ...active,
          turns: [{ ...active.turns[0], status: 'COMPLETED', finished_at: now }],
          messages: active.messages.map((m) =>
            m.role === 'assistant' ? { ...m, content: JSON.stringify(result), is_partial: 0 } : m,
          ),
          results: [row],
          last_event_seq: 5,
        }
      : active;
    await route.fulfill({ json: { data: snapshot } });
  });
  await page.route('**/api/v1/sessions/' + sessionId + '/messages', (route) =>
    route.fulfill({ status: 202, json: { data: { turn_id: turnId, user_message_id: userId } } }),
  );
  await page.route('**/api/v1/sessions/' + sessionId + '/events?after_seq=*', async (route) => {
    await gate;
    const cursor = Number(new URL(route.request().url()).searchParams.get('after_seq'));
    const events = [
      event(2, 'message.reset', { message_id: assistantId, content: '' }),
      event(3, 'message.delta', { message_id: assistantId, delta: JSON.stringify(result) }),
      event(4, 'diagnosis.completed', { result }),
      event(5, 'turn.finished', { status: 'COMPLETED' }),
    ];
    await route.fulfill({
      headers: { 'Content-Type': 'text/event-stream' },
      body: events
        .filter((e) => e.seq > cursor)
        .map((e) => `id: ${e.seq}\nevent: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`)
        .join(''),
    });
  });
  try {
    await page.getByRole('textbox', { name: '诊断问题' }).fill('测试最终答案展示');
    await page.getByRole('button', { name: '发送', exact: true }).click();
    await expect(page.getByText('正在查询并核对证据…', { exact: true })).toBeVisible();
    await expect(page.locator('.diagnosis-result')).toHaveCount(0);
    await expect(page.locator('.diagnosis-history')).not.toContainText(draft);
    released = true;
    release();
    const card = page.locator('.diagnosis-result');
    await expect(card).toHaveCount(1);
    await expect(card).toHaveAttribute('aria-busy', 'true');
    const text = card.locator('.safe-markdown').first();
    await expect.poll(async () => ((await text.textContent()) ?? '').length).toBeGreaterThan(0);
    const first = (await text.textContent())!;
    expect(summary.startsWith(first)).toBe(true);
    expect(first.length).toBeLessThan(summary.length);
    await expect(card).toHaveAttribute('aria-busy', 'false');
    await expect(text).toHaveText(summary);
    await expect(card.locator('.evidence-links button')).toHaveCount(1);
    await expect(page.locator('.diagnosis-history')).not.toContainText(draft);
    await page.reload();
    await expect(page.locator('.diagnosis-result')).toHaveAttribute('aria-busy', 'false');
    await expect(page.locator('.diagnosis-result .safe-markdown').first()).toHaveText(summary);
  } finally {
    release();
  }
});
