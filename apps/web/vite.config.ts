import {defineConfig} from 'vite';
import vue from '@vitejs/plugin-vue';
export default defineConfig({plugins:[vue()],server:{proxy:{'/api':process.env.FLOWLENS_API_TARGET??'http://127.0.0.1:4173','/health':process.env.FLOWLENS_API_TARGET??'http://127.0.0.1:4173'}}});
