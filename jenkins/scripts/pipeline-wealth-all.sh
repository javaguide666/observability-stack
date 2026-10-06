#!/usr/bin/env bash
# 「全量 7 模块」：只拉一次代码、只跑一次 Maven reactor，再逐个（或并行）打镜像、部署
#   1. Java 模块都在 wealth-freedom 里：先用 MAVEN_REACTOR_MODULES 跑一次 checkout + Maven reactor，锁定完整 SHA
#   2. 5 个 Java 模块带 SKIP_MVN=1 + 同一个 GIT_SHA 打镜像/部署（不再各自 fetch、各自 -am 重复编公共模块）
#   3. 两个前端各自仓库，照常处理
# 并行度 WEALTH_ALL_PARALLEL 来自 env/<OVERLAY>.env（dev=1 串行，日志实时输出；>1 时各模块日志在完成后整段输出）
# 注意：全量首次集群仍需先 deploy.sh；本脚本只做逐模块 build + 部署
# 阶段标记：每个模块各自输出 ==> STAGE <n>/4 [<module>] <name> [SKIPPED]（约定见 pipeline-wealth-module.sh 头部）
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MODULE_SCRIPT="$SCRIPT_DIR/pipeline-wealth-module.sh"
JAVA_MODULES=(gateway auth system-server admin-server ecommerce-server)
WEB_MODULES=(freedom-web ecommerce-web)

MODE="${MODE:-build-deploy}"
OVERLAY="${OVERLAY:-dev}"
export WEALTH_CI_ROOT="${WEALTH_CI_ROOT:-$(cd "$SCRIPT_DIR/.." && pwd)}"
ENV_FILE="${WEALTH_ENV_FILE:-${WEALTH_CI_ROOT}/env/${OVERLAY}.env}"
[[ -f "$ENV_FILE" ]] || { echo "ERROR: 缺少环境配置 ${ENV_FILE}" >&2; exit 1; }
# shellcheck disable=SC1090
source "$ENV_FILE"
PARALLEL="${WEALTH_ALL_PARALLEL:-1}"
SKIP_MVN="${SKIP_MVN:-0}"
PREPARE_ONLY="${PREPARE_ONLY:-0}"
# 全量默认带依赖一起编（reactor 只跑一次，代价很小）；显式 1/true 才只编 5 个服务模块本身
if [[ "${ONLY_CURRENT_MODULE:-0}" == "1" || "${ONLY_CURRENT_MODULE:-0}" == "true" ]]; then
  export ONLY_CURRENT_MODULE=1
else
  export ONLY_CURRENT_MODULE=0
fi
export MODE OVERLAY

# 每个模块脚本会写 ${WORKSPACE}/.wealth-meta-<MODULE>（分支/完整 SHA/tag），Job 的 post 汇总进构建描述
rm -f "${WORKSPACE:-.}"/.wealth-meta-* "${WORKSPACE:-.}"/.wealth-all-*.log "${WORKSPACE:-.}"/.wealth-all-*.rc
echo "==> wealth-all：${#JAVA_MODULES[@]} 个 Java + ${#WEB_MODULES[@]} 个前端 MODE=${MODE} OVERLAY=${OVERLAY} 并行度=${PARALLEL}"

