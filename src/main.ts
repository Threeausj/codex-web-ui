import { createApp } from 'vue';
import App from './App.vue';
import './style.css';
import { initPwa } from './lib/pwa';

createApp(App).mount('#app');
void initPwa();
