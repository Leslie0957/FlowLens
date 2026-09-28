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
