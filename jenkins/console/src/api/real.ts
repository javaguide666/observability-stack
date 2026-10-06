/**
 * real 实现：直接调用 Jenkins REST（同源 userContent 部署，浏览器带 Jenkins 会话 Cookie）。
 *
 * - 所有请求用相对路径 + credentials:'same-origin'；开发时走 vite 代理 -> localhost:18080。
 * - 统一封装 request/http/json：15s 超时、非 2xx 抛带状态码的 ApiError、401/403 区分「未登录」与「无权限」。
 * - 约定与实测情况见 README「real 模式」与文档 §17.4.6 / §17.7。真实联调需要在浏览器里登录 Jenkins 后完成。
 */
import { FALLBACK_BRANCHES, HISTORY_LIMIT, JOB_META_IMAGE, JOB_META_REPO, META_URL, MODULES, REFRESH_JOB, RESOLVE_JOB, SHA_RE } from './constants'
import { flattenParams, inferStages, parseDescription, parseRelated, updateHint, withRelated, type StageHint } from './parse'
import { notifyAuthLost } from './session'
import {
  ApiError,
  type BuildParams,
  type BuildResult,
  type BuildState,
  type BranchOptions,
  type BuildStatus,
  type HistoryItem,
  type JenkinsApi,
  type JenkinsInfo,
  type JobSummary,
  type LogChunk,
  type Overlay,
  type ParamDef,
  type ResolveResult,
  type Source,
  type TriggerResult,
  type WhoAmI,
} from './types'
import { sortCandidates } from '@/utils/branches'

const BASE = (import.meta.env.VITE_JENKINS_BASE ?? '').replace(/\/$/, '')

/** 可调参数（测试里会改成 0 以免真等） */
export const tuning = {
  /** 单次请求超时 */
  timeoutMs: 15_000,
  /** 轮询间隔（排队项 / 构建结束 / 日志） */
  pollMs: 1_000,
  /** 等待排队项变成构建的上限 */
  queueTimeoutMs: 120_000,
  /** 等待一次只读 / 刷新类构建结束的上限 */
  buildTimeoutMs: 240_000,
  /** 参数定义缓存（同一 Job 切换模块时避免重复请求） */
  paramCacheMs: 10_000,
}

/* ───────────── 传输层 ───────────── */

interface Crumb {
  field: string
  value: string
}
let crumb: Crumb | null = null
/** crumbIssuer 返回 404 = Jenkins 没开 CSRF 保护，之后不再取 */
let crumbDisabled = false

const metaCache: { t: number; p: Promise<MetaJson | null> | null } = { t: 0, p: null }
const paramCache = new Map<string, { t: number; p: Promise<ParamDef[]> }>()
const hints = new Map<string, StageHint>()
const carry = new Map<string, string>()

/** 仅供测试：清掉模块级缓存 */
export function __resetForTests(): void {
  crumb = null
  crumbDisabled = false
  paramCache.clear()
  metaCache.t = 0
  metaCache.p = null
  hints.clear()
  carry.clear()
}

function abortError(): ApiError {
  return new ApiError('已取消', 0, 'aborted')
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError())
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(t)
      reject(abortError())
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

const noQuery = (path: string) => path.split('?')[0]

/** 单次 fetch：超时 + 外部取消 + 网络错误翻译。不判断状态码。 */
async function request(path: string, init: RequestInit = {}, signal?: AbortSignal): Promise<Response> {
  const ctrl = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    ctrl.abort()
  }, tuning.timeoutMs)
  const onAbort = () => ctrl.abort()
  if (signal) {
    if (signal.aborted) ctrl.abort()
    else signal.addEventListener('abort', onAbort, { once: true })
  }
  try {
    return await fetch(BASE + path, { credentials: 'same-origin', cache: 'no-store', ...init, signal: ctrl.signal })
  } catch {
    if (timedOut) throw new ApiError(`请求超时（${Math.round(tuning.timeoutMs / 1000)}s）：${noQuery(path)}`, 0, 'timeout')
    if (signal?.aborted) throw abortError()
    throw new ApiError(`无法连接 Jenkins（网络错误）：${noQuery(path)}`, 0, 'network')
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
  }
}

function isAnonymous(d: { anonymous?: boolean; name?: string } | null | undefined): boolean {
  if (!d) return true
  if (typeof d.anonymous === 'boolean') return d.anonymous
  return !d.name || d.name === 'anonymous'
}

