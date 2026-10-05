import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { __resetForTests, buildFormFor, realApi, tuning } from './real'
import { flattenParams, inferStages, parseDescription, parseStageLine, stageIndexOfName, updateHint, withRelated } from './parse'
import { setAuthLostHandler } from './session'
import { ApiError, type BuildParams, type ParamDef } from './types'

/* ───────────── fetch 假实现 ───────────── */

interface Req {
  method: string
  path: string
  body: string
  headers: Headers
}
type Handler = (req: Req) => Response | Promise<Response>
interface Route {
  match: string // "METHOD /path-prefix"
  handler: Handler
}

const SHA = 'a'.repeat(39) + 'b'
const SHA_UPPER = SHA.toUpperCase()

let calls: Req[] = []

function jsonRes(obj: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json', ...headers } })
}

function installFetch(routes: Route[]): void {
  calls = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, init: RequestInit = {}) => {
      const req: Req = {
        method: (init.method ?? 'GET').toUpperCase(),
        path: String(input),
        body: typeof init.body === 'string' ? init.body : '',
        headers: new Headers(init.headers),
      }
      calls.push(req)
      const key = `${req.method} ${req.path}`
      const r = routes.find((x) => key.startsWith(x.match))
      if (!r) return new Response(`no route: ${key}`, { status: 599 })
      return r.handler(req)
    }),
  )
}

const callsTo = (prefix: string) => calls.filter((c) => `${c.method} ${c.path}`.startsWith(prefix))

const WHO_ANON = { anonymous: true, authenticated: true, authorities: ['anonymous'], name: 'anonymous' }
const WHO_ME = { anonymous: false, authenticated: true, authorities: ['authenticated'], name: 'admin' }

const crumbRoute = (value = 'crumb-1'): Route => ({
  match: 'GET /crumbIssuer/api/json',
  handler: () => jsonRes({ crumb: value, crumbRequestField: 'Jenkins-Crumb' }),
})

beforeEach(() => {
  __resetForTests()
  tuning.pollMs = 0
  tuning.timeoutMs = 15_000
  tuning.paramCacheMs = 0
  setAuthLostHandler(null)
})
afterEach(() => {
  vi.unstubAllGlobals()
  setAuthLostHandler(null)
})

/* ───────────── 描述解析 ───────────── */

describe('parseDescription', () => {
  const NEW = `分支 main | SHA ${SHA} | tag main-aaaaaaa | MODULE=gateway MODE=build-deploy OVERLAY=dev SHA=${SHA} IMAGE_TAG=main-aaaaaaa`

  it('新格式：取 KEY=value 与前半段', () => {
    expect(parseDescription(NEW)).toEqual({ imageTag: 'main-aaaaaaa', sha: SHA, branch: 'main', mode: 'build-deploy', overlay: 'dev', related: null })
  })

  it('RELATED：有值、空、缺失，以及写回描述', () => {
    expect(parseDescription(`${NEW} RELATED=dev,test`).related).toEqual(['dev', 'test'])
    expect(parseDescription(`${NEW} RELATED=-`).related).toEqual([])
    expect(parseDescription(NEW).related).toBeNull()
    expect(withRelated(NEW, ['dev', 'test'])).toBe(`${NEW} RELATED=dev,test`)
    expect(withRelated(`${NEW} RELATED=old`, ['dev'])).toBe(`${NEW} RELATED=dev`)
    expect(withRelated(`${NEW} RELATED=old`, [])).toBe(`${NEW} RELATED=-`)
  })

  it('新格式：分支含斜杠，回滚模式', () => {
    const d = `分支 feature/order-refund | SHA ${SHA} | tag feature-order-refund-aaaaaaa | MODULE=auth MODE=rollback OVERLAY=test SHA=${SHA} IMAGE_TAG=feature-order-refund-aaaaaaa`
    const r = parseDescription(d)
    expect(r.branch).toBe('feature/order-refund')
    expect(r.mode).toBe('rollback')
    expect(r.overlay).toBe('test')
  })

  it('旧格式：没有 SHA，分支从 tag 倒推', () => {
    const r = parseDescription('MODULE=gateway MODE=build-deploy OVERLAY=dev IMAGE_TAG=dev-1a2b3c4')
    expect(r.sha).toBe('')
    expect(r.imageTag).toBe('dev-1a2b3c4')
    expect(r.branch).toBe('dev')
  })

  it('旧镜像回滚：SHA 与分支为 unknown -> 无 SHA，分支回退到 tag', () => {
    const r = parseDescription('分支 unknown | SHA unknown | tag main-1a2b3c4 | MODULE=gateway MODE=rollback OVERLAY=dev SHA=unknown IMAGE_TAG=main-1a2b3c4')
    expect(r.sha).toBe('')
    expect(r.branch).toBe('main')
    expect(r.mode).toBe('rollback')
  })

  it('KEY=value 优先于 actions.parameters，缺失时才用参数', () => {
    const fromKv = parseDescription('MODULE=x IMAGE_TAG=main-abc1234', { IMAGE_TAG: 'param-tag', GIT_SHA: SHA })
    expect(fromKv.imageTag).toBe('main-abc1234')
    expect(fromKv.sha).toBe(SHA) // 描述没有 SHA，用参数里的完整 GIT_SHA

    const fromParams = parseDescription(null, { IMAGE_TAG: 'dev-9999999', MODE: 'rollback', OVERLAY: 'prod', BRANCH: 'dev' })
    expect(fromParams).toMatchObject({ imageTag: 'dev-9999999', mode: 'rollback', overlay: 'prod', branch: 'dev', sha: '' })
  })

  it('只接受 40 位十六进制；auto 不当作 tag', () => {
    expect(parseDescription('SHA=abc1234 IMAGE_TAG=auto').sha).toBe('')
    expect(parseDescription('SHA=abc1234 IMAGE_TAG=auto').imageTag).toBe('')
    expect(parseDescription(`SHA=${SHA_UPPER}`).sha).toBe(SHA)
  })

  it('flattenParams 摊平 actions 并忽略无参数的 action', () => {
    expect(flattenParams([{ _class: 'x' }, { parameters: [{ name: 'A', value: 'b' }, { name: 'SKIP_MVN', value: false }] }, null])).toEqual({ A: 'b', SKIP_MVN: 'false' })
  })
})

describe('日志阶段推断', () => {
  it('按 ==> 标记推进，未出现 push 则显示跳过', () => {
    let h = updateHint(undefined, ['[t] ==> checkout wealth @ abc', '[t] ==> Maven package -pl x'])
    expect(h?.idx).toBe(1)
    expect(inferStages(h, 'running', 'build-deploy').map((s) => s.state)).toEqual(['done', 'running', 'pending', 'pending'])
    h = updateHint(h, ['==> kubectl set image deploy/x'])
    expect(inferStages(h, 'running', 'build-deploy').map((s) => s.state)).toEqual(['done', 'done', 'skipped', 'running'])
    h = updateHint(updateHint(undefined, ['==> docker push r/x']), ['==> rollout status deploy/x'])
    expect(inferStages(h, 'success', 'build-deploy').map((s) => s.state)).toEqual(['done', 'done', 'done', 'done'])
  })

  it('回滚只有部署阶段；失败时当前阶段标记 failed', () => {
    expect(inferStages(undefined, 'running', 'rollback').map((s) => s.state)).toEqual(['skipped', 'skipped', 'skipped', 'running'])
    expect(inferStages(updateHint(undefined, ['==> docker build x']), 'failure', 'build-deploy').map((s) => s.state)).toEqual(['done', 'failed', 'pending', 'pending'])
    expect(inferStages(undefined, 'queued', 'build-deploy').every((s) => s.state === 'pending')).toBe(true)
  })
})

/* ───────────── 登录 / 错误分类 ───────────── */

