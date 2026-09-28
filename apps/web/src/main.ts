import {createApp} from 'vue';
import {createPinia} from 'pinia';
import {ElButton,ElDialog} from 'element-plus';
import 'element-plus/dist/index.css';
import './style.css';
import App from './App.vue';
import {router} from './router.js';
createApp(App).use(createPinia()).use(router).component('ElButton',ElButton).component('ElDialog',ElDialog).mount('#app');
