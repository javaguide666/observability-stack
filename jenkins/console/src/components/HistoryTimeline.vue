<script setup lang="ts">
import { ref } from 'vue'
import { ElMessage } from 'element-plus'
import { api, ApiError, HISTORY_LIMIT, SHA_RE, type HistoryItem } from '@/api'
import { useConsole } from '@/composables/useConsole'
import { copyText } from '@/utils/clipboard'
import { fullTime } from '@/utils/format'

const emit = defineEmits<{ rollback: [item: HistoryItem] }>()
const c = useConsole()
const refreshing = ref<number | null>(null)

/** 只展示构建时保存的结果，去掉和「分支」重复的名字 */
function relatedText(h: HistoryItem): string {
  const extras = (h.related ?? []).filter((b) => b !== h.branch)
  return extras.length ? extras.join(', ') : '—'
}

async function refreshRelated(h: HistoryItem): Promise<void> {
  if (!SHA_RE.test(h.sha) || refreshing.value !== null) return
  refreshing.value = h.number
  try {
    const r = await api.resolveCommit(c.current.repo, h.sha.toLowerCase())
    const extras = (r.status === 'ok' ? r.candidates : []).filter((b) => b !== h.branch)
    await api.saveRelatedBranches(c.current.job, h.number, extras)
    h.related = extras
    ElMessage.success({ message: extras.length ? `已保存关联分支：${extras.join(', ')}` : '已保存：没有其它关联分支', duration: 1800 })
  } catch (e) {
    ElMessage.error(e instanceof ApiError ? e.message : '保存关联分支失败')
  } finally {
    refreshing.value = null
  }
}

async function copy(sha: string) {
  const ok = await copyText(sha)
  if (ok) ElMessage.success({ message: `已复制完整 SHA：${sha}`, duration: 1800 })
  else ElMessage.error('复制失败，请手动选择')
}

async function copyTag(t: string) {
  const ok = await copyText(t)
  if (ok) ElMessage.success({ message: `已复制 tag：${t}`, duration: 1800 })
  else ElMessage.error('复制失败，请手动选择')
}

function usable(h: HistoryItem): boolean {
  return h.result === 'SUCCESS' && !h.building && !!h.imageTag
}
function statusText(h: HistoryItem): string {
  if (h.building) return '构建中'
  return h.result === 'SUCCESS' ? '成功' : h.result === 'FAILURE' ? '失败' : h.result === 'ABORTED' ? '已中止' : '—'
}
function statusClass(h: HistoryItem): string {
  if (h.building) return 'building'
  return h.result === 'SUCCESS' ? 'ok' : h.result === 'FAILURE' || h.result === 'ABORTED' ? 'bad' : 'idle'
}
</script>

<template>
  <div class="history">
    <div class="head">
      <h3>历史版本<span class="muted">（最近 {{ HISTORY_LIMIT }} 个 · {{ c.current.title }}）</span></h3>
      <el-button size="small" text :loading="c.historyLoading" @click="c.loadHistory()">
        <el-icon v-if="!c.historyLoading"><Refresh /></el-icon>刷新
      </el-button>
    </div>

    <p v-if="c.current.supportsRollback" class="infer-note muted">
      「运行中」是推断：{{ c.overlay }} 环境最近一次成功构建的版本（手工 kubectl 修改不会反映）。
    </p>

    <p v-if="c.current.supportsRollback && c.extraTags.length" class="infer-note muted" data-testid="extra-tags">
      meta.json 里另有可选 tag（不在最近构建历史中，无分支/SHA 信息，点击复制）：
      <button v-for="t in c.extraTags" :key="t" type="button" class="tag-chip" @click="copyTag(t)">{{ t }}</button>
    </p>

    <el-alert
      v-if="!c.current.supportsRollback"
      type="info"
      :closable="false"
      show-icon
      title="全量 Job 不支持历史回放"
      description="三个仓库的 SHA 各不相同，请切换到单个模块再启动历史版本。"
    />

    <p v-else-if="c.historyError" class="err">
      <el-icon><WarningFilled /></el-icon>{{ c.historyError }}
      <a href="javascript:void(0)" @click="c.loadHistory()">重试</a>
    </p>

    <ol v-else-if="c.historyLoading && !c.history.length" class="rows">
      <li v-for="n in 4" :key="n" class="card skeleton"><el-skeleton animated :rows="3" /></li>
    </ol>

    <el-empty v-else-if="!c.history.length" description="还没有构建记录，先构建一次吧" :image-size="64" />

    <ol v-else class="rows">
      <li v-for="h in c.history" :key="h.number" class="card" :class="[statusClass(h), { running: h.running, dim: !usable(h) }]">
        <div class="body">
          <div class="top">
            <code class="tag" :title="h.imageTag">{{ h.imageTag || '（无 tag）' }}</code>
            <span class="when">构建 #{{ h.number }} · {{ fullTime(h.timestamp) }}</span>
            <span v-if="h.running" class="pill run" title="推断：该环境最近一次成功构建的版本；手工 kubectl 变更不会反映"><i />运行中（推断）</span>
            <span v-else class="pill" :class="statusClass(h)">{{ statusText(h) }}</span>
          </div>

          <div class="sha-line">
            <span class="k">GIT_SHA</span>
            <template v-if="h.sha">
              <code>{{ h.sha }}</code>
              <el-tooltip content="复制完整 GIT_SHA" placement="top">
                <button class="copy" type="button" aria-label="复制完整 GIT_SHA" @click="copy(h.sha)">
                  <el-icon><CopyDocument /></el-icon>
                </button>
              </el-tooltip>
            </template>
            <span v-else class="muted no-sha" title="旧镜像 / 描述缺少完整 GIT_SHA：不能用于代码对比，但仍可回滚">无 SHA</span>
          </div>

          <div class="meta">
            <div>
              <span class="k">分支</span>
              <span class="mono">{{ h.branch || '—' }}</span>
            </div>
            <div class="related">
              <span class="k">关联分支</span>
              <span class="mono" :title="relatedText(h)">{{ relatedText(h) }}</span>
              <el-tooltip content="按完整 GIT_SHA 重新查询并保存" placement="top">
                <span class="tip">
                  <button
                    class="copy"
                    type="button"
                    aria-label="刷新关联分支"
                    :disabled="!h.sha || refreshing !== null"
                    @click="refreshRelated(h)"
                  >
                    <el-icon :class="{ spin: refreshing === h.number }"><Refresh /></el-icon>
                  </button>
                </span>
              </el-tooltip>
            </div>
          </div>
        </div>

        <div class="actions">
          <el-button size="small" class="act" @click="c.openHistoryLog(h)">构建进度与日志</el-button>
          <el-button v-if="h.running" size="small" disabled class="act">当前版本</el-button>
          <el-button v-else-if="usable(h)" size="small" type="primary" class="act" :disabled="c.isBuilding" @click="emit('rollback', h)">
            <el-icon><VideoPlay /></el-icon>启动此版本
          </el-button>
          <el-button v-else size="small" disabled class="act">{{ h.building ? '构建中' : '无镜像，不可回放' }}</el-button>
        </div>
      </li>
    </ol>
  </div>
