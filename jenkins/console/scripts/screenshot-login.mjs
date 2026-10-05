// 验证「未登录引导页」：不需要 Jenkins 密码，用 Playwright 把 /whoAmI/api/json 拦截成 anonymous:true 后截图。
// 前提：dist 为默认(real)构建，并已启动 `npx vite preview --port 4173`。
//   PW_CHANNEL=chrome PLAYWRIGHT_MODULE=/path/to/node_modules/playwright-core/index.mjs node scripts/screenshot-login.mjs
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')
const here = path.dirname(fileURLToPath(import.meta.url))
const out = path.resolve(here, '../screenshots/07-login-required.png')
const base = process.env.CONSOLE_URL || 'http://localhost:4173'

const browser = await chromium.launch(process.env.PW_CHANNEL ? { channel: process.env.PW_CHANNEL } : {})
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 })
const errors = []
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))

const requested = []
await page.route('**/*', (route) => {
  const u = new URL(route.request().url())
  if (u.origin !== new URL(base).origin) return route.abort()
  if (u.pathname === '/whoAmI/api/json') {
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: { 'X-Jenkins': '2.555.2' },
      body: JSON.stringify({ anonymous: true, authenticated: true, authorities: ['anonymous'], name: 'anonymous' }),
    })
  }
  if (/^\/(job|api|queue|crumbIssuer)/.test(u.pathname)) {
    requested.push(u.pathname)
    return route.fulfill({ status: 403, body: 'forbidden' })
  }
  return route.continue()
})

await page.goto(`${base}/#/`)
await page.waitForSelector('[data-testid="login-required"]', { timeout: 8000 })
await page.waitForTimeout(400)

const href = await page.getByRole('link', { name: /前往登录 Jenkins/ }).getAttribute('href')
const mockBadge = await page.locator('.mock-badge').count()
const ok = [
  ['标题「请先登录 Jenkins」', await page.getByRole('heading', { name: '请先登录 Jenkins' }).isVisible()],
  ['登录链接 /login?from=/userContent/wealth/', href === '/login?from=/userContent/wealth/'],
  ['无 MOCK 标记', mockBadge === 0],
  ['未登录时不请求 Job 接口', requested.length === 0],
  ['无页面脚本错误', errors.length === 0],
]
await page.screenshot({ path: out })
console.log('saved', out)
for (const [name, pass] of ok) console.log(pass ? 'PASS' : 'FAIL', name, name.startsWith('未登录时') ? requested.join(',') : '')
await browser.close()
if (ok.some(([, p]) => !p)) process.exit(1)
