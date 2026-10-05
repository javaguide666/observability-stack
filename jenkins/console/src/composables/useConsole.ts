import { computed, reactive, ref, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import {
  api,
  ApiError,
  DEFAULT_BRANCH,
  HISTORY_LIMIT,
  MODULES,
  SHA_RE,
  USE_MOCK,
  type BuildParams,
  type BuildStatus,
  type HistoryItem,
  type JenkinsInfo,
  type JobSummary,
  type Mode,
  type Overlay,
  type ParamDef,
  type ResolveResult,
  type Source,
  type WhoAmI,
} from '@/api'
import { setAuthLostHandler } from '@/api/session'
import { sortCandidates } from '@/utils/branches'

export type Flow = 'branch' | 'commit' | 'history'
export type ResolvePhase = 'idle' | 'resolving' | 'done' | 'error'

export interface ActiveBuild {
  job: string
  title: string
  queueId: number
  buildNumber: number | null
  status: BuildStatus | null
  lines: string[]
  logNext: number
  error: string
  /** 用于「重试」：保存提交时的参数 */
  params: BuildParams
}

/* ───────────── 全局单例状态（原型规模不需要 Pinia） ───────────── */

const who = ref<WhoAmI | null>(null)
const info = ref<JenkinsInfo | null>(null)
const connection = ref<'checking' | 'online' | 'offline'>('checking')
/** 之前是登录状态、后来变匿名 = 会话过期 */
const sessionExpired = ref(false)

const jobs = ref<JobSummary[]>([])
const jobsLoading = ref(false)
const currentJob = ref('wealth-gateway')
const paramDefs = ref<ParamDef[]>([])

const flow = ref<Flow>('branch')
const lastBuildFlow = ref<'branch' | 'commit'>('branch')
const overlay = ref<Overlay>('dev')
const source = ref<Source>('github')
const registry = ref('')
const registryManualOpen = ref(false)
const skipMvn = ref(false)

const branches = ref<string[]>([])
const branchesLoading = ref(false)
const branchesError = ref('')
/** 分支来源 meta.json / Job choices / 兜底；兜底时附带「请先刷新分支」提示 */
const branchesSource = ref<'meta' | 'job' | 'default'>('job')
const branchesNotice = ref('')
const refreshing = ref(false)
const branch = ref(DEFAULT_BRANCH)
const branchAuto = ref(false)

const sha = ref('')
const resolvePhase = ref<ResolvePhase>('idle')
const resolveResult = ref<ResolveResult | null>(null)
const resolveError = ref('')
const resolveCandidates = ref<string[]>([])
let resolveSeq = 0

const history = ref<HistoryItem[]>([])
const historyLoading = ref(false)
const historyError = ref('')
const metaTags = ref<string[]>([])

const active = ref<ActiveBuild | null>(null)
const submitting = ref(false)

/** 构建进度与日志弹窗。live=跟随当前 active；否则按历史构建号单独拉取 */
export interface LogView {
  job: string
  title: string
  buildNumber: number | null
  queueId: number
  live: boolean
  sha: string
}
const logOpen = ref(false)
const logView = ref<LogView | null>(null)
let pollToken = 0
let pollAbort: AbortController | null = null
let pollTimer: ReturnType<typeof setTimeout> | undefined
let resolveAbort: AbortController | null = null
let refreshAbort: AbortController | null = null
let jobsTimer: ReturnType<typeof setInterval> | undefined

/* ───────────── 派生 ───────────── */

const current = computed<JobSummary>(() => {
  const found = jobs.value.find((j) => j.job === currentJob.value)
  if (found) return found
  const m = MODULES.find((x) => x.job === currentJob.value) ?? MODULES[0]
  return {
    ...m,
    supportsCommit: m.job !== 'wealth-all',
    supportsRollback: m.job !== 'wealth-all',
    lastResult: null,
    lastBuilding: false,
    lastBuildNumber: null,
    lastBuildAt: null,
  }
})

/** whoAmI.anonymous === true（未登录 / 会话过期）：显示「请先登录 Jenkins」引导 */
const loginRequired = computed(() => who.value?.anonymous === true)

/** meta.json 里有、但最近构建历史里没有的镜像 tag（去重后） */
const extraTags = computed(() => {
  const have = new Set(history.value.map((h) => h.imageTag))
  return metaTags.value.filter((t) => !have.has(t))
})

const mode = computed<Mode>(() => (flow.value === 'history' ? 'rollback' : 'build-deploy'))

const shaError = computed(() => {
  const v = sha.value
  if (!v) return ''
  if (!/^[0-9a-fA-F]*$/.test(v)) return '只能包含 0-9 / a-f 的十六进制字符'
  if (v.length < 40) return `需要完整 40 位 SHA，当前 ${v.length}/40`
  if (v.length > 40) return `SHA 过长：${v.length} 位，应为 40 位`
  return ''
})
const shaValid = computed(() => SHA_RE.test(sha.value))

const registryRequired = computed(() => overlay.value === 'test' || overlay.value === 'prod')
const registryOpen = computed(() => registryRequired.value || registryManualOpen.value)

const submitBlock = computed(() => {
  if (!who.value?.authenticated) return connection.value === 'offline' ? 'Jenkins 未连接' : '未登录 Jenkins'
  if (flow.value === 'commit') {
    if (!sha.value) return '请输入完整 GIT_SHA'
    if (shaError.value) return shaError.value
  } else if (!branch.value) {
    return '请选择分支'
  }
  if (registryRequired.value && !registry.value.trim()) return `${overlay.value} 环境需要填写 REGISTRY`
  return ''
})

const isBuilding = computed(() => {
  const s = active.value?.status?.state
  return !!active.value && (s === undefined || s === 'queued' || s === 'running')
})

/* ───────────── 动作 ───────────── */

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/** 读取登录状态与连接信息；返回是否已登录 */
async function checkSession(): Promise<boolean> {
  try {
    const [w, i] = await Promise.all([api.whoAmI(), api.getInfo()])
    if (who.value && !who.value.anonymous && w.anonymous) sessionExpired.value = true
    if (!w.anonymous) sessionExpired.value = false
    who.value = w
    info.value = i
    connection.value = i.online ? 'online' : 'offline'
  } catch (e) {
    connection.value = 'offline'
    who.value = { name: '未登录', authenticated: false, anonymous: false, authorities: [] }
    ElMessage.error(`连接 Jenkins 失败：${errMsg(e)}`)
  }
  return !!who.value?.authenticated
}

/** 会话丢失：停止所有轮询，展示登录引导 */
function stopAllPolling(): void {
  clearInterval(jobsTimer)
  clearTimeout(pollTimer)
  pollToken++
  pollAbort?.abort()
  resolveAbort?.abort()
  refreshAbort?.abort()
}

let checkingAuth = false
async function onAuthLost(): Promise<void> {
  if (checkingAuth || loginRequired.value) return
  checkingAuth = true
  try {
    await checkSession()
    if (loginRequired.value) stopAllPolling()
  } finally {
    checkingAuth = false
  }
}

async function init(initialJob?: string): Promise<void> {
  if (initialJob && MODULES.some((m) => m.job === initialJob)) currentJob.value = initialJob
  setAuthLostHandler(() => void onAuthLost())
  connection.value = 'checking'
  clearInterval(jobsTimer)
  const ok = await checkSession()
  if (!ok && loginRequired.value) return // 未登录：只显示引导页，不再请求 Job 接口（都会 403）
  await Promise.all([loadJobs(), onJobChanged()])
  jobsTimer = setInterval(() => void loadJobs(true), 8000)
}

async function loadJobs(silent = false): Promise<void> {
  if (!silent) jobsLoading.value = true
  try {
    jobs.value = await api.getJobs()
  } catch (e) {
    if (!silent) ElMessage.error(`读取 Job 列表失败：${errMsg(e)}`)
  } finally {
    jobsLoading.value = false
  }
}

async function selectJob(job: string): Promise<void> {
  if (job === currentJob.value) return
  currentJob.value = job
  await onJobChanged()
}

async function onJobChanged(): Promise<void> {
  const cur = current.value
  if (!cur.supportsCommit && flow.value !== 'branch') flow.value = 'branch'
  skipMvn.value = false
  resolveSeq++
  resolveAbort?.abort() // 切换模块：取消上一个模块的 commit 识别轮询
  refreshAbort?.abort()
  resolvePhase.value = 'idle'
  resolveResult.value = null
  resolveError.value = ''
  branchAuto.value = false
  void api
    .getJobParams(cur.job)
    .then((d) => {
      if (current.value.job === cur.job) paramDefs.value = d
    })
    .catch(() => undefined)
  await Promise.all([loadBranches(), loadHistory()])
}

async function loadBranches(): Promise<void> {
  const repo = current.value.repo
  const job = current.value.job
  branchesLoading.value = true
  branchesError.value = ''
  try {
    const opt = api.listBranchOptions
      ? await api.listBranchOptions(repo, job)
      : { branches: await api.listBranches(repo, job), source: 'job' as const, notice: undefined }
    if (job !== current.value.job) return
    branches.value = opt.branches
    branchesSource.value = opt.source
    branchesNotice.value = opt.notice ?? ''
    if (!branches.value.includes(branch.value)) {
      branch.value = branches.value.includes(DEFAULT_BRANCH) ? DEFAULT_BRANCH : (branches.value[0] ?? 'main')
      branchAuto.value = false
    }
  } catch (e) {
    branchesError.value = errMsg(e)
  } finally {
    branchesLoading.value = false
  }
}

async function refreshBranches(): Promise<void> {
  if (refreshing.value) return
  refreshing.value = true
  branchesError.value = ''
  const before = branches.value.length
  const job = current.value.job
  const ctrl = new AbortController()
  refreshAbort = ctrl
  try {
    const list = await api.refreshBranches(current.value.repo, job, ctrl.signal)
    if (ctrl.signal.aborted || job !== current.value.job) return
    branches.value = list
    branchesNotice.value = ''
    if (api.listBranchOptions) {
      const opt = await api.listBranchOptions(current.value.repo, job) // 命中刚刷新的 meta.json 缓存
      branchesSource.value = opt.source
      branchesNotice.value = opt.notice ?? ''
    }
    const added = branches.value.length - before
    ElMessage.success(added > 0 ? `分支缓存已刷新，新增 ${added} 个分支` : '分支缓存已刷新，没有新分支')
  } catch (e) {
    if (e instanceof ApiError && e.kind === 'aborted') return
    branchesError.value = errMsg(e)
    ElMessage.error(errMsg(e))
  } finally {
    refreshing.value = false
  }
}

function setBranch(b: string, auto = false): void {
  branch.value = b
  branchAuto.value = auto
  if (b && !branches.value.includes(b)) branches.value = [...branches.value, b]
}

async function loadHistory(): Promise<void> {
  const cur = current.value
  if (!cur.supportsRollback) {
    history.value = []
    return
  }
  historyLoading.value = true
  historyError.value = ''
  try {
    const list = await api.listHistory(cur.job, HISTORY_LIMIT, overlay.value)
    if (cur.job === current.value.job) history.value = list
    // 补充来源：meta.json 的 tags.<镜像名>（只作「可选 tag」提示，读不到就忽略）
    void (api.listExtraTags?.(cur.job) ?? Promise.resolve([]))
      .then((t) => {
        if (cur.job === current.value.job) metaTags.value = t
      })
      .catch(() => {
        metaTags.value = []
      })
  } catch (e) {
    historyError.value = errMsg(e)
  } finally {
    historyLoading.value = false
  }
}

function setFlow(f: Flow): void {
  if (f !== 'branch' && !current.value.supportsCommit) return
  flow.value = f
  if (f !== 'history') lastBuildFlow.value = f
  if (f === 'history') void loadHistory()
}

/** 顶部 MODE 页签 */
function setMode(m: Mode): void {
  setFlow(m === 'rollback' ? 'history' : lastBuildFlow.value)
}

function setSha(v: string): void {
  const next = v.trim()
  if (next === sha.value) return
  sha.value = next
  resolveSeq++
  resolveAbort?.abort()
  resolveResult.value = null
  resolveError.value = ''
  resolvePhase.value = 'idle'
  if (branchAuto.value) branchAuto.value = false
}

async function resolve(): Promise<void> {
  const seq = ++resolveSeq
  const cur = current.value
  resolveAbort?.abort()
  const ctrl = new AbortController()
  resolveAbort = ctrl
  resolvePhase.value = 'resolving'
  resolveResult.value = null
  resolveError.value = ''
  try {
    const r = await api.resolveCommit(cur.repo, sha.value.toLowerCase(), ctrl.signal)
    if (seq !== resolveSeq) return
    resolveResult.value = r
    resolveCandidates.value = sortCandidates(r.candidates)
    resolvePhase.value = 'done'
    if (r.status === 'ok' && resolveCandidates.value.length) setBranch(resolveCandidates.value[0], true)
  } catch (e) {
    if (seq !== resolveSeq || (e instanceof ApiError && e.kind === 'aborted')) return
    resolvePhase.value = 'error'
    resolveError.value = errMsg(e)
  }
}

/** 用户在候选分支里点选 */
function pickCandidate(b: string): void {
  setBranch(b, true)
}

function buildParams(): BuildParams {
  const cur = current.value
  return {
    MODE: 'build-deploy',
    OVERLAY: overlay.value,
    SOURCE: source.value,
    IMAGE_TAG: 'auto',
    REGISTRY: registry.value.trim(),
    BRANCH: branch.value || 'main',
    GIT_SHA: flow.value === 'commit' ? sha.value.toLowerCase() : '',
    SKIP_MVN: cur.java ? skipMvn.value : false,
  }
}

async function startBuild(params: BuildParams, title?: string): Promise<boolean> {
  if (submitting.value) return false
  submitting.value = true
  const cur = current.value
  try {
    const r = await api.triggerBuild(cur.job, params)
    if (r.notice) ElMessage.warning({ message: r.notice, duration: 6000 })
    pollToken++
    pollAbort?.abort()
    clearTimeout(pollTimer)
    pollAbort = new AbortController()
    active.value = {
      job: cur.job,
      title: title ?? cur.title,
      queueId: r.queueId,
      buildNumber: r.buildNumber,
      status: null,
      lines: [],
      logNext: 0,
      error: '',
      params,
    }
    void poll(pollToken, pollAbort.signal)
    void loadJobs(true)
    void loadHistory()
    openActiveLog()
    return true
  } catch (e) {
    ElMessage.error(`触发构建失败：${errMsg(e)}`)
    return false
  } finally {
    submitting.value = false
  }
}

/** 指定 GIT_SHA：先跑一次只读识别（更新镜像仓库），存在才继续构建 */
async function verifyShaExists(): Promise<boolean> {
  await resolve()
  if (resolvePhase.value === 'error') {
    ElMessage.error(resolveError.value || '核对 GIT_SHA 失败')
    return false
  }
  const r = resolveResult.value
  if (!r || r.status === 'not_found') {
    await ElMessageBox.alert('该GIT_SHA不存在，请检查确认', 'GIT_SHA', {
      type: 'warning',
      confirmButtonText: '知道了',
    })
    return false
  }
  // 存在即可构建；推荐分支只用来填 IMAGE_TAG 前缀，界面不再让人选
  if (r.status === 'ok' && r.branch) setBranch(r.branch, true)
  return true
}

async function submitBuild(): Promise<boolean> {
  if (submitBlock.value || submitting.value) return false
  if (flow.value === 'commit') {
    submitting.value = true
    try {
      const ok = await verifyShaExists()
      if (!ok) return false
    } finally {
      submitting.value = false
    }
    if (submitBlock.value) return false
  }
  if (overlay.value === 'prod') {
    const what = flow.value === 'commit' ? `GIT_SHA ${sha.value}` : `分支 ${branch.value}`
    try {
      await ElMessageBox.confirm(
        `目标环境是 prod，将构建并部署 ${current.value.title}（${what}）。确认继续？`,
        '生产环境二次确认',
        { type: 'warning', confirmButtonText: '确认部署', cancelButtonText: '取消', confirmButtonClass: 'el-button--danger' },
      )
    } catch {
      return false
    }
  }
  return startBuild(buildParams())
}

function openActiveLog(): void {
  const a = active.value
  if (!a) return
  logView.value = { job: a.job, title: a.title, buildNumber: a.buildNumber, queueId: a.queueId, live: true, sha: a.params.GIT_SHA }
  logOpen.value = true
}

function openHistoryLog(item: HistoryItem): void {
  const a = active.value
  const live = !!a && a.job === currentJob.value && a.buildNumber != null && a.buildNumber === item.number
  logView.value = {
    job: currentJob.value,
    title: current.value.title,
    buildNumber: item.number,
    queueId: live && a ? a.queueId : 0,
    live,
    sha: item.sha,
  }
  logOpen.value = true
}

async function startRollback(item: HistoryItem): Promise<boolean> {
  const params: BuildParams = {
    MODE: 'rollback',
    OVERLAY: overlay.value,
    SOURCE: source.value,
    IMAGE_TAG: item.imageTag,
    REGISTRY: registry.value.trim(),
    BRANCH: item.branch,
    GIT_SHA: '',
    SKIP_MVN: false,
  }
  return startBuild(params)
}

async function retry(): Promise<void> {
  if (active.value) await startBuild(active.value.params, active.value.title)
}

async function stopActive(): Promise<void> {
  const a = active.value
  if (!a) return
  try {
    if (a.buildNumber) {
      await api.stopBuild(a.job, a.buildNumber)
      ElMessage.warning(`已请求中止 #${a.buildNumber}`)
    } else if (a.queueId && api.cancelQueued) {
      await api.cancelQueued(a.queueId)
      ElMessage.warning('已请求取消排队')
    }
  } catch (e) {
    ElMessage.error(`中止失败：${errMsg(e)}`)
  }
}

function dismissActive(): void {
  pollToken++
  pollAbort?.abort()
  clearTimeout(pollTimer)
  active.value = null
}

async function poll(token: number, signal: AbortSignal, errors = 0): Promise<void> {
  const a = active.value
  if (!a || token !== pollToken) return
  let nextErrors = errors
  let finished = false
  try {
    const st = await api.getBuildStatus(a.job, a.queueId, a.buildNumber, signal)
    if (token !== pollToken) return
    a.status = st
    if (st.number) a.buildNumber = st.number
    let more = false
    if (a.buildNumber) {
      const chunk = await api.getBuildLog(a.job, a.buildNumber, a.logNext, signal)
      if (token !== pollToken) return
      if (chunk.lines.length) a.lines.push(...chunk.lines)
      if (a.lines.length > 2000) a.lines.splice(0, a.lines.length - 2000)
      a.logNext = chunk.next
      more = chunk.more
    }
    a.error = ''
    nextErrors = 0
    finished = (st.state === 'success' || st.state === 'failure' || st.state === 'aborted') && !more
  } catch (e) {
    if (token !== pollToken || (e instanceof ApiError && e.kind === 'aborted')) return
    a.error = errMsg(e)
    if (e instanceof ApiError && (e.kind === 'auth' || e.kind === 'forbidden')) return // 重试没有意义；auth 会触发登录引导
    nextErrors++
    if (nextErrors >= 6) {
      ElMessage.error('多次读取构建状态失败，已停止轮询')
      return
    }
  }
  if (finished) {
    void loadJobs(true)
    void loadHistory()
    return
  }
  pollTimer = setTimeout(() => void poll(token, signal, nextErrors), 1000)
}

function dispose(): void {
  stopAllPolling()
  setAuthLostHandler(null)
}

// 切换 overlay 后「运行中版本」的推断随之变化，重读历史
watch(overlay, () => {
  if (!loginRequired.value && flow.value === 'history') void loadHistory()
})

const store = reactive({
    // 只读状态
    who, info, connection, loginRequired, sessionExpired, jobs, jobsLoading, currentJob, current, paramDefs, mockMode: USE_MOCK,
    flow, mode, overlay, source, registry, registryOpen, registryRequired, registryManualOpen, skipMvn,
    branches, branchesLoading, branchesError, branchesSource, branchesNotice, extraTags, refreshing, branch, branchAuto,
    sha, shaError, shaValid, resolvePhase, resolveResult, resolveError, resolveCandidates,
    history, historyLoading, historyError,
    active, submitting, isBuilding, submitBlock, logOpen, logView,
    // 动作
    init, dispose, loadJobs, selectJob, loadBranches, refreshBranches, setBranch, loadHistory,
    setFlow, setMode, setSha, resolve, pickCandidate, submitBuild, startRollback, retry,
    stopActive, dismissActive, openActiveLog, openHistoryLog,
})

export type ConsoleStore = typeof store

export function useConsole(): ConsoleStore {
  return store
}
