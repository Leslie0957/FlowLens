<script setup lang="ts">
import { computed } from 'vue';
import type { SessionState } from './agent-reducer.js';
import { formatTime } from './ui.js';
const props = defineProps<{ tool: SessionState['tool_calls'][number] }>();
const purposes: Record<string, string> = {
  get_task_run: '查询当前运行状态',
  get_task_definition: '查询任务定义',
  get_task_logs: '查询当前运行日志',
  search_runbook: '检索故障手册',
};
const purpose = computed(() => purposes[props.tool.name] ?? '只读扩展查询');
const statusIcons = { RUNNING: '⏳', SUCCEEDED: '✓', FAILED: '!', CANCELLED: '—' };
const resultSummary = computed(() => {
  try {
    const value = JSON.parse(props.tool.result_summary_json ?? 'null');
    return typeof value?.summary === 'string'
      ? value.summary
      : typeof value?.count === 'number'
        ? `取得 ${value.count} 条证据`
        : null;
  } catch {
    return null;
  }
});
function pretty(raw: string | null, result = false) {
  if (raw === null) return '尚无查询结果';
  try {
    const value: unknown = JSON.parse(raw);
    return JSON.stringify(
      result && value !== null && typeof value === 'object' && 'output' in value
        ? value.output
        : value,
      null,
      2,
    );
  } catch {
    return '历史数据不是有效 JSON：\n' + raw;
  }
}
const duration = computed(() => {
  const start = Date.parse(props.tool.started_at),
    finish = props.tool.finished_at ? Date.parse(props.tool.finished_at) : NaN;
  return Number.isFinite(start) && Number.isFinite(finish) && finish >= start
    ? `${finish - start} ms`
    : props.tool.status === 'RUNNING'
      ? '进行中'
      : '耗时未记录';
});
</script>
<template>
  <article class="tool-card">
    <div class="trace-heading">
      <strong>{{ tool.name }}</strong
      ><span
        ><span aria-hidden="true">{{ statusIcons[tool.status] }}</span> {{ tool.status }}</span
      ><small>{{ duration }}</small>
    </div>
    <p>{{ purpose }} · 开始于 {{ formatTime(tool.started_at) }}</p>
    <small class="trace-id">调用 ID：{{ tool.id }}</small>
    <p v-if="resultSummary">{{ resultSummary }}</p>
    <p v-if="tool.error_code" class="inline-error">{{ tool.error_code }}</p>
    <details>
      <summary>参数与查询结果</summary>
      <h4>参数</h4>
      <pre>{{ pretty(tool.args_json) }}</pre>
      <h4>查询结果</h4>
      <pre>{{ pretty(tool.result_summary_json, true) }}</pre>
    </details>
  </article>
</template>
<style scoped>
.tool-card {
  display: block;
  min-width: 0;
}
.trace-heading {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 14px;
}
.tool-card p {
  margin: 6px 0;
}
.trace-id {
  display: block;
  overflow-wrap: anywhere;
  color: #71829f;
}
.tool-card details {
  margin-top: 10px;
}
.tool-card summary {
  cursor: pointer;
  color: #4f63e3;
}
.tool-card h4 {
  margin: 12px 0 6px;
}
.tool-card pre {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  max-height: 260px;
  overflow: auto;
  padding: 10px;
  background: #f5f7fb;
  border-radius: 8px;
  font-size: 12px;
}
</style>