describe('whoAmI / 未登录处理', () => {
  it('匿名：anonymous===true 视为未登录（即使 authenticated 为 true）', async () => {
    installFetch([{ match: 'GET /whoAmI/api/json', handler: () => jsonRes(WHO_ANON) }])
    const w = await realApi.whoAmI()
    expect(w).toMatchObject({ anonymous: true, authenticated: false })
  })

  it('已登录：anonymous===false', async () => {
    installFetch([{ match: 'GET /whoAmI/api/json', handler: () => jsonRes(WHO_ME) }])
    expect(await realApi.whoAmI()).toMatchObject({ anonymous: false, authenticated: true, name: 'admin' })
  })

  it('whoAmI 本身 403 也当作未登录；getInfo 取 X-Jenkins 版本', async () => {
    installFetch([{ match: 'GET /whoAmI/api/json', handler: () => new Response('forbidden', { status: 403, headers: { 'X-Jenkins': '2.555.2' } }) }])
    expect((await realApi.whoAmI()).anonymous).toBe(true)
    expect(await realApi.getInfo()).toMatchObject({ online: true, version: '2.555.2', mock: false })
  })

  it('getInfo：网络不通 -> offline', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new TypeError('failed'))))
    expect((await realApi.getInfo()).online).toBe(false)
  })

  it('GET 返回 403 且 whoAmI 匿名 -> kind=auth，并通知界面', async () => {
    const lost = vi.fn()
    setAuthLostHandler(lost)
    installFetch([
      { match: 'GET /api/json', handler: () => new Response('no', { status: 403 }) },
      { match: 'GET /whoAmI/api/json', handler: () => jsonRes(WHO_ANON) },
    ])
    const err = await realApi.getJobs().catch((e) => e)
    expect(err).toBeInstanceOf(ApiError)
    expect(err).toMatchObject({ kind: 'auth', status: 403 })
    expect(err.message).toContain('登录')
    expect(lost).toHaveBeenCalledTimes(1)
  })

  it('GET 返回 403 但已登录 -> kind=forbidden（无权限），不触发登录引导', async () => {
    const lost = vi.fn()
    setAuthLostHandler(lost)
    installFetch([
      { match: 'GET /api/json', handler: () => new Response('no', { status: 403 }) },
      { match: 'GET /whoAmI/api/json', handler: () => jsonRes(WHO_ME) },
    ])
    const err = await realApi.getJobs().catch((e) => e)
    expect(err).toMatchObject({ kind: 'forbidden', status: 403 })
    expect(err.message).toContain('没有权限')
    expect(lost).not.toHaveBeenCalled()
  })

  it('会话过期后接口 200 返回登录页 HTML -> kind=auth', async () => {
    installFetch([
      { match: 'GET /api/json', handler: () => new Response('<html>login</html>', { status: 200, headers: { 'Content-Type': 'text/html' } }) },
      { match: 'GET /whoAmI/api/json', handler: () => jsonRes(WHO_ANON) },
    ])
    expect(await realApi.getJobs().catch((e) => e)).toMatchObject({ kind: 'auth' })
  })

  it('非 2xx 抛出带状态码的明确错误', async () => {
    installFetch([{ match: 'GET /api/json', handler: () => new Response('boom', { status: 500 }) }])
    const err = await realApi.getJobs().catch((e) => e)
    expect(err).toMatchObject({ status: 500, kind: 'http' })
    expect(err.message).toContain('HTTP 500')
  })

  it('超时（默认 15s，这里缩短）-> kind=timeout', async () => {
    tuning.timeoutMs = 20
    vi.stubGlobal(
      'fetch',
      vi.fn((_u: string, init: RequestInit) => new Promise((_res, rej) => init.signal?.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError'))))),
    )
    expect(await realApi.getJobs().catch((e) => e)).toMatchObject({ kind: 'timeout' })
  })
})

/* ───────────── crumb ───────────── */

describe('crumb', () => {
  const okQueue: Route = { match: 'POST /job/wealth-gateway/buildWithParameters', handler: () => new Response('', { status: 201, headers: { Location: 'http://localhost:18080/queue/item/42/' } }) }
  const paramsRoute = (): Route => ({
    match: 'GET /job/wealth-gateway/api/json',
    handler: () => jsonRes({ property: [{ parameterDefinitions: [defOf('MODE', 'ChoiceParameterDefinition', ['build-deploy', 'rollback']), defOf('BRANCH', 'ChoiceParameterDefinition', ['main']), defOf('IMAGE_TAG', 'StringParameterDefinition')] }] }),
  })
  const P: BuildParams = { MODE: 'build-deploy', OVERLAY: 'dev', SOURCE: 'github', IMAGE_TAG: 'auto', REGISTRY: '', BRANCH: 'main', GIT_SHA: '', SKIP_MVN: false }

  it('crumb 被缓存：连续两次 POST 只取一次，并带上 crumbRequestField 头', async () => {
    installFetch([crumbRoute('c-1'), paramsRoute(), okQueue])
    await realApi.triggerBuild('wealth-gateway', P)
    await realApi.triggerBuild('wealth-gateway', P)
    expect(callsTo('GET /crumbIssuer')).toHaveLength(1)
    const posts = callsTo('POST /job/wealth-gateway/buildWithParameters')
    expect(posts).toHaveLength(2)
    expect(posts.every((p) => p.headers.get('Jenkins-Crumb') === 'c-1')).toBe(true)
  })

  it('POST 返回 403（crumb 失效）-> 刷新 crumb 重试一次并成功', async () => {
    let issued = 0
    let posts = 0
    installFetch([
      { match: 'GET /crumbIssuer/api/json', handler: () => jsonRes({ crumb: `c-${++issued}`, crumbRequestField: 'Jenkins-Crumb' }) },
      paramsRoute(),
      {
        match: 'POST /job/wealth-gateway/buildWithParameters',
        handler: (r) => {
          posts++
          return r.headers.get('Jenkins-Crumb') === 'c-2' ? new Response('', { status: 201, headers: { Location: '/queue/item/7/' } }) : new Response('No valid crumb', { status: 403 })
        },
      },
    ])
    const r = await realApi.triggerBuild('wealth-gateway', P)
    expect(r.queueId).toBe(7)
    expect(posts).toBe(2)
    expect(issued).toBe(2)
  })

  it('重试后仍 403：已登录 -> forbidden（不会无限重试）', async () => {
    let posts = 0
    installFetch([
      crumbRoute(),
      paramsRoute(),
      { match: 'POST /job/wealth-gateway/buildWithParameters', handler: () => (posts++, new Response('nope', { status: 403 })) },
      { match: 'GET /whoAmI/api/json', handler: () => jsonRes(WHO_ME) },
    ])
    const err = await realApi.triggerBuild('wealth-gateway', P).catch((e) => e)
    expect(err).toMatchObject({ kind: 'forbidden' })
    expect(posts).toBe(2)
  })

  it('取 crumb 本身 403 且匿名 -> kind=auth，不会发出 POST', async () => {
    installFetch([
      { match: 'GET /crumbIssuer/api/json', handler: () => new Response('no', { status: 403 }) },
      { match: 'GET /whoAmI/api/json', handler: () => jsonRes(WHO_ANON) },
      paramsRoute(),
      okQueue,
    ])
    expect(await realApi.triggerBuild('wealth-gateway', P).catch((e) => e)).toMatchObject({ kind: 'auth' })
    expect(callsTo('POST ')).toHaveLength(0)
  })

  it('crumbIssuer 404（未开 CSRF）-> 不带 crumb 头照常 POST', async () => {
    installFetch([{ match: 'GET /crumbIssuer/api/json', handler: () => new Response('', { status: 404 }) }, paramsRoute(), okQueue])
    await realApi.triggerBuild('wealth-gateway', P)
    expect(callsTo('POST /job/wealth-gateway')[0].headers.get('Jenkins-Crumb')).toBeNull()
  })
})

function defOf(name: string, type: string, choices?: string[], value?: string | boolean): Record<string, unknown> {
  return { name, type, description: `${name} 说明`, defaultParameterValue: { value: value ?? (choices ? choices[0] : '') }, ...(choices ? { choices } : {}) }
}

/* ───────────── resolveCommit ───────────── */

