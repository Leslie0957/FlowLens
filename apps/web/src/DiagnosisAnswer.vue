<script setup lang="ts">
import {computed,onUnmounted,ref,watch} from 'vue';
import {diagnosisResultSchema} from '@flowlens/contracts';
import type {SessionState} from './agent-reducer.js';
import SafeMarkdown from './SafeMarkdown.js';
const props=defineProps<{content:string;row?:SessionState['results'][number];status?:string;animate?:boolean}>();
const emit=defineEmits<{evidence:[id:string,event:MouseEvent];reveal:[]}>();
const result=computed(()=>{if(!props.row)return null;try{return diagnosisResultSchema.parse({summary:props.row.summary,findings:JSON.parse(props.row.findings_json),missing_information:JSON.parse(props.row.missing_information_json),next_steps:JSON.parse(props.row.next_steps_json),proposed_action:JSON.parse(props.row.proposed_action_json??'null')});}catch{return null;}});
const pending=computed(()=>props.status==='QUEUED'||props.status==='RUNNING');
// Only server-validated results enter the visible answer. Raw deltas remain in
// the protocol/history, but a rejected or reset attempt never becomes a preview.
const parts=computed(()=>result.value?[result.value.summary,...result.value.findings.map(f=>f.explanation),...result.value.missing_information,...result.value.next_steps].map(text=>Array.from(text)):[]);
const total=computed(()=>parts.value.reduce((sum,part)=>sum+part.length,0));
const visible=ref(0),revealing=computed(()=>!!result.value&&visible.value<total.value);
let timer:ReturnType<typeof setInterval>|undefined,displayedTurn='';
function stopReveal(){clearInterval(timer);timer=undefined;}
watch(()=>[result.value,props.animate] as const,([value,animate])=>{
 if(!value){stopReveal();displayedTurn='';visible.value=0;return;}
 const key=props.row!.turn_id;
 // SSE result IDs and persisted snapshot IDs can differ for the same turn.
 if(key===displayedTurn){if(!animate){stopReveal();visible.value=total.value;}return;}
 stopReveal();displayedTurn=key;
 const reducedMotion=typeof window.matchMedia==='function'&&window.matchMedia('(prefers-reduced-motion: reduce)').matches;
 if(!animate||reducedMotion||!total.value){visible.value=total.value;return;}
 visible.value=0;
 const duration=Math.min(4000,Math.max(600,total.value*12)),step=Math.max(1,Math.ceil(total.value/(duration/40)));
 timer=setInterval(()=>{visible.value=Math.min(total.value,visible.value+step);if(visible.value===total.value)stopReveal();},40);
},{immediate:true});
onUnmounted(stopReveal);
watch(visible,()=>emit('reveal'));
const shown=computed(()=>{let remaining=visible.value;return parts.value.map(part=>{const prefix=part.slice(0,Math.max(0,remaining)).join('');remaining-=part.length;return prefix;});});
function started(index:number){return visible.value>parts.value.slice(0,index).reduce((sum,part)=>sum+part.length,0)||!revealing.value;}
function complete(index:number){return (shown.value[index]?.length??0)===(parts.value[index]?.join('').length??0);}
const missingStart=computed(()=>1+(result.value?.findings.length??0));
const nextStart=computed(()=>missingStart.value+(result.value?.missing_information.length??0));
</script>
<template>
 <article v-if="result" class="diagnosis-result" :aria-busy="revealing">
  <h3>诊断结论</h3><SafeMarkdown :text="shown[0]??''"/>
  <template v-for="(finding,index) in result.findings" :key="index"><section v-if="started(1+index)" class="diagnosis-finding">
   <span class="evidence-status">{{finding.evidence_status==='SUPPORTED'?'有证据支持':'待确认'}}</span>
   <SafeMarkdown :text="shown[1+index]??''"/>
   <div v-if="complete(1+index)" class="evidence-links"><button v-for="(id,n) in finding.evidence_ids" :key="id" aria-haspopup="dialog" @click="$emit('evidence',id,$event)">证据 {{n+1}} · 查看来源</button></div>
  </section></template>
  <section v-if="result.missing_information.length&&started(missingStart)"><h4>仍需确认</h4><ul><template v-for="(item,index) in result.missing_information" :key="index"><li v-if="started(missingStart+index)"><SafeMarkdown :text="shown[missingStart+index]??''"/></li></template></ul></section>
  <section v-if="result.next_steps.length&&started(nextStart)"><h4>建议下一步</h4><ol><template v-for="(item,index) in result.next_steps" :key="index"><li v-if="started(nextStart+index)"><SafeMarkdown :text="shown[nextStart+index]??''"/></li></template></ol></section>
  <span v-if="revealing" class="answer-cursor" aria-hidden="true">▍</span>
 </article>
 <div v-else class="diagnosis-preview"><p class="answer-progress" role="status">{{pending?'正在查询并核对证据…':'本轮未生成可验证的完整结论'}}</p></div>
</template>
