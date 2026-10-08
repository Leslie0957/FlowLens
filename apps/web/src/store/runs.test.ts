import { it, expect, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { useRunsStore } from './runs.js';
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}
it('discards a late list response after filters change', async () => {
  setActivePinia(createPinia());
  const store = useRunsStore();
  const first = deferred<Response>(),
    second = deferred<Response>();
  let count = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(() => (++count === 1 ? first.promise : second.promise)),
  );
  try {
    const slow = store.load({ page: 1, limit: 20, q: 'old' });
    const fast = store.load({ page: 1, limit: 20, q: 'new' });
    second.resolve(
      new Response(
        JSON.stringify({ data: [], page_info: { page: 1, limit: 20, total: 0, has_more: false } }),
        { status: 200 },
      ),
    );
    await fast;
    first.resolve(
      new Response(
        JSON.stringify({ data: [], page_info: { page: 1, limit: 20, total: 999, has_more: true } }),
        { status: 200 },
      ),
    );
    await slow;
    expect(store.total).toBe(0);
    expect(store.error).toBe('');
  } finally {
    vi.unstubAllGlobals();
  }
});
