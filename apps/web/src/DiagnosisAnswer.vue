<script setup lang="ts">
import {computed} from 'vue';
import {diagnosisResultSchema} from '@flowlens/contracts';
import type {SessionState} from './agent-reducer.js';
import {assistantPreview} from './diagnosis-presentation.js';
import SafeMarkdown from './SafeMarkdown.js';
const props=defineProps<{content:string;row?:SessionState['results'][number];status?:string}>();
defineEmits<{evidence:[id:string,event:MouseEvent]}>();
const result=computed(()=>{if(!props.row)return null;try{return diagnosisResultSchema.parse({summary:props.row.summary,findings:JSON.parse(props.row.findings_json),missing_information:JSON.parse(props.row.missing_information_json),next_steps:JSON.parse(props.row.next_steps_json),proposed_action:JSON.parse(props.row.proposed_action_json??'null')});}catch{return null;}});
const preview=computed(()=>assistantPreview(props.content));
const pending=computed(()=>props.status==='QUEUED'||props.status==='RUNNING');
</script>
<template>
 <article v-if="result" class="diagnosis-result">
  <h3>诊断结论</h3><SafeMarkdown :text="result.summary"/>
  <section v-for="(finding,index) in result.findings" :key="index" class="diagnosis-finding">
   <span class="evidence-status">{{finding.evidence_status==='SUPPORTED'?'有证据支持':'待确认'}}</span>
   <SafeMarkdown :text="finding.explanation"/>
   <div class="evidence-links"><button v-for="(id,n) in finding.evidence_ids" :key="id" aria-haspopup="dialog" @click="$emit('evidence',id,$event)">证据 {{n+1}} · 查看来源</button></div>
  </section>
  <section v-if="result.missing_information.length"><h4>仍需确认</h4><ul><li v-for="item in result.missing_information" :key="item"><SafeMarkdown :text="item"/></li></ul></section>
  <section v-if="result.next_steps.length"><h4>建议下一步</h4><ol><li v-for="item in result.next_steps" :key="item"><SafeMarkdown :text="item"/></li></ol></section>
 </article>
 <div v-else class="diagnosis-preview"><p class="answer-progress">{{pending?'正在分析 · 结论尚未完成':'本轮未生成可验证的完整结论'}}</p><SafeMarkdown v-if="preview" :text="preview"/></div>
</template>
