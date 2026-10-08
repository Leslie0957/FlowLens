<script setup lang="ts">
import { ElAlert, ElSelect, ElOption, ElTable, ElTableColumn } from 'element-plus';
import { computed, ref, watch, onUnmounted } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { pipelineQueryResultSchema, pipelineDatabaseSchema } from '@flowlens/contracts';
import { z } from 'zod';
import { pipelineRead, projectPath, usePipelineSnapshot } from '../pipeline-client';
import PipelineSchemaTable from './PipelineSchemaTable.vue';

const route = useRoute();
const router = useRouter();
const projectId = computed(() => String(route.params.projectId));
const { snapshot, error, connection } = usePipelineSnapshot(projectId);

const scope = ref('source');
const batch = ref('');
const sql = ref('');
const result = ref<z.infer<typeof pipelineQueryResultSchema> | null>(null);
const busy = ref(false);
const queryError = ref('');
const invalidated = ref(false);
let seq = 0;
let controller: AbortController | null = null;

const databaseSchema = ref<z.infer<typeof pipelineDatabaseSchema> | null>(null);
const schemaError = ref('');
let schemaSeq = 0;
let schemaController: AbortController | null = null;

watch(
  projectId,
  async pid => {
    const generation = ++schemaSeq;
    schemaController?.abort();
    schemaController = new AbortController();
    const signal = schemaController.signal;
    databaseSchema.value = null;
    schemaError.value = '';

    try {
      const next = await pipelineRead(
        projectPath(pid) + '/schema',
        pipelineDatabaseSchema,
        { signal },
      );
      if (generation === schemaSeq && !signal.aborted) {
        databaseSchema.value = next;
      }
    } catch (e) {
      if (generation === schemaSeq && !signal.aborted) {
        schemaError.value = String(e);
      }
    }
  },
  { immediate: true },
);

const fields = computed(() =>
  scope.value === 'source' ? databaseSchema.value?.source : databaseSchema.value?.target,
);
const sourceSql =
  'SELECT dat, speed_mps, start_us, end_us, car_series FROM raw_vehicle_events ORDER BY event_id LIMIT 20;';
const targetSql =
  'SELECT dat, st, et, car_series FROM mining_results ORDER BY dat, st LIMIT 20;';

watch(
  () => [projectId.value, route.query.scope, route.query.batch],
  () => {
    seq++;
    controller?.abort();
    busy.value = false;
    scope.value = ['source', 'target', 'snapshot'].includes(String(route.query.scope))
      ? String(route.query.scope)
      : 'source';
    batch.value = String(route.query.batch ?? '');
    sql.value = scope.value === 'source' ? sourceSql : targetSql;
    result.value = null;
    queryError.value = '';
    invalidated.value = false;
  },
  { immediate: true },
);

watch(
  () => snapshot.value?.target.data_version,
  (next, old) => {
    if (
      old !== undefined &&
      next !== old &&
      scope.value === 'target' &&
      (result.value || busy.value)
    ) {
      seq++;
      controller?.abort();
      busy.value = false;
      invalidated.value = true;
      result.value = null;
      queryError.value = '目标数据已入库或恢复，旧结果已失效，请重新查询。';
    }
  },
);

onUnmounted(() => {
  seq++;
  controller?.abort();
  schemaSeq++;
  schemaController?.abort();
});

function changeSource(value: string) {
  void router.replace({
    query: { scope: value, ...(batch.value ? { batch: batch.value } : {}) },
  });
}

function changeBatch(value: string) {
  void router.replace({ query: { scope: scope.value, batch: value } });
}

async function query() {
  controller?.abort();
  controller = new AbortController();
  const signal = controller.signal;
  const id = ++seq;
  const pid = projectId.value;
  const selectedScope = scope.value;
  const selectedBatch = batch.value;
  busy.value = true;
  queryError.value = '';
  result.value = null;
  invalidated.value = false;

  try {
    const r = await pipelineRead(projectPath(pid) + '/query', pipelineQueryResultSchema, {
      method: 'POST',
      body: JSON.stringify({
        scope: selectedScope,
        ...(selectedScope === 'snapshot' ? { batch_id: selectedBatch } : {}),
        sql: sql.value,
        limit: 200,
      }),
      signal,
    });
    if (id !== seq || signal.aborted || r.project_id !== pid) return;
    if (
      selectedScope === 'target' &&
      snapshot.value &&
      r.data_version !== snapshot.value.target.data_version
    ) {
      invalidated.value = true;
      queryError.value = '查询期间目标版本已改变，请重新查询。';
      return;
    }
    result.value = r;
  } catch (e) {
    if (id === seq && !signal.aborted) {
      queryError.value = String(e);
    }
  } finally {
    if (id === seq && !signal.aborted) {
      busy.value = false;
    }
  }
}

function cancel() {
  seq++;
  controller?.abort();
  busy.value = false;
  queryError.value = '查询已取消';
}

const selectedBatch = computed(() => snapshot.value?.batches.find(b => b.id === batch.value));

function batchPreset() {
  if (!selectedBatch.value) return;
  sql.value =
    "SELECT dat, st, et, car_series FROM mining_results WHERE execution_id = '" +
    selectedBatch.value.execution_id +
    "' ORDER BY dat LIMIT 20;";
}
</script>

