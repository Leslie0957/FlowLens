<script setup lang="ts">
import {computed,ref,watch} from 'vue';
import type {SessionState} from './agent-reducer.js';
import ToolTraceCard from './ToolTraceCard.vue';
const props=defineProps<{tools:SessionState['tool_calls']}>();
const open=ref(false),page=ref(0);
const pages=computed(()=>Math.max(1,Math.ceil(props.tools.length/20)));
const visible=computed(()=>props.tools.slice(page.value*20,(page.value+1)*20));
watch(pages,n=>{if(page.value>=n)page.value=n-1;});
</script>
<template>
<details v-if="tools.length" class="tool-trace" @toggle="open=($event.target as HTMLDetailsElement).open"><summary>只读查询 · {{tools.length}} 项</summary>
 <template v-if="open"><ToolTraceCard v-for="tool in visible" :key="tool.id" :tool="tool"/><div v-if="pages>1" class="pagination"><span>工具第 {{page+1}} / {{pages}} 页 · 每页最多 20 项</span><div><button :disabled="page===0" @click="page--">更早工具</button><button :disabled="page+1===pages" @click="page++">较新工具</button></div></div></template>
</details>
</template>
