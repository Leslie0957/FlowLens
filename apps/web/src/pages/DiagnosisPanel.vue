<script setup lang="ts">
import {computed,onMounted,onUnmounted,ref,watch,nextTick} from 'vue';
import type {Run} from '@flowlens/contracts';
import {fetchCapabilities,fetchSessions,createSession,fetchSession,sendMessage,fetchEvidence,fetchLogContext,fetchApprovals,proposeRetry,resolveApproval,cancelTurn,fetchRun} from '../api.js';
import {readAgentEvents} from '../agent-stream.js';
import {runEventConnection} from '../agent-connection.js';
import {applyAgentEvent} from '../agent-reducer.js';
import SafeMarkdown from '../SafeMarkdown.js';
import DiagnosisAnswer from '../DiagnosisAnswer.vue';
import ToolTraceCard from '../ToolTraceCard.vue';
import EvidencePopover from '../EvidencePopover.vue';
const evidenceAnchor=ref<HTMLElement|null>(null),evidenceLoading=ref(false),evidenceError=ref('');
let evidenceTicket=0;
function closeEvidence(){evidenceTicket++;evidenceAnchor.value=null;evidence.value=null;context.value=null;evidenceLoading.value=false;evidenceError.value='';}


const props=defineProps<{run:Run}>();
const sessions=ref<Awaited<ReturnType<typeof fetchSessions>>>([]),selected=ref('');
const snapshot=ref<Awaited<ReturnType<typeof fetchSession>>|null>(null),approvals=ref<Awaited<ReturnType<typeof fetchApprovals>>>([]);
const provider=ref(''),draft=ref(''),busy=ref(false),error=ref(''),streamState=ref(''),evidence=ref<Awaited<ReturnType<typeof fetchEvidence>>|null>(null),context=ref<Awaited<ReturnType<typeof fetchLogContext>>|null>(null);
let controller:AbortController|undefined,generation=0;
const pendingSendKeys=new Map<string,string>();
const animateTurn=ref('');
const child=ref<Run|null>(null),historyElement=ref<HTMLElement|null>(null),following=ref(true);
const operationKeys=new Map<string,string>();let childTimer:ReturnType<typeof setInterval>|undefined;
function operationKey(scope:string){let key=operationKeys.get(scope);if(!key){key=crypto.randomUUID();operationKeys.set(scope,key);}return key;}
function onHistoryScroll(){const element=historyElement.value;if(element)following.value=element.scrollHeight-element.scrollTop-element.clientHeight<60;}
function scrollLatest(){following.value=true;void nextTick(()=>{const element=historyElement.value;if(element)element.scrollTop=element.scrollHeight;});}
function onAnswerReveal(){if(following.value)scrollLatest();}
watch(()=>snapshot.value?.last_event_seq,()=>{if(following.value)scrollLatest();});
const activeTurn=computed(()=>snapshot.value?.turns.slice().reverse().find(t=>t.status==='QUEUED'||t.status==='RUNNING'));
const lastTurn=computed(()=>snapshot.value?.turns.at(-1));
const latestResult=computed(()=>{const row=snapshot.value?.results.at(-1);if(!row)return null;try{return {turn_id:row.turn_id,summary:row.summary,findings:JSON.parse(row.findings_json) as {cause:string;explanation:string;evidence_ids:string[];evidence_status:string}[],missing_information:JSON.parse(row.missing_information_json) as string[],next_steps:JSON.parse(row.next_steps_json) as string[],proposed_action:JSON.parse(row.proposed_action_json??'null') as null|{type:string;reason:string;run_id:string;evidence_ids:string[]}};}catch{return null;}});
const latestApproval=computed(()=>approvals.value[0]??null);
function messageProvider(turnId:string){return snapshot.value?.turns.find(t=>t.id===turnId)?.provider_mode==='LIVE'?'DeepSeek · LIVE':'Mock 诊断';}
watch(()=>latestApproval.value?.child_run_id,id=>{clearInterval(childTimer);child.value=null;if(!id)return;const read=async()=>{if(document.visibilityState!=='visible')return;try{const value=await fetchRun(id);if(latestApproval.value?.child_run_id!==id)return;child.value=value;if(value.status==='SUCCEEDED'||value.status==='FAILED')clearInterval(childTimer);}catch{/* existing result remains visible */}};void read();childTimer=setInterval(()=>{void read();},2000);});
async function loadBase(){const runId=props.run.id,ticket=generation;try{const [items,caps,pending]=await Promise.all([fetchSessions(runId),fetchCapabilities(),fetchApprovals(runId)]);if(ticket!==generation||props.run.id!==runId)return;sessions.value=items;provider.value=caps.provider_mode;approvals.value=pending;if(!selected.value&&items.length)selected.value=items[0]!.id;}catch(e){if(ticket===generation&&props.run.id===runId)error.value=e instanceof Error?e.message:'诊断加载失败';}}
async function loadSnapshot(id=selected.value){if(!id)return;const current=generation;try{const data=await fetchSession(id);if(current===generation&&selected.value===id&&data.last_event_seq>=(snapshot.value?.last_event_seq??0))snapshot.value=data;}catch(e){if(current===generation)error.value=e instanceof Error?e.message:'会话加载失败';}}
function connect(){
 controller?.abort();const id=selected.value;if(!id||!snapshot.value)return;
 const ticket=++generation,signal=new AbortController();controller=signal;error.value='';
 const current=()=>ticket===generation&&selected.value===id&&!!snapshot.value;
 void runEventConnection({signal:signal.signal,cursor:()=>snapshot.value?.last_event_seq??0,
  terminal:()=>!current()||!!snapshot.value?.turns.length&&!snapshot.value.turns.some(t=>t.status==='QUEUED'||t.status==='RUNNING'),
  state:value=>{if(current())streamState.value=value==='connecting'?'正在连接本机消息通道':value==='connected'?'本机消息通道已连接':value==='reconnecting'?'连接中断，正在自动恢复':'已同步';},
  connect:async(after)=>{try{
   await readAgentEvents(id,after,item=>{if(!current()||item.session_id!==id)return;streamState.value='本机消息通道已连接';applyAgentEvent(snapshot.value!,item);},signal.signal,()=>{if(current()){streamState.value='本机消息通道已连接';error.value='';}});
   if(current())await loadSnapshot(id);
  }catch(e){if(current()&&!signal.signal.aborted){error.value=e instanceof Error?e.message:'消息通道连接失败';await loadSnapshot(id);}throw e;}}
 });
}
async function choose(id:string){closeEvidence();animateTurn.value='';generation++;controller?.abort();snapshot.value=null;evidence.value=null;context.value=null;error.value='';await loadSnapshot(id);if(selected.value===id)connect();}
async function addSession(){busy.value=true;error.value='';try{const item=await createSession(props.run.id,crypto.randomUUID());sessions.value=[item,...sessions.value];selected.value=item.id;}catch(e){error.value=e instanceof Error?e.message:'创建会话失败';}finally{busy.value=false;}}
async function send(){
 const content=draft.value.trim();if(!content||content.length>2000||busy.value||activeTurn.value)return;
 busy.value=true;error.value='';
 try{if(!selected.value)await addSession();if(!selected.value)return;
  const sessionId=selected.value,requestKey=JSON.stringify([sessionId,content]),key=pendingSendKeys.get(requestKey)??crypto.randomUUID();
  pendingSendKeys.set(requestKey,key);
  const sent=await sendMessage(sessionId,content,key);pendingSendKeys.delete(requestKey);
  if(selected.value!==sessionId)return;
  animateTurn.value=sent.turn_id;
  draft.value='';await loadSnapshot(sessionId);if(selected.value===sessionId)connect();
 }catch(e){error.value=e instanceof Error?e.message:'发送失败；重试会使用相同请求键';}
 finally{busy.value=false;}
}
function onKey(event:KeyboardEvent){if(event.key==='Enter'&&!event.shiftKey&&!event.isComposing){event.preventDefault();void send();}}
async function stop(){if(!activeTurn.value)return;try{await cancelTurn(activeTurn.value.id);await loadSnapshot();}catch(e){error.value=e instanceof Error?e.message:'停止失败';}}
async function showEvidence(id:string,event:MouseEvent){
 if(!selected.value||!(event.currentTarget instanceof HTMLElement))return;
 if(evidenceAnchor.value===event.currentTarget){closeEvidence();return;}
 const ticket=++evidenceTicket,sessionId=selected.value,runId=props.run.id;
 evidenceAnchor.value=event.currentTarget;evidence.value=null;context.value=null;evidenceLoading.value=true;evidenceError.value='';
 try{const item=await fetchEvidence(sessionId,id);if(ticket!==evidenceTicket)return;evidence.value=item;
  if(item.type==='LOG'&&typeof item.locator.log_id==='string'){const logs=await fetchLogContext(runId,item.locator.log_id);if(ticket===evidenceTicket)context.value=logs;}
 }catch(e){if(ticket===evidenceTicket)evidenceError.value=e instanceof Error?e.message:'引用无法访问';}
 finally{if(ticket===evidenceTicket)evidenceLoading.value=false;}
}async function applyProposal(){if(!latestResult.value||busy.value)return;busy.value=true;error.value='';try{const item=await proposeRetry(props.run.id,latestResult.value.turn_id,latestResult.value.proposed_action?.reason??'根据诊断申请重试',crypto.randomUUID());approvals.value=[item,...approvals.value];}catch(e){error.value=e instanceof Error?e.message:'申请失败';}finally{busy.value=false;}}
async function decide(decision:'approve'|'reject'){const item=latestApproval.value;if(!item||busy.value)return;busy.value=true;error.value='';try{const updated=await resolveApproval(item.id,decision,operationKey(item.id+decision));approvals.value=[updated,...approvals.value.filter(x=>x.id!==updated.id)];}catch(e){error.value=e instanceof Error?e.message:'审批失败';}finally{busy.value=false;}}
watch(()=>props.run.id,()=>{closeEvidence();animateTurn.value='';generation++;controller?.abort();selected.value='';snapshot.value=null;sessions.value=[];approvals.value=[];void loadBase();});
onMounted(()=>{void loadBase();});onUnmounted(()=>{closeEvidence();generation++;controller?.abort();clearInterval(childTimer);});
watch(selected,id=>{if(id&&(!snapshot.value||snapshot.value.session.id!==id))void choose(id);});
</script>
<template>
<section class="panel diagnosis-panel">
 <div class="panel-head"><div><h2>诊断工作台</h2><p>只读工具查询演示任务数据；重试必须人工批准</p></div><span class="fixture-tag">{{provider||'未配置'}} 模型 · FIXTURE 数据</span></div>
 <div class="diagnosis-scope" role="note" aria-label="诊断能力范围">本演示仅能查询已保存的任务状态、日志与故障手册；不能提高日志级别、不能调取未记录的堆栈，也不能修改任务。<span v-if="props.run.scenario_id==='S05'">S05 演示数据没有更详细的日志或堆栈。</span><span v-if="props.run.status==='FAILED'&&!props.run.retry_eligibility?.allowed">当前运行不支持模拟重试：{{props.run.retry_eligibility?.message}}</span></div>
 <div class="diagnosis-controls"><select v-model="selected" aria-label="诊断会话"><option value="">选择会话</option><option v-for="item in sessions" :key="item.id" :value="item.id">{{item.title}} · {{item.id.slice(0,8)}}</option></select><el-button :disabled="busy" @click="addSession">新建会话</el-button><el-button v-if="selected" @click="connect">重新连接</el-button><span>{{streamState}}</span></div>
 <div v-if="error" class="inline-error">{{error}}</div>
 <div v-if="lastTurn?.error_code" class="inline-error" role="status">本轮未完成：{{lastTurn.error_code}} · 轮次 ID：{{lastTurn.id}}</div>
 <div v-if="!snapshot" class="empty">选择或新建会话，开始诊断。示例：这次运行为什么失败？</div>
 <template v-else>
  <div class="diagnosis-history-shell">
   <div ref="historyElement" class="diagnosis-history" @scroll="onHistoryScroll">
    <div v-for="turn in snapshot.turns" :key="turn.id" class="diagnosis-turn">
     <div v-for="message in snapshot.messages.filter(m=>m.turn_id===turn.id&&m.role==='user')" :key="message.id" class="diagnosis-message user"><strong>你</strong><SafeMarkdown :text="message.content"/></div>
     <details v-if="snapshot.tool_calls.some(t=>t.turn_id===turn.id)" class="tool-trace"><summary>只读查询 · {{snapshot.tool_calls.filter(t=>t.turn_id===turn.id).length}} 项</summary><ToolTraceCard v-for="tool in snapshot.tool_calls.filter(t=>t.turn_id===turn.id)" :key="tool.id" :tool="tool"/></details>
     <div class="diagnosis-message assistant"><strong>{{messageProvider(turn.id)}}</strong><DiagnosisAnswer :content="snapshot.messages.filter(m=>m.turn_id===turn.id&&m.role==='assistant').map(m=>m.content).join('')" :row="snapshot.results.find(r=>r.turn_id===turn.id)" :status="turn.status" :animate="animateTurn===turn.id" @evidence="showEvidence" @reveal="onAnswerReveal"/></div>
    </div>
   </div>
   <button v-if="!following" class="back-to-latest" aria-label="回到最新" title="回到最新" @click="scrollLatest"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 4v16M5 13l7 7 7-7"/></svg></button>
  </div>
  <div class="diagnosis-compose"><textarea v-model="draft" :disabled="busy" rows="3" maxlength="2000" aria-label="诊断问题" placeholder="这次运行为什么失败？（Enter 发送，Shift+Enter 换行）" @keydown="onKey"></textarea><el-button type="primary" :disabled="busy||!!activeTurn||!draft.trim()" @click="send">发送</el-button><el-button v-if="activeTurn" @click="stop">停止生成</el-button></div>
 </template>
 <div v-if="latestResult?.proposed_action" class="approval-area"><h3>模拟重试建议</h3><p>{{latestResult.proposed_action.reason}}</p><el-button :disabled="busy||!props.run.retry_eligibility?.allowed||latestApproval?.status==='PENDING'||latestApproval?.status==='APPROVED'" @click="applyProposal">申请重试</el-button><p v-if="!props.run.retry_eligibility?.allowed">{{props.run.retry_eligibility?.message}}</p></div>
 <div v-if="latestApproval" class="approval-area"><h3>人工审批 · {{latestApproval.status}}</h3><p>原运行：{{latestApproval.run_id}}；固定参数：{{JSON.stringify(latestApproval.params)}}</p><p>仅创建新的模拟运行，不执行真实任务。有效期至 {{latestApproval.expires_at}}</p><div v-if="latestApproval.status==='PENDING'"><el-button type="primary" :disabled="busy" @click="decide('approve')">批准模拟重试</el-button><el-button :disabled="busy" @click="decide('reject')">拒绝</el-button></div><p v-if="child">{{child.status==='SUCCEEDED'?'模拟重试成功':'模拟执行状态：'+child.status}}</p><router-link v-if="latestApproval.child_run_id" :to="'/runs/'+latestApproval.child_run_id">查看模拟重试运行 →</router-link></div>
 <EvidencePopover v-if="evidenceAnchor" :anchor="evidenceAnchor" @close="closeEvidence">
  <p v-if="evidenceLoading" role="status">正在加载证据…</p><p v-if="evidenceError" class="inline-error" role="alert">{{evidenceError}}</p>
  <template v-if="evidence"><h3>证据 · {{evidence.type}}</h3><p class="evidence-source">来源：{{evidence.source_id}} · 版本 {{evidence.source_version}}</p><pre>{{evidence.excerpt}}</pre><div v-if="context"><strong>日志上下文</strong><p v-for="log in context.logs" :key="log.id" :class="{highlight:log.id===context.log_id}">{{log.seq}} · {{log.message}}</p></div></template>
 </EvidencePopover>
</section>
</template>
