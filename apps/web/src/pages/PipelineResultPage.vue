<script setup lang="ts">
import {ElAlert,ElTable,ElTableColumn} from 'element-plus';
import {computed,ref,watch,onUnmounted} from 'vue';
import {useRoute} from 'vue-router';
import {z} from 'zod';
import {pipelineQueryResultSchema} from '@flowlens/contracts';
import {pipelineRead,projectPath,usePipelineSnapshot,mutationKey} from '../pipeline-client';
import {localTime} from '../pipeline-present';
const route=useRoute(),projectId=computed(()=>String(route.params.projectId)),batchId=computed(()=>String(route.params.batchId));
const {snapshot,error,connection,refresh}=usePipelineSnapshot(projectId);
const batch=computed(()=>snapshot.value?.batches.find(b=>b.id===batchId.value));
const result=ref<z.infer<typeof pipelineQueryResultSchema>|null>(null),queryError=ref(''),queryBusy=ref(false),restoreBusy=ref(false),confirmRestore=ref(false),restoreError=ref('');
let generation=0,querySeq=0,queryController:AbortController|null=null,restoreController:AbortController|null=null;
const workbench=computed(()=>'/pipeline/projects/'+projectId.value+(batch.value?'?execution='+batch.value.execution_id:''));
const working=computed(()=>snapshot.value?.executions.some(e=>e.status==='RUNNING')||snapshot.value?.repairs.some(r=>['QUEUED','RUNNING','VERIFYING'].includes(r.status))||snapshot.value?.operations.some(op=>op.status==='RUNNING'));
watch(()=>[projectId.value,batchId.value],()=>{generation++;querySeq++;queryController?.abort();restoreController?.abort();result.value=null;queryError.value='';restoreError.value='';queryBusy.value=false;restoreBusy.value=false;confirmRestore.value=false;},{flush:'sync'});
async function readResult(){const pid=projectId.value,bid=batchId.value,version=snapshot.value?.target.data_version;if(!batch.value||version===undefined)return;queryController?.abort();queryController=new AbortController();const signal=AbortSignal.any([queryController.signal,AbortSignal.timeout(10000)]),seq=++querySeq;queryBusy.value=true;queryError.value='';result.value=null;
 try{const value=await pipelineRead(projectPath(pid)+'/query',pipelineQueryResultSchema,{method:'POST',body:JSON.stringify({scope:'target',sql:'SELECT dat, st, et, car_series FROM mining_results ORDER BY dat, st LIMIT 200;',limit:200}),signal});if(seq!==querySeq||signal.aborted||pid!==projectId.value||bid!==batchId.value)return;if(value.project_id!==pid||value.data_version!==snapshot.value?.target.data_version){queryError.value='查询期间目标数据已变化，请重新读取。';return;}result.value=value;}catch(e){if(seq===querySeq)queryError.value=String(e);}finally{if(seq===querySeq)queryBusy.value=false;}}
watch([()=>batch.value?.id,()=>snapshot.value?.target.data_version],()=>{confirmRestore.value=false;if(batch.value)void readResult();else{querySeq++;queryController?.abort();result.value=null;queryBusy.value=false;}},{immediate:true});
async function restore(){if(restoreBusy.value||working.value||!batch.value?.can_restore||!confirmRestore.value)return;const pid=projectId.value,bid=batchId.value,gen=generation,key=mutationKey(pid+'/batches/'+bid+'/restore',{});restoreController=new AbortController();const signal=restoreController.signal;restoreBusy.value=true;restoreError.value='';
 try{const op=await pipelineRead(projectPath(pid)+'/batches/'+bid+'/restore',z.object({status:z.string(),error_code:z.string().nullable(),error_message:z.string().nullable()}),{method:'POST',body:'{}',headers:{'Idempotency-Key':key.key},signal});key.done();if(gen!==generation||signal.aborted)return;if(op.status!=='SUCCEEDED')restoreError.value=(op.error_code??'恢复未完成')+' · '+(op.error_message??'请查看操作历史');confirmRestore.value=false;await refresh();}catch(e){if(gen===generation&&!signal.aborted)restoreError.value=String(e);}finally{if(gen===generation&&!signal.aborted)restoreBusy.value=false;}}
