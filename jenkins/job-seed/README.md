# Jenkins Job 种子（按模块）

- `modules/*.xml`：可拷贝到 `~/.docker/jenkins/home/jobs/<name>/config.xml`
- **不要**再安装已删除的 `wealth-ci-cd`（旧种子在 `../legacy/`）
- 安装前请备份旧 `config.xml`
- XML 中 `&&` 必须写成 `&amp;&amp;`
- 改完 home 后执行：`docker restart obs-jenkins`

单模块脚本：`../scripts/pipeline-wealth-module.sh`（`MODULE=gateway|auth|...`，测试环境可设 `REGISTRY=`）
全量可选：`../scripts/pipeline-wealth-all.sh` → Job `wealth-all`
