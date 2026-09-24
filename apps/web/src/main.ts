import { createApp } from 'vue';
import App from './App.vue';
import { router } from './router';
import './styles/main.css';
import './state/display';
import { startUpdates } from './update/manager';

createApp(App).use(router).mount('#app');
startUpdates();
