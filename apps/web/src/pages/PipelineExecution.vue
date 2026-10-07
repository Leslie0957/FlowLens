<script setup lang="ts">
import {ElAlert,ElTable,ElTableColumn} from 'element-plus';
import type {PipelineExecution} from '@flowlens/contracts';
import {statusLabel,statusTone,stepLabel,localTime} from '../pipeline-present';
const props=defineProps<{execution:PipelineExecution;sql:string}>();
function stepState(step:string){const e=props.execution;if(e.failed_step===step)return 'failed';const passed=step==='query'?e.columns.length>0:step==='validate'?e.validation?.passed:step==='precheck'?!!e.precheck&&e.precheck.conflicts===0:e.verification?.passed;return passed?'done':'waiting';}
</script>
<template><div class="pipeline-card pipeline-execution-card">
 <div class="pipeline-card-heading"><h2>实际执行</h2><span class="pipeline-status" :class="statusTone(execution.status)" :title="execution.status">{{statusLabel(execution.status)}}</span></div>
 <p class="pipeline-meta">{{execution.kind==='PRECHECK'?'只读预检':'隔离验证'}} · {{localTime(execution.created_at)}}</p>
 <div class="pipeline-steps"><span v-for="step in ['query','validate','precheck',...(execution.kind==='VERIFICATION'?['verification']:[])]" :key="step" :class="{'failed-step':stepState(step)==='failed','done-step':stepState(step)==='done'}">{{stepState(step)==='failed'?'× ':stepState(step)==='done'?'✓ ':''}}{{stepLabel(step)}}</span></div>
 <el-alert v-if="execution.error_message" :title="execution.error_message" type="error" :closable="false"/>
 <details><summary>本次不可变 task.sql</summary><pre>{{sql}}</pre></details>
 <p v-if="execution.validation" class="pipeline-validation-note" :class="execution.validation.passed?'success':'danger'">独立校验：{{execution.validation.passed?'通过':'失败'}} · 预期 {{execution.validation.expected_count}} / 实际 {{execution.validation.actual_count}} 行 · {{execution.validation.message}}</p>
 <p v-if="execution.verification" class="pipeline-validation-note">隔离验证：新增 {{execution.verification.inserted}} / 重跑跳过 {{execution.verification.rerun_skipped}} · {{execution.verification.passed?'通过':'失败'}}</p>
 <h3>实时执行日志 <small>真实执行与校验记录</small></h3><div class="pipeline-logs"><p v-for="(log,i) in execution.logs" :key="execution.id+':'+i" :class="{error:log.level==='ERROR'}"><time>{{localTime(log.at).split(' ')[1]??log.at.slice(11,23)}}</time> [{{log.step}}] {{log.message}}</p></div>
 <details><summary>实际输出（{{execution.rows.length}} 行）</summary><el-table :data="execution.rows" max-height="300" border stripe><el-table-column v-for="column in execution.columns" :key="column" :prop="column" :label="column" min-width="155"/></el-table></details>
 <details class="pipeline-technical"><summary>执行编号与退出码</summary><p class="mono">{{execution.id}} · {{execution.kind}} · exit {{execution.exit_code??'运行中'}}</p></details>
 </div></template>