java_env=()
if [[ "$MODE" == "build-deploy" && "$PREPARE_ONLY" != "1" ]]; then
  # 整个全量期间持有 wealth-freedom 共用仓库锁，子脚本不再各自加锁（并行打镜像时代码树保持不变）
  cache_root="${CACHE_ROOT:-${JENKINS_HOME:-/var/jenkins_home}}"
  git_cache="${GIT_CACHE_ROOT:-${cache_root}/git-cache}"
  mkdir -p "$git_cache" 2>/dev/null || true
  if [[ -d "$git_cache" ]] && command -v flock >/dev/null 2>&1; then
    exec 9>"${git_cache}/wealth-freedom.lock"
    echo "==> 等待共用仓库锁 wealth-freedom"
    flock 9
  fi
  export REPO_LOCK_HELD=1

  if [[ "$SKIP_MVN" == "1" ]]; then
    echo "==> SKIP_MVN=1：跳过 Maven reactor"
  else
    echo ""
    echo "========== Maven reactor（${JAVA_MODULES[*]}）=========="
    MODULE=gateway STAGE_PREFIX="[maven]" MAVEN_REACTOR_MODULES="${JAVA_MODULES[*]}" \
      WORKSPACE_ROOT="${WORKSPACE_ROOT:-}" bash "$MODULE_SCRIPT"
  fi
  # 锁定 reactor 编译时的完整 SHA，5 个 Java 模块都用它，保证镜像里的 jar 和 SHA 一致
  meta="${WORKSPACE:-.}/.wealth-meta-gateway"
  if [[ -f "$meta" ]]; then
    pinned=$(sed -n 's/^SHA=//p' "$meta" | head -1)
    pinned_branch=$(sed -n 's/^BRANCH=//p' "$meta" | head -1)
    if [[ "$pinned" =~ ^[0-9a-f]{40}$ ]]; then
      echo "==> Java 模块统一使用 ${pinned_branch:-?} @ ${pinned}"
      java_env=(GIT_SHA="$pinned" SKIP_MVN=1)
    fi
  fi
  if [[ ${#java_env[@]} -eq 0 ]]; then
    java_env=(SKIP_MVN=1)
  fi
fi

failed=()
run_one() {
  local m="$1"
  shift
  env "$@" MODULE="$m" STAGE_PREFIX="[${m}]" bash "$MODULE_SCRIPT"
}

if [[ "$PARALLEL" -le 1 ]]; then
  for m in "${JAVA_MODULES[@]}"; do
    echo ""
    echo "========== MODULE=${m} =========="
    run_one "$m" "${java_env[@]}" || failed+=("$m")
    [[ ${#failed[@]} -eq 0 ]] || break   # 串行时与原来一致：失败即停
  done
  if [[ ${#failed[@]} -eq 0 ]]; then
    for m in "${WEB_MODULES[@]}"; do
      echo ""
      echo "========== MODULE=${m} =========="
      run_one "$m" REPO_LOCK_HELD=0 || { failed+=("$m"); break; }
    done
  fi
else
  # 并行：每个模块输出到自己的日志，完成后整段打印，避免多模块日志交错
  start_bg() {
    local m="$1"
    shift
    ( set +e; run_one "$m" "$@" > "${WORKSPACE:-.}/.wealth-all-${m}.log" 2>&1
      echo $? > "${WORKSPACE:-.}/.wealth-all-${m}.rc" ) &
  }
  for m in "${JAVA_MODULES[@]}" "${WEB_MODULES[@]}"; do
    while [[ $(jobs -rp | wc -l) -ge "$PARALLEL" ]]; do wait -n || true; done
    echo "==> 启动 ${m}"
    if [[ " ${WEB_MODULES[*]} " == *" ${m} "* ]]; then
      start_bg "$m" REPO_LOCK_HELD=0
    else
      start_bg "$m" "${java_env[@]}"
    fi
  done
  wait || true
  for m in "${JAVA_MODULES[@]}" "${WEB_MODULES[@]}"; do
    echo ""
    echo "========== MODULE=${m} =========="
    cat "${WORKSPACE:-.}/.wealth-all-${m}.log" 2>/dev/null || true
    rc=$(cat "${WORKSPACE:-.}/.wealth-all-${m}.rc" 2>/dev/null || echo 1)
    [[ "$rc" == "0" ]] || failed+=("$m")
  done
fi

if [[ ${#failed[@]} -gt 0 ]]; then
  echo "ERROR: wealth-all 失败模块：${failed[*]}" >&2
  exit 1
fi
echo "==> wealth-all 全部完成"
