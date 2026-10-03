<script setup lang="ts">
import {ref,onMounted,onUnmounted} from 'vue';
import {useRouter} from 'vue-router';
import {fetchScenarios,createDemoRun} from '../api.js';
import type {Scenario} from '@flowlens/contracts';
const router=useRouter(),items=ref<Scenario[]>([]),loading=ref(true),creating=ref(''),error=ref('');
let mounted=true;const keys=new Map<string,string>();
const expected:Record<string,string>={S00:'正常完成；诊断应说明成功，不编造故障。',S01:'字段校验失败；查看缺少 amount 的日志。',S02:'聚合失败；查看不存在的 order_total 列。',S03:'入库失败；查看订单主键唯一约束冲突。',S04:'读取超时；诊断后可申请、批准一次模拟重试。',S05:'读取失败但信息不足；保持 UNKNOWN，不提供重试。'};
async function load(){loading.value=true;error.value='';try{const result=await fetchScenarios();if(mounted)items.value=result;}catch(e){if(mounted)error.value=e instanceof Error?e.message:'场景加载失败';}finally{if(mounted)loading.value=false;}}
async function create(id:string){if(creating.value)return;creating.value=id;error.value='';const key=keys.get(id)??crypto.randomUUID();keys.set(id,key);try{const run=await createDemoRun(id,key);keys.delete(id);if(mounted)await router.push('/runs/'+run.id);}catch(e){if(mounted)error.value=e instanceof Error?e.message:'创建失败，请重试';}finally{if(mounted)creating.value='';}}
onMounted(()=>{void load();});onUnmounted(()=>{mounted=false;});
</script>
<template>
<div class="page">
 <div class="page-heading"><div><div class="eyebrow">DEMO SCENARIOS</div><h1>演示场景</h1><p>选择一个场景，观察任务状态、诊断证据与审批流程。</p></div><router-link class="text-link" to="/runs">查看运行记录 →</router-link></div>
 <div class="context-banner"><div><strong>六类合成场景 · FIXTURE</strong><p>创建新的模拟运行并保存日志。模型在你提问后调用；模拟重试不修改代码，也不验证真实上游恢复。</p></div></div>
 <div v-if="error" class="inline-error" role="alert">{{error}} <button v-if="!items.length" @click="load">重试加载</button></div>
 <div v-if="loading" class="panel empty" role="status">正在加载场景…</div>
 <div v-else-if="!items.length&&!error" class="panel empty">暂无可用场景。</div>
 <div v-else class="scenario-grid"><article v-for="item in items" :key="item.id" class="panel scenario-card">
  <div><span class="scenario">{{item.id}}</span><span class="fixture-tag">FIXTURE</span></div><h2>{{item.display_name}}</h2><p>{{item.description}}</p><div class="scenario-expectation"><strong>观察重点</strong><p>{{expected[item.id]}}</p></div><el-button type="primary" :loading="creating===item.id" :disabled="!!creating&&creating!==item.id" @click="create(item.id)">创建 {{item.id}} 演示运行</el-button>
 </article></div>
</div>
</template>
