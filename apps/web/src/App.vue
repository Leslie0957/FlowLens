<script setup lang="ts">
import {useRoute} from 'vue-router';
import {computed} from 'vue';
const route=useRoute();
const current=computed(()=>route.path.startsWith('/runs')?'运行监控':route.path==='/diagnoses'?'历史诊断':route.path.startsWith('/local')?'本地执行实验':'演示场景');
</script>
<template>
<div class="shell">
  <aside class="sidebar">
    <router-link class="brand" to="/runs"><span class="brand-icon">◈</span><span>FlowLens<small>诊断工作台</small></span></router-link>
    <div class="nav-caption">工作空间</div>
    <router-link class="nav-item" to="/runs"><span class="nav-symbol" aria-hidden="true"><svg viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" rx="1"/><path d="M9 3v18M15 3v18M3 9h18M3 15h18"/></svg></span><span class="nav-label">运行监控</span><span class="nav-arrow" aria-hidden="true">›</span></router-link>
    <router-link class="nav-item" to="/diagnoses"><span class="nav-symbol" aria-hidden="true"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 6v6h5"/></svg></span><span class="nav-label">历史诊断</span><span class="nav-arrow" aria-hidden="true">›</span></router-link>
    <router-link class="nav-item" to="/demo"><span class="nav-symbol" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="m12 3 9 9-9 9-9-9Z"/></svg></span><span class="nav-label">演示场景</span><span class="nav-arrow" aria-hidden="true">›</span></router-link>
    <router-link class="nav-item" to="/local"><span class="nav-symbol" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M4 5h16v14H4zM7 9l3 3-3 3m5 0h5"/></svg></span><span class="nav-label">本地执行实验</span><span class="nav-arrow" aria-hidden="true">›</span></router-link>
    <div class="sidebar-bottom"><div class="source-indicator"><i></i>本地演示环境</div><p>任务数据均为合成示例<br>不包含真实业务信息</p></div>
  </aside>
  <div class="main-column"><header class="topbar"><div class="breadcrumb">工作空间 <span>/</span> {{current}}</div><div class="top-right"><span class="top-pill"><i></i> 本地服务</span><span class="avatar">FL</span></div></header><main><router-view/></main></div>
</div>
</template>
