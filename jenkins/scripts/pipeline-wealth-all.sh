#!/usr/bin/env bash
# 可选「一键全量」：按顺序对 7 个模块执行 pipeline-wealth-module.sh
# 与各单模块 Job 参数相同（BRANCH/GIT_SHA 对每个模块各自的仓库生效）
# 注意：全量首次集群仍需先 deploy.sh；本脚本只做逐模块 build + set image
# 阶段标记：每个模块各自输出 ==> STAGE <n>/4 [<module>] <name> [SKIPPED]（约定见 pipeline-wealth-module.sh 头部）
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MODULES=(gateway auth system-server admin-server ecommerce-server freedom-web ecommerce-web)

MODE="${MODE:-build-deploy}"
# 每个模块脚本会写 ${WORKSPACE}/.wealth-meta-<MODULE>（分支/完整 SHA/tag），Job 的 post 汇总进构建描述
rm -f "${WORKSPACE:-.}"/.wealth-meta-*
echo "==> wealth-all：依次处理 ${#MODULES[@]} 个模块 MODE=${MODE}"

for m in "${MODULES[@]}"; do
  echo ""
  echo "========== MODULE=${m} =========="
  # STAGE_PREFIX → 子脚本阶段标记形如 "==> STAGE 2/4 [gateway] build"
  MODULE="$m" STAGE_PREFIX="[${m}]" bash "$SCRIPT_DIR/pipeline-wealth-module.sh"
done

echo "==> wealth-all 全部完成"
