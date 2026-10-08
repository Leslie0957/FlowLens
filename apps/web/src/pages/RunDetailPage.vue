<script setup lang="ts">
import { computed, ref, watch, onMounted, onUnmounted } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ElMessage } from 'element-plus';
import { fetchRun, fetchLogs, ApiError } from '../api.js';
import { formatTime, formatDuration, statusLabel, stepLabel, stepOrder } from '../ui.js';
import type { Run, TaskLog } from '@flowlens/contracts';
import DiagnosisPanel from './DiagnosisPanel.vue';
const route = useRoute(),
  router = useRouter(),
  runId = computed(() => String(route.params.runId));
const run = ref<Run | null>(null),
  logs = ref<TaskLog[]>([]),
  loading = ref(true),
  error = ref(''),
  requestId = ref('');
const logQuery = ref(''),
  level = ref(''),
  logError = ref(''),
  logLoading = ref(false),
  hasOlder = ref(false),
  expanded = ref(new Set<string>());
const viewingLatest = ref(true),
  hasNewer = ref(false);
let logAbort: AbortController | undefined,
  logTicket = 0;
let poll: ReturnType<typeof setInterval> | undefined,
  abort: AbortController | undefined,
  seq = 0,
  searchTimer: ReturnType<typeof setTimeout> | undefined;