describe('resolveCommit', () => {
  /** 按约定搭一条完整链路：POST -> Location -> queue -> 构建结束 -> resolve.json */
  function resolveRoutes(opts: { json?: unknown; artifactStatus?: number; result?: string | null; queuePolls?: number; buildPolls?: number }): Route[] {
    let q = 0
    let b = 0
    return [
      crumbRoute(),
      {
        match: 'POST /job/wealth-resolve-commit/buildWithParameters',
        handler: () => new Response('', { status: 201, headers: { Location: 'http://localhost:18080/queue/item/55/' } }),
      },
      {
        match: 'GET /queue/item/55/api/json',
        handler: () => (q++ < (opts.queuePolls ?? 0) ? jsonRes({ cancelled: false }) : jsonRes({ executable: { number: 9 } })),
      },
      {
        match: 'GET /job/wealth-resolve-commit/9/api/json',
        handler: () => (b++ < (opts.buildPolls ?? 0) ? jsonRes({ building: true, result: null }) : jsonRes({ building: false, result: opts.result === undefined ? 'SUCCESS' : opts.result })),
      },
      {
        match: 'GET /job/wealth-resolve-commit/9/artifact/resolve.json',
        handler: () => (opts.artifactStatus && opts.artifactStatus !== 200 ? new Response('missing', { status: opts.artifactStatus }) : jsonRes(opts.json)),
      },
    ]
  }

  it('存在且在多个分支：用 preferred 作默认，候选 main/dev 优先；参数是 SHA/REPO 且 SHA 转小写，带 crumb', async () => {
    installFetch(resolveRoutes({ queuePolls: 2, buildPolls: 2, json: { exists: true, sha: SHA, branches: ['feature/x', 'dev', 'main'], preferred: 'main', repo: 'wealth-freedom', fetched: true } }))
    const r = await realApi.resolveCommit('wealth-freedom', SHA_UPPER)
    expect(r).toMatchObject({ status: 'ok', branch: 'main', sha: SHA, repo: 'wealth-freedom', fetched: true })
    expect(r.candidates).toEqual(['main', 'dev', 'feature/x'])

    const post = callsTo('POST /job/wealth-resolve-commit/buildWithParameters')[0]
    expect(post.path).toContain('delay=0sec')
    const form = new URLSearchParams(post.body)
    expect(form.get('SHA')).toBe(SHA)
    expect(form.get('REPO')).toBe('wealth-freedom')
    expect(form.has('GIT_SHA')).toBe(false)
    expect(post.headers.get('Jenkins-Crumb')).toBe('crumb-1')
    expect(callsTo('GET /queue/item/55/api/json')).toHaveLength(3)
  })

  it('preferred 为 dev（脚本结论）时以 preferred 为准', async () => {
    installFetch(resolveRoutes({ json: { exists: true, sha: SHA, branches: ['dev'], preferred: 'dev', repo: 'wealth-freedom-web', fetched: true } }))
    const r = await realApi.resolveCommit('wealth-freedom-web', SHA)
    expect(r.branch).toBe('dev')
    expect(r.candidates).toEqual(['dev'])
  })

  it('exists:false -> not_found；fetched:false 标记结果可能过期', async () => {
    installFetch(resolveRoutes({ json: { exists: false, sha: SHA, branches: [], preferred: null, repo: 'wealth-freedom', fetched: true } }))
    expect(await realApi.resolveCommit('wealth-freedom', SHA)).toMatchObject({ status: 'not_found', stale: false, candidates: [] })

    installFetch(resolveRoutes({ json: { exists: false, sha: SHA, branches: [], preferred: null, repo: 'wealth-freedom', fetched: false } }))
    expect(await realApi.resolveCommit('wealth-freedom', SHA)).toMatchObject({ status: 'not_found', stale: true, fetched: false })
  })

  it('存在但不在任何分支 -> no_branch', async () => {
    installFetch(resolveRoutes({ json: { exists: true, sha: SHA, branches: [], preferred: null, repo: 'wealth-freedom', fetched: true } }))
    expect(await realApi.resolveCommit('wealth-freedom', SHA)).toMatchObject({ status: 'no_branch', candidates: [] })
  })

  it('构建 SUCCESS 但 error 非空（invalid）-> 抛错，不是 ok', async () => {
    installFetch(resolveRoutes({ json: { exists: false, sha: null, branches: [], preferred: null, repo: 'wealth-freedom', fetched: false, error: 'invalid' } }))
    const err = await realApi.resolveCommit('wealth-freedom', SHA).catch((e) => e)
    expect(err).toBeInstanceOf(ApiError)
    expect(err.message).toContain('40 位')
  })

  it('构建 SUCCESS 但出现未知 error -> 抛错并带上 error 值', async () => {
    installFetch(resolveRoutes({ json: { exists: false, error: 'weird' } }))
    expect((await realApi.resolveCommit('wealth-freedom', SHA).catch((e) => e)).message).toContain('weird')
  })

  it('构建 FAILURE + repo_unavailable -> “仓库不可用”', async () => {
    installFetch(resolveRoutes({ result: 'FAILURE', json: { exists: false, sha: SHA, branches: [], preferred: null, repo: 'wealth-freedom', fetched: false, error: 'repo_unavailable' } }))
    const err = await realApi.resolveCommit('wealth-freedom', SHA).catch((e) => e)
    expect(err.message).toContain('仓库不可用')
    expect(err.message).toContain('repo_unavailable')
  })

  it('构建 FAILURE 且没有产物 -> 仍提示“仓库不可用”并指向控制台日志', async () => {
    installFetch(resolveRoutes({ result: 'FAILURE', artifactStatus: 404 }))
    const err = await realApi.resolveCommit('wealth-freedom', SHA).catch((e) => e)
    expect(err.message).toContain('仓库不可用')
    expect(err.message).toContain('/job/wealth-resolve-commit/9/console')
  })

  it('构建 FAILURE + bad_repo -> 提示仓库参数无效', async () => {
    installFetch(resolveRoutes({ result: 'FAILURE', json: { error: 'bad_repo' } }))
    expect((await realApi.resolveCommit('wealth-freedom', SHA).catch((e) => e)).message).toContain('bad_repo')
  })

  it('非 40 位十六进制：前端直接拒绝，不发任何请求', async () => {
    installFetch([])
    for (const bad of ['abc123', 'z'.repeat(40), SHA + 'a']) {
      expect(await realApi.resolveCommit('wealth-freedom', bad).catch((e) => e)).toBeInstanceOf(ApiError)
    }
    expect(calls).toHaveLength(0)
  })

  it('取消（切换模块 / 修改 SHA）：轮询中途 abort -> kind=aborted，之后不再请求', async () => {
    tuning.pollMs = 5
    installFetch(resolveRoutes({ queuePolls: 1000, json: {} }))
    const ctrl = new AbortController()
    const p = realApi.resolveCommit('wealth-freedom', SHA, ctrl.signal).catch((e) => e)
    await new Promise((r) => setTimeout(r, 30))
    ctrl.abort()
    expect(await p).toMatchObject({ kind: 'aborted' })
    const n = calls.length
    await new Promise((r) => setTimeout(r, 30))
    expect(calls.length).toBe(n)
  })
})

/* ───────────── 日志增量 / 状态 ───────────── */

