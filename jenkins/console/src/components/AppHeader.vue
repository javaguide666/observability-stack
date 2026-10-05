<script setup lang="ts">
import { computed } from 'vue'
import { useConsole } from '@/composables/useConsole'

const c = useConsole()
const connLabel = computed(() => {
  if (c.connection === 'checking') return '连接中…'
  if (c.connection === 'offline') return 'Jenkins 未连接'
  const base = `Jenkins 已连接${c.info ? ` · ${c.info.version} · ${c.info.latencyMs}ms` : ''}`
  return c.loginRequired ? `${base} · 未登录` : base
})
const nativeUrl = '/'
</script>

<template>
  <header class="topbar">
    <div class="brand">
      <div class="brand-mark">W</div>
      <div>
        <div class="title">Wealth CI 控制台</div>
        <div class="sub muted">Jenkins 独立前端 · 构建 / 回滚</div>
      </div>
      <span v-if="c.mockMode" class="mock-badge" title="当前使用 mock 假数据（VITE_USE_MOCK=true）">MOCK 假数据</span>
    </div>

    <div class="actions">
      <span class="conn" :class="c.connection" :title="connLabel">
        <i class="led" />
        <span class="conn-text">{{ connLabel }}</span>
      </span>
      <a class="native" :href="nativeUrl" target="_blank" rel="noopener noreferrer">
        Jenkins 原生页面 <el-icon><TopRight /></el-icon>
      </a>
      <span class="user-chip">
        <el-icon><User /></el-icon>
        {{ c.who?.name ?? '…' }}
      </span>
    </div>
  </header>
</template>

<style scoped>
.topbar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 16px;
  min-height: var(--wc-topbar-h);
  padding: 10px 28px;
  border-bottom: 1px solid var(--wc-line);
  background: var(--wc-bg-elev);
  position: sticky;
  top: 0;
  z-index: 20;
}
.brand {
  display: flex;
  gap: 12px;
  align-items: center;
  min-width: 0;
}
.brand-mark {
  width: 36px;
  height: 36px;
  border-radius: var(--wc-radius-md);
  display: grid;
  place-items: center;
  font-weight: 700;
  color: #fff;
  background: linear-gradient(180deg, var(--wc-accent), var(--wc-accent-2));
  box-shadow: var(--wc-shadow-sm);
}
.title {
  font-size: 16px;
  font-weight: 600;
  letter-spacing: 0.01em;
}
.sub {
  font-size: 12px;
}
.mock-badge {
  margin-left: 4px;
  padding: 2px 10px;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.04em;
  border-radius: var(--wc-radius-pill);
  background: var(--wc-warn-bg);
  color: var(--wc-warn);
  white-space: nowrap;
}
.actions {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  justify-content: flex-end;
}
.conn,
.user-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  padding: 5px 12px;
  border-radius: var(--wc-radius-pill);
  background: var(--wc-chip-bg);
  color: var(--wc-muted);
  white-space: nowrap;
}
.user-chip {
  color: var(--wc-text);
}
.led {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--wc-idle);
}
.conn.online .led {
  background: var(--wc-ok);
  box-shadow: 0 0 0 3px rgba(61, 214, 140, 0.18);
}
.conn.online {
  color: var(--wc-text);
}
.conn.offline .led {
  background: var(--wc-bad);
}
.conn.checking .led {
  background: var(--wc-warn);
  animation: wc-pulse 1.4s ease-out infinite;
}
.native {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 13px;
  font-weight: 600;
}
@media (max-width: 760px) {
  .topbar {
    padding: 10px 14px;
  }
  .sub,
  .native {
    display: none;
  }
}
</style>
