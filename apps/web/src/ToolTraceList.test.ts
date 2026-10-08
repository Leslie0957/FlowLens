import { it, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import ToolTraceList from './ToolTraceList.vue';
it('mounts no collapsed tool cards and paginates all 200 records twenty at a time', async () => {
  const tools = Array.from({ length: 200 }, (_, i) => ({
    id: 'tool_' + i,
    turn_id: 'turn',
    name: 'get_task_run',
    args_json: '{}',
    status: 'SUCCEEDED' as const,
    result_summary_json: null,
    error_code: null,
    started_at: '2026-10-01T00:00:00Z',
    finished_at: '2026-10-01T00:00:01Z',
  }));
  const view = mount(ToolTraceList, { props: { tools } });
  expect(view.findAll('.tool-card')).toHaveLength(0);
  const details = view.get('details');
  (details.element as HTMLDetailsElement).open = true;
  await details.trigger('toggle');
  expect(view.findAll('.tool-card')).toHaveLength(20);
  expect(view.findAll('.tool-card')[0]!.text()).toContain('tool_0');
  for (let i = 1; i < 10; i++) {
    await view.findAll('button')[1]!.trigger('click');
    expect(view.findAll('.tool-card')).toHaveLength(20);
    expect(view.findAll('.tool-card')[0]!.text()).toContain('tool_' + i * 20);
  }
  expect(view.findAll('button')[1]!.attributes('disabled')).toBeDefined();
  (details.element as HTMLDetailsElement).open = false;
  await details.trigger('toggle');
  expect(view.findAll('.tool-card')).toHaveLength(0);
  view.unmount();
});
