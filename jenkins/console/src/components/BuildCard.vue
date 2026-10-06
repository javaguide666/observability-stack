<script setup lang="ts">
import { computed, ref } from 'vue'
import { ElMessage } from 'element-plus'
import type { HistoryItem } from '@/api'
import { useConsole, type Flow } from '@/composables/useConsole'
import BranchPicker from './BranchPicker.vue'
import CommitResolver from './CommitResolver.vue'
import HistoryTimeline from './HistoryTimeline.vue'
import ParamFields from './ParamFields.vue'
import ConfirmBuildDialog from './ConfirmBuildDialog.vue'
import RollbackDialog from './RollbackDialog.vue'
import StatusDot from './StatusDot.vue'

const c = useConsole()

const flowOptions = computed(() => [
  { label: '选分支构建', value: 'branch' },
  { label: '指定完整 GIT_SHA', value: 'commit', disabled: !c.current.supportsCommit },
  { label: '历史版本', value: 'history', disabled: !c.current.supportsRollback },
])
const isProd = computed(() => c.overlay === 'prod')
const submitLabel = computed(() => (isProd.value ? '开始构建部署（PROD）' : '开始构建部署'))

const confirmOpen = ref(false)
function askBuild() {
  if (c.submitBlock || c.isBuilding || c.submitting) return
  confirmOpen.value = true
}
async function confirmBuild() {
  const ok = await c.submitBuild()
  if (ok) {
    confirmOpen.value = false
    ElMessage.success({ message: '已提交到 Jenkins', duration: 2000 })
  }
}

/* 回滚确认 */
const dialogOpen = ref(false)
const target = ref<HistoryItem | null>(null)
function askRollback(item: HistoryItem) {
  target.value = item
  dialogOpen.value = true
}
async function confirmRollback() {
  if (!target.value) return
  const ok = await c.startRollback(target.value)
  if (ok) {
    dialogOpen.value = false
    ElMessage.success({ message: `已触发回滚 ${target.value.imageTag}`, duration: 2000 })
  }
}
</script>

<template>
  <section class="wc-card build-card">
    <header class="head">
      <div class="title-row">
        <StatusDot :result="c.current.lastResult" :building="c.current.lastBuilding" :size="12" />
        <h2>{{ c.current.title }}</h2>
        <code class="job">{{ c.current.job }}</code>
      </div>
      <div class="chips">
        <span class="chip">仓库 {{ c.current.repo }}</span>
        <span v-if="c.current.lastBuildNumber" class="chip">最近 #{{ c.current.lastBuildNumber }}</span>
      </div>
    </header>

    <!-- MODE 页签 -->
    <div class="mode-tabs" role="tablist" aria-label="MODE">
      <button
        type="button"
        role="tab"
        class="tab"
        :class="{ active: c.mode === 'build-deploy' }"
        :aria-selected="c.mode === 'build-deploy'"
        @click="c.setMode('build-deploy')"
      >
        <el-icon><Upload /></el-icon>构建部署
      </button>
      <button
        type="button"
        role="tab"
        class="tab"
        :class="{ active: c.mode === 'rollback' }"
        :aria-selected="c.mode === 'rollback'"
        :disabled="!c.current.supportsRollback"
        @click="c.setMode('rollback')"
      >
        <el-icon><RefreshLeft /></el-icon>回滚
      </button>
      <code class="mode-code">MODE={{ c.mode }}</code>
    </div>

    <div class="flow">
      <el-segmented
        :model-value="c.flow"
        :options="flowOptions"
        size="large"
        block
        @update:model-value="(v: string | number | boolean) => c.setFlow(v as Flow)"
      />
    </div>

    <el-alert
      v-if="!c.current.supportsCommit"
      class="all-hint"
      type="info"
      :closable="false"
      show-icon
      title="全量 7 模块：不开放 GIT_SHA 与历史回放"
      description="三个仓库的 SHA 不同，同一个 SHA 套给三个仓库没有意义。需要指定 GIT_SHA 或回滚时，请切换到单个模块。"
    />

    <!-- 构建部署：分支 / GIT_SHA -->
    <template v-if="c.flow !== 'history'">
      <div class="block">
        <BranchPicker v-if="c.flow === 'branch'" />
        <CommitResolver v-else />
      </div>
      <ParamFields show-source show-skip />
      <div class="submit-row">
        <el-button
          :type="isProd ? 'danger' : 'primary'"
          size="large"
          class="submit"
          :loading="c.submitting"
          :disabled="!!c.submitBlock || c.isBuilding"
          @click="askBuild"
        >
          <el-icon v-if="!c.submitting"><CaretRight /></el-icon>{{ submitLabel }}
        </el-button>
        <span v-if="c.isBuilding" class="status muted">
          构建进行中
          <button type="button" class="text-btn" @click="c.openActiveLog()">查看构建进度与日志</button>
        </span>
        <span v-else-if="c.submitting && c.flow === 'commit'" class="status muted">正在更新代码并核对 GIT_SHA…</span>
        <span v-else-if="c.submitBlock" class="status muted">{{ c.submitBlock }}</span>
        <span v-else-if="c.flow === 'commit'" class="status ok">
          将按 GIT_SHA <code class="sha">{{ c.sha }}</code> 构建并部署到 {{ c.overlay }}
        </span>
        <span v-else class="status ok">
          将构建 <code>{{ c.branch }}</code> → {{ c.overlay }}
        </span>
      </div>
    </template>

    <!-- 回滚：历史版本 -->
    <template v-else>
      <ParamFields />
      <div class="block history-block">
        <HistoryTimeline @rollback="askRollback" />
      </div>
    </template>

    <ConfirmBuildDialog v-model="confirmOpen" :busy="c.submitting" @confirm="confirmBuild" />
    <RollbackDialog v-model="dialogOpen" :item="target" :busy="c.submitting" @confirm="confirmRollback" />
  </section>
