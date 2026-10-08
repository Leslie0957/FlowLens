import { it, expect, vi, afterEach } from 'vitest';
import { createApp, defineComponent, ref, nextTick } from 'vue';
import { usePipelineSnapshot, mutationKey } from './pipeline-client';
const a = '10000000-0000-4000-8000-000000000001',
  b = '10000000-0000-4000-8000-000000000002',
  rid = '10000000-0000-4000-8000-000000000003',
  hash = 'a'.repeat(64);
const snapshot = (id: string, cursor = 0) => ({
  project: {
    id,
    name: id,
    template: 'A',
    input_source: 'SYNTHETIC',
    input_hash: hash,
    current_revision_id: rid,
    created_at: 'now',
  },
  revision: {
    id: rid,
    project_id: id,
    parent_id: null,
    sql: 'SELECT',
    hash,
    input_hash: hash,
    source: 'TEMPLATE',
    created_at: 'now',
  },
  revisions: [],
  executions: [],
  repairs: [],
  batches: [],
  operations: [],
  target: { data_version: 0, head_batch_id: null, hash, row_count: 0, preview: [] },
  cursor,
});
afterEach(() => {
  vi.unstubAllGlobals();
  sessionStorage.clear();
});
it('ignores a late project snapshot and error after selection changes, including loading cleanup', async () => {
  let resolveOld!: (value: Response) => void;
  let resolveError!: (value: Response) => void;
  const old = new Promise<Response>((r) => (resolveOld = r)),
    lateError = new Promise<Response>((r) => (resolveError = r));
  let callsA = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, options: RequestInit = {}) => {
      if (url.includes('/events?'))
        return new Promise<Response>((resolve) => {
          const stream = new ReadableStream({
            start(c) {
              options.signal?.addEventListener('abort', () => c.close(), { once: true });
            },
          });
          resolve(new Response(stream));
        });
      if (url.endsWith(a)) return callsA++ === 0 ? old : lateError;
      return Promise.resolve(
        new Response(JSON.stringify({ data: snapshot(b) }), {
          headers: { 'Content-Type': 'application/json' },
        }),
      );
    }),
  );
  const project = ref(a);
  let state!: ReturnType<typeof usePipelineSnapshot>;
  const app = createApp(
    defineComponent({
      setup() {
        state = usePipelineSnapshot(project);
        return () => null;
      },
    }),
  );
  app.mount(document.createElement('div'));
  project.value = b;
  await vi.waitFor(() => expect(state.snapshot.value?.project.id).toBe(b));
  resolveOld(new Response(JSON.stringify({ data: snapshot(a) })));
  await nextTick();
  expect(state.snapshot.value?.project.id).toBe(b);
  expect(state.error.value).toBe('');
  resolveError(new Response(JSON.stringify({ error: { message: 'old error' } }), { status: 500 }));
  app.unmount();
});
it('deduplicates replay, refreshes gaps, and maintains a project scoped event cursor', async () => {
  let stream!: ReadableStreamDefaultController<Uint8Array>,
    cursor = 0,
    reads = 0;
  const id = ref(a);
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, options: RequestInit = {}) => {
      if (url.includes('/events?'))
        return Promise.resolve(
          new Response(
            new ReadableStream({
              start(c) {
                stream = c;
                options.signal?.addEventListener('abort', () => c.close(), { once: true });
              },
            }),
          ),
        );
      reads++;
      return Promise.resolve(new Response(JSON.stringify({ data: snapshot(a, cursor) })));
    }),
  );
  let state!: ReturnType<typeof usePipelineSnapshot>;
  const app = createApp(
    defineComponent({
      setup() {
        state = usePipelineSnapshot(id);
        return () => null;
      },
    }),
  );
  app.mount(document.createElement('div'));
  await vi.waitFor(() => expect(state.connection.value).toBe('实时连接'));
  const emit = (seq: number, project = a) =>
    stream.enqueue(
      new TextEncoder().encode(
        'data: ' +
          JSON.stringify({
            project_id: project,
            seq,
            type: 'execution.changed',
            entity_id: rid,
            created_at: 'now',
          }) +
          '\n\n',
      ),
    );
  cursor = 1;
  emit(1);
  await vi.waitFor(() => expect(state.snapshot.value?.cursor).toBe(1));
  const count = reads;
  emit(1);
  emit(1, b);
  await nextTick();
  expect(reads).toBe(count);
  cursor = 4;
  emit(4);
  await vi.waitFor(() => expect(state.snapshot.value?.cursor).toBe(4));
  expect(reads).toBeGreaterThan(count);
  app.unmount();
});
it('retains mutation keys for uncertain responses, separates bodies/projects and renews only after confirmed responses', () => {
  const first = mutationKey(a + '/executions', {});
  expect(mutationKey(a + '/executions', {}).key).toBe(first.key);
  expect(mutationKey(b + '/executions', {}).key).not.toBe(first.key);
  expect(mutationKey(a + '/revisions', { sql: 'one' }).key).not.toBe(
    mutationKey(a + '/revisions', { sql: 'two' }).key,
  );
  first.done();
  expect(mutationKey(a + '/executions', {}).key).not.toBe(first.key);
});

