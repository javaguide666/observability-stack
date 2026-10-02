#!/usr/bin/env bash
# 停止并移除容器（默认保留数据目录）。用法：scripts/down.sh [名称或分组 ...]   默认：core
#   与 up.sh 同名称/分组；停止时按启动顺序的反序。不会删除 data/ 与任何 volume。
set -euo pipefail
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"
[[ "${1:-}" == "-h" || "${1:-}" == "--help" ]] && { sed -n '2,4p' "$0"; exit 0; }
comps="$(resolve_components "$@")"
rev=""; for c in $comps; do rev="$c $rev"; done
for c in $rev; do
  [[ "$c" == "alloy" ]] && continue    # alloy 随 loki 文件 down 一并处理
  f="$(comp_file "$c")"
  echo "==> 停止 $c"
  extra=(); [[ "$c" == "loki" ]] && extra=(--profile logs)
  dc "$f" ${extra[@]+"${extra[@]}"} down
done
echo "完成。数据目录保留：$(envget DOCKER_DATA_DIR ./data)（需清空请手动删除该目录下对应子目录）"
