import {afterEach,expect,it,vi} from 'vitest';
import {mount} from '@vue/test-utils';
import {pipelineRepairSchema} from '@flowlens/contracts';
import PipelineDiagnosis from './pages/PipelineDiagnosis.vue';
const id='10000000-0000-4000-8000-000000000001',hash='a'.repeat(64);
const base=pipelineRepairSchema.parse({id,project_id:id,execution_id:id,base_revision_id:id,base_hash:hash,input_hash:hash,status:'RUNNING',provider_mode:'MOCK',model:'mock',created_at:'now',expires_at:null,tools:[],evidence:[],diagnosis:null,action:null,failed_step:null,evidence_ids:[],candidate:null,approved_revision_id:null,verification_execution_id:null,error_code:null,model_requests:1,usage:{prompt_tokens:0,completion_tokens:0}});
const diagnosis='实际日志确认查询阶段使用了不存在的列，结合源表结构与既定规则提出任务 SQL 候选，仍需人工审批和独立验证。';
const final={...base,status:'PENDING_APPROVAL',diagnosis,action:'SQL_PATCH',candidate:{file_path:'task.sql' as const,sql:'SELECT dat FROM raw_vehicle_events',hash,diff:'--- task.sql\n+++ task.sql'}};
// Framework dialog transitions have their own timers; this suite targets text reveal cleanup.
const options={global:{stubs:{ElButton:{props:['disabled'],template:'<button :disabled="disabled"><slot/></button>'},ElDialog:true}}};
afterEach(()=>{vi.useRealTimers();vi.restoreAllMocks();});

it('progressively presents a validated live result, delays Diff, and does not replay on duplicate snapshots or verification status changes',async()=>{
 vi.useFakeTimers();const wrapper=mount(PipelineDiagnosis,{...options,props:{repair:base,busy:false,animate:true}});
 expect(wrapper.find('.pipeline-diagnosis-text').exists()).toBe(false);expect(wrapper.text()).toContain('正在取证');
 await wrapper.setProps({repair:final});expect(wrapper.get('.pipeline-diagnosis-answer').attributes('aria-busy')).toBe('true');expect(wrapper.text()).not.toContain(diagnosis);expect(wrapper.find('.pipeline-diff').exists()).toBe(false);
 await vi.advanceTimersByTimeAsync(120);const prefix=wrapper.get('.pipeline-diagnosis-text').text().replace(/▍$/,'');expect(prefix.length).toBeGreaterThan(0);expect(prefix.length).toBeLessThan(diagnosis.length);expect(diagnosis.startsWith(prefix)).toBe(true);
 await wrapper.setProps({repair:{...final,status:'VERIFYING',model_requests:2}});expect(wrapper.get('.pipeline-diagnosis-text').text().replace(/▍$/,'')).toBe(prefix);
 await vi.advanceTimersByTimeAsync(5000);expect(wrapper.get('.pipeline-diagnosis-text').text()).toBe(diagnosis);expect(wrapper.find('.pipeline-diff').exists()).toBe(true);expect(wrapper.emitted('presented')).toEqual([[id]]);expect(vi.getTimerCount()).toBe(0);wrapper.unmount();
});

it('restored history is immediate and a replacement diagnosis or failure never retains old text or progress',async()=>{
 vi.useFakeTimers();const wrapper=mount(PipelineDiagnosis,{...options,props:{repair:final,busy:false}});expect(wrapper.get('.pipeline-diagnosis-text').text()).toBe(diagnosis);expect(vi.getTimerCount()).toBe(0);
 const next={...base,id:'10000000-0000-4000-8000-000000000002'};await wrapper.setProps({repair:next,animate:true});expect(wrapper.text()).not.toContain(diagnosis);expect(wrapper.find('.pipeline-diff').exists()).toBe(false);
 await wrapper.setProps({repair:{...next,status:'FAILED',error_code:'REPAIR_EVIDENCE_INVALID'}});expect(wrapper.text()).toContain('未生成通过校验');expect(wrapper.text()).not.toContain('正在取证');expect(wrapper.find('.pipeline-diagnosis-text').exists()).toBe(false);wrapper.unmount();
});

