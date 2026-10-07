<script setup lang="ts">
import {ElAlert,ElSelect,ElOption} from 'element-plus';
import {computed,ref,reactive,watch,onUnmounted,nextTick} from 'vue';
import {useRoute,useRouter} from 'vue-router';
import {z} from 'zod';
import {pipelineExecutionSchema,pipelineRepairSchema,pipelineRevisionSchema} from '@flowlens/contracts';
import {usePipelineSnapshot,pipelineRead,projectPath,mutationKey} from '../pipeline-client';
import PipelineExecution from './PipelineExecution.vue';
import PipelineDiagnosis from './PipelineDiagnosis.vue';
import {statusLabel,statusTone,localTime} from '../pipeline-present';
const route=useRoute(),router=useRouter(),projectId=computed(()=>String(route.params.projectId)),{snapshot,error,connection,refresh}=usePipelineSnapshot(projectId);
const clock=ref(Date.now()),clockTimer=setInterval(()=>{clock.value=Date.now();},1000);onUnmounted(()=>clearInterval(clockTimer));
const draft=ref(''),draftBase=ref(''),busy=ref(false),actionError=ref(''),selected=ref(String(route.query.execution??''));let generation=0;const controller=new AbortController();onUnmounted(()=>{generation++;controller.abort();});
watch(()=>snapshot.value?.revision.id,()=>{if(snapshot.value&&draftBase.value!==snapshot.value.revision.id){draft.value=snapshot.value.revision.sql;draftBase.value=snapshot.value.revision.id;}});
const execution=computed(()=>selected.value?snapshot.value?.executions.find(e=>e.id===selected.value):snapshot.value?.executions[0]);
watch(()=>snapshot.value?.executions,items=>{if(!selected.value&&items?.[0])selected.value=items[0].id;});
watch(selected,value=>{if(value&&String(route.query.execution??'')!==value)void router.replace({query:{...route.query,execution:value}});});
watch(()=>route.query.execution,value=>{if(value)selected.value=String(value);});
const repairs=computed(()=>snapshot.value?.repairs.filter(r=>r.execution_id===execution.value?.id)??[]);
const revealRepairs=reactive(new Set<string>()),seenRepairs=new Set<string>();let requestedRepairExecution:string|null=null;
// Observe in-flight diagnoses, or new results from this page's own request.
// Terminal history loaded on refresh/selection is displayed immediately.
watch(repairs,items=>{for(const r of items){if(['QUEUED','RUNNING'].includes(r.status)||(!seenRepairs.has(r.id)&&requestedRepairExecution===r.execution_id))revealRepairs.add(r.id);if(['FAILED','CANCELLED','INTERRUPTED'].includes(r.status))revealRepairs.delete(r.id);seenRepairs.add(r.id);}},{flush:'sync'});
watch(selected,()=>{revealRepairs.clear();requestedRepairExecution=null;for(const r of repairs.value??[])if(['QUEUED','RUNNING'].includes(r.status))revealRepairs.add(r.id);},{flush:'sync'});
const running=computed(()=>snapshot.value?.executions.some(e=>e.status==='RUNNING')||snapshot.value?.repairs.some(r=>['QUEUED','RUNNING','VERIFYING'].includes(r.status)));
const sql=computed(()=>snapshot.value?.revisions.find(r=>r.id===execution.value?.revision_id)?.sql??'');
const currentExecution=computed(()=>snapshot.value?.executions.find(e=>e.revision_id===snapshot.value?.project.current_revision_id&&e.kind==='PRECHECK'));
const pending=computed(()=>repairs.value.some(r=>r.status==='PENDING_APPROVAL'&&r.base_revision_id===snapshot.value?.project.current_revision_id&&Date.parse(r.expires_at??'')>clock.value));
const publishedRepair=computed(()=>snapshot.value?.repairs.find(r=>r.status==='VERIFIED'&&r.approved_revision_id===snapshot.value?.project.current_revision_id));
const nextStep=computed(()=>{
 const s=snapshot.value;if(!s)return {stage:0,title:'加载任务',text:'正在恢复项目状态。',target:'pipeline-editor'};
 if(running.value){const repair=s.repairs.find(r=>['QUEUED','RUNNING','VERIFYING'].includes(r.status));return {stage:repair?2:1,title:repair?(repair.status==='VERIFYING'?'候选正在隔离验证':'Agent 正在取证与诊断'):'正在查询与校验',text:'状态、日志和工具结果会实时更新，请等待当前操作结束。',target:repair?'pipeline-agent':'pipeline-execution'};}
 if(draft.value!==s.revision.sql)return {stage:0,title:'SQL 有未保存的修改',text:'先保存新版本，再运行只读预检；执行历史继续保留原 SQL。',target:'pipeline-editor'};
 const e=currentExecution.value;
 if(!e)return {stage:publishedRepair.value?3:0,title:publishedRepair.value?'修复已验证，准备入库预检':'从只读预检开始',text:publishedRepair.value?'SQL 新版本已经发布，目标库尚未因此写入。运行预检后再批准入库。':'查询合成车辆源表并校验结果，此操作不会写入目标库。',target:'pipeline-editor'};
 const batch=s.batches.find(b=>b.execution_id===e.id);
 if(batch){const restored=batch.status==='RESTORED'||(s.operations[0]?.type==='RESTORE'&&s.operations[0]?.status==='SUCCEEDED');return {stage:4,title:restored?'最近一次入库撤销已完成':'入库操作已完成',text:restored?'业务数据已恢复到入库前，SQL、诊断和审批历史仍保留。':'打开 SQL 查询页复查结果；如需恢复数据，在批次区撤销最新有效入库。',target:'pipeline-batches'};}
 if(e.status==='FAILED'){
  const repair=s.repairs.find(r=>r.execution_id===e.id&&r.status==='PENDING_APPROVAL'&&Date.parse(r.expires_at??'')>clock.value);
  if(repair)return {stage:2,title:'修复候选已生成，等待人工批准',text:'先查看取证内容、诊断结论与 SQL Diff。批准后才在隔离库验证。',target:'pipeline-agent'};
  return {stage:2,title:'查询或校验失败，进入 Agent 取证',text:'查看失败阶段与原始日志，让 Agent 获取证据并提出仅修改 task.sql 的候选。',target:'pipeline-execution'};
 }
 if(e.status==='PRECHECK_PASSED'){
  if(e.precheck&&(e.precheck.target_version!==s.target.data_version||Date.parse(e.precheck.expires_at)<=clock.value))return {stage:1,title:'预检已失效，请重新运行',text:'预检有效期已到或目标版本变化。重新预检后才可批准入库。',target:'pipeline-editor'};
  return {stage:3,title:'预检通过，等待批准入库',text:'核对预计新增、跳过和冲突。批准后才会在事务中写入项目目标库。',target:'pipeline-precheck'};
 }
 return {stage:1,title:'本次执行已停止',text:'查看原始状态；可对当前 SQL 重新运行只读预检。',target:'pipeline-editor'};
});
async function locateNext(){const target=nextStep.value.target;if(currentExecution.value&&target!=='pipeline-editor')selected.value=currentExecution.value.id;await nextTick();const element=document.getElementById(target);element?.scrollIntoView({behavior:window.matchMedia('(prefers-reduced-motion: reduce)').matches?'auto':'smooth',block:'start'});element?.querySelector<HTMLElement>('button:not(:disabled),textarea,summary')?.focus({preventScroll:true});}
const restoreBatch=ref('');
watch(()=>snapshot.value?.target.data_version,()=>{restoreBatch.value='';});
watch(projectId,()=>{generation++;draft.value='';draftBase.value='';selected.value=String(route.query.execution??'');busy.value=false;actionError.value='';restoreBatch.value='';revealRepairs.clear();seenRepairs.clear();requestedRepairExecution=null;});
async function mutate(path:string,body:unknown,schema:z.ZodType=z.unknown()){if(busy.value)return;busy.value=true;actionError.value='';const gen=generation,pid=projectId.value,k=mutationKey(pid+path,body);try{const value=await pipelineRead(projectPath(pid)+path,schema,{method:'POST',body:JSON.stringify(body),headers:{'Idempotency-Key':k.key},signal:controller.signal});k.done();if(gen!==generation||controller.signal.aborted)return;if(path==='/executions')selected.value=(value as {id:string}).id;const op=value as {status?:string;error_code?:string};if(op.status==='FAILED')actionError.value=op.error_code??'操作失败，保留历史';await refresh();}catch(e){if(gen===generation&&!controller.signal.aborted)actionError.value=String(e);}finally{if(gen===generation&&!controller.signal.aborted)busy.value=false;}}
function diagnose(){if(!execution.value||busy.value)return;const id=execution.value.id;requestedRepairExecution=id;void mutate('/executions/'+id+'/repairs',{},pipelineRepairSchema).finally(()=>{if(requestedRepairExecution===id)requestedRepairExecution=null;});}
function decide(id:string,d:'approve'|'reject'|'cancel'){void mutate('/repairs/'+id+'/'+d,{},pipelineRepairSchema);}
</script>
<template>
 <section class="pipeline-page pipeline-workspace">
  <div class="page-heading"><div><router-link class="pipeline-back" to="/pipeline">← 车辆任务</router-link><h1>{{snapshot?.project.name??'加载任务'}}</h1><p><span class="pipeline-connection" :class="{connected:connection==='实时连接'}"><i></i>{{connection}}</span><span class="pipeline-meta-divider">合成车辆数据 · 本地 SQLite</span></p></div><router-link class="pipeline-query-link" :to="'/pipeline/projects/'+projectId+'/database'">打开只读 SQL 查询页 →</router-link></div>
  <el-alert v-if="error||actionError" :title="actionError||error" type="error" :closable="false"/>
  <template v-if="snapshot">
   <ol class="pipeline-flow" aria-label="任务操作流程"><li v-for="(label,i) in ['编辑 SQL','查询与校验','Agent 诊断修复','预检与批准入库','查询与撤销']" :key="label" :class="{active:nextStep.stage===i}" :aria-current="nextStep.stage===i?'step':undefined"><span>{{i+1}}</span><div>{{label}}<small v-if="i===2">失败时进入</small></div></li></ol>
   <div class="pipeline-next" role="status"><div><span class="pipeline-eyebrow">当前版本 · 下一步</span><h2>{{nextStep.title}}</h2><p>{{nextStep.text}}</p></div><button class="pipeline-outline-action" @click="locateNext">定位操作 ↓</button></div>
   <div id="pipeline-editor" class="pipeline-card pipeline-editor-card">
    <div class="pipeline-card-heading"><h2>任务 SQL</h2><span class="pipeline-meta">task.sql · 版本 {{snapshot.revision.id.slice(0,8)}}</span></div>
    <p class="pipeline-rule">筛选速度 &lt; 1 m/s、持续 ≥ 3 秒的车辆事件，输出 dat / st / et / car_series。</p>
    <textarea v-model="draft" class="pipeline-sql" aria-label="task.sql 编辑器" spellcheck="false"/>
    <div class="pipeline-actions"><el-button :disabled="busy||running||draft===snapshot.revision.sql" @click="mutate('/revisions',{base_revision_id:draftBase,sql:draft},pipelineRevisionSchema)">保存 SQL 新版本</el-button><el-button type="primary" :disabled="busy||running||draft!==snapshot.revision.sql" @click="mutate('/executions',{},pipelineExecutionSchema)">运行只读预检</el-button><router-link class="text-link" :to="'/pipeline/projects/'+projectId+'/database?scope=source'">查看实际源表与结构</router-link><span v-if="draft!==snapshot.revision.sql" class="pipeline-save-hint">有未保存修改，保存后才能运行</span></div>
    <details class="pipeline-technical"><summary>SQL 版本记录（{{snapshot.revisions.length}} 条，最多100条）</summary><p v-for="r in snapshot.revisions" :key="r.id"><code>{{r.id.slice(0,8)}}</code> · {{r.source}} · {{localTime(r.created_at)}} <span v-if="r.id===snapshot.project.current_revision_id" class="pipeline-status success">当前版本</span></p></details>
   </div>
   <div class="pipeline-layout">
    <div id="pipeline-execution">
     <div class="pipeline-card pipeline-history-card"><div class="pipeline-card-heading"><h2>执行结果与历史</h2><span class="pipeline-meta">{{snapshot.executions.length}} 次执行</span></div>
      <el-select :model-value="execution?.id??''" aria-label="执行历史" @update:model-value="selected=String($event)"><el-option v-for="e in snapshot.executions" :key="e.id" :value="e.id" :label="e.id.slice(0,8)+' · '+(e.kind==='PRECHECK'?'只读预检':'隔离验证')+' · '+statusLabel(e.status)"/></el-select>
      <p v-if="!execution" class="pipeline-muted">运行只读预检后，在这里查看实际查询、校验和日志。</p>
      <p v-else-if="execution.revision_id!==snapshot.project.current_revision_id" class="pipeline-history-note">正在查看旧版本的执行；原 SQL 和诊断保留。上方编辑器是当前版本。</p>
      <p v-else-if="pending" class="pipeline-muted">已有待审批候选，请先查看右侧 Diff，批准或拒绝。</p>
      <div v-if="execution" class="pipeline-actions"><el-button v-if="execution.status==='FAILED'" type="primary" :disabled="busy||running||pending||execution.revision_id!==snapshot.project.current_revision_id" @click="diagnose">Agent 取证并生成候选</el-button><el-button v-if="execution.status==='RUNNING'" :disabled="busy" @click="mutate('/executions/'+execution.id+'/cancel',{})">取消执行</el-button></div>
     </div>
     <PipelineExecution v-if="execution" :execution="execution" :sql="sql"/>
     <div v-if="execution?.precheck&&execution.kind==='PRECHECK'" id="pipeline-precheck" class="pipeline-card pipeline-precheck-card"><div class="pipeline-card-heading"><h2>本次入库预检</h2><span class="pipeline-status" :class="statusTone(execution.status)">{{statusLabel(execution.status)}}</span></div>
      <div class="pipeline-precheck-counts"><div><strong>{{execution.precheck.inserted}}</strong><span>预计新增</span></div><div><strong>{{execution.precheck.skipped}}</strong><span>重复跳过</span></div><div><strong>{{execution.precheck.conflicts}}</strong><span>数据冲突</span></div></div>
      <p class="pipeline-muted">预计新增 {{execution.precheck.inserted}}、跳过 {{execution.precheck.skipped}}、冲突 {{execution.precheck.conflicts}} · 绑定目标版本 {{execution.precheck.target_version}}</p>
      <p>当前目标：{{snapshot.target.row_count}} 行 · 数据版本 {{snapshot.target.data_version}}</p>
      <template v-if="!snapshot.batches.some(b=>b.execution_id===execution?.id)"><el-button type="primary" :disabled="busy||running||execution.status!=='PRECHECK_PASSED'||execution.revision_id!==snapshot.project.current_revision_id||execution.precheck.target_version!==snapshot.target.data_version||Date.parse(execution.precheck.expires_at)<=clock" @click="mutate('/executions/'+execution.id+'/commit',{})">批准本次入库</el-button><p class="pipeline-approval-note">批准后事务写入，并保存入库前快照；失败会回滚。</p><p v-if="execution.revision_id!==snapshot.project.current_revision_id||execution.precheck.target_version!==snapshot.target.data_version||Date.parse(execution.precheck.expires_at)<=clock" class="pipeline-history-note">预检已过期，或 SQL / 目标版本已变化，请重新预检。</p></template>
      <p v-else class="pipeline-muted">本次执行已有提交凭证，预检结果与提交历史均保留。</p>
     </div>
    </div>
    <div id="pipeline-agent"><PipelineDiagnosis v-for="r in repairs" :key="r.id" :repair="r" :busy="busy" :animate="revealRepairs.has(r.id)" :now="clock" :current-revision-id="snapshot.project.current_revision_id" @presented="revealRepairs.delete($event)" @decide="decide"/>
     <div v-if="!repairs.length" class="pipeline-card pipeline-agent-empty"><span class="pipeline-empty-glyph">◈</span><h2>Agent 诊断</h2><p>失败后，先取证，再提出 SQL 修复候选。</p><div class="pipeline-empty-steps"><span>实际 SQL / 表结构 / 日志</span><span>带证据的结论与 Diff</span><span>人工批准后隔离验证</span></div><p class="pipeline-muted">正常执行无需 Agent。模型不会直接改写业务数据。</p></div>
    </div>
   </div>
   <div id="pipeline-batches" class="pipeline-card"><div class="pipeline-card-heading"><h2>入库批次与人工撤销</h2><span class="pipeline-meta">目标 {{snapshot.target.row_count}} 行 · 数据版本 {{snapshot.target.data_version}}</span></div><p class="pipeline-muted">仅恢复业务表到入库前，保留 SQL、诊断、审批与原执行历史。只允许撤销最新有效批次。</p>
    <div v-for="b in snapshot.batches" :key="b.id" class="pipeline-batch"><div class="pipeline-card-heading"><strong>批次 {{b.id.slice(0,8)}}</strong><span class="pipeline-status" :class="statusTone(b.status)">{{statusLabel(b.status)}}</span></div><p><strong>{{b.before_count}} → {{b.after_count}} 行</strong><span class="pipeline-meta-divider">新增 {{b.inserted}} · 跳过 {{b.skipped}} · 版本 {{b.data_version}}</span></p><p class="pipeline-meta">{{localTime(b.created_at)}}</p>
     <div class="pipeline-actions"><router-link class="text-link" :to="'/pipeline/projects/'+projectId+'/database?scope=target&batch='+b.id">查看本次写入 / 撤销结果</router-link><router-link class="text-link" :to="'/pipeline/projects/'+projectId+'/database?scope=snapshot&batch='+b.id">查看入库前数据</router-link><el-button v-if="b.can_restore" type="warning" plain :disabled="busy||running" @click="restoreBatch=b.id">撤销本次入库</el-button><span v-if="b.inserted===0" class="pipeline-muted">无数据变更，无需撤销</span></div>
     <div v-if="restoreBatch===b.id&&b.can_restore" class="pipeline-restore-confirm" role="region" aria-label="确认恢复范围"><strong>将当前业务数据恢复为入库前的 {{b.before_count}} 行</strong><p>本批次新增的 {{b.inserted}} 行会移除；执行、诊断与审批历史保留。</p><div class="pipeline-actions"><el-button type="warning" :disabled="busy||running" @click="mutate('/batches/'+b.id+'/restore',{})">确认撤销并恢复</el-button><el-button :disabled="busy" @click="restoreBatch=''">保留当前数据</el-button></div></div>
     <p v-if="b.restore_id" class="pipeline-restored-note">已恢复入库前业务数据 · {{localTime(b.restored_at??'')}}<span class="mono">恢复凭证 {{b.restore_id}}</span></p>
    </div>
    <p v-if="!snapshot.batches.length" class="pipeline-muted">尚未批准入库。通过预检并批准后，这里会出现真实批次及可恢复快照。</p>
    <details class="pipeline-technical"><summary>入库 / 撤销操作记录</summary><p v-if="!snapshot.operations.length">暂无入库或撤销记录。修复审批结果见上方 Agent 诊断；运行当前 SQL 的只读预检并批准入库后，这里会显示操作记录。</p><div v-for="op in snapshot.operations" :key="op.id" class="pipeline-operation"><strong>{{op.type==='COMMIT'?'入库':'撤销恢复'}} · {{statusLabel(op.status)}}</strong><span>{{localTime(op.created_at)}}</span><p v-if="op.error_code">{{op.error_code}} · {{op.error_message}}</p><code>{{op.id}}</code></div></details>
   </div>
  </template>
 </section>
</template>
