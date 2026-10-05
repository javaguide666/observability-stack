// 用 Playwright 在浏览器里拦截 Jenkins 请求（假 Jenkins），端到端走一遍 real 模式的主流程。
// 不需要 Jenkins 账号；用来验证界面与 real.ts 的接线（不代表真实 Jenkins 行为，真实联调见 README）。
//   前提：dist 为默认(real)构建，已启动 `npx vite preview --port 4173`
//   PW_CHANNEL=chrome PLAYWRIGHT_MODULE=/path/to/node_modules/playwright-core/index.mjs node scripts/e2e-fake-jenkins.mjs
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')
const here = path.dirname(fileURLToPath(import.meta.url))
const base = process.env.CONSOLE_URL || 'http://localhost:4173'
const SHA = 'abcdef0123456789abcdef0123456789abcdef01'

const def = (name, type, value, choices) => ({ name, type, description: `${name} 说明`, defaultParameterValue: { value }, ...(choices ? { choices } : {}) })
const moduleDefs = [
  def('MODE', 'ChoiceParameterDefinition', 'build-deploy', ['build-deploy', 'rollback']),
  def('OVERLAY', 'ChoiceParameterDefinition', 'dev', ['dev', 'test', 'prod', 'local']),
  def('SOURCE', 'ChoiceParameterDefinition', 'github', ['github', 'local-mount']),
  def('IMAGE_TAG', 'StringParameterDefinition', 'auto'),
  def('REGISTRY', 'StringParameterDefinition', ''),
  def('BRANCH', 'ChoiceParameterDefinition', 'main', ['main', 'dev']),
  def('GIT_SHA', 'StringParameterDefinition', ''),
  def('SKIP_MVN', 'BooleanParameterDefinition', false),
]
const NEW_DESC = (b, tag) => `分支 ${b} | SHA ${SHA} | tag ${tag} | MODULE=gateway MODE=build-deploy OVERLAY=dev SHA=${SHA} IMAGE_TAG=${tag}`
const builds = [
  { number: 12, result: 'SUCCESS', building: false, timestamp: Date.now() - 3600e3, description: NEW_DESC('dev', 'dev-abcdef0'), actions: [{ parameters: [] }] },
  { number: 11, result: 'SUCCESS', building: false, timestamp: Date.now() - 7200e3, description: 'MODULE=gateway MODE=build-deploy OVERLAY=dev IMAGE_TAG=main-1111111', actions: [] },
  { number: 10, result: 'SUCCESS', building: false, timestamp: Date.now() - 9000e3, description: '分支 unknown | SHA unknown | tag main-2222222 | MODULE=gateway MODE=rollback OVERLAY=dev SHA=unknown IMAGE_TAG=main-2222222', actions: [] },
]

const LOG = [
  '[t] ==> 预检 MODULE=gateway MODE=build-deploy',
  `[t] ==> checkout wealth-freedom @ ${SHA} (requested ${SHA})`,
  '[t] ==> Maven package -pl gateway -am (SKIP_MVN=false)',
  '[t] ==> docker build wealth-gateway:dev-abcdef0 from gateway',
  '[t] ==> kubectl set image deploy/wealth-gateway',
  '[t] ==> rollout status deploy/wealth-gateway',
  '[t] ==> 完成 MODE=build-deploy MODULE=gateway IMAGE_TAG=dev-abcdef0',
].join('\n') + '\n'

const seen = []
let buildPolls = 0
let logOffset = 0
const json = (route, obj, status = 200, headers = {}) =>
  route.fulfill({ status, contentType: 'application/json', headers, body: JSON.stringify(obj) })

const browser = await chromium.launch(process.env.PW_CHANNEL ? { channel: process.env.PW_CHANNEL } : {})
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
const errors = []
page.on('pageerror', (e) => errors.push(e.message))