</template>

<style scoped>
.build-card {
  padding: 22px 24px 24px;
}
.head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 10px 16px;
  margin-bottom: 18px;
}
.title-row {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}
.title-row h2 {
  margin: 0;
  font-size: 20px;
  font-weight: 600;
}
.job {
  color: var(--wc-muted);
}
.chips {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.chip {
  font-size: 12px;
  padding: 4px 10px;
  border-radius: var(--wc-radius-pill);
  background: var(--wc-chip-bg);
  color: var(--wc-muted);
}
.chip.link {
  color: var(--wc-accent);
}
.chip.link:hover {
  text-decoration: none;
  background: var(--wc-card-active);
}

.mode-tabs {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 16px;
}
.tab {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  background: var(--wc-card);
  color: var(--wc-muted);
  border: 1px solid var(--wc-line);
  border-radius: var(--wc-radius-pill);
  padding: 8px 18px;
  font: inherit;
  cursor: pointer;
  transition: all 0.15s;
}
.tab:hover:not(:disabled) {
  color: var(--wc-text);
}
.tab.active {
  color: var(--wc-text);
  border-color: var(--wc-accent);
  background: var(--wc-card-active);
}
.tab:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
.mode-code {
  margin-left: auto;
  color: var(--wc-muted);
}
.flow {
  margin-bottom: 18px;
}
.all-hint {
  margin-bottom: 18px;
}
.block {
  padding: 18px;
  border: 1px solid var(--wc-line);
  border-radius: var(--wc-radius-md);
  background: var(--wc-bg-elev);
}
.history-block {
  margin-top: 20px;
}
.submit-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 14px;
  margin-top: 24px;
}
.submit {
  min-width: 220px;
}
.status {
  font-size: 13px;
}
.status.ok {
  color: var(--wc-ok);
}
.status code {
  color: inherit;
}
.status code.sha {
  word-break: break-all;
}
.text-btn {
  margin-left: 6px;
  padding: 0;
  border: 0;
  background: none;
  color: var(--wc-accent);
  font: inherit;
  cursor: pointer;
}
.text-btn:hover {
  text-decoration: underline;
}

@media (max-width: 640px) {
  .build-card {
    padding: 16px;
  }
  .mode-code {
    display: none;
  }
  .submit {
    width: 100%;
  }
}
</style>
