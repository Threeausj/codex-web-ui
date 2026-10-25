import { createApp } from 'vue';
import App from './App.vue';
import 'katex/dist/katex.min.css';
import './style.css';
import './chat-tabs.css';
import { initPwa } from './lib/pwa';

createApp(App).mount('#app');
void initPwa();