</template>

<style scoped>
.head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 12px;
}
.head h3 {
  margin: 0;
  font-size: 15px;
  font-weight: 600;
}
.head h3 .muted {
  font-size: 12px;
  font-weight: 400;
  margin-left: 6px;
}
.rows {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.card {
  position: relative;
  padding: 14px 16px;
  border: 1px solid var(--wc-line);
  border-radius: var(--wc-radius-md);
  background: var(--wc-bg);
  display: flex;
  align-items: center;
  gap: 16px;
  transition: border-color 0.15s;
}
.body {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.sha-line {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  font-size: 12px;
}
.sha-line .k {
  flex: none;
  color: var(--wc-muted);
}
.sha-line code {
  font-family: var(--wc-font-mono);
  font-size: 12px;
  word-break: break-all;
}
.actions {
  flex: none;
  display: flex;
  flex-direction: column;
  gap: 8px;
  width: 148px;
}
.card:hover {
  border-color: #3c5069;
}
.card.running {
  border-color: var(--wc-ok);
  background: linear-gradient(180deg, rgba(61, 214, 140, 0.07), var(--wc-bg) 60%);
}
.card.dim {
  opacity: 0.62;
}
.card.skeleton {
  min-height: 120px;
}
.top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.tag {
  flex: none;
  max-width: 42%;
  font-family: var(--wc-font-mono);
  font-size: 13px;
  font-weight: 600;
  color: var(--wc-text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.when {
  flex: 1;
  min-width: 0;
  font-family: var(--wc-font-mono);
  font-size: 12px;
  color: var(--wc-muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  margin-left: 30px;
}
.pill {
  flex: none;
  font-size: 11px;
  padding: 2px 9px;
  border-radius: var(--wc-radius-pill);
  background: var(--wc-chip-bg);
  color: var(--wc-muted);
}
.pill.ok {
  background: var(--wc-ok-bg);
  color: var(--wc-ok);
}
.pill.bad {
  background: var(--wc-bad-bg);
  color: var(--wc-bad);
}
.pill.building {
  background: var(--wc-warn-bg);
  color: var(--wc-warn);
}
.pill.run {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  background: var(--wc-ok);
  color: #06210f;
  font-weight: 700;
}
.pill.run i {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: #06210f;
  animation: wc-blink 1.4s steps(2) infinite;
}
.meta {
  display: flex;
  flex-wrap: wrap;
  gap: 6px 20px;
  font-size: 12px;
}
.meta > div {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.meta .k {
  flex: none;
  color: var(--wc-muted);
}
.meta .mono {
  font-family: var(--wc-font-mono);
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.meta .related {
  margin-left: auto;
}
.copy:disabled {
  cursor: default;
  opacity: 0.4;
}
.spin {
  animation: wc-spin 0.8s linear infinite;
}
@keyframes wc-spin {
  to {
    transform: rotate(360deg);
  }
}
@media (max-width: 720px) {
  .card {
    flex-direction: column;
    align-items: stretch;
  }
  .actions {
    width: auto;
    flex-direction: row;
  }
}
.meta code {
  font-family: var(--wc-font-mono);
}
.copy {
  display: inline-grid;
  place-items: center;
  border: 0;
  background: transparent;
  color: var(--wc-muted);
  padding: 2px;
  border-radius: 4px;
  cursor: pointer;
}
.copy:hover {
  color: var(--wc-accent);
  background: var(--wc-chip-bg);
}
.act {
  width: 100%;
  margin: 0;
}
.err {
  display: flex;
  align-items: center;
  gap: 6px;
  color: var(--wc-bad);
  font-size: 13px;
}

.tag-chip {
  margin: 0 4px 2px 0;
  padding: 1px 8px;
  font: inherit;
  font-family: var(--wc-mono, monospace);
  font-size: 12px;
  color: var(--wc-text);
  background: var(--wc-chip-bg);
  border: 1px solid var(--wc-line);
  border-radius: var(--wc-radius-pill);
  cursor: pointer;
}
.tag-chip:hover {
  border-color: var(--wc-accent);
}
</style>