/** 当前会话是否匿名；检测本身失败返回 null（无法判断） */
async function probeAnonymous(signal?: AbortSignal): Promise<boolean | null> {
  try {
    const r = await request('/whoAmI/api/json', { headers: { Accept: 'application/json' } }, signal)
    if (r.status === 401 || r.status === 403) return true
    if (!r.ok) return null
    return isAnonymous((await r.json()) as { anonymous?: boolean; name?: string })
  } catch (e) {
    if (e instanceof ApiError && e.kind === 'aborted') throw e
    return null
  }
}

/** 401/403 之后分类：未登录（会话过期）还是已登录但无权限 */
async function authFailure(status: number, path: string, signal?: AbortSignal): Promise<ApiError> {
  const anon = await probeAnonymous(signal)
  if (anon === false) {
    return new ApiError(`没有权限执行该操作（HTTP ${status}）：${noQuery(path)}。已登录但账号缺少相应 Jenkins 权限`, status, 'forbidden')
  }
  if (anon === null) {
    return new ApiError(`Jenkins 拒绝了请求（HTTP ${status}）：${noQuery(path)}。无法判断是未登录还是无权限`, status, 'forbidden')
  }
  notifyAuthLost()
  return new ApiError('未登录或登录会话已过期，请先登录 Jenkins', status, 'auth')
}

async function loadCrumb(signal?: AbortSignal): Promise<void> {
  crumb = null
  const res = await request('/crumbIssuer/api/json', { headers: { Accept: 'application/json' } }, signal)
  if (res.status === 404) {
    crumbDisabled = true // 没开 CSRF 保护
    return
  }
  if (res.status === 401 || res.status === 403) throw await authFailure(res.status, '/crumbIssuer/api/json', signal)
  if (!res.ok) throw new ApiError(`获取 CSRF crumb 失败：HTTP ${res.status}`, res.status)
  const d = (await res.json()) as { crumb?: string; crumbRequestField?: string }
  if (!d.crumb) throw new ApiError('获取 CSRF crumb 失败：响应里没有 crumb 字段', res.status)
  crumb = { field: d.crumbRequestField ?? 'Jenkins-Crumb', value: d.crumb }
}

/**
 * 带 crumb 的请求。POST 先确保有 crumb（缓存），403 时刷新一次 crumb 重试；
 * 仍然 401/403 则判断是未登录还是无权限并抛出。其它状态码交给调用方判断。
 */
async function http(path: string, init: RequestInit = {}, signal?: AbortSignal): Promise<Response> {
  const method = (init.method ?? 'GET').toUpperCase()
  const send = async (): Promise<Response> => {
    const headers = new Headers(init.headers)
    if (method !== 'GET') {
      if (!crumb && !crumbDisabled) await loadCrumb(signal)
      if (crumb) headers.set(crumb.field, crumb.value)
    }
    return request(path, { ...init, method, headers }, signal)
  }
  let res = await send()
  if (method !== 'GET' && res.status === 403) {
    crumb = null
    crumbDisabled = false
    res = await send()
  }
  if (res.status === 401 || res.status === 403) throw await authFailure(res.status, path, signal)
  return res
}

function httpError(res: Response, path: string, what = ''): ApiError {
  const hint = res.status === 404 ? '（不存在，Job 未创建？）' : res.status >= 500 ? '（Jenkins 内部错误）' : ''
  return new ApiError(`${what || '请求失败'}：HTTP ${res.status}${hint} ${noQuery(path)}`, res.status)
}

async function json<T>(path: string, init?: RequestInit, signal?: AbortSignal): Promise<T> {
  const res = await http(path, { ...init, headers: { Accept: 'application/json', ...(init?.headers as Record<string, string> | undefined) } }, signal)
  if (!res.ok) throw httpError(res, path)
  // 会话过期时 Jenkins 可能 302 到登录页，fetch 跟随后拿到 200 的 HTML
  if ((res.headers.get('Content-Type') ?? '').includes('text/html')) {
    if ((await probeAnonymous(signal)) === true) {
      notifyAuthLost()
      throw new ApiError('未登录或登录会话已过期，请先登录 Jenkins', res.status, 'auth')
    }
    throw new ApiError(`Jenkins 返回了 HTML 而不是 JSON：${noQuery(path)}`, res.status)
  }
  try {
    return (await res.json()) as T
  } catch {
    throw new ApiError(`Jenkins 返回了无法解析的 JSON：${noQuery(path)}`, res.status)
  }
}

function toForm(p: Record<string, string>): string {
  const q = new URLSearchParams()
  for (const [k, v] of Object.entries(p)) q.set(k, v)
  return q.toString()
}

function queueIdOf(res: Response): number {
  const loc = res.headers.get('Location') ?? ''
  return Number(loc.match(/\/queue\/item\/(\d+)/)?.[1] ?? 0)
}

function resultOf(r: string | null | undefined): BuildResult {
  return r === 'SUCCESS' || r === 'FAILURE' || r === 'ABORTED' || r === 'UNSTABLE' ? r : null
}