<template>
  <section class="pipeline-page">
    <div class="page-heading">
      <div>
        <router-link :to="'/pipeline/projects/' + projectId">← 执行工作台</router-link>
        <h1>只读 SQL 查询</h1>
        <p>{{ snapshot?.project.name }} · {{ connection }} · 查询不创建版本或入库</p>
      </div>
    </div>

    <el-alert
      v-if="error || queryError"
      :title="queryError || error"
      :type="invalidated ? 'warning' : 'error'"
      :closable="false"
    />

    <div class="pipeline-card">
      <h2>数据作用域</h2>
      <div class="pipeline-actions">
        <el-select
          :model-value="scope"
          aria-label="数据来源"
          @update:model-value="changeSource(String($event))"
        >
          <el-option label="本项目源数据" value="source" />
          <el-option label="当前目标结果" value="target" />
          <el-option label="指定入库前快照" value="snapshot" />
        </el-select>
        <el-select
          v-if="scope !== 'source'"
          :model-value="batch"
          clearable
          aria-label="关联入库批次"
          @update:model-value="changeBatch(String($event))"
        >
          <el-option
            v-for="b in snapshot?.batches ?? []"
            :key="b.id"
            :value="b.id"
            :label="b.id.slice(0, 8) + ' · ' + b.status + ' · 前 ' + b.before_count + ' 行'"
          />
        </el-select>
      </div>

      <p v-if="scope === 'source'">
        允许表 raw_vehicle_events · synthetic-vehicles-v1 · {{ snapshot?.project.input_hash }}
      </p>
      <p v-else-if="scope === 'target'">
        允许表 mining_results · 当前 data_version {{ snapshot?.target.data_version }} ·
        {{ snapshot?.target.row_count }} 行
      </p>
      <p v-else>
        允许表 mining_results · 入库前快照 {{ selectedBatch?.snapshot_id ?? '请选择批次' }} ·
        {{ selectedBatch?.before_count }} 行 · {{ selectedBatch?.before_hash }} ·
        {{ selectedBatch?.created_at }}
      </p>

      <div class="pipeline-schema" aria-label="允许字段与实际类型">
        <p v-if="schemaError">字段结构读取失败：{{ schemaError }}</p>
        <p v-else-if="!fields">正在读取实际 SQLite 表结构…</p>
        <template v-else>
          <p class="pipeline-field-caption">允许字段与实际类型 · {{ fields.length }} 个字段</p>
          <PipelineSchemaTable :fields="fields" />
        </template>
      </div>
    </div>

    <div class="pipeline-card">
      <h2>受限 SELECT</h2>
      <p>
        支持字段、简单比较/算术、WHERE、ORDER BY、LIMIT 和 COUNT。禁止写入、跨库、系统表、JOIN 与多语句。默认最多200行。
      </p>
      <textarea
        v-model="sql"
        class="pipeline-sql"
        aria-label="只读 SQL 编辑器"
        spellcheck="false"
      />
      <div class="pipeline-actions">
        <el-button
          type="primary"
          :disabled="busy || (scope === 'snapshot' && !batch)"
          @click="query"
        >
          执行只读查询
        </el-button>
        <el-button v-if="busy" @click="cancel">取消查询</el-button>
        <el-button :disabled="busy" @click="sql = scope === 'source' ? sourceSql : targetSql">
          预览模板
        </el-button>
        <el-button
          :disabled="busy"
          @click="
            sql =
              'SELECT COUNT(*) AS result_count FROM ' +
              (scope === 'source' ? 'raw_vehicle_events' : 'mining_results') +
              ';'
          "
        >
          COUNT 模板
        </el-button>
        <el-button
          v-if="scope === 'target' && selectedBatch"
          :disabled="busy"
          @click="batchPreset"
        >
          本次实际新增行
        </el-button>
      </div>
    </div>

    <div v-if="result" class="pipeline-card pipeline-query-result">
      <h2>实际查询结果</h2>
      <dl class="pipeline-query-stats">
        <div>
          <dt>返回行数</dt>
          <dd>{{ result.row_count }} <small>行</small></dd>
        </div>
        <div>
          <dt>执行耗时</dt>
          <dd>{{ result.elapsed_ms.toFixed(1) }} <small>ms</small></dd>
        </div>
        <div>
          <dt>数据版本</dt>
          <dd>{{ result.data_version }}</dd>
        </div>
        <div>
          <dt>结果范围</dt>
          <dd :class="{ 'pipeline-query-truncated': result.truncated }">
            {{ result.truncated ? '已达到截断上限' : '完整结果' }}
          </dd>
        </div>
      </dl>

      <details class="pipeline-query-hash">
        <summary>数据摘要 <code>{{ result.data_hash.slice(0, 16) }}…</code></summary>
        <p class="mono">{{ result.data_hash }}</p>
      </details>
      <details class="pipeline-schema-details">
        <summary>实际 SQLite 字段结构 <span>{{ result.schema.length }} 个字段</span></summary>
        <PipelineSchemaTable :fields="result.schema" label="本次查询的实际表结构" />
      </details>

      <h3 class="pipeline-query-data-heading">查询数据</h3>
      <el-table :data="result.rows" max-height="500" empty-text="查询成功，0 行" border stripe>
        <el-table-column
          v-for="c in result.columns"
          :key="c"
          :prop="c"
          :label="c"
          min-width="160"
        />
      </el-table>
    </div>
  </section>
</template>
