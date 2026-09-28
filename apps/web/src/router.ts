import {createRouter,createWebHistory} from 'vue-router';
export const router=createRouter({history:createWebHistory(),routes:[{path:'/',redirect:'/runs'},{path:'/runs',component:()=>import('./pages/RunsPage.vue')},{path:'/runs/:runId',component:()=>import('./pages/RunDetailPage.vue')},{path:'/:pathMatch(.*)*',redirect:'/runs'}]});
