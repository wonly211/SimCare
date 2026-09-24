import { createRouter, createWebHashHistory } from 'vue-router';

export const router = createRouter({
  history: createWebHashHistory(),
  scrollBehavior: () => ({ top: 0 }),
  routes: [
    { path: '/', redirect: '/overview' },
    { path: '/overview', name: 'overview', component: () => import('../pages/OverviewPage.vue') },
    { path: '/health', name: 'health', component: () => import('../pages/HealthPage.vue') },
    {
      path: '/medication',
      name: 'medication',
      component: () => import('../pages/MedicationPage.vue'),
    },
    { path: '/family', name: 'family', component: () => import('../pages/FamilyPage.vue') },
    { path: '/settings', name: 'settings', component: () => import('../pages/SettingsPage.vue') },
    { path: '/backup', name: 'backup', component: () => import('../pages/BackupPage.vue') },
    { path: '/:pathMatch(.*)*', redirect: '/overview' },
  ],
});
