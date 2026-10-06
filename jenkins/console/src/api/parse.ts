/**
 * 纯函数：构建描述解析、日志阶段推断。无网络、无副作用，便于单测。
 *
 * 构建描述（文档 §17.7.4）：
 *   分支 <分支> | SHA <40位> | tag <IMAGE_TAG> | MODULE=<模块> MODE=<MODE> OVERLAY=<OVERLAY> SHA=<40位> IMAGE_TAG=<IMAGE_TAG>
 * 旧格式（T3 之前）：
 *   MODULE=… MODE=… OVERLAY=… IMAGE_TAG=…        （没有 SHA）
 * 旧镜像做回滚时 SHA/分支为 unknown。
 */
import type { Mode, StageInfo, StageKey, StageState } from './types'
import { STAGES } from './constants'

export interface ParsedDescription {
  imageTag: string
  /** 完整 40 位小写；unknown / 缺失 / 非 40 位 => '' */
  sha: string
  branch: string
  mode: Mode
  overlay: string
  /** 构建时保存的其它分支。null = 描述里没有 RELATED（旧构建）；[] = 保存过、没有其它分支 */
  related: string[] | null
}

const HEX40 = /^[0-9a-fA-F]{40}$/

function validSha(v: string | undefined | null): string {
  return v && HEX40.test(v) ? v.toLowerCase() : ''
}

function cleanWord(v: string | undefined | null): string {
  if (!v) return ''
  const t = v.trim()
  return t === 'unknown' || t === 'auto' || t === '-' ? '' : t
}

/** 把 actions[].parameters[] 摊平成 name -> string */
export function flattenParams(actions: unknown): Record<string, string> {
  const out: Record<string, string> = {}
  if (!Array.isArray(actions)) return out
  for (const a of actions) {
    const ps = (a as { parameters?: { name?: string; value?: unknown }[] } | null)?.parameters
    if (!Array.isArray(ps)) continue
    for (const p of ps) {
      if (p?.name && p.value !== undefined && p.value !== null) out[p.name] = String(p.value)
    }
  }
  return out
}

function kv(desc: string, key: string): string | undefined {
  return desc.match(new RegExp(`(?:^|[\\s|])${key}=(\\S+)`))?.[1]
}

/**
 * 优先级：描述里的 KEY=value → actions.parameters → 描述前半段（人读部分）。
 * 分支没有 KEY 兜底时，从 tag（<分支>-<7位sha>）倒推。
 */
export function parseDescription(desc: string | null | undefined, params: Record<string, string> = {}): ParsedDescription {
  const d = desc ?? ''

  // IMAGE_TAG
  const frontTag = d.match(/\|\s*tag\s+(\S+)/)?.[1]
  const imageTag = cleanWord(kv(d, 'IMAGE_TAG')) || cleanWord(params.IMAGE_TAG) || cleanWord(frontTag)

  // SHA（只接受 40 位十六进制）
  const frontSha = d.match(/\|\s*SHA\s+(\S+)/)?.[1] ?? d.match(/^\s*SHA\s+(\S+)/)?.[1]
  const sha = validSha(kv(d, 'SHA')) || validSha(params.GIT_SHA) || validSha(frontSha)

  // 分支：前半段「分支 xxx」是脚本实际 checkout 的分支，最可信
  const frontBranch = d.match(/分支\s+(\S+)/)?.[1]
  let branch = cleanWord(frontBranch) || cleanWord(kv(d, 'BRANCH'))
  if (!branch && imageTag.includes('-')) branch = imageTag.slice(0, imageTag.lastIndexOf('-'))
  if (!branch) branch = cleanWord(params.BRANCH)

  const modeRaw = kv(d, 'MODE') ?? params.MODE
  const mode: Mode = modeRaw === 'rollback' ? 'rollback' : 'build-deploy'
  const overlay = kv(d, 'OVERLAY') ?? params.OVERLAY ?? ''

  return { imageTag, sha, branch, mode, overlay, related: parseRelated(d) }
}

/** RELATED=dev,test；RELATED=- 表示查过但没有其它分支；没有这个键则为 null */
export function parseRelated(desc: string | null | undefined): string[] | null {
  const raw = kv(desc ?? '', 'RELATED')
  if (raw === undefined) return null
  if (raw === '-' || raw === 'none') return []
  return raw.split(',').map((s) => s.trim()).filter((s) => s && s !== '-')
}

/** 把关联分支写进描述：已有 RELATED= 则替换，否则追加。空列表写成 RELATED=- */
export function withRelated(desc: string | null | undefined, branches: string[]): string {
  const clean = [...new Set(branches.map((b) => b.trim()).filter((b) => b && b !== '-' && !/[\s,]/.test(b)))]
  const token = `RELATED=${clean.length ? clean.join(',') : '-'}`
  const d = desc ?? ''
  if (/(?:^|[\s|])RELATED=\S+/.test(d)) {
    return d.replace(/(^|[\s|])RELATED=\S+/, `$1${token}`)
  }
  const base = d.trim()
  return base ? `${base} ${token}` : token
}

