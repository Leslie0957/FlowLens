import { expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import SafeMarkdown from './SafeMarkdown.js';
it('renders Markdown while keeping HTML and unsafe links inert', () => {
  const wrapper = mount(SafeMarkdown, {
    props: {
      text: '<img src=x onerror=alert(1)>\n[bad](javascript:alert) [good](https://example.com)\n- item\n```\n<script>bad</script>\n```\n| a | b |\n| --- | --- |\n| 1 | 2 |',
    },
  });
  expect(wrapper.find('img').exists()).toBe(false);
  expect(wrapper.find('script').exists()).toBe(false);
  expect(wrapper.findAll('a')).toHaveLength(1);
  expect(wrapper.get('a').attributes('href')).toBe('https://example.com');
  expect(wrapper.find('li').text()).toBe('item');
  expect(wrapper.findAll('td')).toHaveLength(2);
});
