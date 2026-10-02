#!/usr/bin/env bash
# 列出本机 Docker 上 wealth-* 镜像的近期 tag（便于 rollback 选 IMAGE_TAG）
set -euo pipefail
IMGS=(wealth-gateway wealth-auth wealth-system-server wealth-admin-server wealth-ecommerce-server wealth-freedom-web wealth-ecommerce-web)
KEEP="${KEEP:-10}"
for img in "${IMGS[@]}"; do
  echo "==== ${img} (最近 ${KEEP} 个 tag) ===="
  docker images --format '{{.Tag}}\t{{.ID}}\t{{.CreatedSince}}\t{{.Size}}' "$img" 2>/dev/null \
    | grep -v '^<none>' | head -n "$KEEP" || echo "(无镜像)"
  echo
done
echo "提示：可选清理旧 tag（勿删正在跑的）：docker image rm ${IMGS[0]}:<旧tag> ..."
