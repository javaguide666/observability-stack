import { HISTORY_LIMIT, MODULES, STAGES } from './constants'
import { branchToTagPrefix, sortCandidates } from '@/utils/branches'
import { clockTime } from '@/utils/format'
import {
  ApiError,
  type BuildParams,
  type BuildResult,
  type BuildState,
  type BuildStatus,
  type HistoryItem,
  type JenkinsApi,
  type JenkinsInfo,
  type JobSummary,
  type LogChunk,
  type ParamDef,
  type ResolveResult,
  type StageInfo,
  type StageState,
  type TriggerResult,
  type WhoAmI,
} from './types'

/* ───────────── 工具：延迟 / 偶发失败 / 伪随机 ───────────── */

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))
const delay = (min = 160, max = 480) => sleep(min + Math.random() * (max - min))

function readFailRate(): number {
  const q = new URLSearchParams(window.location.search).get('mockFail')
  const raw = q ?? import.meta.env.VITE_MOCK_FAIL_RATE ?? '0.08'
  const n = Number(raw)
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0.08
}
const FAIL_RATE = readFailRate()

function maybeFail(what: string): void {
  if (Math.random() < FAIL_RATE) {
    throw new ApiError(`${what}失败：HTTP 503（mock 偶发错误，请重试）`, 503)
  }
}