const jobPath = (job: string) => `/job/${encodeURIComponent(job)}`

/* ───────────── 参数定义 ───────────── */

interface RawDef {
  name: string
  type?: string
  _class?: string
  description?: string
  defaultParameterValue?: { value?: string | boolean }
  choices?: string[]
}

function toParamDef(x: RawDef): ParamDef {
  const t = x.type ?? x._class ?? ''
  const type: ParamDef['type'] = /Choice/.test(t) ? 'choice' : /Boolean/.test(t) ? 'boolean' : 'string'
  const raw = x.defaultParameterValue?.value
  const defaultValue: string | boolean = type === 'boolean' ? raw === true || raw === 'true' : raw == null ? '' : String(raw)
  return { name: x.name, type, description: x.description ?? '', defaultValue, choices: type === 'choice' ? (x.choices ?? []) : undefined }
}

async function fetchParamDefs(job: string, signal?: AbortSignal): Promise<ParamDef[]> {
  const d = await json<{ property?: { parameterDefinitions?: RawDef[] }[] }>(
    `${jobPath(job)}/api/json?tree=property[parameterDefinitions[name,type,defaultParameterValue[value],choices,description]]`,
    undefined,
    signal,
  )
  return (d.property ?? []).flatMap((p) => p.parameterDefinitions ?? []).map(toParamDef)
}

/** fresh=true 绕过缓存（触发构建前必须用最新的选项校验） */
function getParamDefs(job: string, fresh = false, signal?: AbortSignal): Promise<ParamDef[]> {
  const hit = paramCache.get(job)
  if (!fresh && hit && Date.now() - hit.t < tuning.paramCacheMs) return hit.p
  const p = fetchParamDefs(job, signal)
  paramCache.set(job, { t: Date.now(), p })
  p.catch(() => {
    if (paramCache.get(job)?.p === p) paramCache.delete(job)
  })
  return p
}

/* ───────────── meta.json（分支 / 镜像 tag 缓存） ───────────── */

interface MetaJson {
  branches?: Record<string, string[]>
  tags?: Record<string, (string | { tag?: string })[]>
}

async function fetchMeta(signal?: AbortSignal): Promise<MetaJson | null> {
  try {
    const res = await http(META_URL, { headers: { Accept: 'application/json' } }, signal)
    if (!res.ok) return null
    const d = (await res.json()) as unknown
    return d && typeof d === 'object' ? (d as MetaJson) : null
  } catch (e) {
    // 未登录要让界面知道；其它（404、网络、无权限、坏 JSON）都当作“读不到”，由调用方回退
    if (e instanceof ApiError && (e.kind === 'auth' || e.kind === 'aborted')) throw e
    return null
  }
}

/** fresh=true 绕过缓存（刷新分支之后必须重读） */
function getMeta(fresh = false, signal?: AbortSignal): Promise<MetaJson | null> {
  if (!fresh && metaCache.p && Date.now() - metaCache.t < tuning.paramCacheMs) return metaCache.p
  const p = fetchMeta(signal)
  metaCache.t = Date.now()
  metaCache.p = p
  p.catch(() => {
    if (metaCache.p === p) {
      metaCache.t = 0
      metaCache.p = null
    }
  })
  return p
}

function metaBranches(meta: MetaJson | null, job: string, repo: string): string[] {
  const list = meta?.branches?.[JOB_META_REPO[job] ?? repo]
  return Array.isArray(list) ? [...new Set(list.filter((b): b is string => typeof b === 'string' && !!b))] : []
}

/**
 * 分支来源：① meta.json branches.<仓库> ② Job 参数 BRANCH 的 choices（choice 类型）③ 兜底 main/dev + 提示刷新。
 * BRANCH 是 string 类型时没有 choices，自然落到 ① 或 ③。
 */
async function branchOptions(repo: string, job: string, signal?: AbortSignal, freshMeta = false): Promise<BranchOptions> {
  const fromMeta = metaBranches(await getMeta(freshMeta, signal), job, repo)
  if (fromMeta.length) return { branches: fromMeta, source: 'meta' }
  let fromJob: string[] = []
  try {
    const def = (await getParamDefs(job, false, signal)).find((d) => d.name === 'BRANCH')
    if (def?.type === 'choice') fromJob = def.choices ?? []
  } catch (e) {
    if (e instanceof ApiError && (e.kind === 'auth' || e.kind === 'aborted')) throw e
  }
  if (fromJob.length) return { branches: [...fromJob], source: 'job' }
  return { branches: [...FALLBACK_BRANCHES], source: 'default', notice: '还没有分支缓存（meta.json 与 Job 的 BRANCH 选项都为空），请先点「刷新分支」' }
}

