<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import { api, ApiError, type BuildParams } from '@/api'
import { useConsole, type ActiveBuild } from '@/composables/useConsole'
import { splitLogLine } from '@/utils/logline'
import { clockTime, formatDuration } from '@/utils/format'

const c = useConsole()
const archive = ref<ActiveBuild | null>(null)
let archiveAbort: AbortController | null = null

const a = computed(() => (c.logView?.live ? c.active : archive.value))
const st = computed(() => a.value?.status ?? null)
const shownSha = computed(() => a.value?.params.GIT_SHA || c.logView?.sha || '')

const collapsed = ref(false)
const paused = ref(false)
const logEl = ref<HTMLElement | null>(null)

const stateText = computed(() => {
  switch (st.value?.state) {
    case 'queued':
      return '排队中'
    case 'running':
      return '构建中'
    case 'success':
      return '成功'
    case 'failure':
      return '失败'
    case 'aborted':
      return '已中止'
    default:
      return '提交中…'
  }
})
const stateKind = computed(() => {
  const s = st.value?.state
  return s === 'success' ? 'ok' : s === 'failure' || s === 'aborted' ? 'bad' : 'run'
})
const finished = computed(() => ['success', 'failure', 'aborted'].includes(st.value?.state ?? ''))
const shownLines = computed(() =>
  (a.value?.lines ?? []).map((raw, i) => ({ i, ...splitLogLine(raw) })).filter((row) => row.text || row.time),
)
const barStatus = computed(() => (st.value?.state === 'success' ? 'success' : st.value?.state === 'failure' ? 'exception' : undefined))
const barColor = computed(() => (st.value?.state === 'aborted' ? 'var(--wc-warn)' : ''))

function lineClass(l: string): string {
  if (l.includes('==> ')) return 'step'
  if (/\[ERROR\]|\bERROR\b|error TS|Finished: FAILURE|ELIFECYCLE/.test(l)) return 'err'
  if (/Finished: SUCCESS|BUILD SUCCESS|successfully rolled out/.test(l)) return 'okl'
  if (/Aborted|ABORTED|WARN/.test(l)) return 'warnl'
  return ''
}

watch(
  () => a.value?.lines.length,
  async () => {
    if (paused.value || collapsed.value) return
    await nextTick()
    const el = logEl.value
    if (el) el.scrollTop = el.scrollHeight
  },
)
watch(paused, async (p) => {
  if (!p) {
    await nextTick()
    if (logEl.value) logEl.value.scrollTop = logEl.value.scrollHeight
  }
})
watch(
  () => a.value?.queueId,
  () => {
    collapsed.value = false
    paused.value = false
  },
)

const consoleUrl = computed(() => (a.value?.buildNumber ? api.consoleUrl(a.value.job, a.value.buildNumber) : '#'))
const nativeUrl = computed(() => (a.value?.buildNumber ? `/job/${a.value.job}/${a.value.buildNumber}/console` : '#'))

const BLANK_PARAMS: BuildParams = {
  MODE: 'build-deploy',
  OVERLAY: 'dev',
  SOURCE: 'github',
  IMAGE_TAG: 'auto',
  REGISTRY: '',
  BRANCH: '',
  GIT_SHA: '',
  SKIP_MVN: false,
  ONLY_CURRENT_MODULE: true,
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException('aborted', 'AbortError'))
      return
    }
    const t = setTimeout(resolve, ms)
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(t)
        reject(new DOMException('aborted', 'AbortError'))
      },
      { once: true },
    )
  })
}

