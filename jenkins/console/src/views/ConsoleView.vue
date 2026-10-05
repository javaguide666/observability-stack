<script setup lang="ts">
import { onBeforeUnmount, onMounted, watch } from 'vue'
import { useRouter } from 'vue-router'
import { useConsole } from '@/composables/useConsole'
import AppHeader from '@/components/AppHeader.vue'
import BuildCard from '@/components/BuildCard.vue'
import BuildConsole from '@/components/BuildConsole.vue'
import LoginRequired from '@/components/LoginRequired.vue'
import ModuleSidebar from '@/components/ModuleSidebar.vue'

const props = defineProps<{ job?: string }>()
const router = useRouter()
const c = useConsole()

onMounted(() => void c.init(props.job))
onBeforeUnmount(() => c.dispose())

// 路由 -> 状态（浏览器前进/后退）
watch(
  () => props.job,
  (j) => {
    if (j && j !== c.currentJob) void c.selectJob(j)
  },
)

// 状态 -> 路由
function select(job: string) {
  void router.push({ name: 'module', params: { job } })
  void c.selectJob(job)
}
</script>

<template>
  <div class="app">
    <AppHeader />
    <LoginRequired v-if="c.loginRequired" />
    <div v-else class="layout">
      <ModuleSidebar @select="select" />
      <main class="main">
        <BuildCard />
      </main>
    </div>
    <BuildConsole />
  </div>
</template>

<style scoped>
.layout {
  display: grid;
  grid-template-columns: var(--wc-sidebar-w) minmax(0, 1fr);
  align-items: start;
}
.main {
  padding: 24px 28px 40px;
  min-width: 0;
}

@media (max-width: 1180px) {
  .layout {
    grid-template-columns: minmax(0, 1fr);
  }
  .main {
    padding: 16px;
  }
}
</style>
