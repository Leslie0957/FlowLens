import { ref, watch, onUnmounted, type Ref } from 'vue';
import { z } from 'zod';
import {
  pipelineSnapshotSchema,
  pipelineEventSchema,
  type PipelineSnapshot,
} from '@flowlens/contracts';
import { consumeJsonEvents } from './agent-stream';
export async function pipelineRead<T extends z.ZodType>(
  path: string,
  schema: T,
  options: RequestInit = {},
) {
  const response = await fetch('/api/v1/pipeline' + path, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...options.headers },
  });
  const body = await response.json();
  if (!response.ok)
    throw new Error(
      (body.error?.message ?? '请求失败') + ' · ' + (body.error?.request_id ?? response.status),
    );
  return schema.parse(body.data);
}
export const projectPath = (id: string) => '/projects/' + encodeURIComponent(id);
// Retain a mutation key across uncertain responses and reloads, scoped to its body.
export function mutationKey(scope: string, body: unknown) {
  const name = 'flowlens.pipeline.' + scope + ':' + JSON.stringify(body);
  let key = sessionStorage.getItem(name);
  if (!key) {
    key = crypto.randomUUID();
    sessionStorage.setItem(name, key);
  }
  return { key, done: () => sessionStorage.removeItem(name) };
}
export function usePipelineSnapshot(
  projectId: Ref<string>,
  timing: { reconcileMs?: number; idleMs?: number; requestTimeoutMs?: number } = {},
) {
  const snapshot = ref<PipelineSnapshot | null>(null),
    error = ref(''),
    connection = ref('连接中');
  let generation = 0,
    controller: AbortController | null = null,
    flight: Promise<void> | null = null,
    again = false,
    cursor = 0,
    lastSuccess = 0;
  async function refresh() {
    if (flight) {
      again = true;
      return flight;
    }
    const gen = generation,
      id = projectId.value,
      signal = controller?.signal;
    flight = (async () => {
      try {
        const deadline = AbortSignal.timeout(timing.requestTimeoutMs ?? 5000);
        const s = await pipelineRead(projectPath(id), pipelineSnapshotSchema, {
          signal: signal ? AbortSignal.any([signal, deadline]) : deadline,
          cache: 'no-store',
        });
        if (gen !== generation || signal?.aborted) return;
        if (s.project.id !== id) throw new Error('状态返回了其他项目');
        if (s.cursor < cursor) return;
        snapshot.value = s;
        cursor = s.cursor;
        lastSuccess = Date.now();
        error.value = '';
      } catch (e) {
        if (gen === generation && !signal?.aborted)
          error.value = e instanceof Error ? e.message : '同步失败';
      }
    })();
    const current = flight;
    await current;
    if (gen !== generation) return;
    if (flight === current) flight = null;
    if (again) {
      again = false;
      await refresh();
    }
  }
  watch(
    projectId,
    async (id) => {
      generation++;
      const gen = generation;
      controller?.abort();
      controller = new AbortController();
      const signal = controller.signal;
      snapshot.value = null;
      error.value = '';
      connection.value = '连接中';
      flight = null;
      again = false;
      cursor = 0;
      lastSuccess = 0;
      await refresh();
      while (gen === generation && !signal.aborted) {
        try {
          connection.value = '连接中';
          const response = await fetch(
            '/api/v1/pipeline' + projectPath(id) + '/events?after_seq=' + cursor,
            { signal, headers: { Accept: 'text/event-stream' } },
          );
          if (!response.ok || !response.body) throw new Error('事件流不可用');
          connection.value = '实时连接';
          await consumeJsonEvents(
            response.body,
            (raw) => {
              const e = pipelineEventSchema.parse(raw);
              if (gen !== generation || signal.aborted || e.project_id !== id || e.seq <= cursor)
                return;
              // Receiving a notification is not an acknowledgement of its state. Only a
              // successfully applied snapshot advances the cursor used for reconnects.
              void refresh();
            },
            signal,
          );
        } catch {
          if (!signal.aborted && gen === generation) connection.value = '断线，正在恢复';
        }
        if (!signal.aborted && gen === generation) {
          await new Promise<void>((resolve) => {
            const finish = () => {
              clearTimeout(timer);
              signal.removeEventListener('abort', finish);
              resolve();
            };
            const timer = setTimeout(finish, 1000);
            signal.addEventListener('abort', finish, { once: true });
          });
          await refresh();
        }
      }
    },
    { immediate: true },
  );
  // SSE remains the immediate path. Reconcile actual state even when the stream
  // stays open but loses a notification, or a refresh request fails/stalls.
  // These GETs never start executions or model jobs.
  const reconcileTimer = setInterval(() => {
    if (controller?.signal.aborted || flight) return;
    const s = snapshot.value,
      active =
        !s ||
        s.executions.some((e) => e.status === 'RUNNING') ||
        s.repairs.some(
          (r) =>
            ['QUEUED', 'RUNNING', 'VERIFYING'].includes(r.status) ||
            ['APPROVED', 'PRECHECKING', 'COMMITTING'].includes(r.commit_approval?.status ?? ''),
        ) ||
        s.operations.some((op) => op.status === 'RUNNING');
    if (active || Date.now() - lastSuccess >= (timing.idleMs ?? 5000)) void refresh();
  }, timing.reconcileMs ?? 1000);
  onUnmounted(() => {
    generation++;
    clearInterval(reconcileTimer);
    controller?.abort();
  });
  return { snapshot, error, connection, refresh };
}
