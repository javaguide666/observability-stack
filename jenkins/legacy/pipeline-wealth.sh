#!/usr/bin/env bash
# Wealth Freedom CI/CD：选分支 / 指定 SHA 构建部署，或按 IMAGE_TAG 回滚
# MODE=build-deploy|rollback  SOURCE=github|local-mount
set -euo pipefail

MODE="${MODE:-build-deploy}"
OVERLAY="${OVERLAY:-dev}"
IMAGE_TAG="${IMAGE_TAG:-auto}"
WORKSPACE_ROOT="${WORKSPACE_ROOT:-${WORKSPACE:-$(pwd)/workspace-wealth}/repos}"
SKIP_MVN="${SKIP_MVN:-0}"
SKIP_FRONT="${SKIP_FRONT:-0}"
SOURCE="${SOURCE:-github}"

export JAVA_HOME="${JAVA_HOME:-/opt/java/jdk-25}"
export PATH="${JAVA_HOME}/bin:/opt/maven/bin:/usr/local/bin:${PATH:-/usr/bin}"

GH_FREEDOM="${GH_FREEDOM:-git@github.com:javaguide666/wealth-freedom.git}"
GH_WEB="${GH_WEB:-git@github.com:javaguide666/wealth-freedom-web.git}"
GH_MALL="${GH_MALL:-git@github.com:javaguide666/wealth-ecommerce-web.git}"
BRANCH_FREEDOM="${BRANCH_FREEDOM:-main}"
BRANCH_WEB="${BRANCH_WEB:-main}"
BRANCH_MALL="${BRANCH_MALL:-main}"
GIT_SHA_FREEDOM="${GIT_SHA_FREEDOM:-}"
GIT_SHA_WEB="${GIT_SHA_WEB:-}"
GIT_SHA_MALL="${GIT_SHA_MALL:-}"

# 兼容旧变量：USE_LOCAL_GITEE=1 等价 SOURCE=local-mount
if [[ "${USE_LOCAL_GITEE:-}" == "1" ]]; then
  SOURCE="local-mount"
elif [[ "${USE_LOCAL_GITEE:-}" == "0" ]]; then
  SOURCE="github"
fi

NS="${K8S_NAMESPACE:-wealth}"

# deploy 名 → 容器名 → 镜像名（无 registry）
# shellcheck disable=SC2034
WEALTH_SET_IMAGE_SPECS=(
  "wealth-gateway:app:wealth-gateway"
  "wealth-auth:app:wealth-auth"
  "wealth-system-server:app:wealth-system-server"
  "wealth-admin-server:app:wealth-admin-server"
  "wealth-ecommerce-server:app:wealth-ecommerce-server"
  "wealth-freedom-web:nginx:wealth-freedom-web"
  "wealth-ecommerce-web:web:wealth-ecommerce-web"
)

sanitize_tag_part() {
  # Docker tag 允许 [A-Za-z0-9_.-]；把分支名里的 / 等换成 -
  echo "$1" | tr '/:' '--' | tr -cd 'A-Za-z0-9_.-' | cut -c1-80
}

