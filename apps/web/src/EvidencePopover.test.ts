import {expect,it} from 'vitest';
import {mount} from '@vue/test-utils';
import {nextTick} from 'vue';
import EvidencePopover from './EvidencePopover.vue';
it('anchors below the selected reference and closes with Escape or outside click',async()=>{
 const anchor=document.createElement('button');document.body.append(anchor);
 anchor.getBoundingClientRect=()=>({left:100,right:200,top:100,bottom:132,width:100,height:32,x:100,y:100,toJSON(){return {};}});
 const wrapper=mount(EvidencePopover,{props:{anchor},slots:{default:'证据内容'}});
 await nextTick();
 const panel=document.querySelector<HTMLElement>('.evidence-popover')!;
 expect(panel.style.top).toBe('140px');expect(panel.style.position).toBe('fixed');
 document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'}));expect(wrapper.emitted('close')).toHaveLength(1);expect(document.activeElement).toBe(anchor);
 document.body.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true}));expect(wrapper.emitted('close')).toHaveLength(2);
 wrapper.unmount();anchor.remove();expect(document.querySelector('.evidence-popover')).toBeNull();
});
