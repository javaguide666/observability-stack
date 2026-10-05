<script setup lang="ts">
import { computed } from 'vue'
import { QUICK_BRANCHES } from '@/api'
import { useConsole } from '@/composables/useConsole'
import FieldLabel from './FieldLabel.vue'

const c = useConsole()
const quick = computed(() => QUICK_BRANCHES.filter((b) => c.branches.includes(b)))
const tip = computed(
  () =>
    c.paramDefs.find((p) => p.name === 'BRANCH')?.description ??
    '本模块分支（本地缓存下拉；刷新：Job wealth-refresh-branches）',
)
</script>

<template>
  <div class="branch-picker">
    <FieldLabel label="分支" param="BRANCH" :tip="tip" />
    <div class="row">
      <div class="select-wrap">
        <el-select
          :model-value="c.branch"
          filterable
          placeholder="选择分支"
          :loading="c.branchesLoading"
          :class="{ auto: c.branchAuto }"
          class="select"
          @update:model-value="(v: string) => c.setBranch(v, false)"
        >
          <el-option v-for="b in c.branches" :key="b" :label="b" :value="b" />
        </el-select>
        <span v-if="c.branchAuto" class="auto-badge">
          <el-icon><MagicStick /></el-icon>自动识别
        </span>
      </div>

      <div class="quick">
        <button
          v-for="b in quick"
          :key="b"
          type="button"
          class="chip-btn"
          :class="{ on: c.branch === b }"
          @click="c.setBranch(b, false)"
        >
          {{ b }}
        </button>
        <el-button :loading="c.refreshing" :disabled="c.refreshing" @click="c.refreshBranches()">
          <el-icon v-if="!c.refreshing"><Refresh /></el-icon>
          {{ c.refreshing ? '刷新中…' : '刷新分支' }}
        </el-button>
      </div>
    </div>

    <p v-if="c.branchesError" class="err">
      <el-icon><WarningFilled /></el-icon>
      {{ c.branchesError }}
      <a href="javascript:void(0)" @click="c.loadBranches()">重试</a>
    </p>
    <p v-else-if="c.source === 'local-mount'" class="hint warn">
      SOURCE=local-mount 不会切换分支，实际使用 /gitee 挂载仓当前工作区。
    </p>
    <p v-else-if="c.branchesNotice" class="hint warn">
      <el-icon><WarningFilled /></el-icon>{{ c.branchesNotice }}
    </p>
    <p v-else class="hint">
      {{ c.branches.length }} 个分支来自{{ c.branchesSource === 'meta' ? ' meta.json 缓存' : ' Job 的 BRANCH 选项' }}（{{ c.current.repo }}）；远端有新分支时点「刷新分支」。
    </p>
  </div>
</template>

<style scoped>
.row {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  align-items: center;
}
.select-wrap {
  position: relative;
  flex: 1 1 260px;
  min-width: 220px;
  max-width: 420px;
}
.select {
  width: 100%;
}
.select.auto :deep(.el-select__wrapper) {
  box-shadow: 0 0 0 1px var(--wc-accent) inset;
  background: rgba(61, 156, 240, 0.08);
}
.auto-badge {
  position: absolute;
  right: 38px;
  top: 50%;
  transform: translateY(-50%);
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 8px;
  border-radius: var(--wc-radius-pill);
  background: var(--wc-card-active);
  color: var(--wc-accent);
  font-size: 11px;
  font-weight: 600;
  pointer-events: none;
}
.quick {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.chip-btn {
  border: 1px solid var(--wc-line);
  background: var(--wc-card);
  color: var(--wc-muted);
  border-radius: var(--wc-radius-pill);
  padding: 6px 14px;
  font: inherit;
  font-size: 13px;
  cursor: pointer;
  transition: all 0.15s;
}
.chip-btn:hover {
  color: var(--wc-text);
  border-color: var(--wc-accent);
}
.chip-btn.on {
  color: var(--wc-text);
  border-color: var(--wc-accent);
  background: var(--wc-card-active);
}
.err {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 8px 0 0;
  font-size: 12px;
  color: var(--wc-bad);
}
.hint.warn {
  color: var(--wc-warn);
}
</style>
