<script setup lang="ts">
import {ref,onUnmounted} from 'vue';
import {useRouter} from 'vue-router';
import {fetchLocalProjects,createLocalProject} from '../api.js';
import {formatTime} from '../ui.js';
import type {LocalProject} from '@flowlens/contracts';
const router=useRouter(),rows=ref<LocalProject[]>([]),loading=ref(false),creating=ref(''),error=ref(''),page=ref(1),total=ref(0);
const keys=new Map<string,string>();let controller:AbortController|undefined,ticket=0;
async function load(){const current=++ticket;controller?.abort();controller=new AbortController();loading.value=true;error.value='';try{const result=await fetchLocalProjects(controller.signal,page.value);if(current===ticket){rows.value=result.data;total.value=result.page_info.total;}}catch(e){if(current===ticket&&!controller.signal.aborted)error.value=e instanceof Error?e.message:'项目加载失败';}finally{if(current===ticket)loading.value=false;}}
async function create(id:'sql-column-error'|'sql-valid-control'){if(creating.value)return;creating.value=id;error.value='';const key=keys.get(id)??crypto.randomUUID();keys.set(id,key);try{const project=await createLocalProject(id,key);keys.delete(id);await router.push('/local/projects/'+project.id);}catch(e){error.value=e instanceof Error?e.message:'项目创建失败';}finally{creating.value='';}}
onUnmounted(()=>{ticket++;controller?.abort();});void load();
</script>
<template>
<div class="page">
 <div class="page-heading"><div><div class="eyebrow">LOCAL EXECUTION</div><h1>本地执行实验</h1><p>创建独立 SQL 项目，实际运行合成订单查询。</p></div><el-button :loading="loading" @click="load">刷新项目</el-button></div>
 <div class="context-banner"><div><strong>LOCAL_EXECUTION · SYNTHETIC</strong><p>本步骤未调用模型。这里的运行是实际 Node 子进程和临时 SQLite 查询；S00～S05 仍是独立的 FIXTURE 演示。</p></div></div>
 <div v-if="error" class="inline-error" role="alert">{{error}}</div>
 <div class="scenario-grid">
  <article class="panel scenario-card"><span class="fixture-tag">故障样本</span><h2>SQL 列错误</h2><p>查询引用不存在的 order_total 列。创建项目不会自动运行；不改源码重复运行仍会失败。</p><el-button type="primary" :loading="creating==='sql-column-error'" :disabled="!!creating&&creating!=='sql-column-error'" @click="create('sql-column-error')">创建故障项目</el-button></article>
  <article class="panel scenario-card"><span class="fixture-tag">预置样本</span><h2>正常对照（预置）</h2><p>查询 amount 列，独立验证期望 3 笔订单、总额 100。此样本不是 Agent 修复。</p><el-button :loading="creating==='sql-valid-control'" :disabled="!!creating&&creating!=='sql-valid-control'" @click="create('sql-valid-control')">创建正常对照</el-button></article>
 </div>
 <section class="panel local-history"><div class="panel-head"><h2>实验项目</h2><span class="panel-count">{{rows.length}} 个</span></div><div v-if="loading&&!rows.length" class="empty" role="status">正在加载项目…</div><div v-else-if="!rows.length" class="empty">暂无项目。选择上方样本创建。</div><ul v-else class="history-list"><li v-for="item in rows" :key="item.id" class="history-item"><div class="history-meta"><strong>{{item.name}}</strong><span class="fixture-tag">LOCAL_EXECUTION · SYNTHETIC</span></div><router-link class="history-title" :to="'/local/projects/'+item.id">打开项目 →</router-link><small>创建于 {{formatTime(item.created_at)}} · {{item.id}}</small></li></ul></section>
 <div class="pagination"><span>第 {{page}} / {{Math.max(1,Math.ceil(total/20))}} 页 · 共 {{total}} 个项目</span><div><button :disabled="loading||page<=1" @click="page--;load()">上一页</button><button :disabled="loading||page*20>=total" @click="page++;load()">下一页</button></div></div>
</div>
</template>
