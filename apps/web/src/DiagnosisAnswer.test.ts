import {expect,it} from 'vitest';
import {mount} from '@vue/test-utils';
import DiagnosisAnswer from './DiagnosisAnswer.vue';
it('uses validated history result and preserves evidence actions without exposing raw JSON',async()=>{
 const row={id:'result',turn_id:'turn',summary:'读取阶段超时',findings_json:JSON.stringify([{cause:'UPSTREAM_TIMEOUT',explanation:'日志确认读取超时',evidence_ids:['evidence-1'],evidence_status:'SUPPORTED'}]),missing_information_json:'["上游是否恢复"]',next_steps_json:'["检查上游"]',proposed_action_json:'null',created_at:''};
 const wrapper=mount(DiagnosisAnswer,{props:{row,status:'COMPLETED',content:'Reading logs.{"summary":"RAW_JSON","evidence_ids":["bad"]}'}});
 expect(wrapper.text()).toContain('读取阶段超时');expect(wrapper.text()).not.toContain('RAW_JSON');expect(wrapper.text()).not.toContain('Reading logs');expect(wrapper.findAll('li')).toHaveLength(2);
 await wrapper.get('button').trigger('click');expect(wrapper.emitted('evidence')?.[0]?.[0]).toBe('evidence-1');expect(wrapper.emitted('evidence')?.[0]?.[1]).toBeInstanceOf(MouseEvent);
});
it('keeps partial or failed output distinct from verified conclusions',()=>{
 const wrapper=mount(DiagnosisAnswer,{props:{status:'FAILED',content:'{"summary":"初步判断","findings":['}});
 expect(wrapper.text()).toContain('未生成可验证');expect(wrapper.find('.diagnosis-result').exists()).toBe(false);expect(wrapper.find('button').exists()).toBe(false);expect(wrapper.text()).not.toContain('findings');
});
