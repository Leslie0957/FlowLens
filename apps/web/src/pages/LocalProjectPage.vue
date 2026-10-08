<script setup lang="ts">
import { ref, watch, onUnmounted, computed } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import {
  fetchLocalProject,
  fetchLocalExecutions,
  startLocalExecution,
  fetchLocalExecution,
  fetchLocalLogs,
  fetchLocalArtifacts,
  fetchLocalArtifact,
  cancelLocalExecution,
  fetchLocalRepairs,
  fetchLocalRepair,
  requestLocalRepair,
  decideLocalRepair,
  cancelLocalRepair,
  fetchLocalLoops,
  fetchLocalLoop,
  startLocalLoop,
  cancelLocalLoop,
} from '../api.js';
import { formatTime } from '../ui.js';
import type {
  LocalProject,
  LocalExecution,
  LocalRepair,
  LocalRepairLoop,
} from '@flowlens/contracts';
const route = useRoute(),
  router = useRouter();
const project = ref<LocalProject | null>(null),
  executions = ref<LocalExecution[]>([]),
  executionPage = ref(1),
  executionTotal = ref(0),
  selected = ref<LocalExecution | null>(null),
  logs = ref<Awaited<ReturnType<typeof fetchLocalLogs>>>([]),
  artifacts = ref<Awaited<ReturnType<typeof fetchLocalArtifacts>>>([]),
  artifactText = ref(''),
  artifactName = ref(''),
  error = ref(''),
  loading = ref(false),
  starting = ref(false),
  cancelling = ref(false);
const repairs = ref<LocalRepair[]>([]),
  repair = ref<LocalRepair | null>(null),
  repairBusy = ref(false);
const loops = ref<LocalRepairLoop[]>([]),
  loop = ref<LocalRepairLoop | null>(null),
  loopConsent = ref(false),
  loopBusy = ref(false);
const projectId = computed(() => String(route.params.projectId ?? ''));
const selectedId = computed(() => String(route.query.execution ?? ''));
const states: Record<string, string> = {
  PENDING: '等待启动',
  RUNNING: '执行中',
  SUCCEEDED: '验证通过',
  FAILED: '执行或验证失败',
  CANCELLED: '已取消',
  INTERRUPTED: '已中断',
};
let controller: AbortController | undefined,
  ticket = 0,
  selectionTicket = 0,
  timer: ReturnType<typeof setInterval> | undefined,
  startKey: string | undefined;
