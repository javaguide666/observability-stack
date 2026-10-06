#!/usr/bin/env bash
# 下载 Jenkins 镜像要用的 linux 工具：docker 静态客户端、buildx、kubectl、maven。
# 国内镜像优先，断点续传，文件够大就复用（BuildKit cache / 宿主机 jenkins/cache/）。
#
# 环境变量：
#   TARGETARCH        amd64 | arm64（镜像构建由 Docker 传入；宿主机预下载按 uname 推断）
#   CI_TOOLS_CACHE    下载目录，默认 /var/cache/ci-tools
#   INSTALL           1=解压安装到 /usr/local 与 /opt/maven（Dockerfile）；0=只下载（prefetch）
set -euo pipefail

DOCKER_VER="${DOCKER_VER:-27.5.1}"
BUILDX_VER="${BUILDX_VER:-0.20.1}"
KUBECTL_VER="${KUBECTL_VER:-v1.32.3}"
MAVEN_VER="${MAVEN_VER:-3.9.9}"
INSTALL="${INSTALL:-0}"
CACHE="${CI_TOOLS_CACHE:-/var/cache/ci-tools}"

arch="${TARGETARCH:-}"
if [[ -z "$arch" ]]; then
  case "$(uname -m)" in
    arm64|aarch64) arch=arm64 ;;
    *) arch=amd64 ;;
  esac
fi
case "$arch" in
  arm64) DARCH=aarch64; KARCH=arm64 ;;
  amd64) DARCH=x86_64; KARCH=amd64 ;;
  *) echo "unsupported TARGETARCH=${arch}" >&2; exit 1 ;;
esac

mkdir -p "$CACHE"
size_of() {
  if [[ -f "$1" ]]; then stat -c%s "$1" 2>/dev/null || stat -f%z "$1"; else echo 0; fi
}

# DaoCloud 给任意 https 源加前缀（k8s / GitHub 在国内常用）
dc() { printf 'https://files.m.daocloud.io/%s' "${1#https://}"; }

curl_flags() {
  CURL_FLAGS=(-fL --retry 8 --retry-delay 2 --connect-timeout 15 --max-time 600)
  if curl --help 2>/dev/null | grep -q retry-all-errors; then
    CURL_FLAGS+=(--retry-all-errors)
  fi
}

curl_flags

# 已有合格文件则跳过；失败保留 .partial 以便续传
fetch() {
  local dest="$1" min="$2"; shift 2
  if [[ "$(size_of "$dest")" -ge "$min" ]]; then
    echo "==> reuse $(basename "$dest") ($(size_of "$dest") bytes)"
    return 0
  fi
  local url partial="${dest}.partial"
  for url in "$@"; do
    echo "==> ${url}"
    rm -f "$partial"
    if curl "${CURL_FLAGS[@]}" -o "$partial" "$url"; then
      if [[ "$(size_of "$partial")" -ge "$min" ]]; then
        mv "$partial" "$dest"
        return 0
      fi
      echo "WARN: $(basename "$dest") 太小 ($(size_of "$partial"))，换源" >&2
    fi
    rm -f "$partial"
  done
  echo "FAILED ${dest}" >&2
  return 1
}

echo "==> CI tools TARGETARCH=${arch} cache=${CACHE} kubectl=${KUBECTL_VER} docker=${DOCKER_VER} buildx=${BUILDX_VER} maven=${MAVEN_VER}"

fetch "$CACHE/docker.tgz" 1000000 \
  "https://mirrors.aliyun.com/docker-ce/linux/static/stable/${DARCH}/docker-${DOCKER_VER}.tgz" \
  "https://mirrors.huaweicloud.com/docker-ce/linux/static/stable/${DARCH}/docker-${DOCKER_VER}.tgz" \
  "https://download.docker.com/linux/static/stable/${DARCH}/docker-${DOCKER_VER}.tgz"

BX="https://github.com/docker/buildx/releases/download/v${BUILDX_VER}/buildx-v${BUILDX_VER}.linux-${KARCH}"
fetch "$CACHE/docker-buildx" 1000000 \
  "$(dc "$BX")" \
  "https://ghfast.top/${BX}" \
  "https://gh-proxy.com/${BX}" \
  "$BX"

KC="https://dl.k8s.io/release/${KUBECTL_VER}/bin/linux/${KARCH}/kubectl"
fetch "$CACHE/kubectl" 10000000 \
  "$(dc "$KC")" \
  "https://cdn.dl.k8s.io/release/${KUBECTL_VER}/bin/linux/${KARCH}/kubectl" \
  "https://kubernetes.oss-cn-hangzhou.aliyuncs.com/kubernetes-release/release/${KUBECTL_VER}/bin/linux/${KARCH}/kubectl" \
  "$KC"

MVN_TGZ="apache-maven-${MAVEN_VER}-bin.tar.gz"
fetch "$CACHE/maven.tgz" 1000000 \
  "https://mirrors.huaweicloud.com/apache/maven/maven-3/${MAVEN_VER}/binaries/${MVN_TGZ}" \
  "https://mirrors.aliyun.com/apache/maven/maven-3/${MAVEN_VER}/binaries/${MVN_TGZ}" \
  "https://repo.maven.apache.org/maven2/org/apache/maven/apache-maven/${MAVEN_VER}/${MVN_TGZ}" \
  "https://archive.apache.org/dist/maven/maven-3/${MAVEN_VER}/binaries/${MVN_TGZ}"

if [[ "$INSTALL" != "1" ]]; then
  ls -lh "$CACHE"
  echo "prefetch OK → $CACHE"
  exit 0
fi

mkdir -p /tmp/ci-tools /usr/local/lib/docker/cli-plugins /opt
tar -xzf "$CACHE/docker.tgz" -C /tmp/ci-tools
mv /tmp/ci-tools/docker/docker /usr/local/bin/docker
cp "$CACHE/docker-buildx" /usr/local/lib/docker/cli-plugins/docker-buildx
cp "$CACHE/kubectl" /usr/local/bin/kubectl
chmod +x /usr/local/bin/docker /usr/local/lib/docker/cli-plugins/docker-buildx /usr/local/bin/kubectl
tar -xzf "$CACHE/maven.tgz" -C /opt
ln -sfn "/opt/apache-maven-${MAVEN_VER}" /opt/maven
rm -rf /tmp/ci-tools
groupadd -f docker
if id jenkins >/dev/null 2>&1; then usermod -aG docker jenkins; fi
java -version
mvn -v
docker --version
docker buildx version
kubectl version --client=true
echo "install-ci-tools OK"
