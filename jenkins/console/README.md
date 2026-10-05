# Wealth CI 控制台（前端原型）

Jenkins 的独立控制台：Vue 3 + Vite + TypeScript + Element Plus（暗色），配色与间距沿用 `../ui/styles.css`
（令牌见 `src/styles/tokens.css`，再叠加到 Element Plus 暗色变量上，见 `src/styles/element-overrides.css`）。
`vite`(dev) 默认使用 **mock 假数据**，无需 Jenkins 即可点击体验；`vite build` 的产物**默认走真实 Jenkins**（`src/api/real.ts`，见下文「real 模式」）。方案见 `CI CD Jenkins相关文档.md` §17。

## 开发

```bash
cd jenkins/console
npx --yes pnpm@12.8.1 install      # Node >= 22
npx --yes pnpm@12.8.1 dev          # http://localhost:5173 （mock）
npx --yes pnpm@12.8.1 type-check   # vue-tsc --noEmit
npx --yes pnpm@12.8.1 test         # vitest：real.ts 单元测试（mock 全局 fetch，不需要 Jenkins）
```

mock 里可试的 SHA（页面上「示例」按钮也有）：

| SHA | 结果 |
| --- | --- |
| `3c9a41f0…`（首位 0-5） | 存在，点击「开始构建部署」后正常构建 |
| `7e12b8c4…`（首位 6-9） | 存在（仅 dev），正常构建 |
| 40 个 `0` | 不存在，提示「该GIT_SHA不存在，请检查确认」 |
| 40 个 `f` | 存在但不在任何分支，仍会构建 |
| 以 `bad` 开头 | 核对失败（超时） |

mock 还会偶发失败（默认概率 0.08，影响刷新分支/识别/触发构建，构建本身也可能"编译失败"）。
关闭：URL 加 `?mockFail=0`，或设 `VITE_MOCK_FAIL_RATE=0`。

## 构建

```bash
npx --yes pnpm@12.8.1 build        # vue-tsc + vite build -> dist/（默认 real；要 mock 演示版：VITE_USE_MOCK=true）
npx --yes pnpm@12.8.1 preview      # http://localhost:4173 预览产物
```

- `base: './'` + hash 路由，产物可放在任意子目录；`index.html` 无内联脚本，兼容 Jenkins CSP。
  （Element Plus 运行时会写少量内联 *style*；若 CSP 的 `style-src` 过严需放开。）
- Element Plus 目前是全量引入（JS ≈ 1.2 MB / gzip ≈ 400 KB）；需要瘦身时再换 `unplugin-vue-components` 按需引入。

## 切换 mock / real

| 变量 | 说明 |
| --- | --- |
| `VITE_USE_MOCK` | 未设置：`vite`(dev) → mock，`vite build`(生产) → **real**；`true` 强制 mock，`false` 强制 real |
| `VITE_MOCK_FAIL_RATE` | mock 偶发失败概率，默认 `0.08`（仅 mock） |
| `VITE_JENKINS_BASE` | real 模式的 Jenkins 基础路径，同源部署留空 |
| `VITE_JENKINS_URL` | 仅 dev 代理目标，默认 `http://localhost:18080` |

header 上的「MOCK 假数据」标记只在 mock 模式显示。

```bash
# 开发 + 真实 Jenkins：先在浏览器登录 http://localhost:18080（Cookie 不区分端口），再：
VITE_USE_MOCK=false npx --yes pnpm@12.8.1 dev   # /job /api /queue /crumbIssuer /whoAmI /login 代理到 localhost:18080
# 演示用 mock 版产物（截图脚本用）：
VITE_USE_MOCK=true npx --yes pnpm@12.8.1 build
```

## real 模式（`src/api/real.ts`）

部署在 Jenkins 的 `userContent/wealth/`，与 Jenkins 同源：所有请求都是相对路径 + `credentials:'same-origin'`，
复用浏览器里的 Jenkins 登录会话，**不保存任何令牌**。

