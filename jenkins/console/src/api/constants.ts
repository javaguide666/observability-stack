import type { Overlay, Source, StageKey } from './types'

export interface ModuleMeta {
  job: string
  module: string
  title: string
  repo: string
  image: string
  java: boolean
  port?: number
}

/** 与 jenkins/ui/app.js 中 MODULES 保持一致：7 个模块 Job + 全量 Job */
export const MODULES: ModuleMeta[] = [
  { job: 'wealth-gateway', module: 'gateway', title: '网关', repo: 'wealth-freedom', image: 'wealth-gateway', java: true, port: 7070 },
  { job: 'wealth-auth', module: 'auth', title: '认证', repo: 'wealth-freedom', image: 'wealth-auth', java: true },
  { job: 'wealth-system-server', module: 'system-server', title: '系统服务', repo: 'wealth-freedom', image: 'wealth-system-server', java: true },
  { job: 'wealth-admin-server', module: 'admin-server', title: '管理后端', repo: 'wealth-freedom', image: 'wealth-admin-server', java: true },
  { job: 'wealth-ecommerce-server', module: 'ecommerce-server', title: '电商后端', repo: 'wealth-freedom', image: 'wealth-ecommerce-server', java: true },
  { job: 'wealth-freedom-web', module: 'freedom-web', title: '管理前端', repo: 'wealth-freedom-web', image: 'wealth-freedom-web', java: false },
  { job: 'wealth-ecommerce-web', module: 'ecommerce-web', title: '电商前端', repo: 'wealth-ecommerce-web', image: 'wealth-ecommerce-web', java: false },
  { job: 'wealth-all', module: 'all', title: '全量 7 模块', repo: 'wealth-all', image: '', java: true },
]

/** 控制台数据文件（由 wealth-refresh-branches / write-ui-meta.sh 生成，同源静态文件） */
export const META_URL = '/userContent/wealth-data/meta.json'
/**
 * meta.json 的 key，以 scripts/write-ui-meta.sh 里的 REPOS / IMAGES 为准：
 *   branches.<仓库名> -> string[]；tags.<镜像名> -> ({tag, created, size} | string)[]
 */
export const META_REPOS = ['wealth-freedom', 'wealth-freedom-web', 'wealth-ecommerce-web', 'wealth-all'] as const
export const META_IMAGES = [
  'wealth-gateway',
  'wealth-auth',
  'wealth-system-server',
  'wealth-admin-server',
  'wealth-ecommerce-server',
  'wealth-freedom-web',
  'wealth-ecommerce-web',
] as const
/** Job -> meta.json branches 的仓库 key（wealth-all 对应聚合键 wealth-all） */
export const JOB_META_REPO: Record<string, string> = Object.fromEntries(MODULES.map((m) => [m.job, m.repo]))
/** Job -> meta.json tags 的镜像 key（wealth-all 没有） */
export const JOB_META_IMAGE: Record<string, string> = Object.fromEntries(MODULES.filter((m) => m.image).map((m) => [m.job, m.image]))
/** 分支数据全都读不到时的兜底（提示用户先刷新分支） */
export const FALLBACK_BRANCHES = ['main', 'dev']

export const REFRESH_JOB = 'wealth-refresh-branches'
export const RESOLVE_JOB = 'wealth-resolve-commit'

export const OVERLAYS: Overlay[] = ['dev', 'test', 'prod', 'local']
export const SOURCES: Source[] = ['github', 'local-mount']
export const QUICK_BRANCHES = ['main', 'dev']
export const DEFAULT_BRANCH = 'dev'
export const HISTORY_LIMIT = 10

export const STAGES: { key: StageKey; label: string }[] = [
  { key: 'checkout', label: '拉代码' },
  { key: 'build', label: '构建' },
  { key: 'push', label: '推镜像' },
  { key: 'deploy', label: '部署' },
]

export const SHA_RE = /^[0-9a-fA-F]{40}$/
/** 脚本 detect_branch_for_sha 的优先级：main > master > dev > develop > 其余 */
export const BRANCH_PRIORITY = ['main', 'master', 'dev', 'develop']
