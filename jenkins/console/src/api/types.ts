/** Jenkins 控制台数据层类型（mock 与 real 共用） */

export type Mode = 'build-deploy' | 'rollback'
export type Overlay = 'dev' | 'test' | 'prod' | 'local'
export type Source = 'github' | 'local-mount'
/** Jenkins 构建结果；null = 未完成 / 无构建 */
export type BuildResult = 'SUCCESS' | 'FAILURE' | 'ABORTED' | 'UNSTABLE' | null

export interface WhoAmI {
  name: string
  /** 已登录（= anonymous === false）。注意 Jenkins 匿名时 authenticated 字段也是 true，不能用它判登录 */
  authenticated: boolean
  /** 匿名访问（未登录 / 会话过期） */
  anonymous: boolean
  authorities: string[]
}

export interface JenkinsInfo {
  online: boolean
  version: string
  latencyMs: number
  mock: boolean
}

/** 左侧模块列表项（8 个 Job：7 模块 + 全量） */
export interface JobSummary {
  job: string
  module: string
  title: string
  /** 仓库；wealth-all 为聚合 */
  repo: string
  /** 镜像名；全量为空 */
  image: string
  java: boolean
  /** 是否允许指定 commit / 历史回放（wealth-all 不允许） */
  supportsCommit: boolean
  supportsRollback: boolean
  lastResult: BuildResult
  lastBuilding: boolean
  lastBuildNumber: number | null
  lastBuildAt: number | null
}

export interface ParamDef {
  name: string
  type: 'choice' | 'string' | 'boolean'
  description: string
  defaultValue: string | boolean
  choices?: string[]
}

/** buildWithParameters 的参数，字段名与 Jenkins Job 完全一致 */
export interface BuildParams {
  MODE: Mode
  OVERLAY: Overlay
  SOURCE: Source
  IMAGE_TAG: string
  REGISTRY: string
  BRANCH: string
  GIT_SHA: string
  SKIP_MVN: boolean
  /** 默认 true：Maven 只打包本模块；false 则 -am 连同依赖一起编译 */
  ONLY_CURRENT_MODULE: boolean
}

export interface ResolveResult {
  /** ok 已识别；not_found 仓库里没有；no_branch commit 存在但不在任何分支（如被强推覆盖） */
  status: 'ok' | 'not_found' | 'no_branch'
  repo: string
  sha: string
  /** 脚本侧的推荐分支（main > master > dev > develop > 其余） */
  branch: string
  candidates: string[]
  fetched: boolean
  /** 不存在且 fetched=false：远程刷新失败，结论可能过期 */
  stale?: boolean
}

/** 分支列表及其来源：meta=meta.json；job=Job 参数 BRANCH 的 choices；default=兜底 */
export interface BranchOptions {
  branches: string[]
  source: 'meta' | 'job' | 'default'
  /** 需要提示给用户的说明（如：请先刷新分支） */
  notice?: string
}

export interface HistoryItem {
  number: number
  imageTag: string
  branch: string
  /** 完整 40 位 SHA；旧镜像 / 描述缺失 / unknown 时为空串（界面显示「无 SHA」） */
  sha: string
  /** 是否允许用于代码对比（有完整 SHA 才行；回滚不受影响） */
  canCompare: boolean
  /** 构建时的 OVERLAY（描述或参数里取到时有值） */
  overlay?: string
  timestamp: number
  /** Jenkins 该次构建耗时（毫秒）；构建中为 0 */
  durationMs: number
  result: BuildResult
  building: boolean
  mode: Mode
  /** 是否当前运行中的版本。【推断】：所选 overlay 下最近一次成功构建的 IMAGE_TAG，手工 kubectl 变更不会反映 */
  running: boolean
  /** 构建时保存的其它分支（已去掉本次「分支」）。null = 还没保存过 */
  related: string[] | null
}

export type StageKey = 'checkout' | 'build' | 'push' | 'deploy'
export type StageState = 'pending' | 'running' | 'done' | 'skipped' | 'failed'

