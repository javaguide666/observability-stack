# Wealth Jenkins CI

- **推荐**：按模块 Job（`wealth-gateway` … `wealth-ecommerce-web`）
- **可选全量**：`wealth-all`
- **已删除**：`wealth-ci-cd`（旧单体；备份见 `legacy/`）

脚本：

- `scripts/pipeline-wealth-module.sh` — 单模块构建 + `kubectl set image`（可选 `REGISTRY=` 推仓库）
- `scripts/pipeline-wealth-all.sh` — 顺序跑 7 个模块
- `scripts/list-wealth-tags.sh` — 列出本机 wealth 镜像 tag

种子：`job-seed/modules/`  
说明：见 obsidian-doc `build_doc/Jenkins CI CD相关文档.md`

## BRANCH 下拉

Job 参数 **BRANCH** 使用插件 `list-git-branches-parameter`，按模块仓库 `git ls-remote --heads` 列出远程分支。凭据 ID：`github-ssh`。

## BRANCH 下拉（本地缓存）

- 打开 Build 页只读本地选项（与 SOURCE 同款紧凑下拉），**不每次** `git ls-remote`
- 缓存目录：`cache/branches/*.txt`
- 刷新：跑 Job **`wealth-refresh-branches`**，或：

```bash
bash /Users/eric_brewer/gitee/observability-stack/jenkins/scripts/refresh-branch-cache.sh
docker restart obs-jenkins   # 若 UI 未立刻变，重启加载 Job 配置
```
