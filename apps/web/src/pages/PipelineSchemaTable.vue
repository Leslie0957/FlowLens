<script setup lang="ts">
withDefaults(defineProps<{fields:{name:string;type:string}[];label?:string}>(),{label:'表字段与类型'});
</script>
<template>
 <div class="pipeline-field-table-wrap">
  <table class="pipeline-field-table" :aria-label="label">
   <thead><tr><th scope="col">字段名</th><th scope="col">SQLite 类型</th></tr></thead>
   <tbody>
    <tr v-for="field in fields" :key="field.name"><td><code>{{field.name}}</code></td><td><span class="pipeline-field-type">{{field.type||'未声明'}}</span></td></tr>
    <tr v-if="!fields.length"><td colspan="2">暂无字段结构</td></tr>
   </tbody>
  </table>
 </div>
</template>
