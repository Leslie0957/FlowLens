import { afterEach, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import DiagnosisAnswer from './DiagnosisAnswer.vue';
const finalRow = {
  id: 'verified-result',
  turn_id: 'verified-turn',
  summary: '最终确认读取阶段发生超时，请结合日志查看原因。',
  findings_json: JSON.stringify([
    {
      cause: 'UPSTREAM_TIMEOUT',
      explanation: '日志记录了读取请求超过五秒，并导致后续步骤跳过。',
      evidence_ids: ['verified-evidence'],
      evidence_status: 'SUPPORTED',
    },
  ]),
  missing_information_json: '["上游真实服务是否恢复"]',
  next_steps_json: '["人工检查上游状态"]',
  proposed_action_json: 'null',
  created_at: '',
};
afterEach(() => {
  vi.useRealTimers();
});
it('uses validated history result and preserves evidence actions without exposing raw JSON', async () => {
  const row = {
    id: 'result',
    turn_id: 'turn',
    summary: '读取阶段超时',
    findings_json: JSON.stringify([
      {
        cause: 'UPSTREAM_TIMEOUT',
        explanation: '日志确认读取超时',
        evidence_ids: ['evidence-1'],
        evidence_status: 'SUPPORTED',
      },
    ]),
    missing_information_json: '["上游是否恢复"]',
    next_steps_json: '["检查上游"]',
    proposed_action_json: 'null',
    created_at: '',
  };
  const wrapper = mount(DiagnosisAnswer, {
    props: {
      row,
      status: 'COMPLETED',
      content: 'Reading logs.{"summary":"RAW_JSON","evidence_ids":["bad"]}',
    },
  });
  expect(wrapper.text()).toContain('读取阶段超时');
  expect(wrapper.text()).not.toContain('RAW_JSON');
  expect(wrapper.text()).not.toContain('Reading logs');
  expect(wrapper.findAll('li')).toHaveLength(2);
  await wrapper.get('button').trigger('click');
  expect(wrapper.emitted('evidence')?.[0]?.[0]).toBe('evidence-1');
  expect(wrapper.emitted('evidence')?.[0]?.[1]).toBeInstanceOf(MouseEvent);
});
it('keeps partial or failed output distinct from verified conclusions', () => {
  const wrapper = mount(DiagnosisAnswer, {
    props: { status: 'FAILED', content: '{"summary":"初步判断","findings":[' },
  });
  expect(wrapper.text()).toContain('未生成可验证');
  expect(wrapper.find('.diagnosis-result').exists()).toBe(false);
  expect(wrapper.find('button').exists()).toBe(false);
  expect(wrapper.text()).not.toContain('findings');
});
it('never shows rejected drafts while waiting or after failure', async () => {
  const wrapper = mount(DiagnosisAnswer, {
    props: { status: 'RUNNING', content: '{"summary":"错误的第一版回答"}' },
  });
  expect(wrapper.text()).not.toContain('错误的第一版回答');
  expect(wrapper.find('.diagnosis-result').exists()).toBe(false);
  await wrapper.setProps({ content: '' });
  await wrapper.setProps({ content: '{"summary":"第二版仍未校验"}', status: 'FAILED' });
  expect(wrapper.text()).not.toContain('第二版仍未校验');
  expect(wrapper.text()).toContain('未生成可验证');
  wrapper.unmount();
});
it('reveals one verified answer progressively with evidence after its text', async () => {
  vi.useFakeTimers();
  const wrapper = mount(DiagnosisAnswer, {
    props: { status: 'RUNNING', content: '{"summary":"被拒绝的初稿"}', animate: true },
  });
  await wrapper.setProps({ row: finalRow, status: 'COMPLETED' });
  expect(wrapper.text()).not.toContain(finalRow.summary);
  expect(wrapper.text()).not.toContain('被拒绝的初稿');
  expect(wrapper.find('button').exists()).toBe(false);
  await vi.advanceTimersByTimeAsync(120);
  const prefix = wrapper.find('.safe-markdown').text();
  expect(prefix.length).toBeGreaterThan(0);
  expect(finalRow.summary.startsWith(prefix)).toBe(true);
  await vi.advanceTimersByTimeAsync(5000);
  expect(wrapper.text()).toContain(finalRow.summary);
  expect(wrapper.text()).toContain('人工检查上游状态');
  await wrapper.get('button').trigger('click');
  expect(wrapper.emitted('evidence')?.[0]?.[0]).toBe('verified-evidence');
  expect(vi.getTimerCount()).toBe(0);
  wrapper.unmount();
});
it('does not restart reveal when the final snapshot replaces the event result id', async () => {
  vi.useFakeTimers();
  const wrapper = mount(DiagnosisAnswer, {
    props: { status: 'COMPLETED', content: '', row: finalRow, animate: true },
  });
  await vi.advanceTimersByTimeAsync(160);
  const prefix = wrapper.find('.safe-markdown').text();
  expect(prefix.length).toBeGreaterThan(0);
  expect(prefix.length).toBeLessThan(finalRow.summary.length);
  await wrapper.setProps({ row: { ...finalRow, id: 'persisted-result-id' } });
  expect(wrapper.find('.safe-markdown').text()).toBe(prefix);
  await vi.advanceTimersByTimeAsync(120);
  expect(wrapper.find('.safe-markdown').text().startsWith(prefix)).toBe(true);
  await wrapper.setProps({ animate: false });
  expect(wrapper.text()).toContain(finalRow.summary);
  expect(vi.getTimerCount()).toBe(0);
  wrapper.unmount();
});
it('shows restored history immediately and stops reveal on session unmount', async () => {
  vi.useFakeTimers();
  const outgoing = mount(DiagnosisAnswer, {
    props: { status: 'COMPLETED', content: '', row: finalRow, animate: true },
  });
  await vi.advanceTimersByTimeAsync(80);
  expect(outgoing.find('.safe-markdown').text().length).toBeLessThan(finalRow.summary.length);
  outgoing.unmount();
  expect(vi.getTimerCount()).toBe(0);
  const history = mount(DiagnosisAnswer, {
    props: { status: 'COMPLETED', content: '', row: finalRow },
  });
  expect(history.text()).toContain(finalRow.summary);
  expect(history.text()).toContain('人工检查上游状态');
  expect(vi.getTimerCount()).toBe(0);
  history.unmount();
});
