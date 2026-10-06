#!/usr/bin/env bash
# 按名称启动一个或多个组件（每个组件仍是独立的 docker-compose.<组件>.yml，此脚本只做顺序/等待/封装）。
# 用法：scripts/up.sh [--recreate] [--no-wait] [名称或分组 ...]      默认：core
#   组件：mysql redis postgres clickhouse nacos skywalking loki alloy prometheus grafana clickvisual jenkins
#   分组：core=mysql redis nacos | logging=clickhouse loki grafana | metrics=prometheus
#         observability=clickhouse loki prometheus grafana | monitor=skywalking prometheus grafana | ci=jenkins | full=全部
# 说明：
#   - 自动补依赖（nacos→mysql，loki→clickhouse，clickvisual→mysql+clickhouse）并按顺序等待 healthy
#   - 已在运行的组件默认跳过（不会因为配置漂移而重建）；--recreate 才按最新配置重建（数据目录不动）
#   - 缺 .env 时自动调用 init-env.sh（默认账号，不覆盖已有文件）
#   - alloy 是 loki 文件里的可选采集器（--profile logs）
#   - clickvisual 默认不启动（--profile clickvisual），查日志用 Grafana
set -euo pipefail
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

RECREATE=0; WAIT=1; args=()
for a in "$@"; do
  case "$a" in
    --recreate) RECREATE=1 ;;
    --no-wait) WAIT=0 ;;
    -h|--help) sed -n '2,12p' "$0"; exit 0 ;;
    *) args+=("$a") ;;
  esac
done

command -v docker >/dev/null || { echo "未找到 docker" >&2; exit 1; }
docker info >/dev/null 2>&1 || { echo "Docker 守护进程未运行" >&2; exit 1; }
[[ -f "$ENV_FILE" ]] || "$ROOT/scripts/init-env.sh"

comps="$(resolve_components ${args[@]+"${args[@]}"})"
echo "==> 将启动：$comps"

already_running() { # file
  local file="$1" total running s svcs
  svcs="$(dc "$file" config --services 2>/dev/null || true)"
  total=0
  for s in $svcs; do
    case " $ONESHOT_SERVICES " in *" $s "*) ;; *) total=$((total+1)) ;; esac
  done
  running="$(dc "$file" ps -q --orphans=false 2>/dev/null | grep -c . || true)"
  [[ "$total" -gt 0 && "$running" -ge "$total" ]]
}

for c in $comps; do
  f="$(comp_file "$c")"
  extra=()
  [[ "$c" == "alloy" ]] && extra=(--profile logs)
  [[ "$c" == "clickvisual" ]] && extra=(--profile clickvisual)
  if [[ $RECREATE -eq 0 && "$c" != "alloy" ]] && already_running "$f"; then
    echo "==> $c 已在运行，跳过（--recreate 强制重建）"
    continue
  fi
  echo "==> 启动 $c"
  build=()
  [[ "$c" == "jenkins" ]] && build=(--build)
  dc "$f" ${extra[@]+"${extra[@]}"} up -d ${build[@]+"${build[@]}"}
  if [[ $WAIT -eq 1 ]]; then
    if wait_healthy "$f" "$(envget WAIT_TIMEOUT 300)"; then
      echo "    $c 就绪"
    else
      echo "    警告：$c 在超时内未全部 healthy，查看：docker compose -f $(basename "$f") ps / logs" >&2
    fi
  fi
done

echo
"$ROOT/scripts/check.sh" --urls $comps