describe('getBuildLog（progressiveText 增量）', () => {
  it('按 X-Text-Size 递增 start，X-More-Data 控制是否继续，半行拼接', async () => {
    const chunks = [
      { text: 'line1\nline2\nli', size: '14', more: 'true' },
      { text: 'ne3\n', size: '18', more: 'true' },
      { text: '', size: '18', more: 'false' },
    ]
    let i = 0
    installFetch([
      {
        match: 'GET /job/wealth-gateway/5/logText/progressiveText',
        handler: () => {
          const c = chunks[i++]
          return new Response(c.text, { status: 200, headers: { 'X-Text-Size': c.size, 'X-More-Data': c.more } })
        },
      },
    ])
    const a = await realApi.getBuildLog('wealth-gateway', 5, 0)
    expect(a).toEqual({ lines: ['line1', 'line2'], next: 14, more: true })
    const b = await realApi.getBuildLog('wealth-gateway', 5, a.next)
    expect(b).toEqual({ lines: ['line3'], next: 18, more: true })
    const c = await realApi.getBuildLog('wealth-gateway', 5, b.next)
    expect(c).toEqual({ lines: [], next: 18, more: false })
    expect(calls.map((x) => x.path)).toEqual([
      '/job/wealth-gateway/5/logText/progressiveText?start=0',
      '/job/wealth-gateway/5/logText/progressiveText?start=14',
      '/job/wealth-gateway/5/logText/progressiveText?start=18',
    ])
  })

  it('构建结束时最后半行也会输出；ANSI 颜色码被去掉', async () => {
    installFetch([
      { match: 'GET /job/j/1/logText', handler: () => new Response('\u001b[32mok\u001b[0m\ntail', { status: 200, headers: { 'X-Text-Size': '9', 'X-More-Data': 'false' } }) },
    ])
    expect((await realApi.getBuildLog('j', 1, 0)).lines).toEqual(['ok', 'tail'])
  })

  it('日志里的 ==> 标记驱动 getBuildStatus 的阶段', async () => {
    installFetch([
      { match: 'GET /job/wealth-gateway/5/logText', handler: () => new Response('[t] ==> checkout x\n[t] ==> docker build wealth-gateway:t\n', { status: 200, headers: { 'X-Text-Size': '60', 'X-More-Data': 'true' } }) },
      {
        match: 'GET /job/wealth-gateway/5/api/json',
        handler: () =>
          jsonRes({
            number: 5,
            building: true,
            result: null,
            timestamp: Date.now() - 30_000,
            duration: 0,
            estimatedDuration: 60_000,
            description: `分支 main | SHA ${SHA} | tag main-aaaaaaa | MODULE=gateway MODE=build-deploy OVERLAY=dev SHA=${SHA} IMAGE_TAG=main-aaaaaaa`,
            executor: { progressPercent: 50 },
            actions: [{ parameters: [{ name: 'OVERLAY', value: 'dev' }, { name: 'SKIP_MVN', value: false }] }],
          }),
      },
    ])
    await realApi.getBuildLog('wealth-gateway', 5, 0)
    const st = await realApi.getBuildStatus('wealth-gateway', 1, 5)
    expect(st).toMatchObject({ state: 'running', progress: 50, number: 5, imageTag: 'main-aaaaaaa', branch: 'main', mode: 'build-deploy' })
    expect(st.stages.map((s) => s.state)).toEqual(['done', 'running', 'pending', 'pending'])
    expect(callsTo('GET /job/wealth-gateway/5/api/json')[0].path).toContain('executor[progressPercent]')
  })

  it('getBuildStatus：排队中 -> queued；有 executable 后读构建详情；取消 -> aborted', async () => {
    let n = 0
    installFetch([
      {
        match: 'GET /queue/item/3/api/json',
        handler: () => (n++ === 0 ? jsonRes({}) : n === 2 ? jsonRes({ executable: { number: 11 } }) : jsonRes({ cancelled: true })),
      },
      { match: 'GET /job/j/11/api/json', handler: () => jsonRes({ number: 11, building: false, result: 'SUCCESS', timestamp: 1, duration: 4000, description: null, actions: [] }) },
    ])
    expect(await realApi.getBuildStatus('j', 3, null)).toMatchObject({ state: 'queued', number: 0 })
    expect(await realApi.getBuildStatus('j', 3, null)).toMatchObject({ state: 'success', number: 11, progress: 100, durationMs: 4000 })
    expect(await realApi.getBuildStatus('j', 3, null)).toMatchObject({ state: 'aborted' })
  })
})

/* ───────────── 参数 / 触发 / 历史 / Job 列表 / 刷新分支 ───────────── */

describe('参数定义与触发', () => {
  const moduleDefs = [
    defOf('MODE', 'ChoiceParameterDefinition', ['build-deploy', 'rollback']),
    defOf('OVERLAY', 'ChoiceParameterDefinition', ['dev', 'test', 'prod', 'local']),
    defOf('SOURCE', 'ChoiceParameterDefinition', ['github', 'local-mount']),
    defOf('IMAGE_TAG', 'StringParameterDefinition', undefined, 'auto'),
    defOf('REGISTRY', 'StringParameterDefinition'),
    defOf('BRANCH', 'ChoiceParameterDefinition', ['main', 'dev']),
    defOf('GIT_SHA', 'StringParameterDefinition'),
    defOf('SKIP_MVN', 'BooleanParameterDefinition', undefined, false),
  ]
  const P: BuildParams = { MODE: 'build-deploy', OVERLAY: 'dev', SOURCE: 'github', IMAGE_TAG: 'auto', REGISTRY: '', BRANCH: 'dev', GIT_SHA: '', SKIP_MVN: true }
  const defs = moduleDefs.map((d) => ({ ...d }) as unknown as RawParamDef).map(toDef)

  interface RawParamDef { name: string; type: string; description: string; defaultParameterValue: { value: string | boolean }; choices?: string[] }
  function toDef(x: RawParamDef): ParamDef {
    return {
      name: x.name,
      type: x.type.startsWith('Choice') ? 'choice' : x.type.startsWith('Boolean') ? 'boolean' : 'string',
      description: x.description,
      defaultValue: x.defaultParameterValue.value,
      choices: x.choices,
    }
  }

  it('getJobParams：读取并映射 parameterDefinitions（choice / string / boolean）', async () => {
    installFetch([{ match: 'GET /job/wealth-gateway/api/json', handler: () => jsonRes({ property: [{}, { parameterDefinitions: moduleDefs }] }) }])
    const d = await realApi.getJobParams('wealth-gateway')
    expect(d.find((x) => x.name === 'BRANCH')).toMatchObject({ type: 'choice', choices: ['main', 'dev'], defaultValue: 'main' })
    expect(d.find((x) => x.name === 'SKIP_MVN')).toMatchObject({ type: 'boolean', defaultValue: false })
    expect(d.find((x) => x.name === 'IMAGE_TAG')).toMatchObject({ type: 'string', defaultValue: 'auto' })
    expect(calls[0].path).toContain('tree=property[parameterDefinitions[name,type,defaultParameterValue[value],choices,description]]')
  })

  it('listBranches：meta.json 读不到时回退 BRANCH 的 choices；都没有则兜底 main/dev', async () => {
    installFetch([{ match: 'GET /job/wealth-gateway/api/json', handler: () => jsonRes({ property: [{ parameterDefinitions: moduleDefs }] }) }])
    expect(await realApi.listBranches('wealth-freedom', 'wealth-gateway')).toEqual(['main', 'dev'])
    __resetForTests()
    installFetch([{ match: 'GET /job/wealth-gateway/api/json', handler: () => jsonRes({ property: [] }) }])
    expect(await realApi.listBranches('wealth-freedom', 'wealth-gateway')).toEqual(['main', 'dev'])
  })

  it('buildFormFor：只传 Job 定义里存在的参数（前端模块没有 SKIP_MVN）', () => {
    const webDefs = defs.filter((d) => d.name !== 'SKIP_MVN')
    const { form } = buildFormFor('wealth-freedom-web', webDefs, P)
    expect(Object.keys(form).sort()).toEqual(['BRANCH', 'GIT_SHA', 'IMAGE_TAG', 'MODE', 'OVERLAY', 'REGISTRY', 'SOURCE'])
    expect(buildFormFor('wealth-gateway', defs, P).form.SKIP_MVN).toBe('true')
  })

  it('buildFormFor：指定 commit 传完整小写 GIT_SHA；wealth-all 不传', () => {
    expect(buildFormFor('wealth-gateway', defs, { ...P, GIT_SHA: SHA_UPPER }).form.GIT_SHA).toBe(SHA)
    expect(buildFormFor('wealth-all', defs, { ...P, GIT_SHA: SHA }).form.GIT_SHA).toBe('')
  })

  it('buildFormFor：回滚 = MODE=rollback + IMAGE_TAG，不带 SHA/SKIP_MVN=true；缺 tag 报错', () => {
    const { form } = buildFormFor('wealth-gateway', defs, { ...P, MODE: 'rollback', IMAGE_TAG: 'main-aaaaaaa', GIT_SHA: SHA, SKIP_MVN: true, BRANCH: 'feature/gone' })
    expect(form).toMatchObject({ MODE: 'rollback', IMAGE_TAG: 'main-aaaaaaa', GIT_SHA: '', SKIP_MVN: 'false', BRANCH: 'main' })
    expect(() => buildFormFor('wealth-gateway', defs, { ...P, MODE: 'rollback', IMAGE_TAG: 'auto' })).toThrow(/IMAGE_TAG/)
  })

  it('buildFormFor：BRANCH 不在选项里——普通构建提示刷新分支；指定 SHA 时退回默认选项并给出说明', () => {
    expect(() => buildFormFor('wealth-gateway', defs, { ...P, BRANCH: 'feature/new' })).toThrow(/刷新分支/)
    const r = buildFormFor('wealth-gateway', defs, { ...P, BRANCH: 'feature/new', GIT_SHA: SHA })
    expect(r.form.BRANCH).toBe('main')
    expect(r.notice).toContain('feature/new')
  })

  it('buildFormFor：MODE/OVERLAY 不在 Job 选项里直接报错', () => {
    expect(() => buildFormFor('wealth-gateway', defs, { ...P, OVERLAY: 'staging' as never })).toThrow(/OVERLAY/)
  })

  it('triggerBuild：POST 表单 + crumb，返回 Location 里的队列号与说明', async () => {
    installFetch([
      crumbRoute(),
      { match: 'GET /job/wealth-gateway/api/json', handler: () => jsonRes({ property: [{ parameterDefinitions: moduleDefs }] }) },
      { match: 'POST /job/wealth-gateway/buildWithParameters', handler: () => new Response('', { status: 201, headers: { Location: 'http://localhost:18080/queue/item/88/' } }) },
    ])
    const r = await realApi.triggerBuild('wealth-gateway', { ...P, GIT_SHA: SHA })
    expect(r).toMatchObject({ queueId: 88, buildNumber: null })
    const post = callsTo('POST /job/wealth-gateway')[0]
    expect(post.headers.get('Content-Type')).toContain('application/x-www-form-urlencoded')
    expect(Object.fromEntries(new URLSearchParams(post.body))).toMatchObject({ MODE: 'build-deploy', BRANCH: 'dev', GIT_SHA: SHA, IMAGE_TAG: 'auto', SKIP_MVN: 'true' })
  })

  it('triggerBuild：响应缺 Location -> 明确报错', async () => {
    installFetch([
      crumbRoute(),
      { match: 'GET /job/wealth-gateway/api/json', handler: () => jsonRes({ property: [{ parameterDefinitions: moduleDefs }] }) },
      { match: 'POST /job/wealth-gateway/buildWithParameters', handler: () => new Response('', { status: 201 }) },
    ])
    expect((await realApi.triggerBuild('wealth-gateway', P).catch((e) => e)).message).toContain('Location')
  })
})

