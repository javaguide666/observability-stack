// 用 Playwright 对 vite preview 截图（1440x900）。用法见 README「截图」一节。
// ⚠️ 需要 mock 版产物：VITE_USE_MOCK=true vite build（默认生产构建已改为 real）。
//   npx vite preview --port 4173 &
//   PLAYWRIGHT_MODULE=/path/to/node_modules/playwright/index.mjs node scripts/screenshots.mjs
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')
const here = path.dirname(fileURLToPath(import.meta.url))
const out = path.resolve(here, '../screenshots')
const base = process.env.CONSOLE_URL || 'http://localhost:4173'
// mockFail=0：截图时关闭 mock 的偶发失败
const url = `${base}/?mockFail=0#/`

// PW_CHANNEL=chrome 使用本机已安装的 Google Chrome，免下载 chromium
const browser = await chromium.launch(process.env.PW_CHANNEL ? { channel: process.env.PW_CHANNEL } : {})
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 })
page.on('pageerror', (e) => console.error('pageerror:', e.message))
page.on('console', (m) => m.type() === 'error' && console.error('console.error:', m.text()))
const shot = (name) => page.screenshot({ path: path.join(out, name) }).then(() => console.log('saved', name))

await page.goto(url)
await page.waitForSelector('.mod strong')
await page.waitForFunction(() => document.querySelectorAll('.select-wrap').length > 0)
await page.waitForTimeout(1500)
await shot('01-branch-build.png')

// 2) 指定完整 GIT_SHA（只填 SHA，不选分支；核对发生在点击构建时）
await page.getByText('指定完整 GIT_SHA', { exact: true }).click()
await page.getByRole('button', { name: '多分支' }).click()
await page.waitForTimeout(300)
await shot('02-commit-sha.png')

// 3) 历史版本
await page.getByText('历史版本', { exact: true }).first().click()
await page.waitForSelector('.history .card')
await page.waitForTimeout(500)
await shot('03-history.png')

// 4) 回滚确认
await page.getByRole('button', { name: /启动此版本/ }).first().click()
await page.waitForSelector('.el-dialog')
await page.waitForTimeout(500)
await shot('04-rollback-confirm.png')
await page.getByRole('button', { name: '取消' }).click()
await page.waitForTimeout(400)

// 5) 构建中（test 环境 + REGISTRY，四个阶段都有）
await page.getByText('选分支构建', { exact: true }).click()
await page.getByText('dev', { exact: true }).first().click().catch(() => {})
await page.locator('.el-segmented__item-label', { hasText: /^test$/ }).click()
await page.waitForTimeout(500)
await page.getByPlaceholder('registry.example.com/wealth').fill('registry.example.com/wealth')
await page.getByRole('button', { name: /开始构建部署/ }).click()
await page.waitForSelector('.log .line')
await page.waitForTimeout(13500)
await shot('05-building.png')

// 6) 窄屏（单栏）
await page.setViewportSize({ width: 820, height: 1100 })
await page.waitForTimeout(500)
await page.screenshot({ path: path.join(out, '06-narrow.png'), fullPage: true })
console.log('saved 06-narrow.png')

await browser.close()