it('unmount stops an unfinished presentation and historical reselection never replays it',async()=>{
 vi.useFakeTimers();const wrapper=mount(PipelineDiagnosis,{...options,props:{repair:final,busy:false,animate:true}});await vi.advanceTimersByTimeAsync(80);expect(wrapper.get('.pipeline-diagnosis-answer').attributes('aria-busy')).toBe('true');wrapper.unmount();expect(vi.getTimerCount()).toBe(0);
 const history=mount(PipelineDiagnosis,{...options,props:{repair:final,busy:false}});expect(history.get('.pipeline-diagnosis-text').text()).toBe(diagnosis);expect(history.get('.pipeline-diagnosis-answer').attributes('aria-busy')).toBe('false');history.unmount();
});

it('reduced motion shows the full validated result without timers',()=>{
 vi.useFakeTimers();vi.spyOn(window,'matchMedia').mockReturnValue({matches:true} as MediaQueryList);
 const wrapper=mount(PipelineDiagnosis,{...options,props:{repair:final,busy:false,animate:true}});expect(wrapper.get('.pipeline-diagnosis-text').text()).toBe(diagnosis);expect(wrapper.find('.pipeline-diff').exists()).toBe(true);expect(vi.getTimerCount()).toBe(0);wrapper.unmount();
});

it('known citations open their exact evidence and switching repairs closes the previous source',async()=>{
 const evidenceId='20000000-0000-4000-8000-000000000002';
 const evidence={id:evidenceId,type:'get_schema',source_id:id,source_version:hash,excerpt:'{"columns":["speed_mps"]}'};
 const wrapper=mount(PipelineDiagnosis,{...options,props:{repair:{...final,diagnosis:'实际字段见 '+evidenceId,evidence:[evidence],evidence_ids:[evidenceId]},busy:false}});
 const citation=wrapper.get('.pipeline-citation');expect(citation.text()).toBe('[证据1]');expect(citation.attributes('aria-label')).toBe('查看证据1：实际表结构');await citation.trigger('click');expect(wrapper.findComponent({name:'ElDialog'}).props('modelValue')).toBe(true);
 await wrapper.setProps({repair:{...base,id:'30000000-0000-4000-8000-000000000003'}});expect(wrapper.findComponent({name:'ElDialog'}).props('modelValue')).toBe(false);expect(wrapper.find('.pipeline-citation').exists()).toBe(false);wrapper.unmount();
});

it('stale or expired candidates retain their evidence but cannot be approved from the UI',async()=>{
 const wrapper=mount(PipelineDiagnosis,{...options,props:{repair:{...final,expires_at:new Date(2000).toISOString()},busy:false,now:1000,currentRevisionId:id}});
 const approve=()=>wrapper.get('.pipeline-actions button').element as HTMLButtonElement;expect(approve().disabled).toBe(false);
 await wrapper.setProps({now:2000});expect(wrapper.text()).toContain('候选已过期');expect(approve().disabled).toBe(true);expect(wrapper.find('.pipeline-diff').exists()).toBe(true);
 await wrapper.setProps({now:1000,currentRevisionId:'30000000-0000-4000-8000-000000000003'});expect(wrapper.text()).toContain('当前 SQL 版本已变化');expect(approve().disabled).toBe(true);wrapper.unmount();
});

it('failed diagnoses show an explicit error and correction history instead of waiting for nonexistent tools; old records stay readable',async()=>{
 const wrapper=mount(PipelineDiagnosis,{...options,props:{repair:{...base,status:'FAILED',error_code:'REPAIR_TOOLS_REQUIRED',error_message:'模型尚未完成工具取证，不能接受没有真实证据的诊断。',response_checks:[{request:1,code:'REPAIR_TOOLS_REQUIRED',message:'缺少 get_schema 工具取证'}]},busy:false}});
 expect(wrapper.text()).toContain('模型尚未完成工具取证');expect(wrapper.text()).toContain('本次没有执行诊断工具');expect(wrapper.text()).not.toContain('等待模型发起');expect(wrapper.text()).toContain('第 1 次模型请求');expect(wrapper.text()).toContain('get_schema');
 const old=pipelineRepairSchema.parse({...base,status:'FAILED',error_code:'INTERNAL_ERROR',error_message:undefined,response_checks:undefined});expect(old.error_message).toBeNull();expect(old.response_checks).toEqual([]);await wrapper.setProps({repair:old});expect(wrapper.text()).toContain('旧记录未保存具体校验原因');wrapper.unmount();
});

