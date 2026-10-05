# Wealth Jenkins CI

控制台（推荐）：http://localhost:18080/userContent/wealth/

- 选模块 + 选分支 → 打最新代码
- 填完整 Commit → 自动识别分支再构建
- 「启动历史版本」→ 最近 10 个镜像 tag 一键回放（不重新编译）

- **推荐**：按模块 Job（`wealth-gateway` … `wealth-ecommerce-web`）
- **可选全量**：`wealth-all`
- **只读**：`wealth-resolve-commit`（SHA→分支，不构建不部署）
- **已删除**：`wealth-ci-cd`（旧单体；备份见 `legacy/`）

脚本：

- `scripts/pipeline-wealth-module.sh` — 单模块构建 + `kubectl set image`（可选 `REGISTRY=` 推仓库）
- `scripts/pipeline-wealth-all.sh` — 顺序跑 7 个模块
- `scripts/resolve-commit.sh` — 只读 Job `wealth-resolve-commit`：按 40 位 SHA 反查所属分支，产物 `resolve.json`（见 obsidian-doc §17.7）
- `scripts/list-wealth-tags.sh` — 列出本机 wealth 镜像 tag
- `scripts/install-wealth-ui.sh` — 安装/刷新 Wealth CI 控制台到 Jenkins userContent

种子：`job-seed/modules/`  
说明：见 obsidian-doc `build_doc/Jenkins CI CD相关文档.md`

## BRANCH 下拉

Job 参数 **BRANCH** 使用插件 `list-git-branches-parameter`，按模块仓库 `git ls-remote --heads` 列出远程分支。凭据 ID：`github-ssh`。

## BRANCH 下拉（本地缓存）

- 打开 Build 页只读本地选项（与 SOURCE 同款紧凑下拉），**不每次** `git ls-remote`
- 缓存目录：`cache/branches/*.txt`；控制台 JSON：`$JENKINS_HOME/userContent/wealth-data/meta.json`
- 刷新：跑 Job **`wealth-refresh-branches`**，或控制台左侧按钮，或：

```bash
bash /Users/eric_brewer/gitee/observability-stack/jenkins/scripts/refresh-branch-cache.sh
bash /Users/eric_brewer/gitee/observability-stack/jenkins/scripts/install-wealth-ui.sh
```