onUnmounted(()=>{generation++;querySeq++;queryController?.abort();restoreController?.abort();});
</script>
<template><section class="pipeline-page pipeline-result-page">
 <div class="page-heading"><div><router-link :to="workbench">← 执行工作台</router-link><h1>入库结果复查</h1><p>{{snapshot?.project.name}} · {{connection}}</p></div><router-link class="pipeline-query-link" :to="'/pipeline/projects/'+projectId+'/database?scope=target&batch='+batchId">打开只读 SQL 查询页 →</router-link></div>
 <el-alert v-if="error||restoreError" :title="restoreError||error" type="error" :closable="false"/>
 <div v-if="snapshot&&!batch" class="pipeline-card"><h2>未找到本项目的入库批次</h2><p>请返回工作台查看批次记录。</p></div>
 <template v-if="batch">
  <div class="pipeline-card pipeline-result-receipt" role="region" aria-label="本次入库结果">
   <div class="pipeline-card-heading"><h2>{{batch.status==='RESTORED'?'本次入库已撤销':'本次入库已完成'}}</h2><span class="pipeline-status" :class="batch.status==='RESTORED'?'muted':'success'">{{batch.status==='RESTORED'?'已恢复':'事务已提交'}}</span></div>
   <p>{{batch.status==='RESTORED'?'已恢复本次入库前业务数据，原 SQL、诊断和审批历史保留。':'批准后已在事务中完成写入。下方自动查询实际目标数据；复查发现问题时，可撤销最新有效批次。'}}</p>
   <dl class="pipeline-query-stats"><div><dt>本次新增</dt><dd>{{batch.inserted}} <small>行</small></dd></div><div><dt>重复跳过</dt><dd>{{batch.skipped}} <small>行</small></dd></div><div><dt>入库前 → 入库后</dt><dd>{{batch.before_count}} → {{batch.after_count}}</dd></div><div><dt>当前目标</dt><dd>{{snapshot?.target.row_count}} <small>行</small></dd></div></dl>
   <p class="pipeline-meta">批次 {{batch.id.slice(0,8)}} · {{localTime(batch.created_at)}} · 当前数据版本 {{snapshot?.target.data_version}}</p>
   <div class="pipeline-actions"><router-link v-if="batch.status!=='RESTORED'" class="pipeline-outline-action" :to="workbench">复查无误，完成</router-link><router-link v-else class="pipeline-outline-action" :to="workbench">返回工作台</router-link><el-button v-if="batch.can_restore" type="warning" plain :disabled="restoreBusy||working" @click="confirmRestore=true">发现问题，撤销本次入库</el-button><router-link class="text-link" :to="'/pipeline/projects/'+projectId+'/database?scope=snapshot&batch='+batchId">查看入库前数据</router-link></div>
   <p v-if="!batch.can_restore&&batch.status!=='RESTORED'" class="pipeline-muted">{{batch.inserted===0?'本次没有新增数据，无需撤销。':'该批次不是最新有效数据头，不能从这里撤销；请在工作台查看最新批次。'}}</p>
   <div v-if="confirmRestore&&batch.can_restore" class="pipeline-restore-confirm" role="region" aria-label="确认恢复范围"><strong>将当前业务数据恢复为入库前的 {{batch.before_count}} 行</strong><p>本批次新增的 {{batch.inserted}} 行会移除；执行、诊断与审批历史保留。</p><div class="pipeline-actions"><el-button type="warning" :disabled="restoreBusy||working" @click="restore">确认撤销并恢复</el-button><el-button :disabled="restoreBusy" @click="confirmRestore=false">保留当前数据</el-button></div></div>
   <p v-if="batch.restore_id" class="pipeline-restored-note">已恢复入库前业务数据 · {{localTime(batch.restored_at??'')}}<span class="mono">恢复凭证 {{batch.restore_id}}</span></p>
  </div>
  <div class="pipeline-card pipeline-query-result"><div class="pipeline-card-heading"><h2>实际目标数据</h2><el-button :disabled="queryBusy||restoreBusy" @click="readResult">重新读取结果</el-button></div><p class="pipeline-muted">这里显示当前项目目标库的实际数据，包含既有批次。入库或撤销后自动更新。</p><p v-if="queryBusy" role="status">正在查询实际目标库…</p><el-alert v-if="queryError" :title="queryError" type="error" :closable="false"/>
   <template v-if="result"><p>查询成功，{{result.row_count}} 行 · 数据版本 {{result.data_version}} · {{result.elapsed_ms.toFixed(1)}} ms<span v-if="result.truncated"> · 仅显示前200行，请用 SQL 查询页进一步检查</span></p><el-table :data="result.rows" max-height="500" empty-text="查询成功，0 行" border stripe><el-table-column v-for="c in result.columns" :key="c" :prop="c" :label="c" min-width="160"/></el-table></template>
  </div>
 </template>
</section></template>