resolve_sha() {
  # $1=repo dir  $2=want sha(7+) → 打印完整 SHA；找不到则失败
  local dir="$1" want="$2" full
  if [[ ${#want} -lt 7 ]]; then
    echo "ERROR: SHA 过短（至少 7 位）: ${want}" >&2
    return 1
  fi
  full=$(git -C "$dir" rev-parse --verify "${want}^{commit}" 2>/dev/null || true)
  if [[ -z "$full" ]]; then
    # 尝试按对象抓取（部分托管支持 fetch 任意 SHA）
    GIT_SSH_COMMAND="${GIT_SSH_COMMAND:-ssh -o StrictHostKeyChecking=accept-new}" \
      git -C "$dir" fetch --depth=1 origin "$want" 2>/dev/null || \
    GIT_SSH_COMMAND="${GIT_SSH_COMMAND:-ssh -o StrictHostKeyChecking=accept-new}" \
      git -C "$dir" fetch origin "$want" 2>/dev/null || true
    full=$(git -C "$dir" rev-parse --verify "${want}^{commit}" 2>/dev/null || true)
  fi
  if [[ -z "$full" ]]; then
    echo "ERROR: 仓库 $(basename "$dir") 找不到 commit: ${want}" >&2
    echo "       请确认 SHA 正确且已 push 到远端，或先 fetch 对应分支。" >&2
    return 1
  fi
  echo "$full"
}

clone_or_update() {
  # $1=url $2=dir $3=branch $4=optional sha
  local url="$1" dir="$2" branch="$3" sha="${4:-}"
  local full
  if [[ -d "$dir/.git" ]]; then
    GIT_SSH_COMMAND="${GIT_SSH_COMMAND:-ssh -o StrictHostKeyChecking=accept-new}" \
      git -C "$dir" fetch --all --prune
  else
    mkdir -p "$(dirname "$dir")"
    GIT_SSH_COMMAND="${GIT_SSH_COMMAND:-ssh -o StrictHostKeyChecking=accept-new}" \
      git clone --branch "$branch" --single-branch "$url" "$dir" || \
    GIT_SSH_COMMAND="${GIT_SSH_COMMAND:-ssh -o StrictHostKeyChecking=accept-new}" \
      git clone "$url" "$dir"
    GIT_SSH_COMMAND="${GIT_SSH_COMMAND:-ssh -o StrictHostKeyChecking=accept-new}" \
      git -C "$dir" fetch --all --prune || true
  fi

  if [[ -n "$sha" ]]; then
    # 确保分支 tip 已拉到，便于短 SHA 解析；再 checkout 具体 commit
    git -C "$dir" fetch origin "+refs/heads/${branch}:refs/remotes/origin/${branch}" 2>/dev/null || true
    full=$(resolve_sha "$dir" "$sha")
    echo "==> checkout $(basename "$dir") @ ${full} (requested ${sha})"
    git -C "$dir" checkout --detach "$full"
  else
    # 保证有 origin/branch
    if ! git -C "$dir" rev-parse --verify "origin/${branch}" >/dev/null 2>&1; then
      GIT_SSH_COMMAND="${GIT_SSH_COMMAND:-ssh -o StrictHostKeyChecking=accept-new}" \
        git -C "$dir" fetch origin "${branch}:refs/remotes/origin/${branch}" || \
      GIT_SSH_COMMAND="${GIT_SSH_COMMAND:-ssh -o StrictHostKeyChecking=accept-new}" \
        git -C "$dir" fetch origin "$branch"
    fi
    echo "==> checkout $(basename "$dir") branch=${branch} @ origin/${branch}"
    git -C "$dir" checkout -B "$branch" "origin/${branch}"
    git -C "$dir" reset --hard "origin/${branch}"
  fi
}

rewrite_kubeconfig_for_docker_desktop() {
  if [[ -f "${KUBECONFIG:-$HOME/.kube/config}" ]] && grep -qE 'https://(127\.0\.0\.1|localhost):6443' "${KUBECONFIG:-$HOME/.kube/config}"; then
    mkdir -p /var/jenkins_home/.kube-ci
    sed -E 's#https://(127\.0\.0\.1|localhost):6443#https://kubernetes.docker.internal:6443#g' \
      "${KUBECONFIG:-$HOME/.kube/config}" > /var/jenkins_home/.kube-ci/config
    export KUBECONFIG=/var/jenkins_home/.kube-ci/config
    echo "==> KUBECONFIG 已改写为 kubernetes.docker.internal:6443"
  fi
}

set_wealth_images() {
  local tag="$1" spec deploy ctn image
  echo "==> kubectl set image → tag=${tag} (ns=${NS})"
  for spec in "${WEALTH_SET_IMAGE_SPECS[@]}"; do
    IFS=':' read -r deploy ctn image <<<"$spec"
    if kubectl -n "$NS" get deploy "$deploy" >/dev/null 2>&1; then
      kubectl -n "$NS" set image "deploy/${deploy}" "${ctn}=${image}:${tag}"
    else
      echo "    skip missing deploy/${deploy}"
    fi
  done
}

wait_wealth_rollout() {
  local deploy
  for deploy in wealth-gateway wealth-auth wealth-system-server wealth-admin-server \
                wealth-ecommerce-server wealth-freedom-web wealth-ecommerce-web; do
    if kubectl -n "$NS" get deploy "$deploy" >/dev/null 2>&1; then
      kubectl -n "$NS" rollout status "deploy/${deploy}" --timeout=300s || true
    fi
  done
}

verify_images_exist() {
  local tag="$1" img required_ok=1
  # 后端必检；前端缺失仅警告（可能 SKIP_FRONT 打的历史包）
  for img in wealth-gateway wealth-auth wealth-system-server wealth-admin-server wealth-ecommerce-server; do
    if ! docker image inspect "${img}:${tag}" >/dev/null 2>&1; then
      echo "ERROR: 缺少镜像 ${img}:${tag}（rollback 需要本机 Docker 已有该 tag）" >&2
      required_ok=0
    fi
  done
  for img in wealth-freedom-web wealth-ecommerce-web; do
    if ! docker image inspect "${img}:${tag}" >/dev/null 2>&1; then
      echo "WARN: 前端镜像不存在 ${img}:${tag}（若该 deploy 需要会失败）"
    fi
  done
  [[ "$required_ok" == "1" ]] || return 1
}

persist_image_tag() {
  local tag="$1" out
  out="${WORKSPACE:-.}/.wealth-image-tag"
  echo "$tag" > "$out"
  echo "==> 已写入 IMAGE_TAG=${tag} → ${out}"
}

# ---------- 预检 kube / docker ----------
rewrite_kubeconfig_for_docker_desktop

echo "==> 预检 MODE=${MODE} OVERLAY=${OVERLAY} SOURCE=${SOURCE}"
command -v docker >/dev/null
command -v kubectl >/dev/null
docker info >/dev/null
kubectl cluster-info >/dev/null

# ---------- rollback：不拉码、不构建 ----------
if [[ "$MODE" == "rollback" ]]; then
  if [[ -z "$IMAGE_TAG" || "$IMAGE_TAG" == "auto" || "$IMAGE_TAG" == "local" ]]; then
    echo "ERROR: MODE=rollback 时必须显式指定历史 IMAGE_TAG（不可为 auto/local/空）" >&2
    exit 1
  fi
  verify_images_exist "$IMAGE_TAG"

  # deploy.sh 需要 wealth-freedom 仓库里的 kustomize；优先 /gitee，否则用已有 WORKSPACE
  if [[ -d /gitee/wealth-freedom/deploy/k8s/scripts ]]; then
    export WEALTH_FREEDOM_ROOT=/gitee/wealth-freedom
  elif [[ -d "${WORKSPACE_ROOT}/wealth-freedom/deploy/k8s/scripts" ]]; then
    export WEALTH_FREEDOM_ROOT="${WORKSPACE_ROOT}/wealth-freedom"
  elif [[ -d /gitee/wealth-freedom ]]; then
    export WEALTH_FREEDOM_ROOT=/gitee/wealth-freedom
  else
    echo "ERROR: rollback 找不到 wealth-freedom（需 /gitee 或 WORKSPACE_ROOT 下已有仓以执行 deploy.sh）" >&2
    exit 1
  fi
  DEPLOY_SH="$WEALTH_FREEDOM_ROOT/deploy/k8s/scripts/deploy.sh"
  chmod +x "$DEPLOY_SH" "$WEALTH_FREEDOM_ROOT/deploy/k8s/scripts/wait-ready.sh" || true

  echo "==> CD(rollback): deploy.sh ${OVERLAY} 然后 set image → ${IMAGE_TAG}"
  "$DEPLOY_SH" "$OVERLAY"
  set_wealth_images "$IMAGE_TAG"
  wait_wealth_rollout
  persist_image_tag "$IMAGE_TAG"
  echo "==> 验收"
  kubectl -n "$NS" get pods -o wide || true
  kubectl -n "$NS" get deploy -o wide || true
  exit 0
fi

if [[ "$MODE" != "build-deploy" ]]; then
  echo "ERROR: 未知 MODE=${MODE}（期望 build-deploy|rollback）" >&2
  exit 1
fi

# ---------- build-deploy：准备三仓 ----------
if [[ "$SOURCE" == "local-mount" && -d /gitee/wealth-freedom/deploy/k8s/scripts ]]; then
  export WEALTH_FREEDOM_ROOT=/gitee/wealth-freedom
  export WEALTH_FREEDOM_WEB_ROOT=/gitee/wealth-freedom-web
  export WEALTH_ECOMMERCE_WEB_ROOT=/gitee/wealth-ecommerce-web
  echo "==> SOURCE=local-mount：使用 /gitee（不切换分支/SHA）。分支/SHA 构建请选 SOURCE=github"
  if [[ -n "$GIT_SHA_FREEDOM$GIT_SHA_WEB$GIT_SHA_MALL" ]]; then
    echo "WARN: local-mount 忽略 GIT_SHA_*；请改 SOURCE=github"
  fi
else
  if [[ "$SOURCE" == "local-mount" ]]; then
    echo "WARN: /gitee 不可用，回退 SOURCE=github"
  fi
  mkdir -p "$WORKSPACE_ROOT"
  clone_or_update "$GH_FREEDOM" "$WORKSPACE_ROOT/wealth-freedom" "$BRANCH_FREEDOM" "$GIT_SHA_FREEDOM"
  clone_or_update "$GH_WEB" "$WORKSPACE_ROOT/wealth-freedom-web" "$BRANCH_WEB" "$GIT_SHA_WEB"
  clone_or_update "$GH_MALL" "$WORKSPACE_ROOT/wealth-ecommerce-web" "$BRANCH_MALL" "$GIT_SHA_MALL"
  export WEALTH_FREEDOM_ROOT="$WORKSPACE_ROOT/wealth-freedom"
  export WEALTH_FREEDOM_WEB_ROOT="$WORKSPACE_ROOT/wealth-freedom-web"
  export WEALTH_ECOMMERCE_WEB_ROOT="$WORKSPACE_ROOT/wealth-ecommerce-web"
fi

# ---------- IMAGE_TAG 自动：branch-shortsha（freedom） ----------
FREEDOM_FULL_SHA=$(git -C "$WEALTH_FREEDOM_ROOT" rev-parse HEAD)
FREEDOM_SHORT_SHA=$(git -C "$WEALTH_FREEDOM_ROOT" rev-parse --short=7 HEAD)
BRANCH_PART=$(sanitize_tag_part "$BRANCH_FREEDOM")
AUTO_TAG="${BRANCH_PART}-${FREEDOM_SHORT_SHA}"

if [[ -z "$IMAGE_TAG" || "$IMAGE_TAG" == "auto" || "$IMAGE_TAG" == "local" ]]; then
  IMAGE_TAG="$AUTO_TAG"
  echo "==> IMAGE_TAG 自动设为 ${IMAGE_TAG}（freedom ${FREEDOM_FULL_SHA}）"
else
  echo "==> 使用用户指定 IMAGE_TAG=${IMAGE_TAG}（freedom HEAD ${FREEDOM_FULL_SHA}）"
fi

export IMAGE_TAG SKIP_MVN SKIP_FRONT OVERLAY

BUILD_SH="$WEALTH_FREEDOM_ROOT/deploy/k8s/scripts/build-images.sh"
DEPLOY_SH="$WEALTH_FREEDOM_ROOT/deploy/k8s/scripts/deploy.sh"
chmod +x "$BUILD_SH" "$DEPLOY_SH" "$WEALTH_FREEDOM_ROOT/deploy/k8s/scripts/wait-ready.sh" || true

command -v mvn >/dev/null

echo "==> CI: build-images overlay=${OVERLAY} tag=${IMAGE_TAG}"
echo "    freedom=$(git -C "$WEALTH_FREEDOM_ROOT" rev-parse --short HEAD) web=$(git -C "$WEALTH_FREEDOM_WEB_ROOT" rev-parse --short HEAD 2>/dev/null || echo n/a) mall=$(git -C "$WEALTH_ECOMMERCE_WEB_ROOT" rev-parse --short HEAD 2>/dev/null || echo n/a)"
OVERLAY="$OVERLAY" "$BUILD_SH"

echo "==> CD: deploy.sh ${OVERLAY} + set image → ${IMAGE_TAG}"
"$DEPLOY_SH" "$OVERLAY"
set_wealth_images "$IMAGE_TAG"
wait_wealth_rollout
persist_image_tag "$IMAGE_TAG"

echo "==> 验收"
kubectl -n "$NS" get pods -o wide || true
kubectl -n "$NS" get deploy -o custom-columns=NAME:.metadata.name,IMAGE:.spec.template.spec.containers[0].image 2>/dev/null || true
echo "==> 完成 MODE=build-deploy IMAGE_TAG=${IMAGE_TAG}"