describe('getJobs / listHistory', () => {
  it('getJobs：一次请求取全部，缺失的 Job 当作无构建', async () => {
    installFetch([
      {
        match: 'GET /api/json?tree=jobs[name,color,lastBuild[number,result,building,timestamp]]',
        handler: () =>
          jsonRes({
            jobs: [
              { name: 'wealth-gateway', color: 'blue', lastBuild: { number: 12, result: 'SUCCESS', building: false, timestamp: 1000 } },
              { name: 'wealth-auth', color: 'red_anime', lastBuild: { number: 3, result: null, building: true, timestamp: 2000 } },
              { name: 'wealth-refresh-branches', lastBuild: null },
            ],
          }),
      },
    ])
    const jobs = await realApi.getJobs()
    expect(calls).toHaveLength(1)
    expect(jobs).toHaveLength(8)
    expect(jobs.find((j) => j.job === 'wealth-gateway')).toMatchObject({ lastResult: 'SUCCESS', lastBuildNumber: 12, lastBuilding: false })
    expect(jobs.find((j) => j.job === 'wealth-auth')).toMatchObject({ lastResult: null, lastBuilding: true })
    expect(jobs.find((j) => j.job === 'wealth-ecommerce-web')).toMatchObject({ lastBuildNumber: null })
    expect(jobs.find((j) => j.job === 'wealth-all')).toMatchObject({ supportsCommit: false, supportsRollback: false })
  })

  const mk = (number: number, result: string | null, desc: string | null, params: Record<string, string> = {}, building = false) => ({
    number,
    result,
    building,
    timestamp: 1_000_000 - number,
    duration: 1,
    description: desc,
    actions: [{ parameters: Object.entries(params).map(([name, value]) => ({ name, value })) }],
  })

  it('listHistory：新旧格式混合、unknown SHA 不可对比；运行中 = 所选 overlay 最近一次成功', async () => {
    installFetch([
      {
        match: 'GET /job/wealth-gateway/api/json?tree=builds[number,result,building,timestamp,duration,description,actions[parameters[name,value]],url]{0,10}',
        handler: () =>
          jsonRes({
            builds: [
              mk(9, null, `分支 dev | SHA ${SHA} | tag dev-aaaaaaa | MODULE=gateway MODE=build-deploy OVERLAY=dev SHA=${SHA} IMAGE_TAG=dev-aaaaaaa`, {}, true),
              mk(8, 'FAILURE', `分支 dev | SHA ${SHA} | tag dev-bbbbbbb | MODULE=gateway MODE=build-deploy OVERLAY=dev SHA=${SHA} IMAGE_TAG=dev-bbbbbbb`),
              mk(7, 'SUCCESS', `分支 main | SHA ${SHA} | tag main-ccccccc | MODULE=gateway MODE=build-deploy OVERLAY=test SHA=${SHA} IMAGE_TAG=main-ccccccc`),
              mk(6, 'SUCCESS', `分支 unknown | SHA unknown | tag main-ddddddd | MODULE=gateway MODE=rollback OVERLAY=dev SHA=unknown IMAGE_TAG=main-ddddddd`),
              mk(5, 'SUCCESS', 'MODULE=gateway MODE=build-deploy OVERLAY=dev IMAGE_TAG=main-eeeeeee'),
              mk(4, 'SUCCESS', null, { IMAGE_TAG: 'auto', OVERLAY: 'dev', MODE: 'build-deploy' }),
            ],
          }),
      },
    ])
    const h = await realApi.listHistory('wealth-gateway', 10, 'dev')
    expect(h.map((x) => x.number)).toEqual([9, 8, 7, 6, 5, 4])

    const by = (n: number) => h.find((x) => x.number === n)!
    expect(by(9)).toMatchObject({ building: true, running: false, sha: SHA, canCompare: true, imageTag: 'dev-aaaaaaa' })
    expect(by(7)).toMatchObject({ running: false, overlay: 'test' }) // 不是 dev 环境，不算 dev 的“运行中”
    expect(by(6)).toMatchObject({ running: true, sha: '', canCompare: false, mode: 'rollback', imageTag: 'main-ddddddd', branch: 'main' })
    expect(by(5)).toMatchObject({ running: false, sha: '', canCompare: false, imageTag: 'main-eeeeeee', branch: 'main' })
    expect(by(4)).toMatchObject({ imageTag: '', canCompare: false })
    expect(h.filter((x) => x.running)).toHaveLength(1)

    const forTest = await realApi.listHistory('wealth-gateway', 10, 'test')
    expect(forTest.find((x) => x.running)?.number).toBe(7)
  })

  it('saveRelatedBranches：把 RELATED 写回该次构建描述', async () => {
    const desc = `分支 main | SHA ${SHA} | tag main-aaaaaaa | MODULE=gateway MODE=build-deploy OVERLAY=dev SHA=${SHA} IMAGE_TAG=main-aaaaaaa`
    installFetch([
      crumbRoute(),
      { match: 'GET /job/wealth-gateway/9/api/json', handler: () => jsonRes({ description: desc }) },
      { match: 'POST /job/wealth-gateway/9/submitDescription', handler: () => new Response('', { status: 200 }) },
    ])
    await realApi.saveRelatedBranches('wealth-gateway', 9, ['dev', 'test'])
    const post = callsTo('POST /job/wealth-gateway/9/submitDescription')[0]
    expect(post.headers.get('Jenkins-Crumb')).toBe('crumb-1')
    expect(decodeURIComponent(post.body.replace(/\+/g, ' '))).toContain(`${desc} RELATED=dev,test`)
  })
})

