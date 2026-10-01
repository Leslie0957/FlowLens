import {expect,it} from 'vitest';
import {applyAgentEvent,type SessionState} from './agent-reducer.js';
const state=():SessionState=>({schema_version:1,session:{id:'s',run_id:'r',title:'test',created_at:'',updated_at:''},turns:[],messages:[],tool_calls:[],results:[],last_event_seq:0});
const event={schema_version:1,event_id:'e',seq:1,session_id:'s',turn_id:'t',timestamp:'now',type:'message.delta',payload:{message_id:'m',delta:'中文'}};
it('does not duplicate replayed text or accept another session',()=>{const s=state();applyAgentEvent(s,event);applyAgentEvent(s,event);applyAgentEvent(s,{...event,seq:2,session_id:'other'});expect(s.messages[0]?.content).toBe('中文');expect(s.last_event_seq).toBe(1);});
it('detects missing events before mutating state',()=>{const s=state();expect(()=>applyAgentEvent(s,{...event,seq:2})).toThrow('EVENT_GAP');expect(s.messages).toHaveLength(0);});
it('a retry reset replaces failed stream text and replay remains idempotent',()=>{
 const s=state();applyAgentEvent(s,event);
 const reset={...event,event_id:'reset',seq:2,type:'message.reset',payload:{message_id:'m',content:''}};
 applyAgentEvent(s,reset);applyAgentEvent(s,reset);
 applyAgentEvent(s,{...event,event_id:'new',seq:3,payload:{message_id:'m',delta:'正确摘要'}});
 expect(s.messages[0]?.content).toBe('正确摘要');expect(s.last_event_seq).toBe(3);
});
it('preserves bounded tool output during SSE replay and rejects an invalid output payload',()=>{
 const s=state();applyAgentEvent(s,{...event,type:'tool.started',payload:{tool_call_id:'tool',name:'read_test_signal',args:{}}});
 const complete={...event,seq:2,type:'tool.completed',payload:{tool_call_id:'tool',summary:'只读结果',evidence_ids:['evidence'],output:{signal:'available'}}};
 expect(()=>applyAgentEvent(s,{...complete,payload:{...complete.payload,output:'invalid'}})).toThrow('EVENT_PROTOCOL_ERROR');expect(s.last_event_seq).toBe(1);expect(s.tool_calls[0]?.status).toBe('RUNNING');
 applyAgentEvent(s,complete);applyAgentEvent(s,complete);expect(s.tool_calls).toHaveLength(1);expect(JSON.parse(s.tool_calls[0]!.result_summary_json!)).toMatchObject({output:{signal:'available'},evidence_ids:['evidence']});
});
