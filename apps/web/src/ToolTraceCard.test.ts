import { expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import ToolTraceCard from './ToolTraceCard.vue';
const tool = {
  id: 'trace-test-id',
  turn_id: 'turn-id',
  name: 'read_test_signal',
  args_json: '{"query":"<script>alert(1)</script>"}',
  status: 'SUCCEEDED' as const,
  result_summary_json: JSON.stringify({
    count: 1,
    output: { signal: '<img src=x onerror=alert(1)>' },
  }),
  error_code: null,
  started_at: '2026-10-01T00:00:00.000Z',
  finished_at: '2026-10-01T00:00:00.125Z',
};
it('shows generic tool metadata and expandable stored data as inert text', () => {
  const wrapper = mount(ToolTraceCard, { props: { tool } });
  expect(wrapper.text()).toContain('read_test_signal');
  expect(wrapper.text()).toContain('trace-test-id');
  expect(wrapper.text()).toContain('125 ms');
  expect(wrapper.get('[aria-hidden="true"]').text()).toBe('✓');
  expect(wrapper.text()).toContain('取得 1 条证据');
  expect(wrapper.get('summary').text()).toContain('参数与查询结果');
  expect(wrapper.findAll('pre')).toHaveLength(2);
  expect(wrapper.text()).toContain('<script>alert(1)</script>');
  expect(wrapper.text()).toContain('<img src=x onerror=alert(1)>');
  expect(wrapper.find('script').exists()).toBe(false);
  expect(wrapper.find('img').exists()).toBe(false);
});
it('keeps old result summaries and incomplete/error states readable', () => {
  const wrapper = mount(ToolTraceCard, {
    props: {
      tool: {
        ...tool,
        status: 'FAILED',
        error_code: 'TOOL_TIMEOUT',
        result_summary_json: null,
        finished_at: null,
      },
    },
  });
  expect(wrapper.text()).toContain('TOOL_TIMEOUT');
  expect(wrapper.text()).toContain('尚无查询结果');
  expect(wrapper.get('[aria-hidden="true"]').text()).toBe('!');
  const old = mount(ToolTraceCard, {
    props: { tool: { ...tool, result_summary_json: '{"count":2}' } },
  });
  expect(old.text()).toContain('"count": 2');
});