/* ───────────── 排队 / 构建等待（resolve、refresh 共用） ───────────── */

async function waitForQueue(queueId: number, signal?: AbortSignal): Promise<number> {
  const deadline = Date.now() + tuning.queueTimeoutMs
  for (;;) {
    const q = await json<{ executable?: { number: number } | null; cancelled?: boolean }>(
      `/queue/item/${queueId}/api/json?tree=executable[number,url],cancelled`,
      undefined,
      signal,
    )
    if (q.cancelled) throw new ApiError('构建在队列中被取消', 0)
    if (q.executable?.number) return q.executable.number
    if (Date.now() > deadline) throw new ApiError('等待执行器超时：任务一直在排队', 0, 'timeout')
    await sleep(tuning.pollMs, signal)
  }
}

async function waitForBuild(job: string, n: number, signal?: AbortSignal): Promise<BuildResult> {
  const deadline = Date.now() + tuning.buildTimeoutMs
  for (;;) {
    const b = await json<{ building: boolean; result: string | null }>(`${jobPath(job)}/${n}/api/json?tree=building,result`, undefined, signal)
    if (!b.building) return resultOf(b.result)
    if (Date.now() > deadline) throw new ApiError(`等待 ${job} #${n} 结束超时`, 0, 'timeout')
    await sleep(tuning.pollMs, signal)
  }
}

/* ───────────── 触发参数 ───────────── */

function firstJobOfRepo(repo: string): string {
  return (MODULES.find((m) => m.repo === repo) ?? MODULES[0]).job
}

/** 只传 Job 定义里存在的参数；Choice 参数先校验（Jenkins 对非法选项会直接 500） */
export function buildFormFor(job: string, defs: ParamDef[], p: BuildParams): { form: Record<string, string>; notice?: string } {
  const byName = new Map(defs.map((d) => [d.name, d]))
  const form: Record<string, string> = {}
  let notice: string | undefined
  const rollback = p.MODE === 'rollback'

  const put = (name: string, value: string): void => {
    const def = byName.get(name)
    if (!def) return
    if (def.type === 'choice' && def.choices?.length && !def.choices.includes(value)) {
      throw new ApiError(`Job ${job} 的参数 ${name} 不接受 "${value}"（可选：${def.choices.join(' / ')}）`, 400)
    }
    form[name] = value
  }

  put('MODE', p.MODE)
  put('OVERLAY', p.OVERLAY)
  put('SOURCE', p.SOURCE as Source)

  if (rollback) {
    const tag = p.IMAGE_TAG.trim()
    if (!tag || tag === 'auto') throw new ApiError('回滚需要明确的 IMAGE_TAG（历史版本 tag）', 400)
    put('IMAGE_TAG', tag)
  } else {
    put('IMAGE_TAG', p.IMAGE_TAG.trim() || 'auto')
  }
  put('REGISTRY', p.REGISTRY.trim())

  // BRANCH
  const bdef = byName.get('BRANCH')
  if (bdef) {
    const sha = !rollback && job !== 'wealth-all' ? p.GIT_SHA.trim().toLowerCase() : ''
    const choices = bdef.type === 'choice' ? (bdef.choices ?? []) : null
    let branch = p.BRANCH.trim() || String(bdef.defaultValue || '')
    if (choices && choices.length && !choices.includes(branch)) {
      const fallback = String(bdef.defaultValue || choices[0])
      if (rollback) {
        branch = fallback // 回滚不拉代码，BRANCH 无实际作用，只需是合法选项
      } else if (sha) {
        // 指定 commit 时脚本会自己识别所属分支（BRANCH 仅在它包含该 commit 时被采用），可以退回默认选项
        notice = `分支 ${branch} 还不在 Job 的 BRANCH 选项里（分支缓存未刷新），已改用 ${fallback}，构建脚本会按 SHA 自动识别所属分支。`
        branch = fallback
      } else {
        throw new ApiError(`分支 ${branch} 不在 Job 的 BRANCH 选项里（BRANCH 为 choice 类型，只接受其 choices），请先点「刷新分支」`, 400)
      }
    }
    put('BRANCH', branch)
  }

  // GIT_SHA：仅指定 commit 的构建传；wealth-all 三个仓库 SHA 不同，不传
  if (!rollback && job !== 'wealth-all' && p.GIT_SHA.trim()) put('GIT_SHA', p.GIT_SHA.trim().toLowerCase())
  else if (byName.has('GIT_SHA')) form.GIT_SHA = ''

  // SKIP_MVN：仅 Java 模块 Job 定义了它
  if (byName.has('SKIP_MVN')) form.SKIP_MVN = String(!rollback && p.SKIP_MVN)
  if (byName.has('ONLY_CURRENT_MODULE')) form.ONLY_CURRENT_MODULE = String(!rollback && p.ONLY_CURRENT_MODULE)

  return { form, notice }
}