function hashStr(s: string): number {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}
function rng(seed: string): () => number {
  let a = hashStr(seed)
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
function hex40(seed: string): string {
  const r = rng(seed)
  let out = ''
  while (out.length < 40) out += Math.floor(r() * 16).toString(16)
  return out
}

/* ───────────── 静态数据 ───────────── */

const PARAM_DEFS: ParamDef[] = [
  { name: 'MODE', type: 'choice', description: 'build-deploy=拉码构建并滚动更新本模块；rollback=仅按 IMAGE_TAG 回滚本模块', defaultValue: 'build-deploy', choices: ['build-deploy', 'rollback'] },
  { name: 'OVERLAY', type: 'choice', description: '部署环境：dev / test / prod / local', defaultValue: 'dev', choices: ['dev', 'test', 'prod', 'local'] },
  { name: 'SOURCE', type: 'choice', description: 'github=clone/fetch（BRANCH/GIT_SHA 生效）；local-mount=用 /gitee 挂载仓，不会切换分支/SHA', defaultValue: 'github', choices: ['github', 'local-mount'] },
  { name: 'IMAGE_TAG', type: 'string', description: 'build-deploy 用 auto；rollback 填最近 10 个历史 tag 之一（控制台可点选）', defaultValue: 'auto' },
  { name: 'REGISTRY', type: 'string', description: '镜像仓库前缀。本机 Desktop 留空；测试/生产填如 registry.example.com/wealth（会 docker push + set 全名）', defaultValue: '' },
  { name: 'BRANCH', type: 'choice', description: '本模块分支（本地缓存下拉；刷新：Job wealth-refresh-branches）', defaultValue: 'main', choices: ['main'] },
  { name: 'GIT_SHA', type: 'string', description: '完整 GIT_SHA（建议 40 位）。填写后自动识别分支，BRANCH 可保持默认；空=分支最新', defaultValue: '' },
  { name: 'SKIP_MVN', type: 'boolean', description: '跳过 Maven（仅重打镜像，需已有 jar）', defaultValue: false },
]

const branchCache: Record<string, string[]> = {
  'wealth-freedom': ['main', 'dev', 'release/1.8', 'feature/order-refund'],
  'wealth-freedom-web': ['main', 'dev', 'feature/dashboard-v2'],
  'wealth-ecommerce-web': ['main', 'dev'],
}
/** 远端有、但本地缓存还没刷新出来的分支（点「刷新分支」后出现） */
const remoteExtra: Record<string, string[]> = {
  'wealth-freedom': ['feature/coupon-v2'],
  'wealth-freedom-web': [],
  'wealth-ecommerce-web': ['hotfix/cart-total'],
}

const COMMIT_SUBJECTS = [
  'fix: 订单退款幂等校验',
  'feat: 优惠券叠加规则',
  'chore: 升级 spring-boot 3.3.5',
  'fix: 网关限流误判',
  'feat: 管理端新增审计日志页',
  'refactor: 抽取支付回调模板',
  'fix: token 刷新并发竞争',
]

/* ───────────── 内存状态 ───────────── */

interface LogLine {
  t: number
  text: string
}
interface MockBuild {
  job: string
  number: number
  queueId: number
  startedAt: number
  params: BuildParams
  imageTag: string
  branch: string
  sha: string
  /** 计划总时长（成功路径） */
  plan: number
  /** 排队时间 */
  queueMs: number
  willFail: boolean
  /** 结束时刻（相对 queue 之后的毫秒），null=未结束 */
  endAt: number | null
  outcome: 'success' | 'failure' | 'aborted' | null
  lines: LogLine[]
  skipPush: boolean
  skipBuild: boolean
  settled: boolean
}
interface LastBuild {
  number: number | null
  result: BuildResult
  building: boolean
  at: number | null
}

const histories = new Map<string, HistoryItem[]>()
const lastBuilds = new Map<string, LastBuild>()
const runningTag = new Map<string, string>()
const counters = new Map<string, number>()
const builds = new Map<number, MockBuild>()
let queueSeq = 9000

function seedJob(job: string, repo: string, idx: number): void {
  const r = rng(`hist-${job}`)
  const branches = ['dev', 'dev', 'main', 'dev', 'feature/order-refund', 'dev', 'main', 'dev', 'dev', 'main']
  const agoMin = [12, 190, 540, 1440, 2040, 2900, 4300, 5800, 8500, 11500]
  const base = 30 + Math.floor(r() * 40)
  // 个别 Job 的最新构建失败 / 中间有失败构建
  const failIdx = new Set<number>([job === 'wealth-system-server' ? 0 : -1, idx % 3 === 0 ? 5 : 2])
  const now = Date.now()
  const items: HistoryItem[] = branches.map((b0, i) => {
    let branch = b0
    if (repo !== 'wealth-freedom' && branch === 'feature/order-refund') branch = 'feature/dashboard-v2'
    const sha = hex40(`${job}-${i}`)
    return {
      number: base - i,
      imageTag: `${branchToTagPrefix(branch)}-${sha.slice(0, 7)}`,
      branch,
      sha,
      canCompare: true,
      timestamp: now - (agoMin[i] + Math.floor(r() * 9)) * 60_000,
      result: failIdx.has(i) ? 'FAILURE' : 'SUCCESS',
      building: false,
      mode: 'build-deploy',
      running: false,
      related: mockCandidates(repo, sha).filter((b) => b !== branch),
    }
  })
  histories.set(job, items)
  counters.set(job, base)
  const first = items[0]
  lastBuilds.set(job, { number: first.number, result: first.result, building: false, at: first.timestamp })
  const ok = items.find((x) => x.result === 'SUCCESS')
  if (ok) runningTag.set(job, ok.imageTag)
}

/* ───────────── 构建模拟 ───────────── */

function buildLog(b: MockBuild): LogLine[] {
  const m = MODULES.find((x) => x.job === b.job)
  const mod = m?.module ?? b.job
  const java = m?.java ?? true
  const p = b.params
  const D = b.plan
  const L = (f: number, text: string): LogLine => ({ t: Math.round(f * D), text })
  const out: LogLine[] = []
  const sha7 = b.sha.slice(0, 7)
  const reg = p.REGISTRY ? `${p.REGISTRY}/` : ''
  const image = m?.image || b.job
  out.push(L(0, 'Started by user admin'))
  out.push(L(0.005, `==> pipeline-wealth-module.sh MODULE=${mod} MODE=${p.MODE} OVERLAY=${p.OVERLAY} SOURCE=${p.SOURCE}`))

  if (p.MODE === 'rollback') {
    out.push(L(0.05, `==> rollback: IMAGE_TAG=${p.IMAGE_TAG}（不拉代码、不重新编译）`))
    out.push(L(0.2, p.REGISTRY ? '==> verify_one_image 已配置 REGISTRY，跳过本机检查' : `==> verify_one_image: docker image inspect ${image}:${p.IMAGE_TAG} ... OK`))
    out.push(L(0.4, `==> kubectl -n wealth set image deploy/${image} ${image}=${reg}${image}:${p.IMAGE_TAG}`))
    out.push(L(0.45, `deployment.apps/${image} image updated`))
    out.push(L(0.62, `Waiting for deployment "${image}" rollout to finish: 1 old replicas are pending termination...`))
    out.push(L(0.9, `deployment "${image}" successfully rolled out`))
    out.push(L(0.95, `==> 写入 .wealth-image-tag = ${p.IMAGE_TAG}`))
    out.push(L(0.99, 'Finished: SUCCESS'))
    return out
  }

  // 阶段 1：拉代码 0 ~ 0.14
  out.push(L(0.02, `==> checkout ${m?.repo ?? 'wealth-freedom'} branch=${b.branch} @ origin/${b.branch}`))
  out.push(L(0.04, `From github.com:javaguide666/${m?.repo ?? 'wealth-freedom'}`))
  out.push(L(0.05, `   ${hex40('o' + b.number).slice(0, 7)}..${sha7}  ${b.branch} -> origin/${b.branch}`))
  if (p.GIT_SHA) {
    out.push(L(0.07, `==> SHA ${p.GIT_SHA.slice(0, 12)}… 自动选择分支 BRANCH=${b.branch}`))
    out.push(L(0.09, `==> checkout ${m?.repo ?? ''} @ ${p.GIT_SHA}`))
  } else {
    out.push(L(0.09, `HEAD is now at ${sha7} ${COMMIT_SUBJECTS[b.number % COMMIT_SUBJECTS.length]}`))
  }
  out.push(L(0.12, `==> IMAGE_TAG 自动设为 ${b.imageTag}（模块 ${mod} 完整SHA ${b.sha}）`))

  // 阶段 2：构建 0.14 ~ 0.62
  if (b.skipBuild) {
    out.push(L(0.16, '==> SKIP_MVN=true，跳过 Maven，直接使用已有 jar'))
  } else if (java) {
    out.push(L(0.15, `==> mvn -q -pl ${m?.module === 'all' ? '.' : 'wealth-' + mod} -am package -DskipTests`))
    out.push(L(0.19, '[INFO] Scanning for projects...'))
    out.push(L(0.24, '[INFO] Reactor Build Order: wealth-common, wealth-api, wealth-' + mod))
    out.push(L(0.3, '[INFO] --- maven-compiler-plugin:3.13.0:compile (default-compile) @ wealth-' + mod + ' ---'))
    out.push(L(0.36, '[INFO] Compiling 214 source files with javac [debug release 21] to target/classes'))
    if (b.willFail) {
      out.push(L(0.43, `[ERROR] /src/main/java/com/wealth/${mod}/service/OrderService.java:[88,31] cannot find symbol`))
      out.push(L(0.45, '[ERROR] Failed to execute goal maven-compiler-plugin:3.13.0:compile (default-compile): Compilation failure'))
      out.push(L(0.46, 'Finished: FAILURE'))
      return out
    }
    out.push(L(0.45, '[INFO] --- spring-boot-maven-plugin:3.3.5:repackage (repackage) ---'))
    out.push(L(0.55, `[INFO] Replacing main artifact with repackaged archive, wealth-${mod}-1.0.0.jar`))
    out.push(L(0.6, '[INFO] BUILD SUCCESS'))
  } else {
    out.push(L(0.15, '==> pnpm install --frozen-lockfile'))
    out.push(L(0.24, 'Packages: +1042  Progress: resolved 1042, reused 1038, downloaded 4'))
    out.push(L(0.32, '==> pnpm build'))
    out.push(L(0.4, 'vite v7.1.0 building for production...'))
    if (b.willFail) {
      out.push(L(0.43, 'error TS2339: Property \'total\' does not exist on type \'OrderVO\'.'))
      out.push(L(0.45, 'ELIFECYCLE  Command failed with exit code 2.'))
      out.push(L(0.46, 'Finished: FAILURE'))
      return out
    }
    out.push(L(0.5, '✓ 2318 modules transformed.'))
    out.push(L(0.6, '✓ built in 18.42s'))
  }

  // 阶段 3：推镜像 0.62 ~ 0.78
  out.push(L(0.63, `==> docker build -t ${image}:${b.imageTag} .`))
  out.push(L(0.67, '#7 [build 3/5] COPY target/*.jar app.jar'))
  out.push(L(0.72, `#9 exporting to image ... naming to docker.io/library/${image}:${b.imageTag} done`))
  if (b.skipPush) {
    out.push(L(0.77, '==> REGISTRY 为空，跳过 docker push（本机 Desktop 直接使用本地镜像）'))
  } else {
    out.push(L(0.74, `==> docker push ${reg}${image}:${b.imageTag}`))
    out.push(L(0.77, `${b.imageTag}: digest: sha256:${hex40('d' + b.number)} size: 2417`))
  }

  // 阶段 4：部署 0.78 ~ 1
  out.push(L(0.8, `==> kubectl -n wealth set image deploy/${image} ${image}=${reg}${image}:${b.imageTag}`))
  out.push(L(0.83, `deployment.apps/${image} image updated`))
  out.push(L(0.88, `Waiting for deployment "${image}" rollout to finish: 1 old replicas are pending termination...`))
  out.push(L(0.94, `deployment "${image}" successfully rolled out`))
  out.push(L(0.97, '==> prune_image_history HISTORY_KEEP=10'))
  out.push(L(0.99, 'Finished: SUCCESS'))
  return out
}

function createBuild(job: string, params: BuildParams, opts: { startedAt?: number; plan?: number; forceOk?: boolean } = {}): MockBuild {
  const m = MODULES.find((x) => x.job === job)
  const number = (counters.get(job) ?? 100) + 1
  counters.set(job, number)
  const rb = params.MODE === 'rollback'
  const sha = params.GIT_SHA || hex40(`new-${job}-${number}-${Date.now()}`)
  const target = rb ? (histories.get(job) ?? []).find((h) => h.imageTag === params.IMAGE_TAG) : undefined
  const branch = rb ? (target?.branch ?? 'dev') : params.BRANCH
  const finalSha = rb ? (target?.sha ?? sha) : sha
  const imageTag = rb ? params.IMAGE_TAG : `${branchToTagPrefix(branch)}-${finalSha.slice(0, 7)}`
  const plan = opts.plan ?? (rb ? 9000 : m?.java === false ? 18000 : job === 'wealth-all' ? 42000 : 26000)
  const b: MockBuild = {
    job,
    number,
    queueId: ++queueSeq,
    startedAt: opts.startedAt ?? Date.now(),
    params,
    imageTag,
    branch,
    sha: finalSha,
    plan,
    queueMs: opts.startedAt ? 0 : 900,
    willFail: !opts.forceOk && !rb && FAIL_RATE > 0 && Math.random() < FAIL_RATE * 1.5,
    endAt: null,
    outcome: null,
    lines: [],
    skipPush: rb || !params.REGISTRY,
    skipBuild: params.SKIP_MVN && !!m?.java,
    settled: false,
  }
  b.lines = buildLog(b)
  const last = b.lines[b.lines.length - 1]
  if (b.willFail || last.text.endsWith('FAILURE')) {
    b.endAt = last.t
    b.outcome = null // 由 settle 时刻判断
  }
  builds.set(b.queueId, b)

  if (!rb) {
    const list = histories.get(job) ?? []
    list.unshift({
      number,
      imageTag,
      branch,
      sha: finalSha,
      canCompare: true,
      timestamp: b.startedAt,
      result: null,
      building: true,
      mode: 'build-deploy',
      running: false,
      related: mockCandidates(m?.repo ?? 'wealth-freedom', finalSha).filter((b) => b !== branch),
    })
    histories.set(job, list.slice(0, 24))
  }
  lastBuilds.set(job, { number, result: null, building: true, at: b.startedAt })
  return b
}

/** 当前模拟时刻下的构建快照 */
function snapshot(b: MockBuild, now = Date.now()) {
  const raw = now - b.startedAt - b.queueMs
  const failAt = b.willFail ? b.lines[b.lines.length - 1].t : null
  const end = b.endAt ?? b.plan
  const e = Math.max(0, Math.min(raw, end))
  const finished = raw >= end
  let outcome: MockBuild['outcome'] = b.outcome
  if (finished && !outcome) outcome = failAt !== null ? 'failure' : 'success'
  let state: BuildState
  if (raw < 0) state = 'queued'
  else if (!finished) state = 'running'
  else state = outcome === 'failure' ? 'failure' : outcome === 'aborted' ? 'aborted' : 'success'
  return { raw, e, finished, outcome, state }
}

function stagesOf(b: MockBuild, e: number, state: BuildState): StageInfo[] {
  const rb = b.params.MODE === 'rollback'
  const bounds: [number, number][] = rb
    ? [[0, 0], [0, 0], [0, 0], [0, 1]]
    : [[0, 0.14], [0.14, 0.62], [0.62, 0.78], [0.78, 1]]
  const failed = state === 'failure' || state === 'aborted'
  return STAGES.map((s, i) => {
    const [s0, s1] = bounds[i]
    let st: StageState
    const skipped = (rb && i < 3) || (i === 2 && b.skipPush) || (i === 1 && b.skipBuild)
    if (skipped) st = 'skipped'
    else if (state === 'success' || e >= s1 * b.plan) st = 'done'
    else if (e >= s0 * b.plan && state !== 'queued') st = failed ? 'failed' : 'running'
    else st = 'pending'
    // 失败后，失败阶段之后保持 pending
    return { key: s.key, label: s.label, state: st }
  })
}

function toStatus(b: MockBuild): BuildStatus {
  const now = Date.now()
  const s = snapshot(b, now)
  const stages = stagesOf(b, s.e, s.state)
  return {
    job: b.job,
    number: b.number,
    state: s.state,
    progress: s.state === 'success' ? 100 : Math.min(99, Math.round((s.e / b.plan) * 100)),
    stages,
    startedAt: b.startedAt,
    durationMs: Math.max(0, Math.min(now - b.startedAt, s.e + b.queueMs)),
    imageTag: b.imageTag,
    branch: b.branch,
    mode: b.params.MODE,
    params: b.params,
    etaSec: s.finished ? 0 : Math.max(0, Math.round((b.plan - s.e) / 1000)),
  }
}

/** 到点的构建落地：更新历史、最近构建、运行中 tag */
function settleAll(): void {
  for (const b of builds.values()) {
    if (b.settled) continue
    const s = snapshot(b)
    if (!s.finished) continue
    b.settled = true
    const result: BuildResult = s.outcome === 'success' ? 'SUCCESS' : s.outcome === 'aborted' ? 'ABORTED' : 'FAILURE'
    const item = (histories.get(b.job) ?? []).find((h) => h.number === b.number)
    if (item) {
      item.building = false
      item.result = result
    }
    lastBuilds.set(b.job, { number: b.number, result, building: false, at: b.startedAt })
    if (result === 'SUCCESS') runningTag.set(b.job, b.imageTag)
  }
}

let seeded = false
function ensureSeed(): void {
  if (seeded) return
  seeded = true
  MODULES.forEach((m, i) => seedJob(m.job, m.repo, i))
  // 电商前端正在构建中：让左侧出现琥珀色脉冲点
  createBuild(
    'wealth-ecommerce-web',
    { MODE: 'build-deploy', OVERLAY: 'dev', SOURCE: 'github', IMAGE_TAG: 'auto', REGISTRY: '', BRANCH: 'dev', GIT_SHA: '', SKIP_MVN: false },
    { startedAt: Date.now() - 6000, plan: 70000, forceOk: true },
  )
}

/* ───────────── 对外实现 ───────────── */

function branchesOf(repo: string): string[] {
  if (repo === 'wealth-all') {
    const sets = Object.values(branchCache)
    return sets[0].filter((b) => sets.every((s) => s.includes(b)))
  }
  return [...(branchCache[repo] ?? ['main'])]
}

/** 与 resolveCommit 同一套假数据：构建时就算好并保存，历史页不再现查 */
function mockCandidates(repo: string, sha: string): string[] {
  const s = sha.toLowerCase()
  if (!/^[0-9a-f]{40}$/.test(s) || /^0{40}$/.test(s) || /^f{40}$/.test(s)) return []
  const other = branchesOf(repo).find((b) => !['main', 'dev'].includes(b)) ?? 'release/1.8'
  const c = parseInt(s[0], 16)
  const raw = c < 6 ? [other, 'dev', 'main'] : c < 10 ? ['dev'] : c < 13 ? [other, 'dev'] : ['main']
  return [...raw].sort()
}

function buildByNumber(job: string, number: number): MockBuild | undefined {
  for (const b of builds.values()) {
    if (b.job === job && b.number === number) return b
  }
  return undefined
}

/** 种子历史没有对应的 MockBuild，打开日志弹窗时按历史记录补一份已结束的构建 */
function materializeHistory(job: string, number: number): MockBuild | undefined {
  const existing = buildByNumber(job, number)
  if (existing) return existing
  const h = (histories.get(job) ?? []).find((x) => x.number === number)
  if (!h) return undefined
  const overlay = h.overlay === 'test' || h.overlay === 'prod' || h.overlay === 'local' || h.overlay === 'dev' ? h.overlay : 'dev'
  const params: BuildParams = {
    MODE: h.mode,
    OVERLAY: overlay,
    SOURCE: 'github',
    IMAGE_TAG: h.imageTag,
    REGISTRY: '',
    BRANCH: h.branch,
    GIT_SHA: h.sha,
    SKIP_MVN: false,
  }
  const failed = h.result === 'FAILURE'
  const aborted = h.result === 'ABORTED'
  const b: MockBuild = {
    job,
    number,
    queueId: ++queueSeq,
    startedAt: h.timestamp,
    params,
    imageTag: h.imageTag,
    branch: h.branch,
    sha: h.sha,
    plan: 20000,
    queueMs: 0,
    willFail: failed,
    endAt: 20000,
    outcome: failed ? 'failure' : aborted ? 'aborted' : 'success',
    lines: [],
    skipPush: true,
    skipBuild: false,
    settled: true,
  }
  b.lines = buildLog(b)
  builds.set(b.queueId, b)
  return b
}

export const mockApi: JenkinsApi = {
  name: 'mock',

  async whoAmI(): Promise<WhoAmI> {
    await delay(120, 260)
    return { name: 'admin', authenticated: true, anonymous: false, authorities: ['authenticated', 'admin'] }
  },

  async getInfo(): Promise<JenkinsInfo> {
    await delay(100, 240)
    return { online: true, version: '2.555.2', latencyMs: 18 + Math.floor(Math.random() * 40), mock: true }
  },

  async getJobs(): Promise<JobSummary[]> {
    ensureSeed()
    await delay(120, 300)
    settleAll()
    return MODULES.map((m) => {
      const lb = lastBuilds.get(m.job)
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
        lastResult: lb?.result ?? null,
        lastBuilding: lb?.building ?? false,
        lastBuildNumber: lb?.number ?? null,
        lastBuildAt: lb?.at ?? null,
      }
    })
  },

  async getJobParams(job: string): Promise<ParamDef[]> {
    await delay(80, 200)
    const repo = MODULES.find((m) => m.job === job)?.repo ?? 'wealth-freedom'
    return PARAM_DEFS.map((d) => (d.name === 'BRANCH' ? { ...d, choices: branchesOf(repo) } : { ...d }))
  },

  async listBranches(repo: string): Promise<string[]> {
    await delay(180, 420)
    maybeFail('读取分支缓存')
    return branchesOf(repo)
  },

  async refreshBranches(repo: string): Promise<string[]> {
    // 模拟：触发 wealth-refresh-branches -> 排队 -> 构建 -> 重读分支
    await delay(1300, 1900)
    maybeFail('刷新分支（wealth-refresh-branches）')
    for (const [r, extra] of Object.entries(remoteExtra)) {
      const cur = branchCache[r]
      for (const b of extra) if (!cur.includes(b)) cur.push(b)
    }
    return branchesOf(repo)
  },

  async resolveCommit(repo: string, sha: string): Promise<ResolveResult> {
    await delay(900, 1200) // 模拟 wealth-resolve-commit 约 1 秒
    const s = sha.toLowerCase()
    if (/^0{40}$/.test(s)) {
      return { status: 'not_found', repo, sha: s, branch: '', candidates: [], fetched: true }
    }
    if (/^f{40}$/.test(s)) {
      return { status: 'no_branch', repo, sha: s, branch: '', candidates: [], fetched: true }
    }
    if (s.startsWith('bad')) {
      throw new ApiError('识别失败：wealth-resolve-commit 构建超时（60s），请稍后重试', 504)
    }
    maybeFail('识别 commit')
    const raw = mockCandidates(repo, s)
    const candidates = sortCandidates(raw)
    return { status: 'ok', repo, sha: s, branch: candidates[0] ?? '', candidates: raw, fetched: true }
  },

  async saveRelatedBranches(job: string, buildNumber: number, branches: string[]): Promise<void> {
    await delay(80, 160)
    const list = histories.get(job) ?? []
    const hit = list.find((h) => h.number === buildNumber)
    if (!hit) throw new ApiError('找不到该构建，无法保存关联分支', 404)
    hit.related = [...branches]
  },

  async triggerBuild(job: string, params: BuildParams): Promise<TriggerResult> {
    ensureSeed()
    await delay(250, 600)
    maybeFail('触发构建')
    const b = createBuild(job, params)
    return { queueId: b.queueId, buildNumber: b.number }
  },

  async listHistory(job: string, limit: number = HISTORY_LIMIT): Promise<HistoryItem[]> {
    ensureSeed()
    await delay(180, 420)
    settleAll()
    const cur = runningTag.get(job)
    let marked = false
    return (histories.get(job) ?? []).slice(0, limit).map((h) => {
      const running = !marked && h.result === 'SUCCESS' && h.imageTag === cur
      if (running) marked = true
      return { ...h, running }
    })
  },

  async getBuildStatus(job: string, queueId: number, buildNumber: number | null = null): Promise<BuildStatus> {
    ensureSeed()
    await delay(60, 160)
    settleAll()
    const b =
      (queueId ? builds.get(queueId) : undefined) ??
      (buildNumber != null ? buildByNumber(job, buildNumber) ?? materializeHistory(job, buildNumber) : undefined)
    if (!b) throw new ApiError('找不到该构建（mock 状态已重置）', 404)
    return toStatus(b)
  },

  async getBuildLog(job: string, buildNumber: number, start: number): Promise<LogChunk> {
    ensureSeed()
    await delay(40, 120)
    const b = buildByNumber(job, buildNumber) ?? materializeHistory(job, buildNumber)
    if (!b) return { lines: [], next: start, more: false }
    const s = snapshot(b)
    const visible = b.lines.filter((l) => l.t <= (s.finished ? Infinity : s.e))
    const lines = visible.slice(start).map((l) => `[${clockTime(b.startedAt + b.queueMs + l.t)}] ${l.text}`)
    return { lines, next: visible.length, more: !s.finished }
  },

  async stopBuild(job: string, buildNumber: number): Promise<void> {
    await delay(150, 300)
    const b = [...builds.values()].find((x) => x.job === job && x.number === buildNumber)
    if (!b) return
    const s = snapshot(b)
    if (s.finished) return
    b.endAt = Math.max(0, s.raw)
    b.outcome = 'aborted'
    b.lines = b.lines.filter((l) => l.t <= s.e)
    b.lines.push({ t: b.endAt, text: 'Aborted by admin' }, { t: b.endAt, text: 'Finished: ABORTED' })
    settleAll()
  },

  consoleUrl(job: string, buildNumber: number): string {
    return `/job/${job}/${buildNumber}/consoleText`
  },
}