const execution = (status: string) => ({
  id: rid,
  project_id: a,
  revision_id: rid,
  revision_hash: hash,
  input_hash: hash,
  kind: 'PRECHECK',
  status,
  created_at: 'now',
  finished_at: status === 'RUNNING' ? null : 'now',
  logs: [],
  columns: [],
  rows: [],
  error_code: status === 'FAILED' ? 'SQL_QUERY_FAILED' : null,
  error_message: status === 'FAILED' ? 'no such column: speed_kph' : null,
  failed_step: status === 'FAILED' ? 'query' : null,
  exit_code: status === 'FAILED' ? 2 : null,
  validation: null,
  precheck: null,
  verification: null,
});
const activeSnapshot = (done: boolean) => ({
  ...snapshot(a, done ? 2 : 1),
  executions: [execution(done ? 'FAILED' : 'RUNNING')],
});
function silentStream(signal?: AbortSignal) {
  return new Response(
    new ReadableStream({
      start(c) {
        signal?.addEventListener('abort', () => c.close(), { once: true });
      },
    }),
    { headers: { 'Content-Type': 'text/event-stream' } },
  );
}

it('reconciles an active execution when SSE stays connected but sends no completion notification, and stops on unmount', async () => {
  let done = false,
    reads = 0;
  const requests: RequestInit[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, options: RequestInit = {}) => {
      if (url.includes('/events?'))
        return Promise.resolve(silentStream(options.signal ?? undefined));
      reads++;
      requests.push(options);
      return Promise.resolve(new Response(JSON.stringify({ data: activeSnapshot(done) })));
    }),
  );
  let state!: ReturnType<typeof usePipelineSnapshot>;
  const app = createApp(
    defineComponent({
      setup() {
        state = usePipelineSnapshot(ref(a), { reconcileMs: 25 });
        return () => null;
      },
    }),
  );
  app.mount(document.createElement('div'));
  try {
    await vi.waitFor(() => expect(state.connection.value).toBe('实时连接'));
    expect(state.snapshot.value?.executions[0]?.status).toBe('RUNNING');
    done = true;
    await vi.waitFor(() => expect(state.snapshot.value?.executions[0]?.status).toBe('FAILED'));
    expect(requests.every((r) => r.cache === 'no-store' && !r.method)).toBe(true);
  } finally {
    app.unmount();
  }
  const stopped = reads;
  await new Promise((resolve) => setTimeout(resolve, 80));
  expect(reads).toBe(stopped);
});

it('reconnects after a failed snapshot from the last applied cursor, then reads the replayed completion', async () => {
  let reads = 0,
    success = false;
  const streams: ReadableStreamDefaultController<Uint8Array>[] = [],
    urls: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, options: RequestInit = {}) => {
      if (url.includes('/events?')) {
        urls.push(url);
        return Promise.resolve(
          new Response(
            new ReadableStream({
              start(c) {
                streams.push(c);
                options.signal?.addEventListener(
                  'abort',
                  () => {
                    try {
                      c.close();
                    } catch {
                      /* already ended */
                    }
                  },
                  { once: true },
                );
              },
            }),
          ),
        );
      }
      reads++;
      return Promise.resolve(
        reads === 1 || success
          ? new Response(JSON.stringify({ data: activeSnapshot(success) }))
          : new Response(JSON.stringify({ error: { message: 'temporary snapshot failure' } }), {
              status: 503,
            }),
      );
    }),
  );
  let state!: ReturnType<typeof usePipelineSnapshot>;
  const app = createApp(
    defineComponent({
      setup() {
        state = usePipelineSnapshot(ref(a), { reconcileMs: 10000 });
        return () => null;
      },
    }),
  );
  app.mount(document.createElement('div'));
  const emit = (stream: ReadableStreamDefaultController<Uint8Array>) =>
    stream.enqueue(
      new TextEncoder().encode(
        'data: ' +
          JSON.stringify({
            project_id: a,
            seq: 2,
            type: 'execution.changed',
            entity_id: rid,
            created_at: 'now',
          }) +
          '\n\n',
      ),
    );
  try {
    await vi.waitFor(() => expect(streams).toHaveLength(1));
    emit(streams[0]!);
    await vi.waitFor(() => expect(state.error.value).toContain('temporary snapshot failure'));
    streams[0]!.close();
    await vi.waitFor(() => expect(streams).toHaveLength(2), { timeout: 3000 });
    expect(urls[1]).toContain('after_seq=1');
    success = true;
    emit(streams[1]!);
    await vi.waitFor(() => expect(state.snapshot.value?.executions[0]?.status).toBe('FAILED'));
    expect(state.error.value).toBe('');
  } finally {
    app.unmount();
  }
});

it('times out a stalled state request and retries without starting a new execution', async () => {
  let reads = 0,
    hungSignal: AbortSignal | undefined;
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, options: RequestInit = {}) => {
      if (url.includes('/events?'))
        return Promise.resolve(silentStream(options.signal ?? undefined));
      reads++;
      if (reads === 2) {
        hungSignal = options.signal ?? undefined;
        return new Promise<Response>((_resolve, reject) =>
          options.signal?.addEventListener(
            'abort',
            () => reject(new Error('state request timeout')),
            { once: true },
          ),
        );
      }
      return Promise.resolve(new Response(JSON.stringify({ data: activeSnapshot(reads > 2) })));
    }),
  );
  let state!: ReturnType<typeof usePipelineSnapshot>;
  const app = createApp(
    defineComponent({
      setup() {
        state = usePipelineSnapshot(ref(a), { reconcileMs: 25, requestTimeoutMs: 80 });
        return () => null;
      },
    }),
  );
  app.mount(document.createElement('div'));
  try {
    await vi.waitFor(() => expect(state.snapshot.value?.executions[0]?.status).toBe('FAILED'));
    expect(hungSignal?.aborted).toBe(true);
    expect(reads).toBe(3);
  } finally {
    app.unmount();
  }
});