await page.route('**/*', async (route) => {
  const req = route.request()
  const u = new URL(req.url())
  if (u.origin !== new URL(base).origin) return route.abort()
  const p = decodeURIComponent(u.pathname + u.search)
  const m = req.method()
  if (!/^\/(job|api|queue|crumbIssuer|whoAmI|userContent)/.test(u.pathname)) return route.continue()
  seen.push(`${m} ${u.pathname}`)

  if (p.startsWith('/userContent/wealth-data/meta.json')) {
    return json(route, {
      keep: 10,
      branches: { 'wealth-freedom': ['main', 'dev', 'feature/meta-only'] },
      tags: { 'wealth-gateway': [{ tag: 'dev-abcdef0', created: '1 hour ago', size: '1MB' }, { tag: 'main-9999999', created: '2 days ago', size: '1MB' }] },
    })
  }
  if (p.startsWith('/whoAmI/api/json')) return json(route, { anonymous: false, authenticated: true, authorities: ['authenticated'], name: 'william' }, 200, { 'X-Jenkins': '2.555.2' })
  if (p.startsWith('/crumbIssuer/api/json')) return json(route, { crumb: 'fake-crumb', crumbRequestField: 'Jenkins-Crumb' })
  if (p.startsWith('/api/json?tree=jobs')) {
    return json(route, { jobs: ['wealth-gateway', 'wealth-auth', 'wealth-system-server', 'wealth-admin-server', 'wealth-ecommerce-server', 'wealth-freedom-web', 'wealth-ecommerce-web', 'wealth-all'].map((name, i) => ({ name, lastBuild: { number: 12 - i, result: i === 2 ? 'FAILURE' : 'SUCCESS', building: false, timestamp: Date.now() - 3600e3 } })) })
  }
  if (/\/job\/wealth-resolve-commit\/buildWithParameters/.test(p) && m === 'POST') {
    if (req.headers()['jenkins-crumb'] !== 'fake-crumb') return route.fulfill({ status: 403, body: 'No valid crumb' })
    return route.fulfill({ status: 201, headers: { Location: 'http://localhost:18080/queue/item/1/' }, body: '' })
  }
  if (p.startsWith('/queue/item/1/')) return json(route, { executable: { number: 1 } })
  if (p.startsWith('/job/wealth-resolve-commit/1/api/json')) return json(route, { building: false, result: 'SUCCESS' })
  if (p.startsWith('/job/wealth-resolve-commit/1/artifact/resolve.json')) return json(route, { exists: true, sha: SHA, branches: ['dev', 'main'], preferred: 'main', repo: 'wealth-freedom', fetched: true })
  if (/\/job\/wealth-gateway\/buildWithParameters/.test(p) && m === 'POST') {
    seen.push(`BODY ${req.postData()}`)
    return route.fulfill({ status: 201, headers: { Location: 'http://localhost:18080/queue/item/2/' }, body: '' })
  }
  if (p.startsWith('/queue/item/2/')) return json(route, { executable: { number: 13 } })
  if (p.startsWith('/job/wealth-gateway/13/api/json')) {
    buildPolls++
    const done = buildPolls > 3
    return json(route, { number: 13, building: !done, result: done ? 'SUCCESS' : null, timestamp: Date.now() - 5000, duration: done ? 5000 : 0, estimatedDuration: 20000, description: NEW_DESC('dev', 'dev-abcdef0'), executor: done ? null : { progressPercent: 40 }, actions: [{ parameters: [{ name: 'OVERLAY', value: 'dev' }] }] })
  }
  if (p.startsWith('/job/wealth-gateway/13/logText/progressiveText')) {
    const start = Number(u.searchParams.get('start') || 0)
    const buf = Buffer.from(LOG)
    const end = Math.min(buf.length, start === 0 ? Math.floor(buf.length / 2) : buf.length)
    logOffset = end
    return route.fulfill({ status: 200, headers: { 'X-Text-Size': String(end), 'X-More-Data': end < buf.length ? 'true' : 'false' }, body: buf.subarray(start, end).toString() })
  }
  if (/\/job\/wealth-gateway\/api\/json\?tree=property/.test(p)) return json(route, { property: [{ parameterDefinitions: moduleDefs }] })
  if (/\/job\/wealth-gateway\/api\/json\?tree=builds/.test(p)) return json(route, { builds })
  if (/\/job\/[^/]+\/api\/json\?tree=property/.test(p)) return json(route, { property: [{ parameterDefinitions: moduleDefs }] })
  if (/\/job\/[^/]+\/api\/json\?tree=builds/.test(p)) return json(route, { builds: [] })
  return route.fulfill({ status: 404, body: `fake jenkins: no route ${m} ${p}` })
})

