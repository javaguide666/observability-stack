import { createRouter, createWebHashHistory } from 'vue-router'
import ConsoleView from '@/views/ConsoleView.vue'

// hash 路由：静态托管在 Jenkins userContent 下，刷新不会 404
const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    { path: '/', name: 'console', component: ConsoleView },
    { path: '/m/:job', name: 'module', component: ConsoleView, props: true },
    { path: '/:pathMatch(.*)*', redirect: '/' },
  ],
})

export default router