/* ───────────── 日志 / 阶段 ───────────── */

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;]*[A-Za-z]/g
/** Timestamper 写在日志里的隐藏书签，去掉 ANSI 后会变成可见的 ha://// 乱码 */
const TS_NOTE = /ha:\/\/\/\/\S*/g

function rememberHint(key: string, h: StageHint | undefined): void {
  if (!h) return
  hints.set(key, h)
  if (hints.size > 40) hints.delete(hints.keys().next().value as string)
}

interface RawStatus {
  number?: number
  building: boolean
  result: string | null
  timestamp: number
  duration?: number
  estimatedDuration?: number
  description?: string | null
  executor?: { progressPercent?: number } | null
  actions?: unknown
}

function emptyStatus(job: string, number: number, state: BuildState): BuildStatus {
  return {
    job,
    number,
    state,
    progress: 0,
    stages: inferStages(undefined, state, 'build-deploy'),
    startedAt: Date.now(),
    durationMs: 0,
    imageTag: '',
    branch: '',
    mode: 'build-deploy',
    params: { MODE: 'build-deploy', OVERLAY: 'dev', SOURCE: 'github', IMAGE_TAG: 'auto', REGISTRY: '', BRANCH: '', GIT_SHA: '', SKIP_MVN: false, ONLY_CURRENT_MODULE: true },
    etaSec: 0,
  }
}

/* ───────────── resolve.json ───────────── */

interface ResolveJson {
  exists?: boolean
  sha?: string | null
  branches?: string[]
  preferred?: string | null
  repo?: string
  fetched?: boolean
  error?: string
}

function mapResolve(repo: string, sha: string, d: ResolveJson): ResolveResult {
  const fetched = d.fetched === true
  if (d.error === 'invalid') throw new ApiError('SHA 格式无效：需要完整 40 位十六进制', 400)
  if (d.error === 'bad_repo') throw new ApiError(`仓库参数无效（bad_repo）：${repo}`, 0)
  if (d.error === 'repo_unavailable') throw new ApiError('仓库不可用：GitHub 与本机仓库都读取失败，请检查 github-ssh / 网络', 0)
  if (d.error) throw new ApiError(`识别失败（${d.error}）`, 0)
  const full = (d.sha ?? sha).toLowerCase()
  const base = { repo: d.repo ?? repo, sha: full, fetched }
  if (!d.exists) return { ...base, status: 'not_found', branch: '', candidates: [], stale: !fetched }
  const branches = (d.branches ?? []).filter(Boolean)
  if (!branches.length) return { ...base, status: 'no_branch', branch: '', candidates: [] }
  const preferred = d.preferred && branches.includes(d.preferred) ? d.preferred : undefined
  const sorted = sortCandidates(branches)
  // preferred（脚本按 main > master > dev > develop 选出）放第一位
  const candidates = preferred ? [preferred, ...sorted.filter((b) => b !== preferred)] : sorted
  return { ...base, status: 'ok', branch: candidates[0], candidates }
}

/* ───────────── JenkinsApi ───────────── */

/** 构建脚本写在 userContent 的关联分支。没有文件或不是纯文本则当作没保存过 */
async function savedRelatedFile(job: string, number: number): Promise<string[] | null> {
  const path = `/userContent/wealth-data/related/${encodeURIComponent(job)}/${number}.txt`
  try {
    const res = await request(path)
    if (!res.ok) return null
    const text = (await res.text()).trim()
    if (!text || text.includes('<') || /\s/.test(text)) return null
    return parseRelated(`RELATED=${text}`)
  } catch {
    return null
  }
}

