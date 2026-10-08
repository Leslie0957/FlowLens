import { createRouter, createWebHistory } from 'vue-router';
export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/pipeline', component: () => import('./pages/PipelineProjectsPage.vue') },
    {
      path: '/pipeline/projects/:projectId',
      component: () => import('./pages/PipelineProjectPage.vue'),
    },
    {
      path: '/pipeline/projects/:projectId/database',
      component: () => import('./pages/PipelineDatabasePage.vue'),
    },
    {
      path: '/pipeline/projects/:projectId/results/:batchId',
      component: () => import('./pages/PipelineResultPage.vue'),
    },
    { path: '/', redirect: '/pipeline' },
    { path: '/runs', component: () => import('./pages/RunsPage.vue') },
    { path: '/runs/:runId', component: () => import('./pages/RunDetailPage.vue') },
    { path: '/diagnoses', component: () => import('./pages/HistoryPage.vue') },
    { path: '/demo', component: () => import('./pages/DemoPage.vue') },
    { path: '/local', component: () => import('./pages/LocalProjectsPage.vue') },
    { path: '/local/projects/:projectId', component: () => import('./pages/LocalProjectPage.vue') },
    { path: '/:pathMatch(.*)*', redirect: '/runs' },
  ],
});