it('combined approval explains its write scope, and a verified SQL with failed commit shows failure without another repair approval',async()=>{
 const wrapper=mount(PipelineDiagnosis,{...options,props:{repair:final,busy:false}});expect(wrapper.text()).toContain('一次批准同时授权');expect(wrapper.get('.pipeline-actions button').text()).toBe('批准修复并入库');await wrapper.get('.pipeline-actions button').trigger('click');expect(wrapper.emitted('decide')).toEqual([[id,'approve']]);
 await wrapper.setProps({repair:{...final,status:'VERIFIED',verification_execution_id:id,commit_approval:{approved_at:'now',target_version:0,target_hash:hash,status:'FAILED',execution_id:id,operation_id:null,batch_id:null,error_code:'APPROVAL_TARGET_CHANGED',error_message:'批准后目标数据已变化，原授权停止；请重新预检并批准。'}}});expect(wrapper.text()).toContain('入库未完成');expect(wrapper.text()).toContain('APPROVAL_TARGET_CHANGED');expect(wrapper.find('.pipeline-badges .pipeline-status').classes()).toContain('danger');expect(wrapper.find('.pipeline-actions button').exists()).toBe(false);wrapper.unmount();
});

it('incremental traces retain repeated tools, failed calls and request numbers without a fixed checklist',async()=>{
 const tool={id,name:'get_sql',status:'COMPLETED',args:{},result:{output:{sql:'SELECT 1'},evidence_ids:[]},error_code:null,request:1};
 const wrapper=mount(PipelineDiagnosis,{...options,props:{repair:{...base,tools:[tool]},busy:false}});
 expect(wrapper.text()).toContain('已完成 1 次调用');expect(wrapper.text()).toContain('第 1 次模型请求');expect(wrapper.get('.answer-progress').text()).not.toContain('取证已完成');
 await wrapper.setProps({repair:{...base,tools:[tool,{...tool,id:'other',request:2,status:'FAILED',error_code:'INVALID_ARGUMENTS'}]}});
 expect(wrapper.findAll('.pipeline-tools details')).toHaveLength(2);expect(wrapper.text()).toContain('第 2 次模型请求');expect(wrapper.text()).toContain('INVALID_ARGUMENTS');expect(wrapper.text()).toContain('已完成 1 次调用');
 await wrapper.setProps({repair:{...base,status:'FAILED',error_code:'REPAIR_NO_PROGRESS',error_message:'连续多轮没有新增工具观测，诊断已停止。'}});
 expect(wrapper.text()).toContain('没有新增工具观测');expect(wrapper.find('.pipeline-actions').exists()).toBe(false);expect(wrapper.text()).not.toContain('正在取证');wrapper.unmount();
});

it('initial failure is shown as persisted execution evidence and old records never inherit current budgets',async()=>{
 const evidence={id,type:'INITIAL_FAILURE',source_id:id,source_version:hash,excerpt:'{"error_message":"actual SQLite failure"}'};
 const wrapper=mount(PipelineDiagnosis,{global:{stubs:{...options.global.stubs,ElDialog:{props:['title','modelValue'],template:'<div v-if="modelValue"><h4>{{title}}</h4><slot/></div>'}}},props:{repair:{...base,status:'NO_CANDIDATE',diagnosis:'请补充外部任务意图 '+id,action:'MANUAL_REQUIRED',evidence:[evidence],evidence_ids:[id]},busy:false}});
 expect(wrapper.text()).toContain('初始失败观测');expect(wrapper.text()).toContain('旧记录未保存诊断上限');expect(wrapper.text()).not.toContain('尚未取得真实证据');
 await wrapper.get('.pipeline-evidence-links button').trigger('click');expect(wrapper.text()).toContain('持久化的失败执行（初始观测，未调用工具）');expect(wrapper.text()).toContain('actual SQLite failure');
 await wrapper.setProps({repair:{...base,diagnosis_limits:{max_requests:7,max_tool_calls:9,timeout_ms:1000,max_stall_rounds:2,max_context_bytes:4000}}});expect(wrapper.text()).toContain('模型请求 7 次');expect(wrapper.text()).toContain('上下文 4000 字节');wrapper.unmount();
});
