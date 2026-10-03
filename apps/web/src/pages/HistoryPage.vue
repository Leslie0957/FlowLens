<script setup lang="ts">
import {ref,computed,watch,onUnmounted} from 'vue';
import {useRoute,useRouter} from 'vue-router';
import {fetchHistory} from '../api.js';
import {formatTime} from '../ui.js';
const route=useRoute(),router=useRouter();
const rows=ref<Awaited<ReturnType<typeof fetchHistory>>['data']>([]),total=ref(0),loading=ref(false),error=ref(''),search=ref(String(route.query.q??''));
const page=computed(()=>Math.max(1,Number(route.query.page)||1)),pages=computed(()=>Math.max(1,Math.ceil(total.value/20)));
const labels:Record<string,string>={QUEUED:'等待诊断',RUNNING:'诊断中',COMPLETED:'已完成',FAILED:'失败',CANCELLED:'已取消',INTERRUPTED:'已中断'};
let controller:AbortController|undefined,ticket=0,timer:ReturnType<typeof setTimeout>|undefined;
async function load(){const current=++ticket;controller?.abort();controller=new AbortController();const signal=controller.signal;loading.value=true;error.value='';try{const result=await fetchHistory({page:page.value,limit:20,q:String(route.query.q??'')||undefined},signal);if(current!==ticket)return;rows.value=result.data;total.value=result.page_info.total;}catch(e){if(current===ticket&&!signal.aborted)error.value=e instanceof Error?e.message:'历史加载失败';}finally{if(current===ticket)loading.value=false;}}
function update(patch:Record<string,string|undefined>){void router.replace({path:'/diagnoses',query:{...route.query,...patch}});}
watch(()=>[route.query.page,route.query.q],()=>{search.value=String(route.query.q??'');void load();},{immediate:true});
watch(search,value=>{clearTimeout(timer);if(value===String(route.query.q??''))return;timer=setTimeout(()=>update({q:value.trim()||undefined,page:undefined}),300);});
onUnmounted(()=>{ticket++;controller?.abort();clearTimeout(timer);});
</script>
<template>
<div class="page">
 <div class="page-heading"><div><div class="eyebrow">DIAGNOSIS HISTORY</div><h1>历史诊断</h1><p>查看已保存的会话、最后一轮状态与结论，再继续追问。</p></div><el-button :loading="loading" @click="load">刷新历史</el-button></div>
 <div class="context-banner"><div><strong>演示任务数据 · FIXTURE</strong><p>模型来源按每个会话的最后一轮记录展示，运行与重试仍为模拟。</p></div></div>
 <section class="panel"><div class="panel-head"><h2>诊断会话</h2><span class="panel-count">{{total}} 个会话</span></div>
  <div class="toolbar"><div class="search-wrap"><span>⌕</span><input v-model="search" maxlength="200" aria-label="搜索历史诊断" placeholder="搜索标题、任务名称或运行 ID"></div><span v-if="loading" role="status">正在加载…</span></div>
  <div v-if="error" class="inline-error" role="alert">{{error}} <button @click="load">重试</button></div>
  <div v-else-if="!rows.length" class="empty">{{loading?'正在加载历史…':'暂无符合条件的诊断会话'}}<p>在运行工作台创建会话后，记录会出现在这里。</p><router-link class="text-link" to="/runs">前往运行监控 →</router-link></div>
  <ul v-else class="history-list"><li v-for="item in rows" :key="item.id" class="history-item">
   <div class="history-meta"><span class="scenario">{{item.scenario_id}}</span><strong>{{item.task_name}}</strong><span class="history-state">{{item.last_status?labels[item.last_status]:'尚未提问'}}</span><span class="fixture-tag">{{item.provider_mode||'尚无模型调用'}} · FIXTURE</span></div>
   <router-link class="history-title" :to="{path:'/runs/'+item.run_id,query:{session:item.id}}">{{item.title}} →</router-link>
   <p>{{item.summary||(item.last_status==='FAILED'?'最后一轮未完成：'+item.last_error_code:item.last_status==='RUNNING'||item.last_status==='QUEUED'?'最后一轮正在处理，打开会话查看进度。':'最后一轮暂无诊断结论。')}}</p>
   <small>更新于 {{formatTime(item.updated_at)}} · {{item.turn_count}} 轮 · 运行 {{item.run_id}}</small>
  </li></ul>
  <div class="pagination"><span>第 {{page}} / {{pages}} 页</span><div><button :disabled="loading||page<=1" @click="update({page:String(page-1)})">上一页</button><button :disabled="loading||page>=pages" @click="update({page:String(page+1)})">下一页</button></div></div>
 </section>
</div>
</template>
