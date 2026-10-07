<script setup lang="ts">
import {ElTag,ElAlert} from 'element-plus';
import {computed,ref,onMounted,onUnmounted} from 'vue';
import {useRouter} from 'vue-router';
import {z} from 'zod';
import {pipelineProjectSchema} from '@flowlens/contracts';
import {pipelineRead,mutationKey} from '../pipeline-client';
import {localTime} from '../pipeline-present';
const router=useRouter(),projects=ref<z.infer<typeof pipelineProjectSchema>[]>([]),error=ref(''),busy=ref(false),template=ref('A');const controller=new AbortController();
const search=ref(''),loading=ref(true);
const scenarios=[{id:'A',title:'SQL 列错误',description:'查询真实报错，Agent 对照 SQL 与表结构提出修复。',tag:'推荐首次演示'},{id:'B',title:'输出契约错误',description:'查询成功，但输出字段不符；展示独立校验与取证。',tag:'结果校验'},{id:'C',title:'正常与幂等重跑',description:'预检、批准入库、重复跳过，再查询与撤销恢复。',tag:'数据闭环'}];
const filtered=computed(()=>projects.value.filter(p=>(p.name+' '+p.id).toLowerCase().includes(search.value.trim().toLowerCase())));
onMounted(async()=>{try{projects.value=await pipelineRead('/projects',z.array(pipelineProjectSchema),{signal:controller.signal});}catch(e){if(!controller.signal.aborted)error.value=String(e);}finally{if(!controller.signal.aborted)loading.value=false;}});onUnmounted(()=>controller.abort());
async function create(){if(busy.value)return;busy.value=true;error.value='';const body={template_id:template.value},key=mutationKey('create',body);try{const p=await pipelineRead('/projects',pipelineProjectSchema,{method:'POST',headers:{'Idempotency-Key':key.key},body:JSON.stringify(body),signal:controller.signal});key.done();await router.push('/pipeline/projects/'+p.id);}catch(e){if(!controller.signal.aborted)error.value=String(e);}finally{if(!controller.signal.aborted)busy.value=false;}}
</script>
<template><section class="pipeline-page">
 <div class="page-heading"><div><span class="pipeline-eyebrow">车辆数据任务 · Agent 诊断修复</span><h1>真实 Pipeline</h1><p>从 SQL 失败现场到可验证、可恢复的业务数据</p></div><el-tag>SYNTHETIC</el-tag></div>
 <el-alert v-if="error" :title="error" type="error" :closable="false"/>
 <div class="pipeline-overview"><div><strong>真实执行</strong><p>SQLite 查询与独立结果校验</p></div><div><strong>证据驱动的修复</strong><p>工具取证 → SQL Diff → 人工审批</p></div><div><strong>数据可复查、可恢复</strong><p>隔离验证 → 事务入库 → 查询与撤销</p></div></div>
 <div class="pipeline-card"><div class="pipeline-card-heading"><h2>创建演示任务</h2><span class="pipeline-meta">选择场景，创建独立项目</span></div>
  <div class="pipeline-scenarios" role="radiogroup" aria-label="车辆任务模板"><label v-for="scenario in scenarios" :key="scenario.id" class="pipeline-scenario" :class="{selected:template===scenario.id}"><div><span class="pipeline-scenario-index">{{scenario.id}}</span><input v-model="template" type="radio" name="vehicle-template" :value="scenario.id" :aria-label="scenario.id+' · '+scenario.title" :disabled="busy"/></div><strong>{{scenario.title}}</strong><p>{{scenario.description}}</p><small>{{scenario.tag}}</small></label></div>
  <div class="pipeline-actions"><el-button type="primary" :loading="busy" @click="create">创建车辆任务</el-button><span class="pipeline-muted">创建不会调用模型。每个项目使用独立的合成源数据与目标库。</span></div>
 </div>
 <div class="pipeline-card"><div class="pipeline-card-heading"><h2>任务历史 <small>{{projects.length}} 个项目</small></h2><input v-model="search" class="pipeline-project-search" aria-label="搜索车辆任务" placeholder="搜索名称或项目编号"/></div>
  <p v-if="loading" class="pipeline-muted">正在读取任务历史…</p><p v-else-if="!projects.length" class="pipeline-muted">还没有车辆任务，先选择场景创建。</p><p v-else-if="!filtered.length" class="pipeline-muted">没有匹配的任务。</p>
  <router-link v-for="p in filtered" :key="p.id" class="pipeline-project-link" :to="'/pipeline/projects/'+p.id"><span class="pipeline-project-icon">{{p.template}}</span><div><strong>{{p.name}}</strong><p>{{localTime(p.created_at)}} · {{p.id.slice(0,8)}}</p></div><span class="pipeline-project-enter">打开任务 →</span></router-link>
 </div>
</section></template>
