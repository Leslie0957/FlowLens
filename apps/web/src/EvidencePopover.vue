<script setup lang="ts">
import {ref,onMounted,onUnmounted,watch,nextTick} from 'vue';
const props=defineProps<{anchor:HTMLElement}>();
const emit=defineEmits<{close:[]}>();
const panel=ref<HTMLElement>();const style=ref<Record<string,string>>({visibility:'hidden'});
function position(){
 const rect=props.anchor.getBoundingClientRect(),width=Math.min(520,window.innerWidth-24);
 if(!props.anchor.isConnected||rect.bottom<0||rect.top>window.innerHeight){emit('close');return;}
 const below=window.innerHeight-rect.bottom-20,above=rect.top-20;
 const useBelow=below>=140||below>=above;
 style.value={position:'fixed',width:width+'px',left:Math.max(12,Math.min(rect.left,window.innerWidth-width-12))+'px',maxHeight:Math.max(80,Math.min(400,useBelow?below:above))+'px',...(useBelow?{top:rect.bottom+8+'px'}:{bottom:window.innerHeight-rect.top+8+'px'})};
}
function close(){emit('close');props.anchor.focus({preventScroll:true});}
function outside(e:PointerEvent){if(e.target instanceof Node&&!panel.value?.contains(e.target)&&!props.anchor.contains(e.target))emit('close');}
function key(e:KeyboardEvent){if(e.key==='Escape'){e.preventDefault();close();}}
watch(()=>props.anchor,()=>{void nextTick(position);});
onMounted(()=>{position();window.addEventListener('resize',position);window.addEventListener('scroll',position,true);document.addEventListener('pointerdown',outside);document.addEventListener('keydown',key);});
onUnmounted(()=>{window.removeEventListener('resize',position);window.removeEventListener('scroll',position,true);document.removeEventListener('pointerdown',outside);document.removeEventListener('keydown',key);});
</script>
<template><Teleport to="body"><section ref="panel" class="evidence-popover" :style="style" role="dialog" aria-label="证据详情"><button class="evidence-popover-close" aria-label="关闭引用" title="关闭引用" @click="close">×</button><slot/></section></Teleport></template>