/* ───────────── 阶段推断（日志关键字） ───────────── */

export interface StageHint {
  /** 最近一次出现的阶段标记：0 拉代码 1 构建 2 推镜像 3 部署 */
  idx: number
  pushSeen: boolean
  done: boolean
  /** 已出现 `==> STAGE n/4 ...` 结构化标记：之后以它为准，不再用旧的 `==> ` 关键字推断 */
  structured?: boolean
  /** wealth-all 才有：`[module]` 前缀，表示当前是哪个模块的阶段 */
  module?: string
  /** 结构化模式下，本轮（本模块 / 本次脚本执行）各阶段是否出现过、是否带 SKIPPED */
  seen?: boolean[]
  skipped?: boolean[]
  /** 各阶段首次 STAGE 行的 epoch ms；Resolve source 与 CI+CD 共用，换模块才清零 */
  startedAt?: number[]
  /** 下一阶段开始或「完成」行的 epoch ms */
  endedAt?: number[]
}

function emptyTimes(): number[] {
  return [0, 0, 0, 0]
}

/** 行首 `[2026-10-05T23:09:22.849Z]` → epoch；没有时间戳则 undefined */
export function lineTimeMs(line: string): number | undefined {
  const m = line.match(/^\[(\d{4}-\d{2}-\d{2}T[^\]]+)\]/)
  if (!m) return undefined
  const t = Date.parse(m[1])
  return Number.isNaN(t) ? undefined : t
}

function stampTimes(prev: StageHint | undefined, idx: number, ts: number | undefined, newModule: boolean): { startedAt: number[]; endedAt: number[] } {
  const startedAt = !prev || newModule ? emptyTimes() : [...(prev.startedAt ?? emptyTimes())]
  const endedAt = !prev || newModule ? emptyTimes() : [...(prev.endedAt ?? emptyTimes())]
  if (!ts) return { startedAt, endedAt }
  if (!startedAt[idx]) startedAt[idx] = ts
  for (let j = 0; j < idx; j++) {
    if (startedAt[j] && !endedAt[j]) endedAt[j] = ts
  }
  return { startedAt, endedAt }
}

function closeOpenStages(hint: StageHint, ts: number): number[] {
  const startedAt = hint.startedAt ?? emptyTimes()
  const endedAt = [...(hint.endedAt ?? emptyTimes())]
  for (let j = 0; j < 4; j++) {
    if (startedAt[j] && !endedAt[j]) endedAt[j] = ts
  }
  return endedAt
}

const STAGE_KEYS = ['checkout', 'build', 'push', 'deploy'] as const

/**
 * 阶段名 -> 阶段序号（0 拉代码 1 构建 2 推镜像 3 部署）；认不出返回 undefined。
 * 脚本输出的是固定英文 key（checkout/build/push/deploy），其余写法只是宽松兜底。
 */
export function stageIndexOfName(name: string): number | undefined {
  const n = name.trim().toLowerCase()
  const exact = (STAGE_KEYS as readonly string[]).indexOf(n)
  if (exact >= 0) return exact
  if (/推镜像|push|registry|推送/.test(n)) return 2
  if (/拉代码|拉取|checkout|clone|fetch|源码/.test(n)) return 0
  if (/部署|deploy|rollout|kubectl|验收|回滚|rollback/.test(n)) return 3
  if (/构建|build|maven|package|compile|镜像/.test(n)) return 1
  return undefined
}

export interface StageLine {
  n: number
  total: number
  name: string
  idx: number
  /** `[module]` 前缀里的模块名（只有 wealth-all 才有） */
  module?: string
  skipped: boolean
}

/**
 * 解析脚本输出（scripts/pipeline-wealth-module.sh 的 stage()）：
 *   `==> STAGE <n>/4 [<module>] <name> [SKIPPED]`
 * `[module]` 仅 wealth-all 有，`SKIPPED` 结尾可选；行首可以带 Jenkins 时间戳前缀。
 * 阶段名认得出就按名字，认不出且总数为 4 时按序号。
 */
export function parseStageLine(line: string): StageLine | null {
  const m = line.match(/==>\s*STAGE\s+(\d+)\s*\/\s*(\d+)\s+(.*?)\s*$/)
  if (!m) return null
  const n = Number(m[1])
  const total = Number(m[2])
  let rest = m[3] ?? ''
  let skipped = false
  const sk = rest.match(/^(.*?)\s*\bSKIPPED$/)
  if (sk) {
    skipped = true
    rest = sk[1]
  }
  let module: string | undefined
  const mod = rest.match(/^\[([^\]]+)\]\s*(.*)$/)
  if (mod) {
    module = mod[1]
    rest = mod[2]
  }
  const name = rest.trim()
  const idx = stageIndexOfName(name) ?? (total === 4 && n >= 1 && n <= 4 ? n - 1 : undefined)
  return idx === undefined ? null : { n, total, name, idx, module, skipped }
}

