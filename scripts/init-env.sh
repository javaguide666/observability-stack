#!/usr/bin/env bash
# 生成 .env（从 .env.example 复制并按需填值）。不会覆盖已有 .env（除非 --force，且会先备份）。
# 用法：scripts/init-env.sh [--random] [--data-dir PATH] [--force]
#   默认        沿用 .env.example 的开发默认账号（与 IDEA / wealth-freedom K8s dev secret 一致）
#   --random    为 MySQL root/Redis/Postgres/Nacos/Grafana 等 .env 控制的密码生成随机强密码，只写入 .env，不在终端打印
#               （MySQL 的 nacos/admin 账号密码写在 config/mysql/init/01-users.sql 里，不随机化）
#               （测试/共享环境用；wealth-freedom 的 K8s secret 需同步改成新密码）
#   --data-dir  数据目录（默认 ./data；若检测到旧版数据目录 ~/.docker/mysql/data 则沿用 ~/.docker 以免丢数据）
set -euo pipefail
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

RANDOM_PW=0; FORCE=0; DATA_DIR=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --random) RANDOM_PW=1 ;;
    --force) FORCE=1 ;;
    --data-dir) DATA_DIR="${2:?--data-dir 需要路径}"; shift ;;
    -h|--help) sed -n '2,9p' "$0"; exit 0 ;;
    *) echo "未知参数 $1" >&2; exit 1 ;;
  esac
  shift
done

if [[ -f "$ENV_FILE" && $FORCE -ne 1 ]]; then
  echo ".env 已存在，保持不变（--force 可重新生成并备份旧文件）：$ENV_FILE"
  exit 0
fi
if [[ -f "$ENV_FILE" ]]; then
  bak="$ENV_FILE.bak.$(date +%Y%m%d%H%M%S)"; cp "$ENV_FILE" "$bak"; chmod 600 "$bak"
  echo "已备份旧 .env → $bak"
fi

rand() { # 24 位字母数字，不含特殊字符（兼容 MySQL / ClickHouse DSN）
  local out
  out="$(head -c 512 /dev/urandom | LC_ALL=C tr -dc 'A-Za-z0-9' | cut -c1-24)"
  echo "$out"
}

setv() { # setv KEY VALUE  （仅在本地文件里替换，不回显值）
  local k="$1" v="$2" tmp
  tmp="$(mktemp)"
  awk -v k="$k" -v v="$v" 'BEGIN{FS=OFS="="} $1==k{print k"="v; next} {print}' "$ENV_FILE" > "$tmp"
  cat "$tmp" > "$ENV_FILE"; rm -f "$tmp"
}

cp "$ROOT/.env.example" "$ENV_FILE"
chmod 600 "$ENV_FILE"

# 数据目录：显式指定 > 旧版目录（保护已有数据）> ./data
if [[ -z "$DATA_DIR" && -d "$HOME/.docker/mysql/data" && -n "$(ls -A "$HOME/.docker/mysql/data" 2>/dev/null)" ]]; then
  DATA_DIR="$HOME/.docker"
  echo "检测到旧版数据目录 ${HOME}/.docker/mysql/data，DOCKER_DATA_DIR 沿用 ${DATA_DIR}（不迁移、不改动数据）"
fi
[[ -n "$DATA_DIR" ]] && setv DOCKER_DATA_DIR "$DATA_DIR"

if [[ $RANDOM_PW -eq 1 ]]; then
  for k in MYSQL_ROOT_PASSWORD REDIS_PASSWORD POSTGRES_PASSWORD \
           NACOS_ADMIN_PASSWORD NACOS_AUTH_IDENTITY_VALUE GRAFANA_ADMIN_PASSWORD; do
    setv "$k" "$(rand)"
  done
  setv NACOS_AUTH_TOKEN "$(head -c 32 /dev/urandom | base64 | tr -d '\n')"
  echo "已写入随机密码（仅在 .env 中，未打印）。注意："
  echo "  - MySQL 的 nacos / admin 账号密码写在 config/mysql/init/01-users.sql，未随机化（.env 的 MYSQL_NACOS_PASSWORD 保持与 SQL 一致）"
  echo "  - CLICKHOUSE_PASSWORD 保持默认：config/clickvisual/docker.toml 的 DSN 里写了同一密码，改它需同步改该文件"
  echo "  - wealth-freedom 的 K8s dev secret / IDEA 配置要改成 .env 里的新密码"
fi

mkdir -p "$HOME/.kube" 2>/dev/null || true   # jenkins 挂载源目录（缺失时 Docker 会以 root 创建）
echo "已生成 ${ENV_FILE}（权限 600，已被 .gitignore 忽略）"
echo "下一步：scripts/check.sh   然后：scripts/up.sh core"
