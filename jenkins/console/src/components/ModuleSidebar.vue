<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { useConsole } from '@/composables/useConsole'
import { relativeTime } from '@/utils/format'
import StatusDot from './StatusDot.vue'

const emit = defineEmits<{ select: [job: string] }>()
const c = useConsole()

// 让「x 分钟前」随时间刷新
const now = ref(Date.now())
let timer: ReturnType<typeof setInterval> | undefined
onMounted(() => (timer = setInterval(() => (now.value = Date.now()), 20000)))
onBeforeUnmount(() => clearInterval(timer))

function statusText(r: string | null, building: boolean): string {
  if (building) return '构建中'
  return r === 'SUCCESS' ? '成功' : r === 'FAILURE' ? '失败' : r === 'ABORTED' ? '已中止' : '暂无构建'
}
</script>

<template>
  <aside class="sidebar" aria-label="模块列表">
    <div class="head">
      <h2 class="wc-section-title">模块</h2>
      <button class="reload" type="button" title="刷新状态" :disabled="c.jobsLoading" @click="c.loadJobs()">
        <el-icon :class="{ spin: c.jobsLoading }"><Refresh /></el-icon>
      </button>
    </div>

    <nav class="list">
      <template v-if="c.jobs.length">
        <button
          v-for="j in c.jobs"
          :key="j.job"
          type="button"
          class="mod"
          :class="{ active: j.job === c.currentJob, all: j.job === 'wealth-all' }"
          @click="emit('select', j.job)"
        >
          <StatusDot :result="j.lastResult" :building="j.lastBuilding" />
          <span class="txt">
            <strong>{{ j.title }}</strong>
            <small>{{ j.job }}</small>
          </span>
          <span class="meta" :class="{ run: j.lastBuilding, bad: j.lastResult === 'FAILURE' && !j.lastBuilding }">
            <template v-if="j.lastBuildNumber">#{{ j.lastBuildNumber }}</template>
            <small>{{ j.lastBuilding ? statusText(null, true) : relativeTime(j.lastBuildAt, now) }}</small>
          </span>
        </button>
      </template>
      <template v-else>
        <div v-for="n in 8" :key="n" class="mod skeleton"><el-skeleton animated :rows="1" /></div>
      </template>
    </nav>

    <div class="legend muted">
      <span><StatusDot result="SUCCESS" :size="8" /> 成功</span>
      <span><StatusDot result="FAILURE" :size="8" /> 失败</span>
      <span><StatusDot building :size="8" /> 构建中</span>
    </div>
  </aside>
</template>

<style scoped>
.sidebar {
  padding: 20px 16px;
  border-right: 1px solid var(--wc-line);
  background: var(--wc-bg-elev);
  min-height: calc(100vh - var(--wc-topbar-h));
}
.head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 8px;
}
.reload {
  background: none;
  border: 0;
  color: var(--wc-muted);
  cursor: pointer;
  padding: 4px;
  margin-bottom: 12px;
  border-radius: 6px;
}
.reload:hover {
  color: var(--wc-accent);
}
.spin {
  animation: spin 0.9s linear infinite;
}
@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}
.list {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.mod {
  display: flex;
  align-items: center;
  gap: 12px;
  text-align: left;
  border: 1px solid transparent;
  background: transparent;
  color: var(--wc-text);
  padding: 10px 12px;
  border-radius: var(--wc-radius-md);
  cursor: pointer;
  font: inherit;
  transition:
    background 0.15s,
    border-color 0.15s;
}
.mod:hover {
  background: var(--wc-card);
}
.mod.active {
  background: var(--wc-card);
  border-color: var(--wc-accent);
  box-shadow: var(--wc-shadow-sm);
}
.mod.all {
  margin-top: 8px;
  border-top: 1px dashed var(--wc-line);
  border-radius: 0 0 var(--wc-radius-md) var(--wc-radius-md);
  padding-top: 14px;
}
.mod.all.active {
  border-radius: var(--wc-radius-md);
  border-top-style: solid;
}
.txt {
  flex: 1;
  min-width: 0;
}
.txt strong {
  display: block;
  font-size: 14px;
  font-weight: 600;
}
.txt small,
.meta small {
  display: block;
  color: var(--wc-muted);
  font-size: 11px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.meta {
  text-align: right;
  font-size: 12px;
  color: var(--wc-muted);
  font-family: var(--wc-font-mono);
  white-space: nowrap;
}
.meta.run small {
  color: var(--wc-warn);
}
.meta.bad {
  color: var(--wc-bad);
}
.skeleton {
  cursor: default;
  display: block;
}
.legend {
  display: flex;
  gap: 14px;
  margin-top: 20px;
  padding: 0 8px;
  font-size: 12px;
}
.legend span {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

@media (max-width: 1180px) {
  .sidebar {
    min-height: 0;
    border-right: 0;
    border-bottom: 1px solid var(--wc-line);
    padding: 12px 14px;
  }
  .head,
  .legend {
    display: none;
  }
  .list {
    flex-direction: row;
    overflow-x: auto;
    padding-bottom: 4px;
  }
  .mod {
    flex: none;
    border-color: var(--wc-line);
    gap: 8px;
    padding: 8px 12px;
  }
  .mod.all {
    margin: 0;
    border: 1px solid var(--wc-line);
    border-radius: var(--wc-radius-md);
    padding-top: 8px;
  }
  .mod.active {
    border-color: var(--wc-accent);
  }
  .meta {
    display: none;
  }
}
</style>
