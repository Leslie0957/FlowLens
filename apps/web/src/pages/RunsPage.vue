<script setup lang="ts">
import {ref,computed,watch,onMounted,onUnmounted} from 'vue';
import {useRoute,useRouter} from 'vue-router';
import {ElMessage} from 'element-plus';
import {useRunsStore} from '../store/runs.js';
import {fetchScenarios,createDemoRun,fetchCapabilities,ApiError} from '../api.js';
import {formatTime,formatDuration,shortId,statusLabel} from '../ui.js';
import type {Scenario,Capabilities} from '@flowlens/contracts';
const route=useRoute(),router=useRouter(),store=useRunsStore();
const search=ref(String(route.query.q??'')),modal=ref(false),scenarios=ref<Scenario[]>([]),creating=ref(''),sceneError=ref(''),capabilities=ref<Capabilities|null>(null),capabilityError=ref('');
const pendingKeys:Record<string,string>={};
const status=computed(()=>String(route.query.status??'')),page=computed(()=>Math.max(1,Number(route.query.page)||1));
const pageCount=computed(()=>Math.max(1,Math.ceil(store.total/20)));
const filters=[{value:'',label:'全部运行'},{value:'RUNNING',label:'运行中'},{value:'SUCCEEDED',label:'已完成'},{value:'FAILED',label:'已失败'}];
let debounce:ReturnType<typeof setTimeout>|undefined,poll:ReturnType<typeof setInterval>|undefined;
function query(){return {page:page.value,limit:20,...(status.value?{status:status.value}:{}),...(String(route.query.q??'')?{q:String(route.query.q)}:{})};}
function updateQuery(patch:Record<string,string|undefined>){void router.replace({path:'/runs',query:{...route.query,...patch}});}
watch(()=>[route.query.page,route.query.status,route.query.q],()=>{search.value=String(route.query.q??'');void store.load(query());},{immediate:true});
watch(search,value=>{clearTimeout(debounce);if(value===String(route.query.q??''))return;debounce=setTimeout(()=>updateQuery({q:value.trim()||undefined,page:undefined}),300);});
async function openModal(){modal.value=true;sceneError.value='';try{scenarios.value=await fetchScenarios();}catch(error){sceneError.value=error instanceof Error?error.message:'场景加载失败';}}
async function createScene(id:string){creating.value=id;sceneError.value='';try{const key=pendingKeys[id]??(pendingKeys[id]=crypto.randomUUID());const run=await createDemoRun(id,key);delete pendingKeys[id];modal.value=false;ElMessage.success('演示运行已创建');await router.push('/runs/'+run.id);}catch(error){sceneError.value=error instanceof ApiError?error.message+' · '+error.requestId:error instanceof Error?error.message:'创建失败';}finally{creating.value='';}}
function copyId(id:string){void navigator.clipboard.writeText(id).then(()=>ElMessage.success('运行 ID 已复制'));}
onMounted(()=>{void fetchCapabilities().then(value=>capabilities.value=value).catch(error=>{capabilityError.value=error instanceof Error?error.message:'模型配置状态不可用';});poll=setInterval(()=>{if(document.visibilityState==='visible'&&store.runs.some(r=>r.status==='PENDING'||r.status==='RUNNING'))void store.load(query(),true);},3000);document.addEventListener('visibilitychange',visible);});
function visible(){if(document.visibilityState==='visible')void store.load(query(),true);}
onUnmounted(()=>{clearTimeout(debounce);clearInterval(poll);document.removeEventListener('visibilitychange',visible);store.stop();});
</script>
<template>
<div class="page">
  <div class="page-heading"><div><div class="eyebrow">OVERVIEW <span class="eyebrow-line"></span> RUN MONITOR</div><h1>运行监控</h1><p>查看演示任务的状态、阶段与日志。所有任务数据均来自服务端。</p></div><el-button type="primary" size="large" class="primary-action" @click="openModal"><span class="button-plus">＋</span> 新建演示运行</el-button></div>
  <div class="context-banner"><span class="context-icon">◉</span><div><strong>演示任务数据</strong><p>这里展示的运行与日志均为合成示例，不涉及真实业务系统。</p></div><span class="model-chip">{{capabilityError?'模型配置状态不可用':capabilities?.model_configured?'模型已配置 · 诊断待接入':'模型未配置 · 诊断待接入'}}</span></div>
  <div class="metrics"><div class="metric"><span>当前结果</span><strong>{{store.total}}</strong><small>条运行记录</small></div><div class="metric"><span>当前页进行中</span><strong class="blue">{{store.runs.filter(r=>r.status==='RUNNING'||r.status==='PENDING').length}}</strong><small>每 3 秒更新</small></div><div class="metric"><span>当前页失败</span><strong class="red">{{store.runs.filter(r=>r.status==='FAILED').length}}</strong><small>可查看错误日志</small></div></div>
  <section class="panel"><div class="panel-head"><div><h2>任务运行</h2><p>最近的演示运行与状态变化</p></div><span class="panel-count">{{store.total}} 条记录</span></div>
    <div class="toolbar"><div class="tabs"><button v-for="item in filters" :key="item.label" :class="{selected:status===item.value}" @click="updateQuery({status:item.value||undefined,page:undefined})">{{item.label}}</button></div><div class="search-wrap"><span>⌕</span><input v-model="search" aria-label="搜索任务" placeholder="搜索任务名称"><kbd>⌘ K</kbd></div></div>
    <div v-if="store.error" class="inline-error">加载失败：{{store.error}} <small v-if="store.requestId">请求 ID：{{store.requestId}}</small><button @click="store.load(query())">重试</button></div>
    <div v-if="store.loading&&!store.runs.length" class="empty">正在加载运行…</div>
    <div v-else-if="!store.runs.length&&!store.error" class="empty"><strong>没有符合条件的运行</strong><p>换一个筛选条件，或新建演示运行。</p></div>
    <div v-else class="table-wrap"><table><thead><tr><th>任务 / 运行 ID</th><th>状态</th><th>演示场景</th><th>开始时间</th><th>耗时</th><th>数据来源</th><th></th></tr></thead><tbody><tr v-for="run in store.runs" :key="run.id" @click="router.push('/runs/'+run.id)"><td><div class="task-cell"><div class="task-glyph">▤</div><div><strong>{{run.task_name}}</strong><small>{{shortId(run.id)}} <button class="copy" aria-label="复制运行 ID" @click.stop="copyId(run.id)">⧉</button></small></div></div></td><td><span class="status" :class="run.status.toLowerCase()"><i></i>{{statusLabel[run.status]}}</span></td><td><span class="scenario">{{run.scenario_id}}</span></td><td>{{formatTime(run.started_at||run.created_at)}}</td><td>{{formatDuration(run.duration_ms)}}</td><td><span class="fixture-tag">FIXTURE</span></td><td class="chevron">›</td></tr></tbody></table></div>
    <div class="pagination"><span>第 {{page}} / {{pageCount}} 页</span><div><button :disabled="page<=1" @click="updateQuery({page:String(page-1)})">上一页</button><button :disabled="page>=pageCount" @click="updateQuery({page:String(page+1)})">下一页</button></div></div>
  </section>
  <p class="footnote">FlowLens M1 · 工程基础与运行页面 · 诊断、审批和模拟重试将在后续阶段接入</p>
  <el-dialog v-model="modal" title="新建演示运行" width="480px" class="scene-dialog"><p class="dialog-intro">选择一个合成场景。运行状态和日志将由本地服务生成并保存。</p><div v-if="sceneError" class="inline-error">{{sceneError}}</div><div v-for="item in scenarios" :key="item.id" class="scene-option"><div><span class="scenario">{{item.id}}</span><strong>{{item.display_name}}</strong><p>{{item.description}}</p></div><el-button :loading="creating===item.id" @click="createScene(item.id)">创建</el-button></div></el-dialog>
</div>
</template>