async function loadRun(background = false) {
  const current = ++seq;
  abort?.abort();
  const controller = new AbortController();
  abort = controller;
  if (!background) loading.value = true;
  error.value = '';
  try {
    const value = await fetchRun(runId.value, controller.signal);
    if (current !== seq) return;
    run.value = value;
  } catch (e) {
    if (current !== seq || controller.signal.aborted) return;
    error.value = e instanceof Error ? e.message : '运行加载失败';
    requestId.value = e instanceof ApiError ? e.requestId : '';
  } finally {
    if (current === seq) loading.value = false;
  }
}
async function loadLogs(reset = true, direction: 'older' | 'newer' = 'older') {
  const current = ++logTicket,
    id = runId.value;
  logAbort?.abort();
  const controller = new AbortController();
  logAbort = controller;
  logLoading.value = true;
  logError.value = '';
  const boundary = reset
    ? {}
    : direction === 'older'
      ? { before_seq: logs.value[0]?.seq }
      : { after_seq: logs.value.at(-1)?.seq };
  try {
    const result = await fetchLogs(
      id,
      {
        query: logQuery.value.trim() || undefined,
        level: level.value || undefined,
        limit: 200,
        ...boundary,
      },
      controller.signal,
    );
    if (current !== logTicket || id !== runId.value) return;
    if (!reset && !result.length) {
      if (direction === 'older') hasOlder.value = false;
      else hasNewer.value = false;
      return;
    }
    logs.value = result;
    viewingLatest.value = reset;
    expanded.value = new Set();
    if (reset || direction === 'older') {
      hasOlder.value = result.length === 200;
      hasNewer.value = !reset;
    } else {
      hasOlder.value = true;
      hasNewer.value = result.length === 200;
    }
  } catch (e) {
    if (current === logTicket && !controller.signal.aborted)
      logError.value = e instanceof Error ? e.message : '日志加载失败';
  } finally {
    if (current === logTicket) logLoading.value = false;
  }
}
async function pollRun() {
  if (document.visibilityState !== 'visible') return;
  await loadRun(true);
  if (logQuery.value || level.value || !viewingLatest.value || logLoading.value) return;
  const current = logTicket,
    id = runId.value,
    last = logs.value.at(-1)?.seq ?? 0;
  try {
    const next = await fetchLogs(id, { after_seq: last, limit: 200 });
    if (current !== logTicket || id !== runId.value) return;
    const ids = new Set(logs.value.map((item) => item.id));
    const merged = [...logs.value, ...next.filter((item) => !ids.has(item.id))];
    if (merged.length > 200) hasOlder.value = true;
    logs.value = merged.slice(-200);
  } catch (e) {
    if (current === logTicket)
      logError.value = e instanceof Error ? e.message : '日志同步失败，下一次将重试';
  }
}
function toggleLog(id: string) {
  const next = new Set(expanded.value);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  expanded.value = next;
}
watch(
  runId,
  () => {
    run.value = null;
    logs.value = [];
    void loadRun();
    void loadLogs();
  },
  { immediate: true },
);
watch(level, () => {
  void loadLogs();
});
watch(logQuery, () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    void loadLogs();
  }, 300);
});
onMounted(() => {
  poll = setInterval(() => {
    void pollRun();
  }, 3000);
});
onUnmounted(() => {
  clearInterval(poll);
  clearTimeout(searchTimer);
  abort?.abort();
  logAbort?.abort();
  logTicket++;
  seq++;
});
function copy(value: string) {
  void navigator.clipboard.writeText(value).then(() => ElMessage.success('已复制'));
}
</script>
<template>
  <div class="page detail-page">
    <div class="backline">
      <button @click="router.push('/runs')">← 返回运行列表</button><span>/</span
      ><span>{{ runId }}</span>
    </div>
    <div v-if="loading && !run" class="panel detail-loading">正在加载运行详情…</div>
    <div v-else-if="error && !run" class="panel detail-loading">
      <h2>无法打开运行</h2>
      <p>{{ error }}</p>
      <small v-if="requestId">请求 ID：{{ requestId }}</small>
      <div><el-button @click="loadRun()">重试</el-button></div>
    </div>
    <template v-else-if="run">
      <div class="page-heading detail-heading">
        <div>
          <div class="eyebrow">
            RUN DETAIL <span class="eyebrow-line"></span> {{ run.scenario_id }}
          </div>
          <h1>
            {{ run.task_name }}
            <span class="status heading-status" :class="run.status.toLowerCase()"
              ><i></i>{{ statusLabel[run.status] }}</span
            >
          </h1>
          <p>
            运行 ID：<code>{{ run.id }}</code>
            <button class="copy" aria-label="复制运行 ID" @click="copy(run.id)">⧉</button>
          </p>
        </div>
        <span class="fixture-tag big">演示任务数据 · FIXTURE</span>
      </div>
      <div v-if="error" class="inline-error">
        刷新失败，保留现有数据：{{ error }} <small>{{ requestId }}</small>
      </div>
      <div class="detail-grid">
        <div class="detail-primary">
          <section class="panel overview-panel">
            <div class="panel-head">
              <div>
                <h2>运行概览</h2>
                <p>状态与阶段来自服务端持久化记录</p>
              </div>
              <span class="panel-count">{{ run.scenario_id }}</span>
            </div>
            <div class="run-facts">
              <div>
                <span>创建时间</span><strong>{{ formatTime(run.created_at) }}</strong>
              </div>
              <div>
                <span>开始时间</span><strong>{{ formatTime(run.started_at) }}</strong>
              </div>
              <div>
                <span>完成时间</span><strong>{{ formatTime(run.finished_at) }}</strong>
              </div>
              <div>
                <span>运行耗时</span><strong>{{ formatDuration(run.duration_ms) }}</strong>
              </div>
            </div>
            <div class="step-heading">执行阶段</div>
            <div class="steps">
              <div v-for="(step, index) in stepOrder" :key="step" class="step">
                <span class="step-index" :class="run.step_states[step]?.toLowerCase()">{{
                  run.step_states[step] === 'SUCCEEDED' ? '✓' : String(index + 1).padStart(2, '0')
                }}</span>
                <div>
                  <strong>{{ stepLabel[step] }}</strong
                  ><small>{{ run.step_states[step] }}</small>
                </div>
                <span v-if="index < 3" class="step-line"></span>
              </div>
            </div>
            <div v-if="run.error_message" class="failure-note">
              <strong>{{ run.error_code }}</strong
              ><span>{{ run.error_message }}</span>
            </div>
            <div v-if="run.summary" class="summary-note">
              <strong>演示汇总</strong><span>{{ JSON.stringify(run.summary) }}</span>
            </div>
          </section>
          <section class="panel log-panel">
            <div class="panel-head">
              <div>
                <h2>运行日志</h2>
                <p>按序号保存；可搜索、筛选并加载更早记录</p>
              </div>
              <span class="panel-count">{{ logs.length }} 条当前窗口 · 最多 200</span>
            </div>
            <div class="log-tools">
              <div class="search-wrap">
                <span>⌕</span
                ><input v-model="logQuery" aria-label="搜索日志" placeholder="搜索日志内容" />
              </div>
              <select v-model="level" aria-label="日志级别">
                <option value="">全部级别</option>
                <option value="INFO">INFO</option>
                <option value="WARN">WARN</option>
                <option value="ERROR">ERROR</option>
              </select>
            </div>
            <div v-if="logError" class="inline-error">
              {{ logError }} <button @click="loadLogs()">重试</button>
            </div>
            <div v-if="!logs.length" class="empty">
              {{ logLoading ? '正在加载日志…' : '暂无符合条件的日志' }}
            </div>
            <div v-else class="log-list">
              <div v-for="item in logs" :key="item.id" class="log-row">
                <span class="log-seq">{{ String(item.seq).padStart(3, '0') }}</span
                ><span class="log-time">{{ formatTime(item.timestamp) }}</span
                ><span class="log-level" :class="item.level.toLowerCase()">{{ item.level }}</span
                ><span class="log-step">{{ item.step }}</span>
                <div class="log-message">
                  <pre
                    :class="{ collapsed: item.message.includes('\n') && !expanded.has(item.id) }"
                    >{{ item.message }}</pre>
                  <button
                    v-if="item.message.includes('\n')"
                    class="expand-log"
                    @click="toggleLog(item.id)"
                  >
                    {{ expanded.has(item.id) ? '收起' : '展开全文' }}
                  </button>
                </div>
                <button class="copy" aria-label="复制日志" @click="copy(item.message)">⧉</button>
              </div>
            </div>
            <div class="load-older log-navigation">
              <el-button v-if="hasOlder" :disabled="logLoading" @click="loadLogs(false)"
                >加载更早日志</el-button
              ><el-button v-if="hasNewer" :disabled="logLoading" @click="loadLogs(false, 'newer')"
                >加载较新日志</el-button
              ><el-button v-if="!viewingLatest" :disabled="logLoading" @click="loadLogs()"
                >回到最新日志</el-button
              ><span>{{
                viewingLatest ? '正在查看最新窗口' : '正在查看历史窗口，自动跟随已暂停'
              }}</span>
            </div>
          </section>
        </div>
        <aside class="detail-side">
          <section class="panel side-panel">
            <div class="side-label">INPUT</div>
            <h2>运行参数</h2>
            <div v-for="(value, key) in run.params" :key="key" class="param">
              <span>{{ key }}</span
              ><strong>{{ value }}</strong>
            </div>
          </section>
        </aside>
      </div>
      <DiagnosisPanel :run="run" />
    </template>
  </div>
</template>
