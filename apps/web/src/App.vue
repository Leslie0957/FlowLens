<script setup lang="ts">
import {useRoute} from 'vue-router';
import {computed} from 'vue';
const route=useRoute();
const current=computed(()=>route.path.startsWith('/runs')?'运行监控':'工作台');
</script>
<template>
<div class="shell">
  <aside class="sidebar">
    <router-link class="brand" to="/runs"><span class="brand-icon">◈</span><span>FlowLens<small>诊断工作台</small></span></router-link>
    <div class="nav-caption">工作空间</div>
    <router-link class="nav-item" to="/runs"><span class="nav-symbol">▦</span>运行监控<span class="nav-arrow">›</span></router-link>
    <div class="sidebar-bottom"><div class="source-indicator"><i></i>本地演示环境</div><p>任务数据均为合成示例<br>不包含真实业务信息</p></div>
  </aside>
  <div class="main-column"><header class="topbar"><div class="breadcrumb">工作空间 <span>/</span> {{current}}</div><div class="top-right"><span class="top-pill"><i></i> 本地服务</span><span class="avatar">FL</span></div></header><main><router-view/></main></div>
</div>
</template>