/** 历史构建：不打扰正在轮询的 active，按构建号单独拉进度和日志 */
async function loadArchive(): Promise<void> {
  archiveAbort?.abort()
  archive.value = null
  const view = c.logView
  if (!c.logOpen || !view || view.live || !view.buildNumber) return
  const ctrl = new AbortController()
  archiveAbort = ctrl
  const signal = ctrl.signal
  const snap: ActiveBuild = {
    job: view.job,
    title: view.title,
    queueId: view.queueId,
    buildNumber: view.buildNumber,
    status: null,
    lines: [],
    logNext: 0,
    error: '',
    params: { ...BLANK_PARAMS },
  }
  archive.value = snap
  const row = archive.value
  if (!row) return
  let more = true
  try {
    while (!signal.aborted) {
      if (more && row.buildNumber) {
        const chunk = await api.getBuildLog(view.job, row.buildNumber, row.logNext, signal)
        if (signal.aborted) return
        if (chunk.lines.length) row.lines.push(...chunk.lines)
        if (row.lines.length > 4000) row.lines.splice(0, row.lines.length - 4000)
        row.logNext = chunk.next
        more = chunk.more
      }
      const status = await api.getBuildStatus(view.job, view.queueId || 0, row.buildNumber, signal)
      if (signal.aborted) return
      row.status = status
      row.params = status.params
      row.error = ''
      const done = (status.state === 'success' || status.state === 'failure' || status.state === 'aborted') && !more
      if (done) break
      await sleep(1000, signal)
    }
  } catch (e) {
    if (signal.aborted || (e instanceof DOMException && e.name === 'AbortError')) return
    if (e instanceof ApiError && e.kind === 'aborted') return
    if (archive.value) archive.value.error = e instanceof Error ? e.message : String(e)
  }
}

watch(
  () => [c.logOpen, c.logView?.live, c.logView?.job, c.logView?.buildNumber] as const,
  () => void loadArchive(),
  { immediate: true },
)
onBeforeUnmount(() => archiveAbort?.abort())

async function onStop(): Promise<void> {
  if (c.logView?.live) {
    await c.stopActive()
    return
  }
  const n = archive.value?.buildNumber
  const job = c.logView?.job
  if (!n || !job) return
  try {
    await api.stopBuild(job, n)
    ElMessage.warning(`已请求中止 #${n}`)
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : String(e))
  }
}
</script>

<template>
  <el-dialog
    :model-value="c.logOpen"
    title="构建进度与日志"
    width="880px"
    align-center
    append-to-body
    class="build-log-dialog"
    @update:model-value="(v: boolean) => (c.logOpen = v)"
  >
    <div class="console">
    <div v-if="!a" class="empty">
      <el-icon class="big spin"><Loading /></el-icon>
      <p><strong>正在读取构建进度与日志…</strong></p>
    </div>

    <template v-else>
      <div class="title">
        <span class="state" :class="stateKind"><i />{{ stateText }}</span>
        <strong>#{{ a.buildNumber ?? '—' }} {{ a.title }}</strong>
      </div>
      <div class="sub muted">
        <code>{{ st?.mode === 'rollback' ? '回滚' : '构建' }}</code>
        <span v-if="st?.imageTag"> · <code>{{ st.imageTag }}</code></span>
        <span v-else-if="st?.branch"> · {{ st.branch }}</span>
        <span v-if="shownSha"> · GIT_SHA <code class="sha">{{ shownSha }}</code></span>
        · {{ a.params.OVERLAY }}
      </div>

      <div class="progress">
        <el-progress
          :percentage="st?.progress ?? 0"
          :status="barStatus"
          :color="barColor || undefined"
          :stroke-width="10"
          :striped="st?.state === 'running'"
          :striped-flow="st?.state === 'running'"
          :duration="14"
        />
        <div class="eta muted">
          <span>{{ st ? formatDuration(st.durationMs) : '—' }}</span>
          <span v-if="st && !finished && st.state === 'running'">预计剩余 {{ st.etaSec }}s</span>
          <span v-else-if="st?.state === 'queued'">等待执行器…</span>
        </div>
      </div>

      <div v-if="st?.stageModule" class="stage-module muted">
        当前模块 <code>{{ st.stageModule }}</code>
      </div>
      <ol class="stages">
        <li v-for="s in st?.stages ?? []" :key="s.key" :class="s.state">
          <span class="ico">
            <el-icon v-if="s.state === 'done'"><Check /></el-icon>
            <el-icon v-else-if="s.state === 'failed'"><Close /></el-icon>
            <el-icon v-else-if="s.state === 'running'" class="spin"><Loading /></el-icon>
            <el-icon v-else-if="s.state === 'skipped'"><Minus /></el-icon>
            <i v-else />
          </span>
          <span class="lbl">{{ s.label }}<em v-if="s.state === 'skipped'" class="sk">已跳过</em></span>
          <span v-if="s.durationMs != null" class="when">
            <time v-if="s.startedAt">{{ clockTime(s.startedAt) }}</time>
            {{ formatDuration(s.durationMs) }}
          </span>
        </li>
      </ol>

      <div v-if="st?.state === 'success'" class="banner ok">
        <el-icon><SuccessFilled /></el-icon>
        <div>
          <strong>{{ st.mode === 'rollback' ? '回滚成功' : '部署成功' }}</strong>
          <div class="small">IMAGE_TAG=<code>{{ st.imageTag }}</code></div>
        </div>
      </div>
      <div v-else-if="st?.state === 'failure' || st?.state === 'aborted'" class="banner bad">
        <el-icon><CircleCloseFilled /></el-icon>
        <div class="grow">
          <strong>{{ st.state === 'aborted' ? '构建已中止' : '构建失败' }}</strong>
          <div class="small">查看下方日志末尾，或打开 Jenkins 控制台输出。</div>
        </div>
        <el-button v-if="c.logView?.live" size="small" type="primary" @click="c.retry()">重试</el-button>
      </div>

      <div v-if="a.error" class="poll-err"><el-icon><WarningFilled /></el-icon>{{ a.error }}（将自动重试）</div>

      <div class="log-head">
        <button type="button" class="toggle" @click="collapsed = !collapsed">
          <el-icon class="chev" :class="{ open: !collapsed }"><ArrowRight /></el-icon>
          实时日志 <span class="muted">{{ a.lines.length }} 行</span>
        </button>
        <span class="spacer" />
        <button type="button" class="mini" :class="{ on: paused }" @click="paused = !paused">
          <el-icon><component :is="paused ? 'VideoPlay' : 'VideoPause'" /></el-icon>{{ paused ? '继续滚动' : '暂停滚动' }}
        </button>
        <a class="mini" :href="consoleUrl" target="_blank" rel="noopener noreferrer"><el-icon><Download /></el-icon>下载</a>
      </div>

      <div v-show="!collapsed" ref="logEl" class="log" tabindex="0" aria-label="构建日志" role="log">
        <div v-if="!shownLines.length" class="line muted">等待日志…</div>
        <div v-for="row in shownLines" :key="row.i" class="line" :class="lineClass(row.text)">
          <time v-if="row.time" class="ts">{{ row.time }}</time>{{ row.text }}
        </div>
        <div v-if="st?.state === 'running'" class="cursor">▌</div>
      </div>

      <footer class="foot">
        <el-button v-if="!finished" size="small" type="danger" plain :disabled="!a.buildNumber && !a.queueId" @click="onStop()">
          <el-icon><SwitchButton /></el-icon>中止构建
        </el-button>
        <a class="native" :href="nativeUrl" target="_blank" rel="noopener noreferrer">在 Jenkins 打开 ↗</a>
      </footer>
    </template>
    </div>
  </el-dialog>
