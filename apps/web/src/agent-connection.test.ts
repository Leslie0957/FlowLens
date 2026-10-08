import { expect, it, vi } from 'vitest';
import { runEventConnection } from './agent-connection.js';
it('reconnects from the applied cursor without creating a second turn', async () => {
  const cursors: number[] = [],
    states: string[] = [];
  let seq = 0,
    calls = 0;
  await runEventConnection({
    signal: new AbortController().signal,
    cursor: () => seq,
    terminal: () => seq === 3,
    connect: async (after) => {
      cursors.push(after);
      calls++;
      if (calls === 1) {
        seq = 1;
        throw new Error('disconnect');
      }
      seq = 3;
    },
    state: (value) => states.push(value),
    delay: async () => {},
  });
  expect(cursors).toEqual([0, 1]);
  expect(states).toContain('reconnecting');
  expect(states.at(-1)).toBe('synchronized');
});
it('stops reconnecting when selection is cancelled', async () => {
  const controller = new AbortController(),
    cursors: number[] = [];
  await runEventConnection({
    signal: controller.signal,
    cursor: () => 0,
    terminal: () => false,
    connect: async (after) => {
      cursors.push(after);
      controller.abort();
      throw new Error('closed');
    },
    state: vi.fn(),
    delay: async () => {},
  });
  expect(cursors).toEqual([0]);
});
