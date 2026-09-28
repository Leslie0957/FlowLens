import {agentEventSchema,diagnosisResultSchema,type sessionSnapshotSchema} from '@flowlens/contracts';
import type {z} from 'zod';
export type SessionState=z.infer<typeof sessionSnapshotSchema>;
export function applyAgentEvent(state:SessionState,raw:unknown):boolean{
 const e=agentEventSchema.parse(raw);
 if(e.session_id!==state.session.id||e.seq<=state.last_event_seq)return false;
 if(e.seq!==state.last_event_seq+1)throw new Error('EVENT_GAP');
 const p=e.payload,t=state.turns.find(x=>x.id===e.turn_id);
 if(e.type==='message.delta'){
  if(typeof p.message_id!=='string'||typeof p.delta!=='string')throw new Error('EVENT_PROTOCOL_ERROR');
  let message=state.messages.find(m=>m.id===p.message_id);
  if(!message){message={id:p.message_id,session_id:e.session_id,turn_id:e.turn_id,role:'assistant',content:'',is_partial:1,created_at:e.timestamp};state.messages.push(message);}
  message.content+=p.delta;
 }else if(e.type==='message.reset'){
  if(typeof p.message_id!=='string'||typeof p.content!=='string')throw new Error('EVENT_PROTOCOL_ERROR');
  const message=state.messages.find(m=>m.id===p.message_id&&m.turn_id===e.turn_id);
  if(message)message.content=p.content;
 }else if(e.type==='tool.started'){
  if(typeof p.tool_call_id!=='string'||typeof p.name!=='string')throw new Error('EVENT_PROTOCOL_ERROR');
  if(!state.tool_calls.some(x=>x.id===p.tool_call_id))state.tool_calls.push({id:p.tool_call_id,turn_id:e.turn_id,name:p.name,args_json:JSON.stringify(p.args??{}),status:'RUNNING',result_summary_json:null,error_code:null,started_at:e.timestamp,finished_at:null});
 }else if(['tool.completed','tool.failed','tool.cancelled'].includes(e.type)){
  const tool=state.tool_calls.find(x=>x.id===p.tool_call_id);if(tool){tool.status=e.type==='tool.completed'?'SUCCEEDED':e.type==='tool.cancelled'?'CANCELLED':'FAILED';tool.finished_at=e.timestamp;tool.error_code=typeof p.code==='string'?p.code:null;tool.result_summary_json=JSON.stringify({summary:p.summary??null,evidence_ids:p.evidence_ids??[]});}
 }else if(e.type==='turn.started'){if(t)t.status='RUNNING';}
 else if(e.type==='diagnosis.completed'){
  const result=diagnosisResultSchema.parse(p.result);
  if(!state.results.some(x=>x.turn_id===e.turn_id))state.results.push({id:e.event_id,turn_id:e.turn_id,summary:result.summary,findings_json:JSON.stringify(result.findings),missing_information_json:JSON.stringify(result.missing_information),next_steps_json:JSON.stringify(result.next_steps),proposed_action_json:JSON.stringify(result.proposed_action),created_at:e.timestamp});
 }else if(e.type==='turn.finished'){
  if(!['COMPLETED','FAILED','CANCELLED','INTERRUPTED'].includes(String(p.status)))throw new Error('EVENT_PROTOCOL_ERROR');
  if(t){t.status=p.status as typeof t.status;t.finished_at=e.timestamp;t.error_code=p.error&&typeof p.error==='object'&&'code' in p.error?String(p.error.code):null;}
  for(const m of state.messages)if(m.turn_id===e.turn_id)m.is_partial=0;
 }
 state.last_event_seq=e.seq;return true;
}
