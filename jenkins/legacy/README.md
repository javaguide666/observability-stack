# 已废弃（旧单体 Job）

`wealth-ci-cd` 已从 Jenkins 删除。本目录仅保留历史文件，**勿再安装为 Job**。

- `pipeline-wealth.sh` / `Jenkinsfile.wealth`：旧三仓全量流水线
- `job-seed-wealth-ci-cd.config.xml` / `wealth-ci-cd.xml`：旧 Job 种子

日常请用 `scripts/pipeline-wealth-module.sh` + `job-seed/modules/`（除本目录外的模块 XML）与可选 `wealth-all`。