export const realApi: JenkinsApi = {
  name: 'real',

  async whoAmI(): Promise<WhoAmI> {
    const res = await request('/whoAmI/api/json', { headers: { Accept: 'application/json' } })
    if (res.status === 401 || res.status === 403) {
      return { name: '未登录', authenticated: false, anonymous: true, authorities: [] }
    }
    if (!res.ok) throw httpError(res, '/whoAmI/api/json', '读取登录状态失败')
    if ((res.headers.get('Content-Type') ?? '').includes('text/html')) {
      return { name: '未登录', authenticated: false, anonymous: true, authorities: [] }
    }
    const d = (await res.json()) as { name?: string; anonymous?: boolean; authenticated?: boolean; authorities?: string[] }
    // 注意：匿名时 authenticated 也是 true；判登录只看 anonymous === false
    const anonymous = isAnonymous(d)
    return {
      name: anonymous ? '未登录' : (d.name ?? '已登录'),
      authenticated: !anonymous,
      anonymous,
      authorities: d.authorities ?? [],
    }
  },

  async getInfo(): Promise<JenkinsInfo> {
    const t0 = performance.now()
    try {
      const res = await request('/whoAmI/api/json', { headers: { Accept: 'application/json' } })
      return {
        online: res.status < 500,
        version: res.headers.get('X-Jenkins') ?? '?',
        latencyMs: Math.round(performance.now() - t0),
        mock: false,
      }
    } catch {
      return { online: false, version: '?', latencyMs: Math.round(performance.now() - t0), mock: false }
    }
  },

  async getJobs(): Promise<JobSummary[]> {
    // 一次请求取全部 Job 的最近一次构建
    const d = await json<{
      jobs?: { name: string; color?: string; lastBuild?: { number: number; result: string | null; building: boolean; timestamp: number } | null }[]
    }>('/api/json?tree=jobs[name,color,lastBuild[number,result,building,timestamp]]')
    const byName = new Map((d.jobs ?? []).map((j) => [j.name, j]))
    return MODULES.map((m) => {
      const lb = byName.get(m.job)?.lastBuild ?? null
      const all = m.job === 'wealth-all'
      return {
        job: m.job,
        module: m.module,
        title: m.title,
        repo: m.repo,
        image: m.image,
        java: m.java,
        supportsCommit: !all,
        supportsRollback: !all,
        lastResult: resultOf(lb?.result),
        lastBuilding: !!lb?.building,
        lastBuildNumber: lb?.number ?? null,
        lastBuildAt: lb?.timestamp ?? null,
      } satisfies JobSummary
    })
  },

  getJobParams(job: string): Promise<ParamDef[]> {
    return getParamDefs(job)
  },

  async listBranches(repo: string, job?: string): Promise<string[]> {
    return (await branchOptions(repo, job ?? firstJobOfRepo(repo))).branches
  },

  listBranchOptions(repo: string, job?: string): Promise<BranchOptions> {
    return branchOptions(repo, job ?? firstJobOfRepo(repo))
  },

  async listExtraTags(job: string): Promise<string[]> {
    const image = JOB_META_IMAGE[job]
    const list = image ? (await getMeta())?.tags?.[image] : undefined
    if (!Array.isArray(list)) return []
    return list.map((t) => (typeof t === 'string' ? t : (t?.tag ?? ''))).filter(Boolean)
  },

  async refreshBranches(repo: string, job?: string, signal?: AbortSignal): Promise<string[]> {
    const target = job ?? firstJobOfRepo(repo)
    // 按该 Job 是否真的带参数决定 /build 还是 /buildWithParameters
    const defs = await getParamDefs(REFRESH_JOB, true, signal)
    const path = `${jobPath(REFRESH_JOB)}/${defs.length ? 'buildWithParameters' : 'build'}?delay=0sec`
    const res = await http(path, { method: 'POST' }, signal)
    if (!res.ok) throw httpError(res, path, `触发 ${REFRESH_JOB} 失败`)
    const qid = queueIdOf(res)
    if (!qid) throw new ApiError(`已触发 ${REFRESH_JOB}，但响应里没有队列地址（Location 头缺失）`, res.status)
    const n = await waitForQueue(qid, signal)
    const result = await waitForBuild(REFRESH_JOB, n, signal)
    if (result !== 'SUCCESS') {
      throw new ApiError(
        `刷新分支失败：${REFRESH_JOB} #${n} 结果 ${result ?? '未知'}。请查看 ${jobPath(REFRESH_JOB)}/${n}/console（常见原因：容器缺 python3 / GitHub 不可达）`,
        0,
      )
    }
    // 构建成功后改读 meta.json（脚本已重写它）；Job 参数缓存也清掉
    paramCache.clear()
    return (await branchOptions(repo, target, signal, true)).branches
  },

  async resolveCommit(repo: string, sha: string, signal?: AbortSignal): Promise<ResolveResult> {
    if (!SHA_RE.test(sha)) throw new ApiError('SHA 需要是完整 40 位十六进制', 400)
    if (repo === 'wealth-all') throw new ApiError('wealth-all 是聚合 Job，不支持识别 commit，请切换到单个模块', 400)
    const s = sha.toLowerCase()
    const path = `${jobPath(RESOLVE_JOB)}/buildWithParameters?delay=0sec`
    const res = await http(path, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: toForm({ SHA: s, REPO: repo }) }, signal)
    if (!res.ok) throw httpError(res, path, `触发 ${RESOLVE_JOB} 失败`)
    const qid = queueIdOf(res)
    if (!qid) throw new ApiError(`已触发 ${RESOLVE_JOB}，但响应里没有队列地址（Location 头缺失）`, res.status)

    const n = await waitForQueue(qid, signal)
    const result = await waitForBuild(RESOLVE_JOB, n, signal)

    // 只有 repo_unavailable / bad_repo 会让构建 FAILURE；其余结论（含不存在、非法）都是 SUCCESS，要看 JSON
    const art = `${jobPath(RESOLVE_JOB)}/${n}/artifact/resolve.json`
    let data: ResolveJson | null = null
    const ar = await http(art, { headers: { Accept: 'application/json' } }, signal)
    if (ar.ok) {
      try {
        data = (await ar.json()) as ResolveJson
      } catch {
        data = null
      }
    }
    if (result === 'ABORTED') throw new ApiError(`识别任务 #${n} 被中止`, 0)
    if (result !== 'SUCCESS') {
      if (data?.error === 'bad_repo') throw new ApiError(`仓库参数无效（bad_repo）：${repo}，详见 ${jobPath(RESOLVE_JOB)}/${n}/console`, 0)
      throw new ApiError(`仓库不可用：识别任务 #${n} 失败（${data?.error ?? result ?? '未知'}）。请检查 github-ssh / 网络，详见 ${jobPath(RESOLVE_JOB)}/${n}/console`, 0)
    }
    if (!data) throw httpError(ar, art, `读取 resolve.json 失败（#${n}）`)
    return mapResolve(repo, s, data)
  },

  async triggerBuild(job: string, params: BuildParams): Promise<TriggerResult> {
    const defs = await getParamDefs(job, true)
    if (!defs.length) throw new ApiError(`Job ${job} 没有定义参数，无法 buildWithParameters`, 400)
    const { form, notice } = buildFormFor(job, defs, params)
    const path = `${jobPath(job)}/buildWithParameters?delay=0sec`
    const res = await http(path, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: toForm(form) })
    if (!res.ok) throw httpError(res, path, '触发构建失败')
    const queueId = queueIdOf(res)
    if (!queueId) {
      throw new ApiError('构建已提交，但响应里没有队列地址（Location 头缺失），请到 Jenkins 原生页面查看进度', res.status)
    }
    return { queueId, buildNumber: null, notice }
  },

  async listHistory(job: string, limit: number = HISTORY_LIMIT, overlay?: Overlay): Promise<HistoryItem[]> {
    const d = await json<{
      builds?: {
        number: number
        result: string | null
        building: boolean
        timestamp: number
        duration?: number
        description?: string | null
        actions?: unknown
      }[]
    }>(`${jobPath(job)}/api/json?tree=builds[number,result,building,timestamp,duration,description,actions[parameters[name,value]],url]{0,${limit}}`)
    let marked = false
    const items = (d.builds ?? []).map((b) => {
      const info = parseDescription(b.description, flattenParams(b.actions))
      const result = resultOf(b.result)
      // 「运行中」是推断：所选 overlay 下最近一次成功构建；overlay 未知的旧记录也参与
      const sameEnv = !overlay || !info.overlay || info.overlay === overlay
      const running = !marked && result === 'SUCCESS' && !b.building && !!info.imageTag && sameEnv
      if (running) marked = true
      return {
        number: b.number,
        imageTag: info.imageTag,
        branch: info.branch,
        sha: info.sha,
        canCompare: !!info.sha,
        overlay: info.overlay || undefined,
        timestamp: b.timestamp,
        durationMs: b.building ? 0 : (b.duration ?? 0),
        result,
        building: !!b.building,
        mode: info.mode,
        running,
        related: info.related,
      } satisfies HistoryItem
    })
    await Promise.all(items.map(async (item) => {
      if (item.related !== null) return
      item.related = await savedRelatedFile(job, item.number)
    }))
    return items
  },

  async saveRelatedBranches(job: string, buildNumber: number, branches: string[]): Promise<void> {
    const cur = await json<{ description?: string | null }>(`${jobPath(job)}/${buildNumber}/api/json?tree=description`)
    const description = withRelated(cur.description, branches)
    const path = `${jobPath(job)}/${buildNumber}/submitDescription`
    const res = await http(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: toForm({ description }),
    })
    if (!res.ok && res.status !== 302) throw httpError(res, path, '保存关联分支失败')
  },

  async getBuildStatus(job: string, queueId: number, buildNumber: number | null, signal?: AbortSignal): Promise<BuildStatus> {
    let n = buildNumber
    if (n == null) {
      const q = await json<{ executable?: { number: number } | null; cancelled?: boolean }>(
        `/queue/item/${queueId}/api/json?tree=executable[number,url],cancelled`,
        undefined,
        signal,
      )
      if (q.cancelled) return emptyStatus(job, 0, 'aborted')
      if (!q.executable?.number) return emptyStatus(job, 0, 'queued')
      n = q.executable.number
    }
    const b = await json<RawStatus>(
      `${jobPath(job)}/${n}/api/json?tree=number,building,result,duration,timestamp,estimatedDuration,description,executor[progressPercent],actions[parameters[name,value]]`,
      undefined,
      signal,
    )
    const state: BuildState = b.building ? 'running' : b.result === 'SUCCESS' ? 'success' : b.result === 'ABORTED' ? 'aborted' : 'failure'
    const p = flattenParams(b.actions)
    const info = parseDescription(b.description, p)
    const elapsed = Math.max(0, Date.now() - b.timestamp)
    const est = b.estimatedDuration && b.estimatedDuration > 0 ? b.estimatedDuration : 0
    const pct = b.executor?.progressPercent
    let progress: number
    if (state === 'success') progress = 100
    else if (b.building && typeof pct === 'number' && pct >= 0) progress = Math.min(99, pct)
    else progress = Math.min(99, Math.round((elapsed / (est || 60_000)) * 100))

    const key = `${job}#${n}`
    const st = emptyStatus(job, n, state)
    st.progress = progress
    st.startedAt = b.timestamp
    st.durationMs = b.building ? elapsed : (b.duration ?? elapsed)
    st.imageTag = info.imageTag
    st.branch = info.branch
    st.mode = info.mode
    st.etaSec = b.building && est ? Math.max(0, Math.round((est - elapsed) / 1000)) : 0
    st.params = {
      MODE: info.mode,
      OVERLAY: (p.OVERLAY as Overlay) || 'dev',
      SOURCE: (p.SOURCE as Source) || 'github',
      IMAGE_TAG: p.IMAGE_TAG ?? 'auto',
      REGISTRY: p.REGISTRY ?? '',
      BRANCH: p.BRANCH ?? info.branch,
      GIT_SHA: p.GIT_SHA ?? '',
      SKIP_MVN: p.SKIP_MVN === 'true',
      ONLY_CURRENT_MODULE: p.ONLY_CURRENT_MODULE !== 'false',
    }
    // 阶段：Pipeline 只有 Resolve source / CI + CD 两个 stage，wfapi 给不出 拉代码/构建/推镜像/部署，改用日志里的「==> 」标记推断
    const hint = hints.get(key)
    const clock = b.building ? Date.now() : b.timestamp + (b.duration ?? elapsed)
    st.stages = inferStages(hint, state, info.mode, clock)
    if (hint?.module) st.stageModule = hint.module
    return st
  },

  async getBuildLog(job: string, buildNumber: number, start: number, signal?: AbortSignal): Promise<LogChunk> {
    const path = `${jobPath(job)}/${buildNumber}/logText/progressiveText?start=${start}`
    const res = await http(path, undefined, signal)
    if (!res.ok) throw httpError(res, path, '读取日志失败')
    const key = `${job}#${buildNumber}`
    if (start === 0) carry.delete(key)
    const more = res.headers.get('X-More-Data') === 'true'
    const next = Number(res.headers.get('X-Text-Size') ?? start)
    let text = (carry.get(key) ?? '') + (await res.text()).replace(ANSI, '').replace(TS_NOTE, '')
    // 仍在写入时，最后一行可能只有半截：留到下一次拼接
    if (more && text && !text.endsWith('\n')) {
      const i = text.lastIndexOf('\n')
      carry.set(key, text.slice(i + 1))
      text = text.slice(0, i + 1)
    } else {
      carry.delete(key)
    }
    const lines = text ? text.replace(/\r?\n$/, '').split(/\r?\n/) : []
    rememberHint(key, updateHint(hints.get(key), lines))
    return { lines, next: Number.isFinite(next) ? next : start, more }
  },

  async stopBuild(job: string, buildNumber: number): Promise<void> {
    // 软停止；成功时 Jenkins 回 302 -> 跟随后是 200 HTML
    const path = `${jobPath(job)}/${buildNumber}/stop`
    const res = await http(path, { method: 'POST' })
    if (!res.ok && res.status !== 302) throw httpError(res, path, '中止失败')
  },

  async cancelQueued(queueId: number): Promise<void> {
    const path = `/queue/cancelItem?id=${queueId}`
    const res = await http(path, { method: 'POST' })
    if (!res.ok && res.status !== 302) throw httpError(res, path, '取消排队失败')
  },

  consoleUrl(job: string, buildNumber: number): string {
    return `${BASE}${jobPath(job)}/${buildNumber}/consoleText`
  },
}