| 能力 | 实现 |
| --- | --- |
| 登录检测 | `GET /whoAmI/api/json`，**只看 `anonymous===false`**（匿名时 `authenticated` 也是 true）。匿名/403 → 「请先登录 Jenkins」引导页，链接 `/login?from=/userContent/wealth/`；会话中途过期同样回到引导页并停止轮询 |
| 统一 fetch | 15s 超时、非 2xx 抛带状态码的 `ApiError`；401/403 再查 whoAmI 区分 `auth`(未登录) 与 `forbidden`(无权限)；POST 带 crumb（缓存，403 时刷新一次重试；`crumbIssuer` 404 视为未开 CSRF） |
| Job 列表 | `GET /api/json?tree=jobs[name,color,lastBuild[...]]` 一次取 8 个 Job |
| 参数定义 | `GET /job/<job>/api/json?tree=property[parameterDefinitions[...]]`；触发时只传 Job 里**实际定义**的参数，Choice 值先校验 |
| 分支列表 | ① `GET /userContent/wealth-data/meta.json` 的 `branches.<仓库名>`（键见 `constants.ts` 的 `JOB_META_REPO`，与 `write-ui-meta.sh` 的 REPOS 一致）→ ② 读不到/没有该仓库时回退 Job 参数 `BRANCH` 的 `choices`（仅 choice 类型）→ ③ 都没有则 `main`/`dev` 并提示「请先刷新分支」。`BRANCH` 为 string 类型时触发构建直接传值、不校验；为 choice 类型时保持校验（不在选项里：普通构建报错，指定 SHA 时退回默认选项由脚本识别分支） |
| 刷新分支 | 按 `wealth-refresh-branches` 是否带参数选 `/build` 或 `/buildWithParameters` → 队列 → 等构建成功 → **重新读取 meta.json**（绕过缓存）；失败给出日志位置 |
| 可选 tag | 回滚页读 `meta.json` 的 `tags.<镜像名>`，去掉已在最近构建历史里的 tag，只作为「可选 tag」提示（点击复制），不替代构建历史，也不能直接回滚（无分支/SHA 信息） |
| 核对 GIT_SHA | 只在点击「开始构建部署」时：前端校验 40 位十六进制 → `POST wealth-resolve-commit/buildWithParameters`(`SHA`、`REPO`)（这一次会更新镜像仓库）→ 队列 → 等结束 → `artifact/resolve.json`。不存在则提示「该GIT_SHA不存在，请检查确认」且不构建；存在则继续构建（不再让人选分支） |
| 触发构建 | `POST /job/<job>/buildWithParameters?delay=0sec`，取 `Location` 的队列号；回滚 = `MODE=rollback` + `IMAGE_TAG`；`wealth-all` 不传 `GIT_SHA` |
| 进度/日志 | 队列项 → 构建号；`api/json?tree=...executor[progressPercent]`；`logText/progressiveText?start=` 按 `X-Text-Size`/`X-More-Data` 增量拉（半行拼接）；阶段优先解析脚本输出的 `==> STAGE <n>/4 [<module>] <checkout|build|push|deploy> [SKIPPED]`（`pipeline-wealth-module.sh` 的 `stage()`；`[module]` 仅 wealth-all 有，界面显示「当前模块」；`SKIPPED` 的阶段显示「已跳过」，被跳过时进度推进到下一阶段；序号回退或换模块视为新一轮），没有 STAGE 行时退回旧的 `==> ` 关键字推断（Pipeline 只有 `Resolve source`/`CI + CD` 两个 stage，wfapi 给不出四阶段，未使用） |
| 历史 | `builds[...]{0,10}`，描述解析优先 `KEY=value`，其次 `actions.parameters`，再退回前半段；SHA 缺失/`unknown` → 「无 SHA」且不可用于代码对比（仍可回滚）；「运行中」是**推断**（所选 overlay 下最近一次成功构建） |

进度和日志在「历史版本」每条记录的弹窗里（开始构建后也会自动打开）。轮询 1s 一次；离开页面、重新触发、会话丢失时 `AbortController` 取消。关闭弹窗不中止构建。切换模块会取消该模块尚未结束的 GIT_SHA 核对与分支刷新（Jenkins 侧的任务不受影响）。

### 联调状态

- 已验证：`vue-tsc`、`vite build`、`vitest`（`src/api/real.test.ts`，mock fetch）、浏览器里用**假 Jenkins**（Playwright 路由拦截）走通主流程（`scripts/e2e-fake-jenkins.mjs`）、未登录引导页（`scripts/screenshot-login.mjs` → `screenshots/07-login-required.png`）。
- **未对真实 Jenkins 联调**（需要登录会话）：crumb 实际头名、`buildWithParameters` 的 201/Location、`resolve.json` 链路、`progressPercent`、日志偏移、refresh 后 `meta.json` 是否已更新并能被同源读到（路径 `/userContent/wealth-data/meta.json`、`tags` 元素格式）、`BRANCH` 最终是 choice 还是 string（待确认）、真实日志里 `==> STAGE` 行的呈现（格式已按脚本源码对齐并有单测，但没有在真实构建日志上跑过）、模块 Job 的新版构建描述（需跑过一次 build-deploy 才有）、停止/取消排队。联调步骤见交付说明。

## 部署：拷贝到 userContent/wealth

构建后把 `dist/` 的内容放到 Jenkins 的 `userContent/wealth/`（与旧页面 `../ui` 的位置一致）：

```bash
# 例：容器名 jenkins
docker cp dist/. jenkins:/var/jenkins_home/userContent/wealth/
# 访问：http://localhost:18080/userContent/wealth/index.html
```

`docker-compose.jenkins.yml` 已把 `console/dist` 挂到 `userContent/wealth`（新控制台），旧页面挂到 `userContent/wealth-legacy`（回退）；同时通过 `JAVA_OPTS` 放开 userContent 的 CSP。`scripts/install-wealth-ui.sh` 会在没有 dist 时先构建再拷贝。

## 截图

```bash
# 01~06（mock 版界面）：需要 mock 产物
VITE_USE_MOCK=true npx --yes pnpm@12.8.1 build && npx vite preview --port 4173 &
PW_CHANNEL=chrome PLAYWRIGHT_MODULE=/path/to/node_modules/playwright-core/index.mjs node scripts/screenshots.mjs
# 07 未登录引导页 / 假 Jenkins 端到端：需要默认(real)产物，拦截 /whoAmI/api/json，无需账号
npx --yes pnpm@12.8.1 build && npx vite preview --port 4173 &
PW_CHANNEL=chrome PLAYWRIGHT_MODULE=... node scripts/screenshot-login.mjs
PW_CHANNEL=chrome PLAYWRIGHT_MODULE=... node scripts/e2e-fake-jenkins.mjs
```

截图保存在 `screenshots/`。

## 目录

```text
src/
  api/          types.ts（统一接口）· mock.ts · real.ts · parse.ts（描述/阶段解析）· session.ts · real.test.ts · index.ts（按 VITE_USE_MOCK 切换）· constants.ts
  composables/  useConsole.ts（页面状态与动作，单例）
  components/   AppHeader · ModuleSidebar · BuildCard · BranchPicker · CommitResolver · HistoryTimeline
                RollbackDialog · LoginRequired · ParamFields · BuildConsole · StatusDot · FieldLabel
  styles/       tokens.css · element-overrides.css · base.css
  views/        ConsoleView.vue（三栏布局；窄屏 ≤1180px 折叠为单栏）
  router/       hash 路由
```