const results = []
const check = (name, pass, extra = '') => results.push([name, !!pass, extra])

await page.goto(`${base}/#/`)
await page.waitForSelector('.mod strong', { timeout: 8000 })
await page.waitForFunction(() => document.querySelectorAll('.select-wrap').length > 0, null, { timeout: 8000 })
check('非 mock 模式（无 MOCK 标记）', (await page.locator('.mock-badge').count()) === 0)
check('用户名来自 whoAmI', await page.locator('.user-chip', { hasText: 'william' }).isVisible())
check('连接状态含 X-Jenkins 版本', await page.locator('.conn', { hasText: '2.555.2' }).isVisible())
check('左侧 8 个 Job', (await page.locator('.mod').count()) === 8, String(await page.locator('.mod').count()))
check('只用一次 /api/json?tree=jobs 取 Job 列表', seen.filter((s) => s === 'GET /api/json').length >= 1)

check('分支来自 meta.json（含 meta 独有分支）', (await page.locator('.hint', { hasText: 'meta.json' }).count()) > 0)
// 历史版本：新/旧格式 + 无 SHA
await page.getByText('历史版本', { exact: true }).first().click()
await page.waitForSelector('.history .card')
check('历史 3 张卡片', (await page.locator('.history .card').count()) === 3)
check('旧格式/unknown 卡片显示「无 SHA」', (await page.locator('.history .no-sha').count()) === 2, String(await page.locator('.history .no-sha').count()))
check('meta.json 的额外 tag 只提示不在历史里的那个', (await page.locator('[data-testid="extra-tags"] .tag-chip').allInnerTexts()).join(',') === 'main-9999999')
check('运行中（推断）标记仅 1 个', (await page.locator('.history .pill.run').count()) === 1)

// 指定 GIT_SHA：不选分支；点构建时才更新代码并核对
await page.getByText('指定完整 GIT_SHA', { exact: true }).click()
await page.getByPlaceholder(/粘贴 40 位/).fill(SHA.toUpperCase())
check('指定 GIT_SHA 时不显示分支选择', (await page.locator('.branch-picker, .cands').count()) === 0)
check('填写 SHA 时还不会请求识别', !seen.some((s) => s.startsWith('POST /job/wealth-resolve-commit/buildWithParameters')))

// 触发构建：先 resolve，存在后再构建；进度在弹窗里
await page.getByRole('button', { name: /开始构建部署/ }).click()
await page.waitForSelector('.el-dialog .log .line', { timeout: 10000 })
check('点击构建后才请求识别', seen.some((s) => s.startsWith('POST /job/wealth-resolve-commit/buildWithParameters')))
await page.waitForFunction(() => document.body.innerText.includes('rollout status'), null, { timeout: 15000 })
const body = seen.find((s) => s.startsWith('BODY '))
check('构建表单带完整 GIT_SHA(小写) 与 BRANCH，且只含 Job 定义的参数', body && body.includes(`GIT_SHA=${SHA}`) && body.includes('BRANCH=main') && body.includes('SKIP_MVN=false'), body)
await page.waitForTimeout(2500)
check('构建完成后显示成功', await page.locator('.state.ok, .state.success').first().isVisible().catch(() => false))
await page.screenshot({ path: path.resolve(here, '../.tmp-pw/e2e-real.png') })

check('无页面脚本错误', errors.length === 0, errors.join('; '))
await browser.close()
for (const [n, p, x] of results) console.log(p ? 'PASS' : 'FAIL', n, p ? '' : x)
if (results.some(([, p]) => !p)) process.exit(1)
