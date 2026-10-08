<script setup lang="ts">
import {ElAlert,ElTag,ElDialog} from 'element-plus';
import {computed,ref,watch} from 'vue';
import type {PipelineRepair} from '@flowlens/contracts';
import {useTextReveal} from '../use-text-reveal';
import {statusLabel,statusTone,toolLabel,stepLabel} from '../pipeline-present';
const props=defineProps<{repair:PipelineRepair;busy:boolean;animate?:boolean;currentRevisionId?:string;now?:number}>();
const emit=defineEmits<{decide:[id:string,decision:'approve'|'reject'|'cancel'];presented:[id:string]}>();
const {shown,revealing}=useTextReveal(()=>props.repair.diagnosis,()=>props.repair.id,()=>props.animate??false,()=>emit('presented',props.repair.id));
const evidenceId=ref(''),evidenceOpen=ref(false);
const evidence=computed(()=>props.repair.evidence.find(e=>e.id===evidenceId.value));
watch(()=>props.repair.id,()=>{evidenceOpen.value=false;evidenceId.value='';});
function showEvidence(id:string){evidenceId.value=id;evidenceOpen.value=true;}
const parts=computed(()=>shown.value.split(/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})/gi).map(text=>({text,index:props.repair.evidence.findIndex(e=>e.id===text)})));
const finished=computed(()=>props.repair.tools.filter(t=>t.status==='COMPLETED').length);
const progress=computed(()=>props.repair.status==='QUEUED'?'诊断请求已排队…':'正在取证，已完成 '+finished.value+' 次调用；模型将根据返回资料决定下一步…');
const evidenceText=computed(()=>{if(!evidence.value)return '';try{return JSON.stringify(JSON.parse(evidence.value.excerpt),null,2);}catch{return evidence.value.excerpt;}});
const diffLines=computed(()=>props.repair.candidate?.diff.split('\n')??[]);
const approvalReason=computed(()=>props.repair.status!=='PENDING_APPROVAL'?'':props.currentRevisionId&&props.currentRevisionId!==props.repair.base_revision_id?'当前 SQL 版本已变化，该候选不能批准。':props.repair.expires_at&&Date.parse(props.repair.expires_at)<=(props.now??Date.now())?'候选已过期，请重新取证生成候选。':'');
</script>
<template>
 <article class="pipeline-card pipeline-agent-card">
  <div class="pipeline-card-heading"><h2>Agent 诊断</h2><div class="pipeline-badges"><span class="pipeline-status" :class="approvalReason?'muted':statusTone(repair.commit_approval?.status??repair.status)" :title="repair.status">{{approvalReason?(approvalReason.includes('过期')?'候选已过期':'版本已变化'):repair.commit_approval?.status==='COMMITTED'?'已入库':['FAILED','INTERRUPTED'].includes(repair.commit_approval?.status??'')?'入库未完成':repair.status==='VERIFIED'&&repair.commit_approval?'预检入库中':statusLabel(repair.status)}}</span><el-tag :type="repair.provider_mode==='LIVE'?'success':'warning'">{{repair.provider_mode}}</el-tag></div></div>
  <p class="pipeline-meta">{{repair.model}} · {{repair.model_requests}} 次模型请求 · {{repair.usage.prompt_tokens+repair.usage.completion_tokens}} tokens</p>
  <details class="pipeline-technical"><summary>本次诊断上限</summary><p v-if="repair.diagnosis_limits">模型请求 {{repair.diagnosis_limits.max_requests}} 次 · 工具调用 {{repair.diagnosis_limits.max_tool_calls}} 次 · 总时限 {{repair.diagnosis_limits.timeout_ms/1000}} 秒 · 连续无新增观测 {{repair.diagnosis_limits.max_stall_rounds}} 轮 · 上下文 {{repair.diagnosis_limits.max_context_bytes}} 字节</p><p v-else>旧记录未保存诊断上限，不按当前配置推断。</p></details>
  <el-alert v-if="repair.error_code" :title="repair.error_message??(repair.error_code==='INTERNAL_ERROR'?'本次诊断失败；旧记录未保存具体校验原因，请重试诊断。':repair.error_code)" :description="repair.error_message||repair.error_code==='INTERNAL_ERROR'?repair.error_code:undefined" type="error" :closable="false"/>
  <el-alert v-if="repair.commit_approval?.error_code" :title="repair.commit_approval.error_message??'批准后的入库未完成'" :description="repair.commit_approval.error_code" type="error" :closable="false"/>
  <details v-if="repair.response_checks?.length" class="pipeline-technical"><summary>模型回复校验与纠正记录（{{repair.response_checks.length}} 次）</summary><p v-for="(check,i) in repair.response_checks" :key="i">第 {{check.request}} 次模型请求 · {{check.code}}<br>{{check.message}}</p></details>
  <section class="pipeline-agent-section">
   <div class="pipeline-section-heading"><h3><span>1</span>工具取证</h3><small>已完成 {{finished}} 次调用</small></div>
   <p v-if="!repair.diagnosis&&['QUEUED','RUNNING'].includes(repair.status)" class="answer-progress" role="status">{{progress}}</p>
   <p v-if="!repair.tools.length" class="pipeline-muted">{{['QUEUED','RUNNING'].includes(repair.status)?'等待模型发起工具调用，完成后会显示实际返回结果。':'本次没有执行诊断工具，可查看初始失败观测及结论。'}}</p>
   <div class="pipeline-tools"><details v-for="tool in repair.tools" :key="tool.id">
    <summary><span class="pipeline-tool-title">{{toolLabel(tool.name)}}<code>{{tool.name}}</code><small v-if="tool.request">第 {{tool.request}} 次模型请求</small></span><span class="pipeline-status" :class="statusTone(tool.status)" :title="tool.status">{{statusLabel(tool.status)}}</span></summary>
    <p v-if="!Object.keys(tool.args).length" class="pipeline-muted">无需额外参数，已绑定本次执行与 SQL 版本。</p><pre v-else>调用参数 {{JSON.stringify(tool.args,null,2)}}</pre>
    <template v-if="tool.result!==null"><p class="pipeline-muted">实际返回结果</p><pre>{{JSON.stringify(tool.result,null,2)}}</pre></template>
    <p v-else-if="tool.status==='RUNNING'" role="status">工具正在执行，等待返回结果…</p><p v-if="tool.error_code">工具错误：{{tool.error_code}}</p>
   </details></div>
  </section>
  <section class="pipeline-agent-section">
   <div class="pipeline-section-heading"><h3><span>2</span>诊断结论</h3><small v-if="repair.diagnosis">引用已校验</small></div>
   <div v-if="repair.diagnosis" class="pipeline-diagnosis-answer" :aria-busy="revealing">
    <p v-if="revealing" class="answer-progress" role="status">结论已校验，正在逐步展示…</p>
    <p class="pipeline-diagnosis-text"><template v-for="(part,i) in parts" :key="i"><button v-if="part.index>=0" class="pipeline-citation" :aria-label="'查看证据'+(part.index+1)+'：'+toolLabel(repair.evidence[part.index]!.type)" @click="showEvidence(part.text)">[证据{{part.index+1}}]</button><template v-else>{{part.text}}</template></template><span v-if="revealing" class="answer-cursor" aria-hidden="true">▍</span></p>
   </div>
   <p v-else class="pipeline-muted">{{['QUEUED','RUNNING'].includes(repair.status)?'先获取真实资料，再生成结论与候选。':'本次未生成通过校验的诊断，请查看状态与错误记录。'}}</p>
   <div v-if="repair.action&&!revealing" class="pipeline-conclusion-facts"><span>{{repair.action==='SQL_PATCH'?'建议修改 SQL':repair.action==='RETRY_SUGGESTION'?'建议重试':repair.action==='MANUAL_REQUIRED'?'需要人工处理':'无需修改'}}</span><span>故障阶段：{{stepLabel(repair.failed_step??'')}}</span></div>
   <div v-if="repair.evidence.length" class="pipeline-evidence-links" aria-label="本次取证与引用"><button v-for="(e,i) in repair.evidence" :key="e.id" :class="{cited:repair.evidence_ids.includes(e.id)}" @click="showEvidence(e.id)">证据{{i+1}} · {{toolLabel(e.type)}} <span>{{repair.evidence_ids.includes(e.id)?'已引用':'已获取'}}</span></button></div>
  </section>
  <section v-if="repair.candidate&&!revealing" class="pipeline-agent-section pipeline-candidate">
   <div class="pipeline-section-heading"><h3><span>3</span>修复候选 · task.sql</h3><small>服务端计算 Diff</small></div>
   <div class="pipeline-diff-legend"><span class="removed">− 原 SQL</span><span class="added">+ 候选 SQL</span></div>
   <pre class="pipeline-diff"><template v-for="(line,i) in diffLines" :key="i"><span :class="{'diff-added':line.startsWith('+')&&!line.startsWith('+++'),'diff-removed':line.startsWith('-')&&!line.startsWith('---')}">{{line}}</span>{{i<diffLines.length-1?'\n':''}}</template></pre>
   <p class="pipeline-approval-note">一次批准同时授权本候选的修复与入库：后端先隔离验证，再查询校验与预检，通过后事务写入并自动打开结果复查页。失败或批准后目标数据变化会停止；成功保存入库前快照，可撤销最新有效批次。</p>
   <p v-if="approvalReason" class="pipeline-history-note">{{approvalReason}}</p>
   <div v-if="repair.status==='PENDING_APPROVAL'" class="pipeline-actions"><el-button type="primary" :disabled="busy||!!approvalReason" @click="emit('decide',repair.id,'approve')">批准修复并入库</el-button><el-button :disabled="busy||!!approvalReason" @click="emit('decide',repair.id,'reject')">拒绝候选</el-button></div>
  </section>
  <div v-if="repair.verification_execution_id" class="pipeline-verification-note" :class="statusTone(repair.status)"><strong>{{repair.status==='VERIFIED'?'验证通过并已发布':repair.status==='VERIFYING'?'正在隔离库验证':'验证未通过，当前 SQL 未被失败候选覆盖'}}</strong><p v-if="repair.commit_approval">{{repair.commit_approval.status==='COMMITTED'?'批准后的入库已完成，可在结果页复查或撤销。':['FAILED','INTERRUPTED'].includes(repair.commit_approval.status)?'批准后的流程已停止，请查看上述原因及执行历史。':'本次已批准通过校验后入库，后端继续预检与事务提交，无需再次批准。'}}</p><p v-else-if="repair.status==='VERIFIED'">这是旧的“仅验证修复”审批记录；未授权入库，请在预检卡片批准本次入库。</p><details><summary>验证执行编号与入库授权</summary><code>{{repair.verification_execution_id}}</code><p v-if="repair.commit_approval">批准时间 {{repair.commit_approval.approved_at}} · 绑定目标版本 {{repair.commit_approval.target_version}} · 入库阶段 {{repair.commit_approval.status}}</p></details></div>
  <el-button v-if="['QUEUED','RUNNING','VERIFYING'].includes(repair.status)||repair.commit_approval?.status==='PRECHECKING'" :disabled="busy" @click="emit('decide',repair.id,'cancel')">取消诊断/验证</el-button>
  <el-dialog v-model="evidenceOpen" class="pipeline-evidence-dialog" :title="evidence?'取证内容 · '+toolLabel(evidence.type):'取证内容'" width="min(760px, calc(100vw - 32px))" destroy-on-close>
   <template v-if="evidence"><p class="pipeline-muted">{{repair.evidence_ids.includes(evidence.id)?'本条证据已被诊断引用。':'本条资料已获取，尚未被诊断引用。'}}{{evidence.type==='INITIAL_FAILURE'?'来自持久化的失败执行（初始观测，未调用工具）。':'来自本次执行绑定的只读工具。'}}</p><pre>{{evidenceText}}</pre><details><summary>原始证据与来源编号</summary><p>证据 {{evidence.id}}</p><p>来源 {{evidence.source_id}}</p><p>版本 {{evidence.source_version}}</p></details></template>
  </el-dialog>
 </article>
</template>
