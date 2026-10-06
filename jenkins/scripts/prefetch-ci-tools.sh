#!/usr/bin/env bash
# 可选：在宿主机预下载 linux 版 CI 工具到 jenkins/cache/，再 docker compose --build。
# 不跑也可以：Dockerfile 会用同一套镜像源下载，并用 BuildKit 缓存，失败重试不会从头再下。
# 产物不要提交 git。
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export CI_TOOLS_CACHE="$ROOT/cache"
export INSTALL=0
case "$(uname -m)" in
  arm64|aarch64) export TARGETARCH=arm64 ;;
  *) export TARGETARCH=amd64 ;;
esac
exec bash "$ROOT/scripts/install-ci-tools.sh"