describe('refreshBranches', () => {
  const branchDefs = (choices: string[]) => ({ property: [{ parameterDefinitions: [defOf('BRANCH', 'ChoiceParameterDefinition', choices)] }] })

  function routes(opts: { refreshHasParams: boolean; result: string; choicesAfter?: string[] }): Route[] {
    let refreshed = false
    return [
      crumbRoute(),
      { match: 'GET /job/wealth-refresh-branches/api/json', handler: () => jsonRes(opts.refreshHasParams ? { property: [{ parameterDefinitions: [defOf('VERBOSE', 'BooleanParameterDefinition', undefined, false)] }] } : { property: [{}] }) },
      { match: 'POST /job/wealth-refresh-branches/', handler: () => ((refreshed = true), new Response('', { status: 201, headers: { Location: '/queue/item/70/' } })) },
      { match: 'GET /queue/item/70/api/json', handler: () => jsonRes({ executable: { number: 4 } }) },
      { match: 'GET /job/wealth-refresh-branches/4/api/json', handler: () => jsonRes({ building: false, result: opts.result }) },
      { match: 'GET /job/wealth-gateway/api/json', handler: () => jsonRes(branchDefs(refreshed ? (opts.choicesAfter ?? ['main', 'dev']) : ['main'])) },
    ]
  }

  it('无参数 Job 用 /build；结束后重读参数得到新分支', async () => {
    installFetch(routes({ refreshHasParams: false, result: 'SUCCESS' }))
    expect(await realApi.listBranches('wealth-freedom', 'wealth-gateway')).toEqual(['main'])
    const list = await realApi.refreshBranches('wealth-freedom', 'wealth-gateway')
    expect(list).toEqual(['main', 'dev'])
    expect(callsTo('POST /job/wealth-refresh-branches/build')).toHaveLength(1)
    expect(callsTo('POST /job/wealth-refresh-branches/buildWithParameters')).toHaveLength(0)
  })

  it('带参数 Job 用 /buildWithParameters', async () => {
    installFetch(routes({ refreshHasParams: true, result: 'SUCCESS' }))
    await realApi.refreshBranches('wealth-freedom', 'wealth-gateway')
    expect(callsTo('POST /job/wealth-refresh-branches/buildWithParameters')).toHaveLength(1)
  })

  it('构建失败（如容器缺 python3）-> 给出提示与日志位置', async () => {
    installFetch(routes({ refreshHasParams: false, result: 'FAILURE' }))
    const err = await realApi.refreshBranches('wealth-freedom', 'wealth-gateway').catch((e) => e)
    expect(err.message).toContain('刷新分支失败')
    expect(err.message).toContain('/job/wealth-refresh-branches/4/console')
  })
})

describe('stopBuild / cancelQueued / consoleUrl', () => {
  it('stop 与 cancelItem 带 crumb 且接受 302 跟随后的 200', async () => {
    installFetch([crumbRoute(), { match: 'POST /job/j/3/stop', handler: () => new Response('<html/>', { status: 200 }) }, { match: 'POST /queue/cancelItem?id=9', handler: () => new Response('', { status: 200 }) }])
    await realApi.stopBuild('j', 3)
    await realApi.cancelQueued?.(9)
    expect(callsTo('POST ').every((c) => c.headers.get('Jenkins-Crumb') === 'crumb-1')).toBe(true)
    expect(realApi.consoleUrl('j', 3)).toBe('/job/j/3/consoleText')
  })
})

/* ───────────── meta.json 分支 / tag 来源 ───────────── */