export interface StageInfo {
  key: StageKey
  label: string
  state: StageState
  /** 该阶段第一次出现 STAGE 行的时刻（日志 timestamps） */
  startedAt?: number
  /** 已结束用下一阶段起点或「完成」行；进行中用当前时刻 */
  durationMs?: number
}

export type BuildState = 'queued' | 'running' | 'success' | 'failure' | 'aborted'

export interface BuildStatus {
  job: string
  number: number
  state: BuildState
  /** 0 ~ 100 */
  progress: number
  stages: StageInfo[]
  /** wealth-all：日志里 `[module]` 前缀给出的当前模块 */
  stageModule?: string
  startedAt: number
  durationMs: number
  imageTag: string
  branch: string
  mode: Mode
  params: BuildParams
  /** 预计剩余秒数（仅展示） */
  etaSec: number
}

export interface LogChunk {
  lines: string[]
  /** 下次请求的 start（行偏移 / 字节偏移） */
  next: number
  /** 构建仍在产生日志 */
  more: boolean
}

export interface TriggerResult {
  /** 队列项 id（Location: /queue/item/<id>/） */
  queueId: number
  /** mock 里能立刻拿到构建号；real 里需要轮询 queue 获得 */
  buildNumber: number | null
  /** 需要提示给用户的说明（如：所选分支不在 Job 选项里，改由脚本按 SHA 自动识别） */
  notice?: string
}

/** 统一接口：mock.ts 与 real.ts 都实现它 */
export interface JenkinsApi {
  readonly name: 'mock' | 'real'
  whoAmI(): Promise<WhoAmI>
  getInfo(): Promise<JenkinsInfo>
  getJobs(): Promise<JobSummary[]>
  getJobParams(job: string): Promise<ParamDef[]>
  /** real：读 `job`（缺省取该仓库的第一个 Job）参数定义里 BRANCH 的 choices */
  listBranches(repo: string, job?: string): Promise<string[]>
  /** 触发 wealth-refresh-branches 并等待结束，重读 Job 参数后返回分支列表 */
  refreshBranches(repo: string, job?: string, signal?: AbortSignal): Promise<string[]>
  /** 触发只读 Job wealth-resolve-commit，轮询到结束并读 resolve.json */
  resolveCommit(repo: string, sha: string, signal?: AbortSignal): Promise<ResolveResult>
  /** 把关联分支写回该次构建的描述（历史页只读已保存的结果） */
  saveRelatedBranches(job: string, buildNumber: number, branches: string[]): Promise<void>
  triggerBuild(job: string, params: BuildParams): Promise<TriggerResult>
  /** overlay：用于推断「当前运行中版本」（该 overlay 下最近一次成功构建） */
  listHistory(job: string, limit: number, overlay?: Overlay): Promise<HistoryItem[]>
  getBuildStatus(job: string, queueId: number, buildNumber: number | null, signal?: AbortSignal): Promise<BuildStatus>
  /** 增量日志（等价 logText/progressiveText?start=） */
  getBuildLog(job: string, buildNumber: number, start: number, signal?: AbortSignal): Promise<LogChunk>
  stopBuild(job: string, buildNumber: number): Promise<void>
  /** 带来源/提示的分支列表（real 实现；缺省时界面退回 listBranches） */
  listBranchOptions?(repo: string, job?: string): Promise<BranchOptions>
  /** meta.json 的 tags.<镜像名>：回滚时的「可选 tag」补充来源（real 实现） */
  listExtraTags?(job: string): Promise<string[]>
  /** 取消仍在排队的构建（POST /queue/cancelItem）；mock 无此能力 */
  cancelQueued?(queueId: number): Promise<void>
  /** 原始日志下载链接 */
  consoleUrl(job: string, buildNumber: number): string
}

/** auth=未登录/会话过期；forbidden=已登录但无权限；timeout/network/aborted=传输层；http=其它非 2xx */
export type ApiErrorKind = 'auth' | 'forbidden' | 'timeout' | 'network' | 'aborted' | 'http'

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status = 0,
    public readonly kind: ApiErrorKind = 'http',
  ) {
    super(message)
    this.name = 'ApiError'
  }
}
