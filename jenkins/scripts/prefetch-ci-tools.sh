#!/usr/bin/env bash
# 宿主机预下载 CI 工具到 jenkins/cache/，供 Dockerfile COPY（规避 build 内 TLS 抖动）
# 注意：JDK25 已改由 Dockerfile 多阶段 FROM eclipse-temurin:25-jdk 复制；jdk25.tar.gz 可选
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CACHE="$ROOT/cache"
mkdir -p "$CACHE"
ARCH="$(uname -m)"
case "$ARCH" in
  arm64|aarch64) DARCH=aarch64; KARCH=arm64 ;;
  *) DARCH=x86_64; KARCH=amd64 ;;
esac

size_of() {
  if [[ -f "$1" ]]; then stat -f%z "$1" 2>/dev/null || stat -c%s "$1"; else echo 0; fi
}

curl_get() {
  local out="$1"; shift
  local url
  for url in "$@"; do
    echo "==> try $url"
    if curl -fL --retry 5 --retry-delay 3 --connect-timeout 30 --max-time 900 \
         -o "${out}.partial" "$url"; then
      mv "${out}.partial" "$out"
      ls -lh "$out"
      return 0
    fi
    rm -f "${out}.partial"
  done
  echo "FAILED: $out" >&2
  return 1
}

if [[ $(size_of "$CACHE/docker.tgz") -lt 1000000 ]]; then
  curl_get "$CACHE/docker.tgz" \
    "https://mirrors.aliyun.com/docker-ce/linux/static/stable/${DARCH}/docker-27.5.1.tgz" \
    "https://mirrors.huaweicloud.com/docker-ce/linux/static/stable/${DARCH}/docker-27.5.1.tgz" \
    "https://download.docker.com/linux/static/stable/${DARCH}/docker-27.5.1.tgz"
fi

# 静态 docker 客户端不含 buildx；前端 Dockerfile 的 RUN --mount 必须走 BuildKit
if [[ $(size_of "$CACHE/docker-buildx") -lt 1000000 ]]; then
  curl_get "$CACHE/docker-buildx" \
    "https://github.com/docker/buildx/releases/download/v0.20.1/buildx-v0.20.1.linux-${KARCH}"
fi
chmod +x "$CACHE/docker-buildx" 2>/dev/null || true

if [[ $(size_of "$CACHE/kubectl") -lt 10000000 ]]; then
  KVER=$(curl -fsSL --retry 5 https://dl.k8s.io/release/stable.txt)
  echo "kubectl=$KVER"
  curl_get "$CACHE/kubectl" "https://dl.k8s.io/release/${KVER}/bin/linux/${KARCH}/kubectl"
fi
chmod +x "$CACHE/kubectl"

if [[ $(size_of "$CACHE/maven.tgz") -lt 1000000 ]]; then
  curl_get "$CACHE/maven.tgz" \
    "https://mirrors.huaweicloud.com/apache/maven/maven-3/3.9.9/binaries/apache-maven-3.9.9-bin.tar.gz" \
    "https://repo.maven.apache.org/maven2/org/apache/maven/apache-maven/3.9.9/apache-maven-3.9.9-bin.tar.gz" \
    "https://archive.apache.org/dist/maven/maven-3/3.9.9/binaries/apache-maven-3.9.9-bin.tar.gz"
fi

if [[ $(size_of "$CACHE/jdk25.tar.gz") -lt 10000000 ]]; then
  # 固定 Temurin 25.0.4+7；api.adoptium 在国内易超时，优先 GitHub release
  JDK_GH="https://github.com/adoptium/temurin25-binaries/releases/download/jdk-25.0.4%2B7/OpenJDK25U-jdk_${KARCH}_linux_hotspot_25.0.4_7.tar.gz"
  # github 用 aarch64 文件名（KARCH=arm64 时需映射）
  case "$KARCH" in
    arm64) JDK_ARCH=aarch64 ;;
    *) JDK_ARCH=x64 ;;
  esac
  JDK_GH="https://github.com/adoptium/temurin25-binaries/releases/download/jdk-25.0.4%2B7/OpenJDK25U-jdk_${JDK_ARCH}_linux_hotspot_25.0.4_7.tar.gz"
  curl_get "$CACHE/jdk25.tar.gz"     "$JDK_GH"     "https://api.adoptium.net/v3/binary/latest/25/ga/linux/${KARCH}/jdk/hotspot/normal/eclipse?project=jdk"
fi

ls -lh "$CACHE"
echo "prefetch OK → $CACHE"