describe('meta.json 作为分支来源', () => {
  const META = {
    keep: 10,
    branches: { 'wealth-freedom': ['main', 'dev', 'release/1.8'], 'wealth-freedom-web': ['main', 'web-dev'], 'wealth-ecommerce-web': ['main'], 'wealth-all': ['main'] },
    tags: {
      'wealth-gateway': [{ tag: 'dev-aaaaaaa', created: '1 hour ago', size: '300MB' }, 'main-bbbbbbb'],
      'wealth-freedom-web': [{ tag: 'main-ccccccc', created: 'x', size: 'y' }],
    },
  }
  const metaRoute = (status = 200): Route => ({ match: 'GET /userContent/wealth-data/meta.json', handler: () => (status === 200 ? jsonRes(META) : new Response('nf', { status })) })
  const jobDefs = (branch: Record<string, unknown>) => ({ property: [{ parameterDefinitions: [branch] }] })
  const choiceBranch = defOf('BRANCH', 'ChoiceParameterDefinition', ['main', 'job-only'])
  const stringBranch = defOf('BRANCH', 'StringParameterDefinition', undefined, 'main')
  const jobRoute = (branch: Record<string, unknown>): Route => ({ match: 'GET /job/', handler: () => jsonRes(jobDefs(branch)) })

  it('meta.json 优先：按 Job 对应仓库取 branches，同源 same-origin，且不再请求 Job 参数', async () => {
    installFetch([metaRoute(), jobRoute(choiceBranch)])
    expect(await realApi.listBranchOptions!('wealth-freedom', 'wealth-gateway')).toEqual({ branches: ['main', 'dev', 'release/1.8'], source: 'meta' })
    expect(calls[0].path).toBe('/userContent/wealth-data/meta.json')
    expect(vi.mocked(fetch).mock.calls[0][1]).toMatchObject({ credentials: 'same-origin' })
    expect(callsTo('GET /job/')).toHaveLength(0)
  })

  it('不同 Job 对应不同仓库 key（wealth-freedom-web / wealth-all）', async () => {
    installFetch([metaRoute()])
    expect(await realApi.listBranches('wealth-freedom-web', 'wealth-freedom-web')).toEqual(['main', 'web-dev'])
    expect(await realApi.listBranches('wealth-all', 'wealth-all')).toEqual(['main'])
  })

  it('meta.json 404 -> 回退 Job 的 BRANCH choices（choice 类型）', async () => {
    installFetch([metaRoute(404), jobRoute(choiceBranch)])
    expect(await realApi.listBranchOptions!('wealth-freedom', 'wealth-gateway')).toEqual({ branches: ['main', 'job-only'], source: 'job' })
  })

  it('meta.json 没有该仓库 / 坏 JSON / 网络错误 -> 同样回退', async () => {
    installFetch([{ match: 'GET /userContent/', handler: () => jsonRes({ branches: { other: ['x'] } }) }, jobRoute(choiceBranch)])
    expect((await realApi.listBranchOptions!('wealth-freedom', 'wealth-gateway')).source).toBe('job')

    __resetForTests()
    installFetch([{ match: 'GET /userContent/', handler: () => new Response('{bad', { status: 200, headers: { 'Content-Type': 'application/json' } }) }, jobRoute(choiceBranch)])
    expect((await realApi.listBranchOptions!('wealth-freedom', 'wealth-gateway')).source).toBe('job')

    __resetForTests()
    installFetch([{ match: 'GET /userContent/', handler: () => Promise.reject(new TypeError('net')) }, jobRoute(choiceBranch)])
    expect((await realApi.listBranchOptions!('wealth-freedom', 'wealth-gateway')).source).toBe('job')
  })

  it('BRANCH 是 string 类型且 meta.json 读不到 -> 兜底 main/dev 并提示先刷新分支', async () => {
    installFetch([metaRoute(404), jobRoute(stringBranch)])
    const o = await realApi.listBranchOptions!('wealth-freedom', 'wealth-gateway')
    expect(o).toMatchObject({ branches: ['main', 'dev'], source: 'default' })
    expect(o.notice).toContain('刷新分支')
  })

  it('BRANCH 是 string 类型但 meta.json 有分支 -> 用 meta.json', async () => {
    installFetch([metaRoute(), jobRoute(stringBranch)])
    expect((await realApi.listBranchOptions!('wealth-freedom', 'wealth-gateway')).source).toBe('meta')
  })

  it('meta.json 403 且匿名 -> 抛 auth（不是静默回退）', async () => {
    installFetch([metaRoute(403), { match: 'GET /whoAmI/api/json', handler: () => jsonRes(WHO_ANON) }])
    expect(await realApi.listBranches('wealth-freedom', 'wealth-gateway').catch((e) => e)).toMatchObject({ kind: 'auth' })
  })

  it('BRANCH 为 string：触发构建直接传值，不做 choices 校验', async () => {
    const defsStr = [defOf('MODE', 'ChoiceParameterDefinition', ['build-deploy', 'rollback']), stringBranch, defOf('IMAGE_TAG', 'StringParameterDefinition', undefined, 'auto')]
    installFetch([
      crumbRoute(),
      { match: 'GET /job/wealth-gateway/api/json', handler: () => jsonRes({ property: [{ parameterDefinitions: defsStr }] }) },
      { match: 'POST /job/wealth-gateway/buildWithParameters', handler: () => new Response('', { status: 201, headers: { Location: '/queue/item/5/' } }) },
    ])
    const P: BuildParams = { MODE: 'build-deploy', OVERLAY: 'dev', SOURCE: 'github', IMAGE_TAG: 'auto', REGISTRY: '', BRANCH: 'feature/not-in-any-list', GIT_SHA: '', SKIP_MVN: false }
    const r = await realApi.triggerBuild('wealth-gateway', P)
    expect(r.notice).toBeUndefined()
    expect(new URLSearchParams(callsTo('POST /job/wealth-gateway')[0].body).get('BRANCH')).toBe('feature/not-in-any-list')
  })

  it('BRANCH 为 choice：不在 choices 里仍然校验（普通构建报错、指定 SHA 回退并提示）', () => {
    const defsChoice = [defOf('BRANCH', 'ChoiceParameterDefinition', ['main', 'dev'])].map((d) => ({
      name: d.name as string, type: 'choice' as const, description: '', defaultValue: 'main', choices: ['main', 'dev'],
    }))
    const base: BuildParams = { MODE: 'build-deploy', OVERLAY: 'dev', SOURCE: 'github', IMAGE_TAG: 'auto', REGISTRY: '', BRANCH: 'feature/x', GIT_SHA: '', SKIP_MVN: false }
    expect(() => buildFormFor('wealth-gateway', defsChoice, base)).toThrow(/刷新分支/)
    expect(buildFormFor('wealth-gateway', defsChoice, { ...base, GIT_SHA: SHA }).notice).toBeTruthy()
    const defsString: ParamDef[] = [{ name: 'BRANCH', type: 'string', description: '', defaultValue: 'main' }]
    expect(buildFormFor('wealth-gateway', defsString, base).form.BRANCH).toBe('feature/x')
  })

  it('refreshBranches：构建成功后重新读取 meta.json（不是 Job 参数）', async () => {
    let refreshed = false
    installFetch([
      crumbRoute(),
      { match: 'GET /job/wealth-refresh-branches/api/json', handler: () => jsonRes({ property: [{}] }) },
      { match: 'POST /job/wealth-refresh-branches/build', handler: () => ((refreshed = true), new Response('', { status: 201, headers: { Location: '/queue/item/70/' } })) },
      { match: 'GET /queue/item/70/api/json', handler: () => jsonRes({ executable: { number: 4 } }) },
      { match: 'GET /job/wealth-refresh-branches/4/api/json', handler: () => jsonRes({ building: false, result: 'SUCCESS' }) },
      { match: 'GET /userContent/wealth-data/meta.json', handler: () => jsonRes({ branches: { 'wealth-freedom': refreshed ? ['main', 'dev', 'new-branch'] : ['main'] } }) },
      jobRoute(stringBranch),
    ])
    tuning.paramCacheMs = 60_000 // 缓存开着也必须在刷新后重读
    expect(await realApi.listBranches('wealth-freedom', 'wealth-gateway')).toEqual(['main'])
    expect(await realApi.refreshBranches('wealth-freedom', 'wealth-gateway')).toEqual(['main', 'dev', 'new-branch'])
    expect(callsTo('GET /userContent/wealth-data/meta.json')).toHaveLength(2)
  })

  it('listExtraTags：tags.<镜像名>，兼容对象与字符串；wealth-all 没有镜像', async () => {
    installFetch([metaRoute()])
    expect(await realApi.listExtraTags!('wealth-gateway')).toEqual(['dev-aaaaaaa', 'main-bbbbbbb'])
    expect(await realApi.listExtraTags!('wealth-auth')).toEqual([])
    expect(await realApi.listExtraTags!('wealth-all')).toEqual([])
    installFetch([metaRoute(404)])
    __resetForTests()
    expect(await realApi.listExtraTags!('wealth-gateway')).toEqual([])
  })
})

/* ───────────── `==> STAGE n/m 名称` ───────────── */

describe('STAGE 结构化阶段行', () => {
  it('parseStageLine：按阶段名或序号解析，带时间戳前缀也行', () => {
    expect(parseStageLine('[2026-10-04T03:00:00Z] ==> STAGE 1/4 拉代码')).toMatchObject({ n: 1, total: 4, idx: 0 })
    expect(parseStageLine('==> STAGE 2/4 构建')).toMatchObject({ idx: 1, name: '构建' })
    expect(parseStageLine('==> STAGE 3/4 推镜像')).toMatchObject({ idx: 2 })
    expect(parseStageLine('==> STAGE 4/4 部署')).toMatchObject({ idx: 3 })
    expect(parseStageLine('==> STAGE 2/4 Maven package')?.idx).toBe(1)
    expect(parseStageLine('==> STAGE 3/4 docker push')?.idx).toBe(2)
    expect(parseStageLine('==> STAGE 4/4 rollout')?.idx).toBe(3)
  })

  it('名称认不出：总数为 4 按序号，否则忽略', () => {
    expect(parseStageLine('==> STAGE 3/4 ???')?.idx).toBe(2)
    expect(parseStageLine('==> STAGE 3/5 ???')).toBeNull()
    expect(parseStageLine('==> STAGE x/y z')).toBeNull()
    expect(parseStageLine('==> checkout x')).toBeNull()
    expect(stageIndexOfName('验收')).toBe(3)
  })

  it('STAGE 行优先：出现后旧的 ==> 关键字不再改阶段', () => {
    let h = updateHint(undefined, ['==> STAGE 1/4 拉代码', '==> checkout x'])
    expect(h).toMatchObject({ idx: 0, structured: true })
    h = updateHint(h, ['==> STAGE 2/4 构建', '==> kubectl set image deploy/x']) // 旧关键字会误判到 3
    expect(h?.idx).toBe(1)
    expect(inferStages(h, 'running', 'build-deploy').map((s) => s.state)).toEqual(['done', 'running', 'pending', 'pending'])
    h = updateHint(h, ['==> STAGE 4/4 部署', '==> 完成 MODE=build-deploy'])
    expect(h).toMatchObject({ idx: 3, pushSeen: false, done: true })
    expect(inferStages(h, 'success', 'build-deploy').map((s) => s.state)).toEqual(['done', 'done', 'skipped', 'done'])
  })

  it('没有 STAGE 行时仍用旧 ==> 关键字兜底；STAGE 出现前的旧标记不影响后续', () => {
    const legacy = updateHint(undefined, ['==> Maven package -pl x'])
    expect(legacy).toMatchObject({ idx: 1 })
    expect(legacy?.structured).toBeUndefined()
    const mixed = updateHint(legacy, ['==> STAGE 3/4 推镜像'])
    expect(mixed).toMatchObject({ idx: 2, structured: true, pushSeen: true })
  })

  it('getBuildLog 读到 STAGE 行后 getBuildStatus 据此给出阶段', async () => {
    installFetch([
      { match: 'GET /job/wealth-gateway/8/logText', handler: () => new Response('==> STAGE 1/4 拉代码\n==> STAGE 2/4 构建\n==> STAGE 3/4 推镜像\n', { status: 200, headers: { 'X-Text-Size': '70', 'X-More-Data': 'true' } }) },
      { match: 'GET /job/wealth-gateway/8/api/json', handler: () => jsonRes({ number: 8, building: true, result: null, timestamp: Date.now(), estimatedDuration: 1000, actions: [] }) },
    ])
    await realApi.getBuildLog('wealth-gateway', 8, 0)
    const st = await realApi.getBuildStatus('wealth-gateway', 1, 8)
    expect(st.stages.map((x) => x.state)).toEqual(['done', 'done', 'running', 'pending'])
  })
})