let repairKey: string | undefined, decisionKey: string | undefined, loopKey: string | undefined;
function clear() {
  ticket++;
  selectionTicket++;
  controller?.abort();
  if (timer) clearInterval(timer);
  timer = undefined;
}
function showExecution(execution: LocalExecution) {
  selected.value = execution;
  executions.value = executions.value.map((item) => (item.id === execution.id ? execution : item));
}
async function load() {
  clear();
  const current = ticket;
  controller = new AbortController();
  const signal = controller.signal;
  loading.value = true;
  error.value = '';
  selected.value = null;
  logs.value = [];
  artifacts.value = [];
  repairs.value = [];
  repair.value = null;
  loops.value = [];
  loop.value = null;
  artifactText.value = '';
  try {
    const [p, list] = await Promise.all([
      fetchLocalProject(projectId.value, signal),
      fetchLocalExecutions(projectId.value, signal, executionPage.value),
    ]);
    if (current !== ticket) return;
    project.value = p;
    executions.value = list.data;
    executionTotal.value = list.page_info.total;
    if (selectedId.value) await loadSelected(selectedId.value, current, signal);
    else if (list.data.length)
      await router.replace({ path: route.path, query: { execution: list.data[0]!.id } });
  } catch (e) {
    if (current === ticket && !signal.aborted)
      error.value = e instanceof Error ? e.message : '项目加载失败';
  } finally {
    if (current === ticket) loading.value = false;
  }
}
async function loadSelected(id: string, current = ticket, signal = controller?.signal) {
  const selection = ++selectionTicket;
  selected.value = null;
  logs.value = [];
  artifacts.value = [];
  repairs.value = [];
  repair.value = null;
  loops.value = [];
  loop.value = null;
  artifactText.value = '';
  if (!id) return;
  try {
    const execution = await fetchLocalExecution(id, signal);
    if (current !== ticket || selection !== selectionTicket || id !== selectedId.value) return;
    if (execution.project_id !== projectId.value) {
      error.value = '执行记录不属于当前项目';
      return;
    }
    const [newLogs, newArtifacts, newRepairs, newLoops] = await Promise.all([
      fetchLocalLogs(id, signal),
      fetchLocalArtifacts(id, signal),
      fetchLocalRepairs(id, signal),
      fetchLocalLoops(id, signal),
    ]);
    if (current !== ticket || selection !== selectionTicket || id !== selectedId.value) return;
    showExecution(execution);
    logs.value = newLogs;
    artifacts.value = newArtifacts;
    repairs.value = newRepairs;
    repair.value = newRepairs[0] ?? null;
    loops.value = newLoops;
    loop.value = newLoops[0] ?? null;
  } catch (e) {
    if (current === ticket && selection === selectionTicket && !signal?.aborted)
      error.value = e instanceof Error ? e.message : '执行记录加载失败';
  }
}
async function refreshActive() {
  const id = selectedId.value;
  if (!id) return;
  const current = ticket,
    selection = selectionTicket,
    repairId = repair.value?.id,
    loopId = loop.value?.id;
  try {
    const [execution, newLogs, newArtifacts, newRepair, newLoop] = await Promise.all([
      fetchLocalExecution(id, controller?.signal),
      fetchLocalLogs(id, controller?.signal),
      fetchLocalArtifacts(id, controller?.signal),
      repairId ? fetchLocalRepair(repairId, controller?.signal) : Promise.resolve(null),
      loopId ? fetchLocalLoop(loopId, controller?.signal) : Promise.resolve(null),
    ]);
    if (
      current !== ticket ||
      selection !== selectionTicket ||
      id !== selectedId.value ||
      execution.project_id !== projectId.value
    )
      return;
    showExecution(execution);
    logs.value = newLogs;
    artifacts.value = newArtifacts;
    if (newRepair && repair.value?.id === newRepair.id) {
      repair.value = newRepair;
      repairs.value = repairs.value.map((item) => (item.id === newRepair.id ? newRepair : item));
    }
    if (newLoop && loop.value?.id === newLoop.id) {
      const count = loop.value.rounds.length,
        status = loop.value.status;
      loop.value = newLoop;
      loops.value = loops.value.map((item) => (item.id === newLoop.id ? newLoop : item));
      if (count !== newLoop.rounds.length || status !== newLoop.status) {
        const [p, list] = await Promise.all([
          fetchLocalProject(projectId.value, controller?.signal),
          fetchLocalExecutions(projectId.value, controller?.signal, 1),
        ]);
        if (current === ticket && selection === selectionTicket) {
          project.value = p;
          executions.value = list.data;
          executionTotal.value = list.page_info.total;
          executionPage.value = 1;
        }
      }
    }
  } catch {
    /* explicit refresh displays errors */
  }
}
async function run() {
  if (!project.value || starting.value) return;
  starting.value = true;
  error.value = '';
  startKey ??= crypto.randomUUID();
  try {
    const result = await startLocalExecution(project.value.id, startKey);
    startKey = undefined;
    executionPage.value = 1;
    await router.replace({ path: route.path, query: { execution: result.id } });
    await load();
  } catch (e) {
    error.value = e instanceof Error ? e.message : '启动失败';
  } finally {
    starting.value = false;
  }
}
async function cancel() {
  if (!selected.value || cancelling.value) return;
  cancelling.value = true;
  try {
    await cancelLocalExecution(selected.value.id);
    await refreshActive();
  } catch (e) {
    error.value = e instanceof Error ? e.message : '取消失败';
  } finally {
    cancelling.value = false;
  }
}
async function diagnose() {
  if (!selected.value || repairBusy.value) return;
  repairBusy.value = true;
  error.value = '';
  repairKey ??= crypto.randomUUID();
  try {
    const item = await requestLocalRepair(selected.value.id, repairKey);
    repairKey = undefined;
    repair.value = item;
    repairs.value = [item, ...repairs.value.filter((row) => row.id !== item.id)];
  } catch (e) {
    error.value = e instanceof Error ? e.message : '诊断请求失败';
  } finally {
    repairBusy.value = false;
  }
}
async function decide(decision: 'approve' | 'reject') {
  if (!repair.value || repairBusy.value) return;
  repairBusy.value = true;
  error.value = '';
  decisionKey ??= crypto.randomUUID();
  try {
    const item = await decideLocalRepair(repair.value.id, decision, decisionKey);
    decisionKey = undefined;
    repair.value = item;
    repairs.value = repairs.value.map((row) => (row.id === item.id ? item : row));
    if (decision === 'approve') {
      const [p, list] = await Promise.all([
        fetchLocalProject(projectId.value),
        fetchLocalExecutions(projectId.value, undefined, 1),
      ]);
      project.value = p;
      executions.value = list.data;
      executionTotal.value = list.page_info.total;
      executionPage.value = 1;
    }
  } catch (e) {
    error.value = e instanceof Error ? e.message : '审批操作失败';
  } finally {
    repairBusy.value = false;
  }
}
async function cancelDiagnosis() {
  if (!repair.value || repairBusy.value) return;
  repairBusy.value = true;
  try {
    repair.value = await cancelLocalRepair(repair.value.id);
  } catch (e) {
    error.value = e instanceof Error ? e.message : '取消诊断失败';
  } finally {
    repairBusy.value = false;
  }
}
async function authorizeLoop() {
  if (!selected.value || !loopConsent.value || loopBusy.value) return;
  loopBusy.value = true;
  error.value = '';
  loopKey ??= crypto.randomUUID();
  try {
    const item = await startLocalLoop(selected.value.id, loopKey);
    loopKey = undefined;
    loopConsent.value = false;
    loop.value = item;
    loops.value = [item, ...loops.value.filter((row) => row.id !== item.id)];
  } catch (e) {
    error.value = e instanceof Error ? e.message : '循环授权失败';
  } finally {
    loopBusy.value = false;
  }
}
async function stopLoop() {
  if (!loop.value || loopBusy.value) return;
  loopBusy.value = true;
  error.value = '';
  try {
    const item = await cancelLocalLoop(loop.value.id);
    loop.value = item;
    loops.value = loops.value.map((row) => (row.id === item.id ? item : row));
  } catch (e) {
    error.value = e instanceof Error ? e.message : '停止循环失败';
  } finally {
    loopBusy.value = false;
  }
}
async function showArtifact(id: string) {
  if (!selected.value) return;
  const current = ticket,
    selection = selectionTicket,
    executionId = selected.value.id;
  try {
    const item = await fetchLocalArtifact(executionId, id, controller?.signal);
    if (current !== ticket || selection !== selectionTicket || executionId !== selectedId.value)
      return;
    artifactName.value = item.name;
    artifactText.value = item.content;
  } catch (e) {
    if (current === ticket && selection === selectionTicket)
      error.value = e instanceof Error ? e.message : '产物加载失败';
  }
}
watch(
  projectId,
  () => {
    project.value = null;
    executions.value = [];
    executionPage.value = 1;
    void load();
  },
  { immediate: true },
);
watch(selectedId, () => {
  if (project.value) void loadSelected(selectedId.value);
});
watch(
  () => [
    selected.value?.status,
    repair.value?.status,
    repair.value?.verification?.status,
    loop.value?.status,
  ],
  (statuses) => {
    if (timer) {
      clearInterval(timer);
      timer = undefined;
    }
    if (
      statuses.some(
        (status) =>
          status === 'RUNNING' ||
          status === 'PENDING' ||
          status === 'QUEUED' ||
          status === 'ACTIVE' ||
          status === 'STOPPING',
      )
    )
      timer = setInterval(() => {
        void refreshActive();
      }, 1000);
  },
);
onUnmounted(clear);
</script>
<template>
  <div class="page">
    <div class="backline">
      <router-link to="/local">← 本地执行实验</router-link><span>/</span
      ><span>{{ project?.name || '项目' }}</span>
    </div>
    <div class="page-heading">
      <div>
        <div class="eyebrow">LOCAL EXECUTION · SYNTHETIC</div>
        <h1>{{ project?.name || '本地项目' }}</h1>
        <p>
          SQL 执行使用合成输入；下方 Agent 诊断单独标注 LIVE 或 MOCK。正常对照是预置样本，不代表
          Agent 修复。
        </p>
      </div>
      <div class="local-actions">
        <el-button :loading="loading" @click="load">刷新记录</el-button
        ><el-button type="primary" :loading="starting" :disabled="!project" @click="run"
          >运行任务</el-button
        >
      </div>
    </div>
    <div v-if="error" class="inline-error" role="alert">{{ error }}</div>
    <div v-if="loading && !project" class="panel empty" role="status">正在加载项目…</div>
    <template v-if="project">
      <div class="context-banner">
        <div>
          <strong>实际本地执行 · 合成输入</strong>
          <p>
            运行通过固定 Node 子进程查询内存 SQLite；与 FIXTURE 模拟审批和 DeepSeek LIVE/MOCK
            来源分别记录。
          </p>
        </div>
      </div>
      <div class="local-grid">
        <section class="panel local-card">
          <div class="panel-head">
            <h2>当前不可变版本</h2>
            <span class="panel-count">{{ project.revision?.created_source }}</span>
          </div>
          <div class="local-body">
            <p>版本 {{ project.current_revision_id }}</p>
            <p class="local-hash">SHA-256 {{ project.revision?.sha256 }}</p>
            <h3>task.sql</h3>
            <pre>{{ project.revision?.sql_text }}</pre>
            <h3>合成输入 input.json</h3>
            <pre>{{ project.revision?.input_json }}</pre>
          </div>
        </section>
        <section class="panel local-card">
          <div class="panel-head">
            <h2>执行历史</h2>
            <span class="panel-count">{{ executionTotal }} 次</span>
          </div>
          <div v-if="!executions.length" class="empty">尚未运行。创建项目不会启动任务。</div>
          <ul v-else class="local-execution-list">
            <li v-for="item in executions" :key="item.id">
              <router-link
                :to="{ path: route.path, query: { execution: item.id } }"
                :class="{ active: item.id === selectedId }"
                ><strong>{{ states[item.status] }}</strong
                ><span>{{ formatTime(item.created_at) }}</span
                ><small>{{ item.id }}</small></router-link
              >
            </li>
          </ul>
          <div class="pagination">
            <span
              >第 {{ executionPage }} / {{ Math.max(1, Math.ceil(executionTotal / 20)) }} 页</span
            >
            <div>
              <button
                :disabled="loading || executionPage <= 1"
                @click="
                  executionPage--;
                  load();
                "
              >
                上一页</button
              ><button
                :disabled="loading || executionPage * 20 >= executionTotal"
                @click="
                  executionPage++;
                  load();
                "
              >
                下一页
              </button>
            </div>
          </div>
        </section>
      </div>
      <section v-if="selected" class="panel local-detail">
        <div class="panel-head">
          <h2>执行详情</h2>
          <span class="status" :class="selected.status.toLowerCase()">{{
            states[selected.status]
          }}</span>
        </div>
        <div class="local-body">
          <div class="local-facts">
            <div>
              <span>执行 ID</span><strong>{{ selected.id }}</strong>
            </div>
            <div>
              <span>源码版本 SHA-256</span><strong>{{ selected.revision_hash }}</strong>
            </div>
            <div>
              <span>退出码</span><strong>{{ selected.exit_code ?? '—' }}</strong>
            </div>
            <div>
              <span>耗时</span
              ><strong>{{
                selected.started_at && selected.finished_at
                  ? Date.parse(selected.finished_at) - Date.parse(selected.started_at) + ' ms'
                  : '执行中'
              }}</strong>
            </div>
          </div>
          <p v-if="selected.error_code" class="local-error">
            {{ selected.error_code }} · {{ selected.error_message }}
          </p>
          <p
            v-if="selected.validation"
            :class="selected.validation.passed ? 'local-pass' : 'local-error'"
          >
            独立业务验证：{{ selected.validation.passed ? '通过' : '失败' }} · 实际
            {{ selected.validation.order_count }} 笔 / {{ selected.validation.total_amount }}，期望
            3 笔 / 100
          </p>
          <p v-else>
            独立业务验证：{{
              selected.status === 'RUNNING' || selected.status === 'PENDING'
                ? '等待执行结果'
                : '未通过'
            }}
          </p>
          <el-button
            v-if="selected.status === 'RUNNING' || selected.status === 'PENDING'"
            :loading="cancelling"
            @click="cancel"
            >取消执行</el-button
          >
        </div>
      </section>
      <div v-if="selected" class="local-grid">
        <section class="panel local-card">
          <div class="panel-head">
            <h2>实际执行日志</h2>
            <span class="panel-count">{{ logs.length }} 条</span>
          </div>
          <div v-if="!logs.length" class="empty">暂无日志</div>
          <ol v-else class="local-logs">
            <li v-for="entry in logs" :key="entry.id">
              <span>{{ entry.seq }} · {{ formatTime(entry.timestamp) }} · {{ entry.level }}</span>
              <pre>{{ entry.message }}</pre>
            </li>
          </ol>
        </section>
        <section class="panel local-card">
          <div class="panel-head"><h2>保存的产物</h2></div>
          <div class="local-body">
            <div class="local-artifacts">
              <button v-for="item in artifacts" :key="item.id" @click="showArtifact(item.id)">
                {{ item.name }} · {{ item.size }} B
              </button>
            </div>
            <template v-if="artifactText"
              ><h3>{{ artifactName }}</h3>
              <pre>{{ artifactText }}</pre>
            </template>
          </div>
        </section>
      </div>
      <section v-if="selected" class="panel local-card">
        <div class="panel-head">
          <div>
            <h2>Agent 单次诊断与修复候选</h2>
            <p>只读取此执行的 SQL、日志和结果；候选必须经页面批准才会生成新版本并实际验证。</p>
          </div>
          <el-button
            :disabled="
              selected.status !== 'FAILED' ||
              selected.revision_id !== project.current_revision_id ||
              repairBusy
            "
            :loading="repairBusy"
            @click="diagnose"
            >诊断并生成候选</el-button
          >
        </div>
        <div class="local-body">
          <p v-if="selected.status !== 'FAILED'">选择失败执行后可申请诊断。</p>
          <p v-else-if="selected.revision_id !== project.current_revision_id">
            此执行所属版本已不是当前版本，不能据此提交新候选。
          </p>
          <div v-if="repairs.length" class="local-artifacts">
            <button v-for="item in repairs" :key="item.id" @click="repair = item">
              {{ formatTime(item.created_at) }} · {{ item.provider_mode }} · {{ item.status }}
            </button>
          </div>
          <template v-if="repair"
            ><p>
              <strong>诊断来源：</strong>{{ repair.provider_mode }} · {{ repair.model }} ·
              {{ repair.status }} · {{ repair.model_requests }} 次请求
            </p>
            <p v-if="repair.error_code" class="local-error">{{ repair.error_code }}</p>
            <p v-if="repair.diagnosis">{{ repair.diagnosis }}</p>
            <el-button
              v-if="repair.status === 'QUEUED' || repair.status === 'RUNNING'"
              :disabled="repairBusy"
              @click="cancelDiagnosis"
              >取消诊断</el-button
            >
            <div v-if="repair.tools.length">
              <h3>只读工具轨迹</h3>
              <ol class="local-logs">
                <li v-for="tool in repair.tools" :key="tool.id">
                  <span>{{ tool.seq }} · {{ tool.name }} · {{ tool.error_code || '完成' }}</span>
                </li>
              </ol>
            </div>
            <div v-if="repair.evidence.length">
              <h3>绑定证据</h3>
              <ol class="local-logs">
                <li v-for="item in repair.evidence" :key="item.id">
                  <span
                    >{{ item.source_type }} · {{ item.source_id }} · {{ item.source_version }}</span
                  >
                  <pre>{{ item.excerpt }}</pre>
                </li>
              </ol>
            </div>
            <template v-if="repair.candidate"
              ><h3>待审批补丁 · {{ repair.candidate.file_path }}</h3>
              <p>
                基准版本 {{ repair.base_hash }} · 候选 SHA-256 {{ repair.candidate.sha256 }} ·
                固定验证命令 {{ repair.verification_command_id }}
              </p>
              <p v-if="repair.expires_at">审批有效期至 {{ formatTime(repair.expires_at) }}</p>
              <pre>{{ repair.candidate.diff }}</pre>
              <p>批准只授权这份候选和一次验证。聊天文字不构成审批。</p>
              <div v-if="repair.status === 'PENDING_APPROVAL'" class="local-actions">
                <el-button type="primary" :loading="repairBusy" @click="decide('approve')"
                  >批准并实际验证</el-button
                ><el-button :disabled="repairBusy" @click="decide('reject')">拒绝候选</el-button>
              </div></template
            >
            <div v-if="repair.verification">
              <h3>批准后的实际验证</h3>
              <p>
                新版本 {{ repair.approved_revision_id }} · 执行
                {{ repair.verification_execution_id }}
              </p>
              <p>
                状态 {{ states[repair.verification.status] }} · 退出码
                {{ repair.verification.exit_code ?? '—' }} · 独立业务验证
                {{ repair.verification.validation?.passed ? '通过' : '未通过' }}
              </p>
              <p v-if="repair.verification.error_code" class="local-error">
                {{ repair.verification.error_code }} · {{ repair.verification.error_message }}
              </p>
              <router-link
                :to="{ path: route.path, query: { execution: repair.verification_execution_id } }"
                >查看验证执行与日志 →</router-link
              >
            </div>
          </template>
        </div>
      </section>
      <section v-if="selected" class="panel local-card">
        <div class="panel-head">
          <div>
            <h2>Agent 有限修复循环</h2>
            <p>
              单独授权后，最多自动应用并验证 3 份候选；仅可修改 task.sql，固定执行
              orders-sql-v1，整个循环最多 10 分钟、36 次模型请求。每轮候选和实际结果均会保存。
            </p>
          </div>
        </div>
        <div class="local-body">
          <div
            v-if="
              selected.status === 'FAILED' &&
              selected.revision_id === project.current_revision_id &&
              !loops.some((item) => item.status === 'ACTIVE')
            "
          >
            <label
              ><input v-model="loopConsent" type="checkbox" />
              我批准当前合成项目在上述范围内自动继续修复</label
            >
            <div class="local-actions">
              <el-button
                type="primary"
                :disabled="!loopConsent || loopBusy"
                :loading="loopBusy"
                @click="authorizeLoop"
                >批准有限修复循环</el-button
              >
            </div>
          </div>
          <p v-else-if="selected.revision_id !== project.current_revision_id">
            当前执行属于旧版本，可查看已有循环记录；新循环须从当前版本的失败执行启动。
          </p>
          <div v-if="loops.length" class="local-artifacts">
            <button v-for="item in loops" :key="item.id" @click="loop = item">
              {{ formatTime(item.created_at) }} · {{ item.provider_mode }} · {{ item.status }}
            </button>
          </div>
          <template v-if="loop"
            ><p>
              <strong>循环状态：</strong>{{ loop.status }} · {{ loop.provider_mode }} ·
              {{ loop.rounds.length }} / {{ loop.max_rounds }} 轮 · {{ loop.model_requests }} /
              {{ loop.max_model_requests }} 次模型请求
            </p>
            <p>
              用量：输入 {{ loop.usage.prompt_tokens }} / 输出
              {{ loop.usage.completion_tokens }} tokens · 截止 {{ formatTime(loop.deadline_at) }}
            </p>
            <p>
              授权范围：{{ loop.writable_file }} ·
              {{ loop.verification_command_id }}。只有实际执行与独立 3/100 验证通过才记为成功。
            </p>
            <p v-if="loop.error_code" class="local-error">{{ loop.error_code }}</p>
            <el-button v-if="loop.status === 'ACTIVE'" :loading="loopBusy" @click="stopLoop"
              >停止循环</el-button
            >
            <ol v-if="loop.rounds.length" class="local-logs">
              <li v-for="round in loop.rounds" :key="round.round_no">
                <h3>第 {{ round.round_no }} 轮 · {{ round.repair.status }}</h3>
                <p>
                  基准 {{ round.repair.base_hash }} · 模型 {{ round.repair.provider_mode }} · 本轮
                  {{ round.repair.model_requests }} 次请求 · 输入
                  {{ round.repair.usage?.prompt_tokens ?? 0 }} / 输出
                  {{ round.repair.usage?.completion_tokens ?? 0 }} tokens
                </p>
                <p v-if="round.repair.diagnosis">{{ round.repair.diagnosis }}</p>
                <p v-if="round.repair.candidate">
                  候选 {{ round.repair.candidate.sha256 }} · task.sql
                </p>
                <pre v-if="round.repair.candidate">{{ round.repair.candidate.diff }}</pre>
                <details v-if="round.repair.evidence.length">
                  <summary>查看本轮绑定证据（{{ round.repair.evidence.length }} 条）</summary>
                  <p v-for="item in round.repair.evidence" :key="item.id">
                    {{ item.source_type }} · {{ item.source_id }} · {{ item.source_version
                    }}<br />{{ item.excerpt }}
                  </p>
                </details>
                <p v-if="round.repair.verification">
                  实际验证 {{ states[round.repair.verification.status] }} · 退出码
                  {{ round.repair.verification.exit_code ?? '—' }} ·
                  {{ round.repair.verification.error_code ?? '无错误码' }} ·
                  {{
                    round.repair.verification.validation?.passed
                      ? '3 笔 / 100 通过'
                      : '业务验证未通过'
                  }}
                </p>
                <router-link
                  v-if="round.repair.verification_execution_id"
                  :to="{
                    path: route.path,
                    query: { execution: round.repair.verification_execution_id },
                  }"
                  >查看本轮执行与日志 →</router-link
                >
              </li>
            </ol>
          </template>
        </div>
      </section>
    </template>
  </div>
</template>