</template>

<style scoped>
.console {
  display: flex;
  flex-direction: column;
  gap: 14px;
  min-height: 0;
}
.empty {
  text-align: center;
  padding: 36px 8px;
  color: var(--wc-muted);
  font-size: 13px;
  line-height: 1.7;
}
.empty p {
  margin: 4px 0;
}
.empty strong {
  color: var(--wc-text);
}
.big {
  font-size: 40px;
  color: var(--wc-line);
}
.title {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  font-size: 15px;
}
.sub {
  margin-top: -8px;
  font-size: 12px;
}
.sub code {
  color: var(--wc-text);
}
.sub code.sha {
  word-break: break-all;
}
.state {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  font-weight: 600;
  padding: 3px 10px;
  border-radius: var(--wc-radius-pill);
}
.state i {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: currentColor;
}
.state.run {
  background: var(--wc-warn-bg);
  color: var(--wc-warn);
}
.state.run i {
  animation: wc-pulse 1.4s ease-out infinite;
}
.state.ok {
  background: var(--wc-ok-bg);
  color: var(--wc-ok);
}
.state.bad {
  background: var(--wc-bad-bg);
  color: var(--wc-bad);
}
.eta {
  display: flex;
  justify-content: space-between;
  font-size: 12px;
  margin-top: 2px;
  font-family: var(--wc-font-mono);
}
.progress :deep(.el-progress__text) {
  color: var(--wc-text);
  font-weight: 600;
}
.progress :deep(.el-progress-bar__inner) {
  background-color: var(--wc-warn);
}
.progress :deep(.el-progress.is-success .el-progress-bar__inner) {
  background-color: var(--wc-ok);
}
.progress :deep(.el-progress.is-exception .el-progress-bar__inner) {
  background-color: var(--wc-bad);
}