/** 旧版兜底：脚本还没有 STAGE 标记时，用 `==> ` 关键字粗略推断 */
const MARKERS: { idx: number; re: RegExp }[] = [
  { idx: 3, re: /==> (kubectl|rollout|验收|完成|REGISTRY=)|==> wealth-all 全部完成/ },
  { idx: 2, re: /==> docker (tag|push)/ },
  { idx: 1, re: /==> (Maven package|docker build|构建完成)/ },
  { idx: 0, re: /==> (checkout|SHA |SOURCE=|PREPARE_ONLY|预检|构建元数据|IMAGE_TAG)/ },
]

/** 扫描一批日志行，更新阶段提示（以最后一个出现的标记为准，wealth-all 逐模块循环时也能跟随） */
export function updateHint(prev: StageHint | undefined, lines: string[]): StageHint | undefined {
  let hint = prev
  for (const line of lines) {
    const ts = lineTimeMs(line)
    const doneMark = /==> (完成|wealth-all 全部完成)/.test(line)
    const done = doneMark || (hint?.done ?? false)
    // 1) 结构化 STAGE 行优先
    const st = parseStageLine(line)
    if (st) {
      const old = hint?.structured && hint.seen && hint.skipped ? hint : undefined
      // 序号回退或换模块 = 新一轮（Resolve source 与 CI + CD 各跑一遍脚本；wealth-all 逐模块循环）
      const restart = !old || st.module !== old.module || st.idx <= old.idx
      const seen = restart ? [false, false, false, false] : [...(old!.seen as boolean[])]
      const skipped = restart ? [false, false, false, false] : [...(old!.skipped as boolean[])]
      seen[st.idx] = true
      skipped[st.idx] = st.skipped
      const newModule = !old || st.module !== old.module
      const { startedAt, endedAt } = stampTimes(hint, st.idx, ts, newModule)
      hint = {
        idx: st.idx,
        pushSeen: seen[2] && !skipped[2],
        done: restart ? false : done,
        structured: true,
        module: st.module,
        seen,
        skipped,
        startedAt,
        endedAt,
      }
      continue
    }
    // 2) 已进入结构化模式后，不再用旧关键字改阶段（只记完成标记）
    if (hint?.structured) {
      if (doneMark && ts) hint = { ...hint, done: true, endedAt: closeOpenStages(hint, ts) }
      else if (done !== hint.done) hint = { ...hint, done }
      continue
    }
    // 3) 兜底：旧的 `==> ` 关键字
    const m = MARKERS.find((x) => x.re.test(line))
    if (!m) continue
    hint = { idx: m.idx, pushSeen: (hint?.pushSeen ?? false) || m.idx === 2, done }
  }
  return hint
}

export type StageBuildState = 'queued' | 'running' | 'success' | 'failure' | 'aborted'

function withStageTime(i: number, st: StageState, hint: StageHint | undefined, now: number): Pick<StageInfo, 'startedAt' | 'durationMs'> {
  const start = hint?.startedAt?.[i] ?? 0
  if (!start || st === 'pending' || st === 'skipped') return {}
  const end = hint?.endedAt?.[i] ?? 0
  return { startedAt: start, durationMs: Math.max(0, (end || now) - start) }
}

export function inferStages(hint: StageHint | undefined, state: StageBuildState, mode: Mode, now = Date.now()): StageInfo[] {
  // 结构化：以脚本输出为准（含 SKIPPED），不再按 MODE 猜
  if (hint?.structured && hint.seen && hint.skipped) {
    const { seen, skipped } = hint
    // 最后一个标记若是 SKIPPED，说明该阶段没有工作要做，进度已经推进到下一阶段
    const cur = skipped[hint.idx] ? Math.min(hint.idx + 1, 3) : hint.idx
    return STAGES.map((s, i): StageInfo => {
      let st: StageState
      if (state === 'queued') st = 'pending'
      else if (seen[i] && skipped[i]) st = 'skipped'
      else if (state === 'success') st = seen[i] ? 'done' : 'skipped'
      else if (i < cur) st = seen[i] ? 'done' : 'skipped'
      else if (i === cur) st = state === 'running' ? 'running' : 'failed'
      else st = 'pending'
      return { key: s.key, label: s.label, state: st, ...withStageTime(i, st, hint, now) }
    })
  }

  // 兜底：旧的 `==> ` 关键字 / 无标记时按 MODE 估计
  const rollback = mode === 'rollback'
  const active = state === 'queued' ? -1 : rollback ? 3 : (hint?.idx ?? 0)
  const pushSeen = hint?.pushSeen ?? false
  return STAGES.map((s, i): StageInfo => {
    const key: StageKey = s.key
    let st: StageState
    if (state === 'queued') st = 'pending'
    else if (rollback && i < 3) st = 'skipped'
    else if (state === 'success') st = i === 2 && !pushSeen ? 'skipped' : 'done'
    else if (i < active) st = i === 2 && !pushSeen ? 'skipped' : 'done'
    else if (i === active) st = state === 'running' ? 'running' : 'failed'
    else st = 'pending'
    return { key, label: s.label, state: st, ...withStageTime(i, st, hint, now) }
  })
}