/* ───────────── 真实脚本格式：==> STAGE <n>/4 [<module>] <name> [SKIPPED] ───────────── */

describe('STAGE 行（与 pipeline-wealth-module.sh 的 stage() 输出对齐）', () => {
  /** 与脚本 printf '==> STAGE %s/%s %s%s%s\n' 完全相同的拼法 */
  const stageLine = (n: number, name: string, opts: { prefix?: string; skipped?: boolean } = {}) =>
    `==> STAGE ${n}/4 ${opts.prefix ? `${opts.prefix} ` : ''}${name}${opts.skipped ? ' SKIPPED' : ''}`
  const states = (lines: string[], st: 'running' | 'success' | 'failure' = 'running', mode: 'build-deploy' | 'rollback' = 'build-deploy') =>
    inferStages(updateHint(undefined, lines), st, mode).map((x) => x.state)

  it('parseStageLine：英文 key、[module] 前缀、SKIPPED 结尾、时间戳前缀', () => {
    expect(parseStageLine(stageLine(1, 'checkout'))).toEqual({ n: 1, total: 4, name: 'checkout', idx: 0, module: undefined, skipped: false })
    expect(parseStageLine(stageLine(2, 'build', { skipped: true }))).toMatchObject({ idx: 1, skipped: true, module: undefined, name: 'build' })
    expect(parseStageLine(stageLine(3, 'push', { prefix: '[ecommerce-web]' }))).toMatchObject({ idx: 2, module: 'ecommerce-web', skipped: false, name: 'push' })
    expect(parseStageLine(stageLine(2, 'build', { prefix: '[gateway]', skipped: true }))).toMatchObject({ idx: 1, module: 'gateway', skipped: true })
    expect(parseStageLine(`[2026-10-04T03:30:00.123Z] ${stageLine(4, 'deploy', { prefix: '[auth]' })}`)).toMatchObject({ idx: 3, module: 'auth' })
    for (const [i, k] of ['checkout', 'build', 'push', 'deploy'].entries()) expect(stageIndexOfName(k)).toBe(i)
  })

  it('SKIP_MVN：build SKIPPED 后不卡在被跳过的阶段，进度推进到 push', () => {
    const afterSkip = [stageLine(1, 'checkout'), stageLine(2, 'build', { skipped: true })]
    expect(states(afterSkip)).toEqual(['done', 'skipped', 'running', 'pending'])
    expect(states([...afterSkip, stageLine(3, 'push')])).toEqual(['done', 'skipped', 'running', 'pending'])
    expect(states([...afterSkip, stageLine(3, 'push'), stageLine(4, 'deploy')])).toEqual(['done', 'skipped', 'done', 'running'])
    expect(states([...afterSkip, stageLine(3, 'push'), stageLine(4, 'deploy')], 'success')).toEqual(['done', 'skipped', 'done', 'done'])
  })

  it('前端模块：build SKIPPED(Dockerfile 内编译)，失败时停在当前阶段', () => {
    const lines = [stageLine(1, 'checkout'), stageLine(2, 'build', { skipped: true }), stageLine(3, 'push')]
    expect(states(lines, 'failure')).toEqual(['done', 'skipped', 'failed', 'pending'])
  })

  it('回滚：checkout/build SKIPPED；有 REGISTRY 时 push 也 SKIPPED；不再按 MODE 猜', () => {
    const noReg = [stageLine(1, 'checkout', { skipped: true }), stageLine(2, 'build', { skipped: true }), stageLine(3, 'push'), stageLine(4, 'deploy')]
    expect(states(noReg, 'running', 'rollback')).toEqual(['skipped', 'skipped', 'done', 'running'])
    const reg = [stageLine(1, 'checkout', { skipped: true }), stageLine(2, 'build', { skipped: true }), stageLine(3, 'push', { skipped: true }), stageLine(4, 'deploy')]
    expect(states(reg, 'running', 'rollback')).toEqual(['skipped', 'skipped', 'skipped', 'running'])
    expect(states(reg, 'success', 'rollback')).toEqual(['skipped', 'skipped', 'skipped', 'done'])
    // 刚启动还没有 push 标记：前两个已跳过，进度在 push
    expect(states(reg.slice(0, 2), 'running', 'rollback')).toEqual(['skipped', 'skipped', 'running', 'pending'])
  })

  it('Resolve source(PREPARE_ONLY) 与 CI + CD 各跑一遍脚本：序号回退视为新一轮', () => {
    const lines = [stageLine(1, 'checkout'), stageLine(1, 'checkout'), stageLine(2, 'build')]
    const h = updateHint(undefined, lines)
    expect(h?.seen).toEqual([true, true, false, false])
    expect(inferStages(h, 'running', 'build-deploy').map((x) => x.state)).toEqual(['done', 'running', 'pending', 'pending'])
    // 回滚的 PREPARE_ONLY 轮只到 build SKIPPED，下一轮重新开始
    const rb = [stageLine(1, 'checkout', { skipped: true }), stageLine(2, 'build', { skipped: true }), stageLine(1, 'checkout', { skipped: true })]
    expect(updateHint(undefined, rb)?.seen).toEqual([true, false, false, false])
  })

  it('wealth-all：[module] 前缀不影响解析，换模块重新计阶段，并带出当前模块名', () => {
    const lines = [
      stageLine(1, 'checkout', { prefix: '[gateway]' }),
      stageLine(2, 'build', { prefix: '[gateway]' }),
      stageLine(3, 'push', { prefix: '[gateway]' }),
      stageLine(4, 'deploy', { prefix: '[gateway]' }),
      stageLine(1, 'checkout', { prefix: '[auth]' }),
      stageLine(2, 'build', { prefix: '[auth]', skipped: true }),
    ]
    const h = updateHint(undefined, lines.slice(0, 4))
    expect(h).toMatchObject({ module: 'gateway', idx: 3 })
    expect(inferStages(h, 'running', 'build-deploy').map((x) => x.state)).toEqual(['done', 'done', 'done', 'running'])
    const h2 = updateHint(h, lines.slice(4))
    expect(h2).toMatchObject({ module: 'auth', idx: 1 })
    expect(inferStages(h2, 'running', 'build-deploy').map((x) => x.state)).toEqual(['done', 'skipped', 'running', 'pending'])
  })

  it('getBuildStatus 带出 stageModule（wealth-all）与 SKIPPED 阶段', async () => {
    const log = [stageLine(1, 'checkout', { prefix: '[gateway]' }), stageLine(2, 'build', { prefix: '[gateway]', skipped: true })].join('\n') + '\n'
    installFetch([
      { match: 'GET /job/wealth-all/3/logText', handler: () => new Response(log, { status: 200, headers: { 'X-Text-Size': '99', 'X-More-Data': 'true' } }) },
      { match: 'GET /job/wealth-all/3/api/json', handler: () => jsonRes({ number: 3, building: true, result: null, timestamp: Date.now(), estimatedDuration: 1000, actions: [] }) },
    ])
    await realApi.getBuildLog('wealth-all', 3, 0)
    const st = await realApi.getBuildStatus('wealth-all', 1, 3)
    expect(st.stageModule).toBe('gateway')
    expect(st.stages.map((x) => x.state)).toEqual(['done', 'skipped', 'running', 'pending'])
  })
})