.stages {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 6px;
}
.stages li {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  padding: 10px 4px;
  border: 1px solid var(--wc-line);
  border-radius: var(--wc-radius-md);
  background: var(--wc-bg);
  font-size: 12px;
  color: var(--wc-muted);
}
.ico {
  width: 22px;
  height: 22px;
  display: grid;
  place-items: center;
  border-radius: 50%;
  border: 1.5px solid var(--wc-line);
  font-size: 13px;
}
.ico i {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--wc-line);
}
.stages li.done {
  color: var(--wc-text);
}
.stages li.done .ico {
  background: var(--wc-ok-bg);
  border-color: var(--wc-ok);
  color: var(--wc-ok);
}
.stages li.running {
  color: var(--wc-text);
  border-color: var(--wc-warn);
  background: var(--wc-warn-bg);
}
.stages li.running .ico {
  border-color: var(--wc-warn);
  color: var(--wc-warn);
}
.stages li.failed {
  border-color: var(--wc-bad);
  background: var(--wc-bad-bg);
  color: var(--wc-text);
}
.stages li.failed .ico {
  border-color: var(--wc-bad);
  color: var(--wc-bad);
}
.stages li.skipped {
  opacity: 0.55;
}
.spin {
  animation: spin 0.9s linear infinite;
}
@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}

.banner {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 10px 12px;
  border-radius: var(--wc-radius-md);
  font-size: 13px;
}
.banner .el-icon {
  font-size: 20px;
  margin-top: 1px;
}
.banner .grow {
  flex: 1;
}
.banner .small {
  font-size: 12px;
  color: var(--wc-muted);
  margin-top: 2px;
}
.banner.ok {
  background: var(--wc-ok-bg);
  color: var(--wc-ok);
}
.banner.bad {
  background: var(--wc-bad-bg);
  color: var(--wc-bad);
}
.banner code {
  color: var(--wc-text);
}
.poll-err {
  display: flex;
  gap: 6px;
  align-items: center;
  font-size: 12px;
  color: var(--wc-warn);
}

.log-head {
  display: flex;
  align-items: center;
  gap: 8px;
}
.spacer {
  flex: 1;
}
.toggle {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  background: none;
  border: 0;
  color: var(--wc-text);
  font: inherit;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  padding: 0;
}
.toggle .muted {
  font-weight: 400;
  font-size: 12px;
}
.chev {
  transition: transform 0.2s;
}
.chev.open {
  transform: rotate(90deg);
}
.mini {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  background: transparent;
  border: 1px solid var(--wc-line);
  color: var(--wc-muted);
  border-radius: var(--wc-radius-pill);
  padding: 3px 10px;
  font: inherit;
  font-size: 12px;
  cursor: pointer;
}
.mini:hover {
  color: var(--wc-text);
  border-color: var(--wc-accent);
  text-decoration: none;
}
.mini.on {
  color: var(--wc-accent);
  border-color: var(--wc-accent);
}
.log {
  flex: 1 1 220px;
  min-height: 180px;
  max-height: 360px;
  overflow: auto;
  padding: 10px 12px;
  background: #090e14;
  border: 1px solid var(--wc-line);
  border-radius: var(--wc-radius-md);
  font-family: var(--wc-font-mono);
  font-size: 12px;
  line-height: 1.65;
  color: #b8c7d8;
}
.line {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.ts {
  display: inline-block;
  min-width: 8.2em;
  margin-right: 8px;
  color: var(--wc-muted);
  font-variant-numeric: tabular-nums;
}
.line.step {
  color: var(--wc-accent);
  font-weight: 600;
}
.line.err {
  color: var(--wc-bad);
}
.line.okl {
  color: var(--wc-ok);
}
.line.warnl {
  color: var(--wc-warn);
}
.cursor {
  color: var(--wc-warn);
  animation: wc-blink 1s steps(2) infinite;
}
.foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.native {
  font-size: 12px;
  margin-left: auto;
}

.stage-module {
  margin: 0 0 6px;
  font-size: 12px;
}
.lbl .sk {
  display: block;
  font-style: normal;
  font-size: 11px;
  color: var(--wc-muted);
}
.when {
  font-family: var(--wc-font-mono);
  font-size: 11px;
  line-height: 1.35;
  color: var(--wc-muted);
  text-align: center;
}
.when time {
  display: block;
  font-variant-numeric: tabular-nums;
}
</style>
