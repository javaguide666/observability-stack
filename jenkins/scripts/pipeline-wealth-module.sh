#!/usr/bin/env bash
# 单模块 Wealth CI/CD：只构建并滚动更新一个 Deployment
# 必需：MODULE=gateway|auth|system-server|admin-server|ecommerce-server|freedom-web|ecommerce-web
# MODE=build-deploy|rollback|promote  SOURCE=github|local-mount
# 参数：OVERLAY IMAGE_TAG BRANCH GIT_SHA SKIP_MVN(仅 Java) ONLY_CURRENT_MODULE(仅 Java，默认只打当前模块) REGISTRY
#
# 环境配置：按 OVERLAY 读取 jenkins/env/<OVERLAY>.env（dev|local|test|prod），脚本本身不写死任何环境。
#   REGISTRY / K8S_NAMESPACE / CACHE_ROOT / MAVEN_SETTINGS / M2_REPO
#   IMAGE_BUILDER=docker|buildctl|none   打镜像方式（dev=docker；test 上 k3s Pod agent 用 buildctl；prod 不构建）
#   DEPLOY_MODE=kubectl|gitops           部署方式（kubectl=set image 按 digest；gitops=把 digest 提交进 overlay，交给 ArgoCD）
#   ALLOWED_MODES                        该环境允许的 MODE（prod 只允许 promote rollback，杜绝线上重新构建）
#   PROMOTE_SOURCE_REGISTRY              MODE=promote 的源仓库（test Harbor），用 crane copy 复制同一个 digest
# 内部参数：MAVEN_REACTOR_MODULES="gateway auth ..." → 只拉码 + 一次 Maven reactor 后退出（wealth-all 用）
#           REPO_LOCK_HELD=1 → 共用仓库锁由上层脚本持有
# PREPARE_ONLY=1：只拉码/解析分支与完整 SHA 并写 ${WORKSPACE}/.wealth-meta-<MODULE>，不构建不部署
#   （Job 的 'Resolve source' 阶段用它，让构建一开始就能把「分支 | 完整 SHA | tag」写进构建描述）
#
# 阶段标记（供控制台前端判断进度；格式固定，单独一行，详见 CI CD Jenkins相关文档 §17「阶段标记约定」）：
#   ==> STAGE <n>/4 [<module>] <name> [SKIPPED]
#   n/name：1 checkout（拉代码）· 2 build（构建）· 3 push（镜像）· 4 deploy（部署）
#   [<module>] 仅当环境变量 STAGE_PREFIX 非空时输出（wealth-all 设为 "[gateway]" 等）；失败即 exit，不会输出后续阶段标记
set -euo pipefail

MODULE="${MODULE:-}"
MODE="${MODE:-build-deploy}"
OVERLAY="${OVERLAY:-dev}"

# ---------- 按环境加载配置 ----------
# env 文件统一写成 VAR="${VAR:-默认值}"：Job 参数 / 外部环境变量优先，文件只给默认值
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export WEALTH_CI_ROOT="${WEALTH_CI_ROOT:-$(cd "$SCRIPT_DIR/.." && pwd)}"
ENV_FILE="${WEALTH_ENV_FILE:-${WEALTH_CI_ROOT}/env/${OVERLAY}.env}"
if [[ ! -f "$ENV_FILE" ]]; then
  echo "ERROR: 缺少环境配置 ${ENV_FILE}（OVERLAY 期望 dev|local|test|prod）" >&2
  exit 1
fi
# shellcheck disable=SC1090
source "$ENV_FILE"
IMAGE_TAG="${IMAGE_TAG:-auto}"
WORKSPACE_ROOT="${WORKSPACE_ROOT:-${WORKSPACE:-$(pwd)/workspace-wealth}/repos}"
SKIP_MVN="${SKIP_MVN:-0}"
# 显式 0/false 才 -am 全量；缺省或 true=只打包当前模块
if [[ "${ONLY_CURRENT_MODULE:-}" == "0" || "${ONLY_CURRENT_MODULE:-}" == "false" ]]; then
  ONLY_CURRENT_MODULE=0
else
  ONLY_CURRENT_MODULE=1
fi
# 各 Job 共用的工作副本（Java 模块都在 wealth-freedom 里，只拉一次）
JENKINS_HOME="${JENKINS_HOME:-/var/jenkins_home}"
CACHE_ROOT="${CACHE_ROOT:-$JENKINS_HOME}"      # dev=Jenkins 家目录；test/prod Pod agent=PVC 挂载点
GIT_CACHE_ROOT="${GIT_CACHE_ROOT:-${CACHE_ROOT}/git-cache}"
RESOLVE_CACHE_DIR="${RESOLVE_CACHE_DIR:-${CACHE_ROOT}/cache/repos}"
ENV_NAME="${ENV_NAME:-$OVERLAY}"
IMAGE_BUILDER="${IMAGE_BUILDER:-docker}"
DEPLOY_MODE="${DEPLOY_MODE:-kubectl}"
ALLOWED_MODES="${ALLOWED_MODES:-build-deploy rollback}"
MAVEN_SETTINGS="${MAVEN_SETTINGS:-}"           # 空=Maven 默认 ~/.m2/settings.xml
M2_REPO="${M2_REPO:-}"                         # 空=Maven 默认 ~/.m2/repository
ALLOW_LOCAL_MOUNT="${ALLOW_LOCAL_MOUNT:-0}"
LOCAL_MOUNT_ROOT="${LOCAL_MOUNT_ROOT:-/gitee}"
KUBECONFIG_DOCKER_DESKTOP_REWRITE="${KUBECONFIG_DOCKER_DESKTOP_REWRITE:-0}"
BUILDKIT_HOST="${BUILDKIT_HOST:-}"
PROMOTE_SOURCE_REGISTRY="${PROMOTE_SOURCE_REGISTRY:-}"
PROMOTE_DIGEST="${PROMOTE_DIGEST:-}"           # 可选：按 sha256:... 晋升，优先于 IMAGE_TAG
GITOPS_REPO_URL="${GITOPS_REPO_URL:-}"
GITOPS_BRANCH="${GITOPS_BRANCH:-main}"
GITOPS_OVERLAY_PATH="${GITOPS_OVERLAY_PATH:-deploy/k8s/overlays}"
MAVEN_REACTOR_MODULES="${MAVEN_REACTOR_MODULES:-}"
DEPLOY_HINT="${DEPLOY_HINT:-在 wealth-freedom 仓库根目录执行 ./deploy/k8s/scripts/deploy.sh ${OVERLAY}}"
SOURCE="${SOURCE:-github}"
BRANCH="${BRANCH:-main}"
# List Git Branches 参数可能带回 refs/heads/ 或 origin/ 前缀
BRANCH="${BRANCH#refs/heads/}"
BRANCH="${BRANCH#origin/}"
GIT_SHA="${GIT_SHA:-}"
# 测试/生产私有仓库前缀，例如 registry.example.com/wealth；空=本机 Desktop 短名镜像
REGISTRY="${REGISTRY:-}"
IMAGE_DIGEST_REF=""   # 推送到 REGISTRY 后的 repo@sha256:...，部署按 digest 引用（test 验证过的同一镜像晋升 prod）
HISTORY_KEEP="${HISTORY_KEEP:-10}"
PREPARE_ONLY="${PREPARE_ONLY:-0}"
USED_LOCAL_MOUNT=0
META_BRANCH=""
REPO_FULL_SHA=""

export JAVA_HOME="${JAVA_HOME:-/opt/java/jdk-25}"
export PATH="${JAVA_HOME}/bin:/opt/maven/bin:/usr/local/bin:${PATH:-/usr/bin}"
# 前端 Dockerfile 的 RUN --mount=type=cache 依赖 BuildKit
export DOCKER_BUILDKIT="${DOCKER_BUILDKIT:-1}"

GH_FREEDOM="${GH_FREEDOM:-git@github.com:javaguide666/wealth-freedom.git}"
GH_WEB="${GH_WEB:-git@github.com:javaguide666/wealth-freedom-web.git}"
GH_MALL="${GH_MALL:-git@github.com:javaguide666/wealth-ecommerce-web.git}"

# 容器是 Linux：忽略本机挂载的 macOS ~/.ssh/config（含 UseKeychain 等非法选项会直接让 ssh 退出）
# 与 refresh-branch-cache.sh / resolve-commit.sh 一致；Jenkins 凭据 github-ssh 不注入本脚本，靠挂载私钥
if [[ -z "${GIT_SSH_COMMAND:-}" ]]; then
  _ssh_opts="-F /dev/null -o BatchMode=yes -o StrictHostKeyChecking=accept-new -o ConnectTimeout=15"
  GIT_SSH_COMMAND="ssh ${_ssh_opts}"
  # GIT_SSH_KEY_FILE：test/prod 由 Jenkins 凭据（sshUserPrivateKey）注入；dev 回退到挂载的私钥
  for _k in \
    "${GIT_SSH_KEY_FILE:-}" \
    "${JENKINS_HOME}/.ssh/id_ed25519" \
    "${JENKINS_HOME}/.ssh/id_rsa.github" \
    "${JENKINS_HOME}/.ssh/git-rsa" \
    "${HOME}/.ssh/id_ed25519" \
    "${HOME}/.ssh/id_rsa.github"
  do
    if [[ -f "$_k" ]]; then
      GIT_SSH_COMMAND="ssh ${_ssh_opts} -i ${_k}"
      break
    fi
  done
  unset _k _ssh_opts
fi
export GIT_SSH_COMMAND GIT_TERMINAL_PROMPT=0

# 兼容旧变量
if [[ "${USE_LOCAL_GITEE:-}" == "1" ]]; then
  SOURCE="local-mount"
elif [[ "${USE_LOCAL_GITEE:-}" == "0" ]]; then
  SOURCE="github"
fi

NS="${K8S_NAMESPACE:-wealth}"
JAVA_IMAGE="${JAVA_IMAGE:-eclipse-temurin:25-jre}"

# MODULE → kind repo deploy container image mvn_pl jar_glob compose_service dockerfile_rel
# kind: java | web | mall
declare -A MOD_KIND MOD_REPO MOD_DEPLOY MOD_CTN MOD_IMAGE MOD_PL MOD_JAR MOD_SVC MOD_DF

init_modules() {
  MOD_KIND[gateway]=java;          MOD_REPO[gateway]=freedom
  MOD_DEPLOY[gateway]=wealth-gateway; MOD_CTN[gateway]=app; MOD_IMAGE[gateway]=wealth-gateway
  MOD_PL[gateway]=wealth-gateway;  MOD_JAR[gateway]="wealth-gateway/target/wealth-gateway-*.jar"
  MOD_SVC[gateway]=gateway;        MOD_DF[gateway]=

  MOD_KIND[auth]=java;             MOD_REPO[auth]=freedom
  MOD_DEPLOY[auth]=wealth-auth;    MOD_CTN[auth]=app; MOD_IMAGE[auth]=wealth-auth
  MOD_PL[auth]=wealth-auth;        MOD_JAR[auth]="wealth-auth/target/wealth-auth-*-exec.jar"
  MOD_SVC[auth]=auth;              MOD_DF[auth]=

  MOD_KIND[system-server]=java;    MOD_REPO[system-server]=freedom
  MOD_DEPLOY[system-server]=wealth-system-server; MOD_CTN[system-server]=app
  MOD_IMAGE[system-server]=wealth-system-server
  MOD_PL[system-server]=wealth-system/wealth-system-server
  MOD_JAR[system-server]="wealth-system/wealth-system-server/target/wealth-system-server-*.jar"
  MOD_SVC[system-server]=system-server; MOD_DF[system-server]=

  MOD_KIND[admin-server]=java;     MOD_REPO[admin-server]=freedom
  MOD_DEPLOY[admin-server]=wealth-admin-server; MOD_CTN[admin-server]=app
  MOD_IMAGE[admin-server]=wealth-admin-server
  MOD_PL[admin-server]=wealth-admin/wealth-admin-server
  MOD_JAR[admin-server]="wealth-admin/wealth-admin-server/target/wealth-admin-server-*.jar"
  MOD_SVC[admin-server]=admin-server; MOD_DF[admin-server]=

  MOD_KIND[ecommerce-server]=java; MOD_REPO[ecommerce-server]=freedom
  MOD_DEPLOY[ecommerce-server]=wealth-ecommerce-server; MOD_CTN[ecommerce-server]=app
  MOD_IMAGE[ecommerce-server]=wealth-ecommerce-server
  MOD_PL[ecommerce-server]=wealth-ecommerce/wealth-ecommerce-server
  MOD_JAR[ecommerce-server]="wealth-ecommerce/wealth-ecommerce-server/target/wealth-ecommerce-server-*.jar"
  MOD_SVC[ecommerce-server]=ecommerce-server; MOD_DF[ecommerce-server]=

  MOD_KIND[freedom-web]=web;       MOD_REPO[freedom-web]=web
  MOD_DEPLOY[freedom-web]=wealth-freedom-web; MOD_CTN[freedom-web]=nginx
  MOD_IMAGE[freedom-web]=wealth-freedom-web
  MOD_PL[freedom-web]=; MOD_JAR[freedom-web]=
  MOD_SVC[freedom-web]=freedom-web; MOD_DF[freedom-web]=Dockerfile

  MOD_KIND[ecommerce-web]=mall;    MOD_REPO[ecommerce-web]=mall
  MOD_DEPLOY[ecommerce-web]=wealth-ecommerce-web; MOD_CTN[ecommerce-web]=web
  MOD_IMAGE[ecommerce-web]=wealth-ecommerce-web
  MOD_PL[ecommerce-web]=; MOD_JAR[ecommerce-web]=
  MOD_SVC[ecommerce-web]=ecommerce-web; MOD_DF[ecommerce-web]=apps/web/Dockerfile
}

sanitize_tag_part() {
  echo "$1" | tr '/:' '--' | tr -cd 'A-Za-z0-9_.-' | cut -c1-80
}

# 根据完整/短 SHA 选出最合适的分支名（main > master > dev > 其余）
detect_branch_for_sha() {
  local dir="$1" full="$2" preferred="${3:-}"
  local names name
  names=$(git -C "$dir" branch -r --contains "$full" 2>/dev/null \
    | sed 's/^[* ]*//; s#^origin/##' \
    | grep -vE '^(HEAD|)$' \
    | grep -v ' ' \
    | sort -u || true)
  if [[ -z "$names" ]]; then
    return 1
  fi
  if [[ -n "$preferred" ]] && printf '%s\n' "$names" | grep -qx "$preferred"; then
    echo "$preferred"
    return 0
  fi
  for name in main master dev develop; do
    if printf '%s\n' "$names" | grep -qx "$name"; then
      echo "$name"
      return 0
    fi
  done
  echo "$names" | head -1
}

prune_image_history() {
  local image="$1"
  local keep="${HISTORY_KEEP:-10}"
  local tags tag n=0
  tags=$(docker images --format '{{.CreatedAt}}\t{{.Tag}}' "$image" 2>/dev/null \
    | sort -r \
    | awk -F'\t' '$2!="" && $2!="<none>" && $2!="latest" && $2!="local" {print $2}')
  while IFS= read -r tag; do
    [[ -z "$tag" ]] && continue
    n=$((n + 1))
    if [[ "$n" -gt "$keep" ]]; then
      echo "==> 清理超出 ${keep} 的历史镜像 ${image}:${tag}"
      docker image rm "${image}:${tag}" >/dev/null 2>&1 || true
    fi
  done <<< "$tags"
}

resolve_sha() {
  local dir="$1" want="$2" full
  if [[ ${#want} -lt 7 ]]; then
    echo "ERROR: SHA 过短（至少 7 位）: ${want}" >&2
    return 1
  fi
  full=$(git -C "$dir" rev-parse --verify "${want}^{commit}" 2>/dev/null || true)
  if [[ -z "$full" ]]; then
    GIT_SSH_COMMAND="${GIT_SSH_COMMAND:-ssh -F /dev/null -o BatchMode=yes -o StrictHostKeyChecking=accept-new}" \
      git -C "$dir" fetch --depth=1 origin "$want" 2>/dev/null || \
    GIT_SSH_COMMAND="${GIT_SSH_COMMAND:-ssh -F /dev/null -o BatchMode=yes -o StrictHostKeyChecking=accept-new}" \
      git -C "$dir" fetch origin "$want" 2>/dev/null || true
    full=$(git -C "$dir" rev-parse --verify "${want}^{commit}" 2>/dev/null || true)
  fi
  if [[ -z "$full" ]]; then
    echo "ERROR: 仓库 $(basename "$dir") 找不到 commit: ${want}" >&2
    return 1
  fi
  echo "$full"
}

mark_checkout() {
  local dir="$1" full
  [[ -n "${BUILD_NUMBER:-}" ]] || return 0
  full=$(git -C "$dir" rev-parse HEAD)
  printf '%s %s %s\n' "$BUILD_NUMBER" "$full" "$BRANCH" > "${WORKSPACE:-.}/.wealth-checkout-${MODULE}"
}

fetch_origin_branch() {
  local dir="$1" branch="$2"
  local ssh="${GIT_SSH_COMMAND:-ssh -F /dev/null -o BatchMode=yes -o StrictHostKeyChecking=accept-new}"
  GIT_SSH_COMMAND="$ssh" git -C "$dir" fetch --prune --no-tags origin "+refs/heads/${branch}:refs/remotes/origin/${branch}" \
    || GIT_SSH_COMMAND="$ssh" git -C "$dir" fetch --prune --no-tags origin "$branch"
}

# 占用共用工作副本，避免 gateway/auth 同时 checkout 同一棵树
acquire_repo_lock() {
  local dir="$1"
  if [[ "${REPO_LOCK_HELD:-0}" == "1" ]]; then
    echo "==> 共用仓库锁由上层脚本持有（$(basename "$dir")）"
    return 0
  fi
  mkdir -p "$(dirname "$dir")"
  exec 9>"${dir}.lock"
  if command -v flock >/dev/null 2>&1; then
    echo "==> 等待共用仓库锁 $(basename "$dir")"
    flock 9
    echo "==> 已占用共用仓库 $(basename "$dir")"
  fi
}

# 优先从 resolve-commit 的本地镜像克隆，避免每个 Job 再走一遍 GitHub
clone_from_local_mirror() {
  local url="$1" dir="$2"
  local name mirror
  name="$(basename "$dir")"
  mirror="${RESOLVE_CACHE_DIR}/${name}.git"
  if [[ -d "$mirror" ]]; then
    echo "==> 从本地镜像克隆 ${name}（各模块共用，不再重复拉取 GitHub）"
    git clone "$mirror" "$dir"
    git -C "$dir" remote set-url origin "$url"
    return 0
  fi
  return 1
}

clone_or_update() {
  local url="$1" dir="$2" branch="$3" sha="${4:-}"
  local full detected stamp sbuild="" ssha="" sbranch="" head=""
  branch="${branch:-main}"
  stamp="${WORKSPACE:-.}/.wealth-checkout-${MODULE}"
  acquire_repo_lock "$dir"

  # 同一次构建的第二遍（Resolve source 已经同步过）：不再 fetch
  if [[ -n "${BUILD_NUMBER:-}" && -f "$stamp" && -d "$dir/.git" ]]; then
    read -r sbuild ssha sbranch < "$stamp" || true
    head=$(git -C "$dir" rev-parse HEAD 2>/dev/null || true)
    if [[ "$sbuild" == "$BUILD_NUMBER" && -n "$ssha" && "$head" == "$ssha" ]]; then
      echo "==> 本构建已同步 $(basename "$dir") @ ${ssha:0:12}，跳过再次 fetch"
      if [[ -n "$sbranch" ]]; then BRANCH="$sbranch"; fi
      return 0
    fi
  fi

  if [[ -d "$dir/.git" ]]; then
    if [[ -n "$sha" ]] && git -C "$dir" cat-file -e "${sha}^{commit}" 2>/dev/null; then
      echo "==> 本地已有 commit ${sha:0:12}，跳过 fetch"
    else
      echo "==> fetch origin ${branch}"
      fetch_origin_branch "$dir" "$branch"
      if [[ -n "$sha" ]] && ! git -C "$dir" cat-file -e "${sha}^{commit}" 2>/dev/null; then
        GIT_SSH_COMMAND="${GIT_SSH_COMMAND:-ssh -F /dev/null -o BatchMode=yes -o StrictHostKeyChecking=accept-new}" \
          git -C "$dir" fetch origin "$sha" || true
      fi
    fi
  else
    mkdir -p "$(dirname "$dir")"
    if clone_from_local_mirror "$url" "$dir"; then
      :
    elif [[ -n "$sha" ]]; then
      GIT_SSH_COMMAND="${GIT_SSH_COMMAND:-ssh -F /dev/null -o BatchMode=yes -o StrictHostKeyChecking=accept-new}" \
        git clone "$url" "$dir"
    else
      GIT_SSH_COMMAND="${GIT_SSH_COMMAND:-ssh -F /dev/null -o BatchMode=yes -o StrictHostKeyChecking=accept-new}" \
        git clone --branch "$branch" --single-branch "$url" "$dir" || \
      GIT_SSH_COMMAND="${GIT_SSH_COMMAND:-ssh -F /dev/null -o BatchMode=yes -o StrictHostKeyChecking=accept-new}" \
        git clone "$url" "$dir"
    fi
  fi

  if [[ -n "$sha" ]]; then
    if ! git -C "$dir" cat-file -e "${sha}^{commit}" 2>/dev/null; then
      GIT_SSH_COMMAND="${GIT_SSH_COMMAND:-ssh -F /dev/null -o BatchMode=yes -o StrictHostKeyChecking=accept-new}" \
        git -C "$dir" fetch origin "$sha" || true
    fi
    if ! git -C "$dir" rev-parse --verify "origin/${branch}" >/dev/null 2>&1; then
      fetch_origin_branch "$dir" "$branch" || true
    fi
    full=$(resolve_sha "$dir" "$sha")
    detected=$(detect_branch_for_sha "$dir" "$full" "$branch" || true)
    if [[ -n "$detected" ]]; then
      BRANCH="$detected"
      echo "==> SHA ${full:0:12} 自动选择分支 BRANCH=${BRANCH}"
    else
      echo "WARN: 无法从 SHA 反查分支，继续使用 BRANCH=${branch}" >&2
    fi
    if git -C "$dir" diff --quiet && git -C "$dir" diff --cached --quiet \
      && [[ "$(git -C "$dir" rev-parse HEAD)" == "$full" ]]; then
      echo "==> 已在 ${full:0:12}，保留文件时间戳（Maven 增量编译）"
    else
      echo "==> checkout $(basename "$dir") @ ${full} (requested ${sha})"
      git -C "$dir" checkout --detach "$full"
    fi
    mark_checkout "$dir"
  else
    if ! git -C "$dir" rev-parse --verify "origin/${branch}" >/dev/null 2>&1; then
      GIT_SSH_COMMAND="${GIT_SSH_COMMAND:-ssh -F /dev/null -o BatchMode=yes -o StrictHostKeyChecking=accept-new}" \
        git -C "$dir" fetch origin "${branch}:refs/remotes/origin/${branch}" || \
      GIT_SSH_COMMAND="${GIT_SSH_COMMAND:-ssh -F /dev/null -o BatchMode=yes -o StrictHostKeyChecking=accept-new}" \
        git -C "$dir" fetch origin "$branch"
    fi
    local target
    target=$(git -C "$dir" rev-parse "origin/${branch}")
    if [[ "$(git -C "$dir" rev-parse HEAD)" == "$target" ]] \
      && git -C "$dir" diff --quiet && git -C "$dir" diff --cached --quiet; then
      echo "==> 已在 origin/${branch} @ ${target:0:12}，保留文件时间戳（Maven 增量编译）"
    else
      echo "==> checkout $(basename "$dir") branch=${branch} @ origin/${branch}"
      git -C "$dir" checkout -B "$branch" "origin/${branch}"
      git -C "$dir" reset --hard "origin/${branch}"
    fi
    mark_checkout "$dir"
  fi
}

# 仅 dev（Docker Desktop）：容器里访问不到宿主机 127.0.0.1:6443，改写成 kubernetes.docker.internal
# test/prod 的 KUBECONFIG 由 Jenkins 凭据注入，env 文件里 KUBECONFIG_DOCKER_DESKTOP_REWRITE=0
rewrite_kubeconfig_for_docker_desktop() {
  [[ "$KUBECONFIG_DOCKER_DESKTOP_REWRITE" == "1" ]] || return 0
  if [[ -f "${KUBECONFIG:-$HOME/.kube/config}" ]] && grep -qE 'https://(127\.0\.0\.1|localhost):6443' "${KUBECONFIG:-$HOME/.kube/config}"; then
    mkdir -p "${CACHE_ROOT}/.kube-ci"
    sed -E 's#https://(127\.0\.0\.1|localhost):6443#https://kubernetes.docker.internal:6443#g' \
      "${KUBECONFIG:-$HOME/.kube/config}" > "${CACHE_ROOT}/.kube-ci/config"
    export KUBECONFIG="${CACHE_ROOT}/.kube-ci/config"
    echo "==> KUBECONFIG 已改写为 kubernetes.docker.internal:6443"
  fi
}

pick_jar() {
  local pattern="$1"
  local jar
  # shellcheck disable=SC2086
  jar=$(ls -1 $pattern 2>/dev/null | grep -v plain | head -1 || true)
  if [[ -z "$jar" ]]; then
    # shellcheck disable=SC2086
    jar=$(ls -1 $pattern 2>/dev/null | head -1 || true)
  fi
  if [[ -z "$jar" ]]; then
    echo "ERROR: 找不到 jar: $pattern" >&2
    exit 1
  fi
  echo "$jar"
}

# 含该 SHA 的其它分支（去掉本次构建分支）。成功返回逗号分隔或 "-"；查不到则不输出。
# 同一构建里脚本会跑两遍（解析 SHA / 真正构建），按 SHA 复用，避免再 fetch 一次。
capture_related() {
  local sha="$1" primary="$2"
  local repo="" script out cache line extras=""
  case "${MOD_REPO[$MODULE]:-}" in
    freedom) repo=wealth-freedom ;;
    web) repo=wealth-freedom-web ;;
    mall) repo=wealth-ecommerce-web ;;
  esac
  if [[ -z "$repo" || ! "$sha" =~ ^[0-9a-fA-F]{40}$ ]]; then
    return 0
  fi
  cache="${WORKSPACE:-.}/.wealth-related-cache"
  if [[ -f "$cache" ]] && [[ "$(head -n 1 "$cache" 2>/dev/null || true)" == "$sha" ]]; then
    sed -n '2p' "$cache"
    return 0
  fi
  script="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/resolve-commit.sh"
  out="${WORKSPACE:-.}/.wealth-resolve.json"
  # RESOLVE_UPDATE=0：镜像里已有该 SHA 就不再 remote update。点「刷新关联分支」的 Job 仍默认会刷新。
  RESOLVE_UPDATE=0 SHA="$sha" REPO="$repo" RESOLVE_OUT="$out" bash "$script" >/dev/null 2>&1 || true
  if [[ ! -f "${out}.branches" ]]; then
    echo "WARN: 关联分支未写入（识别失败），构建继续" >&2
    return 0
  fi
  while IFS= read -r line || [[ -n "$line" ]]; do
    line="${line//$'\r'/}"
    [[ -z "$line" || "$line" == "$primary" ]] && continue
    [[ "$line" =~ ^[A-Za-z0-9_./-]+$ ]] || continue
    if [[ -z "$extras" ]]; then extras="$line"; else extras="${extras},${line}"; fi
  done < "${out}.branches"
  [[ -z "$extras" ]] && extras="-"
  printf '%s\n%s\n' "$sha" "$extras" > "$cache"
  printf '%s' "$extras"
}

# 写构建元数据，供 Job 的 Groovy 写入构建描述（只含分支名/SHA/tag/关联分支，无敏感信息）
write_meta() {
  local branch="$1" sha="$2" tag="$3" related="${4-}" out dest
  out="${WORKSPACE:-.}/.wealth-meta-${MODULE}"
  related="$(printf '%s' "$related" | tr -d '\r\n')"
  {
    printf 'MODULE=%s\n' "$MODULE"
    printf 'MODE=%s\n' "$MODE"
    printf 'BRANCH=%s\n' "$(printf '%s' "$branch" | tr -d '\r\n')"
    printf 'SHA=%s\n' "$sha"
    printf 'IMAGE_TAG=%s\n' "$tag"
    if [[ -n "$related" ]]; then
      printf 'RELATED=%s\n' "$related"
    fi
  } > "$out"
  echo "==> 构建元数据 分支=${branch} | SHA ${sha} | tag ${tag}${related:+ | 关联分支 ${related}} → ${out}"
  # 控制台历史直接读这个文件；不依赖 Jenkins 重新加载 Job 里的描述模板
  if [[ -n "$related" && -n "${JOB_NAME:-}" && -n "${BUILD_NUMBER:-}" ]]; then
    dest="${JENKINS_HOME}/userContent/wealth-data/related/${JOB_NAME}"
    mkdir -p "$dest" 2>/dev/null && printf '%s\n' "$related" > "${dest}/${BUILD_NUMBER}.txt" || true
  fi
}

# 读镜像上的 wealth.git.* 标签（build-deploy 时写入）；旧镜像没有标签则返回 unknown
image_label() {
  local img="$1" key="$2" v
  v=$(docker image inspect --format "{{index .Config.Labels \"${key}\"}}" "$img" 2>/dev/null || true)
  if [[ -z "$v" || "$v" == "<no value>" ]]; then v="unknown"; fi
  echo "$v"
}

persist_image_tag() {
  local tag="$1" out
  out="${WORKSPACE:-.}/.wealth-image-tag"
  echo "$tag" > "$out"
  echo "==> 已写入 IMAGE_TAG=${tag} → ${out}"
}

ensure_deploy_exists() {
  local deploy="$1"
  if ! kubectl -n "$NS" get deploy "$deploy" >/dev/null 2>&1; then
    echo "ERROR: 命名空间 ${NS} 中不存在 Deployment/${deploy}" >&2
    echo "       首次请先执行一次全量部署：${DEPLOY_HINT}" >&2
    exit 1
  fi
}

image_ref() {
  # 短名 wealth-xxx + tag → 可选带 REGISTRY 前缀
  local short="$1" tag="$2"
  if [[ -n "${REGISTRY}" ]]; then
    echo "${REGISTRY%/}/${short}:${tag}"
  else
    echo "${short}:${tag}"
  fi
}

push_if_registry() {
  local short="${MOD_IMAGE[$MODULE]}"
  local tag="$IMAGE_TAG"
  local remote
  if [[ -z "${REGISTRY}" || "$IMAGE_BUILDER" != "docker" ]]; then
    return 0   # 无仓库=dev 本机镜像；buildctl 构建时已直接推送并记录 digest
  fi
  remote="$(image_ref "$short" "$tag")"
  echo "==> docker tag ${short}:${tag} → ${remote}"
  docker tag "${short}:${tag}" "$remote"
  echo "==> docker push ${remote}"
  docker push "$remote"
  # 记录 digest：部署按内容哈希引用，tag 被覆盖也不会部署错镜像；prod 晋升复制同一个 digest
  IMAGE_DIGEST_REF=$(docker image inspect --format '{{range .RepoDigests}}{{println .}}{{end}}' "$remote" \
    | grep -F "${remote%:*}@" | head -1 || true)
  if [[ -n "$IMAGE_DIGEST_REF" ]]; then
    save_digest "$IMAGE_DIGEST_REF"
  else
    echo "WARN: 未取到 ${remote} 的 digest，部署回退为按 tag 引用"
  fi
}

die() { echo "ERROR: $*" >&2; exit 1; }

save_digest() {
  IMAGE_DIGEST_REF="$1"
  echo "==> 镜像 digest：${IMAGE_DIGEST_REF}"
  echo "$IMAGE_DIGEST_REF" > "${WORKSPACE:-.}/.wealth-digest-${MODULE}"
}

# Maven 不依赖固定 ~/.m2：settings 与本地仓库由 env 文件指定（阿里云 → 以后 Nexus 只改 env；仓库目录可放 PVC）
mvn_run() {
  local args=(-B -T 1C -nsu -DskipTests)
  if [[ -n "$MAVEN_SETTINGS" ]]; then
    [[ -f "$MAVEN_SETTINGS" ]] || die "MAVEN_SETTINGS 不存在：${MAVEN_SETTINGS}"
    args+=(-s "$MAVEN_SETTINGS")
  fi
  if [[ -n "$M2_REPO" ]]; then
    args+=("-Dmaven.repo.local=${M2_REPO}")
  fi
  echo "==> mvn ${args[*]} $*"
  mvn "${args[@]}" "$@"
}

# 打镜像：build_image <context 目录> <Dockerfile 相对 context，空=Dockerfile> <短名> <tag> [--build-arg K=V ...]
# IMAGE_BUILDER=docker：本机 docker build（dev 行为不变），有 REGISTRY 时随后 push_if_registry
# IMAGE_BUILDER=buildctl：BuildKit 直接构建并推送到 REGISTRY，缓存放在仓库的 cache/<短名>，记录 digest
build_image() {
  local ctx="$1" df="$2" short="$3" tag="$4"
  shift 4
  local sha_label="wealth.git.sha=${REPO_FULL_SHA:-}" branch_label="wealth.git.branch=${META_BRANCH:-$BRANCH}"
  case "$IMAGE_BUILDER" in
    docker)
      echo "==> docker build ${short}:${tag}（context=${ctx}${df:+ dockerfile=${df}}）"
      (cd "$ctx" && docker build ${df:+-f "$df"} "$@" \
        --label "$sha_label" --label "$branch_label" \
        -t "${short}:${tag}" .)
      ;;
    buildctl)
      [[ -n "$REGISTRY" ]] || die "IMAGE_BUILDER=buildctl 必须配置 REGISTRY"
      local ref meta digest opts=() cache
      ref="$(image_ref "$short" "$tag")"
      cache="${REGISTRY%/}/cache/${short}"
      df="${df:-Dockerfile}"
      while [[ $# -gt 0 ]]; do
        [[ "$1" == "--build-arg" && $# -ge 2 ]] || die "build_image(buildctl) 只支持 --build-arg K=V，收到：$1"
        opts+=(--opt "build-arg:$2")
        shift 2
      done
      meta=$(mktemp)
      echo "==> buildctl build → ${ref}（cache=${cache}）"
      buildctl ${BUILDKIT_HOST:+--addr "$BUILDKIT_HOST"} build \
        --frontend dockerfile.v0 \
        --local "context=${ctx}" \
        --local "dockerfile=${ctx}/$(dirname "$df")" \
        --opt "filename=$(basename "$df")" \
        "${opts[@]}" \
        --opt "label:${sha_label}" --opt "label:${branch_label}" \
        --import-cache "type=registry,ref=${cache}" \
        --export-cache "type=registry,ref=${cache},mode=max" \
        --output "type=image,name=${ref},push=true" \
        --metadata-file "$meta"
      digest=$(grep -o '"containerimage.digest": *"sha256:[0-9a-f]*"' "$meta" | grep -o 'sha256:[0-9a-f]*' | head -1 || true)
      rm -f "$meta"
      [[ -n "$digest" ]] || die "buildctl 未返回镜像 digest"
      save_digest "${ref%:*}@${digest}"
      ;;
    *)
      die "IMAGE_BUILDER=${IMAGE_BUILDER} 不能构建镜像（${ENV_NAME} 只允许 MODE=${ALLOWED_MODES}）"
      ;;
  esac
}

# 部署：kubectl=按 digest set image 并等待滚动；gitops=把镜像写进 overlays/<OVERLAY> 并提交，由 ArgoCD Sync
deploy_image() {
  local tag="$1"
  case "$DEPLOY_MODE" in
    kubectl)
      set_one_image "$tag"
      wait_one_rollout
      ;;
    gitops)
      deploy_gitops "$tag"
      ;;
    *)
      die "未知 DEPLOY_MODE=${DEPLOY_MODE}（kubectl|gitops）"
      ;;
  esac
}

deploy_gitops() {
  local tag="$1"
  local image="${MOD_IMAGE[$MODULE]}" ref dir overlay_dir
  [[ -n "$GITOPS_REPO_URL" ]] || die "DEPLOY_MODE=gitops 需要 GITOPS_REPO_URL"
  ref="${IMAGE_DIGEST_REF:-$(image_ref "$image" "$tag")}"
  dir="${GITOPS_DIR:-${CACHE_ROOT}/gitops/$(basename "$GITOPS_REPO_URL" .git)}"
  mkdir -p "$(dirname "$dir")"
  exec 8>"${dir}.lock"
  if command -v flock >/dev/null 2>&1; then flock 8; fi
  if [[ -d "$dir/.git" ]]; then
    git -C "$dir" fetch --prune origin "$GITOPS_BRANCH"
    git -C "$dir" checkout -B "$GITOPS_BRANCH" "origin/${GITOPS_BRANCH}"
    git -C "$dir" reset --hard "origin/${GITOPS_BRANCH}"
  else
    git clone --branch "$GITOPS_BRANCH" --single-branch "$GITOPS_REPO_URL" "$dir"
  fi
  overlay_dir="${dir}/${GITOPS_OVERLAY_PATH}/${OVERLAY}"
  [[ -f "${overlay_dir}/kustomization.yaml" ]] || die "找不到 ${overlay_dir}/kustomization.yaml"
  echo "==> kustomize edit set image ${image}=${ref}（${GITOPS_OVERLAY_PATH}/${OVERLAY}）"
  (cd "$overlay_dir" && kustomize edit set image "${image}=${ref}")
  if git -C "$dir" diff --quiet; then
    echo "==> overlay 已是 ${ref}，无需提交"
    return 0
  fi
  git -C "$dir" -c user.name="${GITOPS_GIT_USER:-wealth-ci}" -c user.email="${GITOPS_GIT_EMAIL:-wealth-ci@localhost}" \
    commit -am "deploy(${OVERLAY}): ${image} -> ${ref}"
  git -C "$dir" push origin "HEAD:${GITOPS_BRANCH}"
  echo "==> 已提交 ${GITOPS_BRANCH}，等待 ArgoCD Sync 上线（回滚 = git revert 这次提交）"
}

# 只有缺内部模块时才会被 build_one_module 退回 -am；wealth-all 用它一次编完全部 Java 模块
run_maven_reactor() {
  local m pls=() pl_csv
  for m in $MAVEN_REACTOR_MODULES; do
    [[ "${MOD_KIND[$m]:-}" == "java" ]] || continue
    pls+=("${MOD_PL[$m]}")
  done
  [[ ${#pls[@]} -gt 0 ]] || die "MAVEN_REACTOR_MODULES 里没有 Java 模块：${MAVEN_REACTOR_MODULES}"
  pl_csv=$(IFS=,; echo "${pls[*]}")
  stage 2 build
  if [[ "$ONLY_CURRENT_MODULE" == "1" ]]; then
    echo "==> Maven reactor：一次构建 ${#pls[@]} 个模块（不带 -am）install -pl ${pl_csv}"
    (cd "$WEALTH_FREEDOM_ROOT" && mvn_run install -pl "$pl_csv")
  else
    echo "==> Maven reactor：一次构建 ${#pls[@]} 个模块及其依赖 install -pl ${pl_csv} -am"
    (cd "$WEALTH_FREEDOM_ROOT" && mvn_run install -pl "$pl_csv" -am)
  fi
}

# 读远端镜像标签（promote 用；镜像不在本机）
remote_label() {
  local ref="$1" key="$2" v
  v=$(crane config "$ref" 2>/dev/null | grep -o "\"${key}\":\"[^\"]*\"" | head -1 | sed 's/.*":"//; s/"$//' || true)
  echo "${v:-unknown}"
}

preflight() {
  if [[ -n "$MAVEN_REACTOR_MODULES" ]]; then
    command -v mvn >/dev/null || die "缺少 mvn"
    return 0   # 只拉码 + Maven，不需要镜像构建器和集群
  fi
  case "$IMAGE_BUILDER" in
    docker)   command -v docker >/dev/null; docker info >/dev/null ;;
    buildctl) if [[ "$MODE" == "build-deploy" ]]; then command -v buildctl >/dev/null || die "缺少 buildctl"; fi ;;
    none)     ;;
    *)        die "未知 IMAGE_BUILDER=${IMAGE_BUILDER}（docker|buildctl|none）" ;;
  esac
  if [[ "$MODE" == "promote" ]]; then
    command -v crane >/dev/null || die "MODE=promote 需要 crane"
  fi
  case "$DEPLOY_MODE" in
    kubectl) command -v kubectl >/dev/null; kubectl cluster-info >/dev/null ;;
    gitops)  command -v git >/dev/null; command -v kustomize >/dev/null || die "DEPLOY_MODE=gitops 需要 kustomize" ;;
    *)       die "未知 DEPLOY_MODE=${DEPLOY_MODE}（kubectl|gitops）" ;;
  esac
}

show_acceptance() {
  [[ "$DEPLOY_MODE" == "kubectl" ]] || return 0
  echo "==> 验收"
  kubectl -n "$NS" get deploy "${MOD_DEPLOY[$MODULE]}" -o custom-columns=NAME:.metadata.name,IMAGE:.spec.template.spec.containers[0].image 2>/dev/null || true
  kubectl -n "$NS" get pods -o wide 2>/dev/null | grep "${MOD_DEPLOY[$MODULE]}" || true
}

set_one_image() {
  local tag="$1"
  local deploy="${MOD_DEPLOY[$MODULE]}"
  local ctn="${MOD_CTN[$MODULE]}"
  local image="${MOD_IMAGE[$MODULE]}"
  local full
  ensure_deploy_exists "$deploy"
  if [[ -n "$IMAGE_DIGEST_REF" ]]; then
    full="$IMAGE_DIGEST_REF"
  else
    full="$(image_ref "$image" "$tag")"
  fi
  echo "==> kubectl set image deploy/${deploy} ${ctn}=${full} (ns=${NS})"
  kubectl -n "$NS" set image "deploy/${deploy}" "${ctn}=${full}"
}

wait_one_rollout() {
  local deploy="${MOD_DEPLOY[$MODULE]}"
  echo "==> rollout status deploy/${deploy}"
  kubectl -n "$NS" rollout status "deploy/${deploy}" --timeout=300s
}

verify_one_image() {
  local tag="$1"
  local image="${MOD_IMAGE[$MODULE]}"
  # 测试/生产走仓库：集群节点会 pull，不要求本机构建机本地一定有该 tag
  if [[ -n "${REGISTRY}" ]]; then
    echo "==> REGISTRY=${REGISTRY}：rollback 跳过本机 docker inspect，直接 set image $(image_ref "$image" "$tag")"
    return 0
  fi
  if ! docker image inspect "${image}:${tag}" >/dev/null 2>&1; then
    echo "ERROR: 缺少镜像 ${image}:${tag}（rollback 需要本机 Docker 已有该 tag）" >&2
    exit 1
  fi
}

build_one_module() {
  local kind="${MOD_KIND[$MODULE]}"
  local image="${MOD_IMAGE[$MODULE]}"
  local svc="${MOD_SVC[$MODULE]}"
  local tag="$IMAGE_TAG"


  if [[ "$kind" == "java" ]]; then
    if [[ "$SKIP_MVN" != "1" ]]; then command -v mvn >/dev/null; fi
    local pl="${MOD_PL[$MODULE]}"
    local jar_pat="${MOD_JAR[$MODULE]}"
    local mvn_rc=0
    if [[ "$SKIP_MVN" != "1" ]]; then stage 2 build; else stage 2 build SKIPPED; fi
    if [[ "$SKIP_MVN" == "1" ]]; then
      echo "==> SKIP_MVN=1，跳过 Maven"
    elif [[ "$ONLY_CURRENT_MODULE" == "1" ]]; then
      echo "==> Maven 只构建当前模块：install -pl ${pl}（不带 -am）"
      local mvn_log
      mvn_log=$(mktemp)
      set +e
      (cd "$WEALTH_FREEDOM_ROOT" && mvn_run install -pl "$pl") 2>&1 | tee "$mvn_log"
      mvn_rc=${PIPESTATUS[0]}
      set -e
      if [[ $mvn_rc -ne 0 ]]; then
        # 只有缺内部模块（com.wealth.freedom:*）时才退回 -am；网络、证书、编译错误直接失败，不白跑一遍
        if grep -E '^\[ERROR\]' "$mvn_log" | grep -q 'com\.wealth\.freedom:'; then
          rm -f "$mvn_log"
          echo "==> 缺内部依赖模块（还没 install），改为 -pl ${pl} -am"
          (cd "$WEALTH_FREEDOM_ROOT" && mvn_run install -pl "$pl" -am)
        else
          rm -f "$mvn_log"
          echo "==> Maven 失败且不是缺内部模块（网络/证书/编译错误），不再退回 -am"
          return "$mvn_rc"
        fi
      fi
      rm -f "$mvn_log"
    else
      echo "==> Maven 全量依赖：install -pl ${pl} -am"
      (cd "$WEALTH_FREEDOM_ROOT" && mvn_run install -pl "$pl" -am)
    fi
    cd "$WEALTH_FREEDOM_ROOT"
    local jar rel
    jar=$(pick_jar "$jar_pat")
    rel="${jar#"$WEALTH_FREEDOM_ROOT"/}"
    stage 3 push
    echo "==> 镜像 ${image}:${tag} from ${rel}"
    build_image "$WEALTH_FREEDOM_ROOT" deploy/docker/Dockerfile.java "$image" "$tag" \
      --build-arg "JAVA_IMAGE=${JAVA_IMAGE}" --build-arg "JAR_FILE=${rel}"
  elif [[ "$kind" == "web" ]]; then
    stage 2 build SKIPPED   # 前端 pnpm 编译在 Dockerfile 多阶段内，随下一阶段 docker build 执行
    stage 3 push
    echo "==> 镜像 ${image}:${tag} (wealth-freedom-web)"
    build_image "$WEALTH_FREEDOM_WEB_ROOT" "" "$image" "$tag"
  elif [[ "$kind" == "mall" ]]; then
    stage 2 build SKIPPED   # 同上：前端编译在 Dockerfile 内
    stage 3 push
    echo "==> 镜像 ${image}:${tag} -f apps/web/Dockerfile"
    build_image "$WEALTH_ECOMMERCE_WEB_ROOT" apps/web/Dockerfile "$image" "$tag"
  else
    echo "ERROR: 未知 kind=${kind}" >&2
    exit 1
  fi
  echo "==> 构建完成 ${image}:${tag}"
  [[ "$IMAGE_BUILDER" == "docker" ]] || return 0
  docker images "${image}" --format '{{.Repository}}:{{.Tag}}\t{{.ID}}\t{{.CreatedSince}}' | head -5 || true
}

prepare_repos() {
  local repo_kind="${MOD_REPO[$MODULE]}"

  # local-mount 只在 dev 允许（ALLOW_LOCAL_MOUNT=1）：直接用宿主机挂进来的源码
  if [[ "$SOURCE" == "local-mount" && "$ALLOW_LOCAL_MOUNT" == "1" && -d "${LOCAL_MOUNT_ROOT}/wealth-freedom" ]]; then
    export WEALTH_FREEDOM_ROOT="${LOCAL_MOUNT_ROOT}/wealth-freedom"
    export WEALTH_FREEDOM_WEB_ROOT="${LOCAL_MOUNT_ROOT}/wealth-freedom-web"
    export WEALTH_ECOMMERCE_WEB_ROOT="${LOCAL_MOUNT_ROOT}/wealth-ecommerce-web"
    USED_LOCAL_MOUNT=1
    echo "==> SOURCE=local-mount：使用 ${LOCAL_MOUNT_ROOT}（不切换分支/SHA）"
    if [[ -n "$GIT_SHA" ]]; then
      echo "WARN: local-mount 忽略 GIT_SHA；请改 SOURCE=github"
    fi
  else
    if [[ "$SOURCE" == "local-mount" ]]; then
      echo "WARN: local-mount 在 ${ENV_NAME} 不可用（ALLOW_LOCAL_MOUNT=${ALLOW_LOCAL_MOUNT}），回退 SOURCE=github"
    fi
    mkdir -p "$WORKSPACE_ROOT"
    if ! mkdir -p "$GIT_CACHE_ROOT" 2>/dev/null; then
      echo "WARN: ${GIT_CACHE_ROOT} 不可写，回退到本 Job 工作区"
      GIT_CACHE_ROOT="$WORKSPACE_ROOT"
    fi
    case "$repo_kind" in
      freedom)
        clone_or_update "$GH_FREEDOM" "$GIT_CACHE_ROOT/wealth-freedom" "$BRANCH" "$GIT_SHA"
        export WEALTH_FREEDOM_ROOT="$GIT_CACHE_ROOT/wealth-freedom"
        ;;
      web)
        clone_or_update "$GH_WEB" "$GIT_CACHE_ROOT/wealth-freedom-web" "$BRANCH" "$GIT_SHA"
        export WEALTH_FREEDOM_WEB_ROOT="$GIT_CACHE_ROOT/wealth-freedom-web"
        # Java Dockerfile 不需要，但 OVERLAY Desktop 无关；保留 freedom 根可选
        if [[ "$ALLOW_LOCAL_MOUNT" == "1" && -d "${LOCAL_MOUNT_ROOT}/wealth-freedom" ]]; then
          export WEALTH_FREEDOM_ROOT="${LOCAL_MOUNT_ROOT}/wealth-freedom"
        elif [[ -d "$WORKSPACE_ROOT/wealth-freedom" ]]; then
          export WEALTH_FREEDOM_ROOT="$WORKSPACE_ROOT/wealth-freedom"
        fi
        ;;
      mall)
        clone_or_update "$GH_MALL" "$GIT_CACHE_ROOT/wealth-ecommerce-web" "$BRANCH" "$GIT_SHA"
        export WEALTH_ECOMMERCE_WEB_ROOT="$GIT_CACHE_ROOT/wealth-ecommerce-web"
        if [[ "$ALLOW_LOCAL_MOUNT" == "1" && -d "${LOCAL_MOUNT_ROOT}/wealth-freedom" ]]; then
          export WEALTH_FREEDOM_ROOT="${LOCAL_MOUNT_ROOT}/wealth-freedom"
        elif [[ -d "$WORKSPACE_ROOT/wealth-freedom" ]]; then
          export WEALTH_FREEDOM_ROOT="$WORKSPACE_ROOT/wealth-freedom"
        fi
        ;;
    esac
  fi
}

resolve_auto_tag() {
  local repo_dir=""
  case "${MOD_REPO[$MODULE]}" in
    freedom) repo_dir="$WEALTH_FREEDOM_ROOT" ;;
    web)     repo_dir="$WEALTH_FREEDOM_WEB_ROOT" ;;
    mall)    repo_dir="$WEALTH_ECOMMERCE_WEB_ROOT" ;;
  esac
  local full short branch_part
  full=$(git -C "$repo_dir" rev-parse HEAD)
  short=$(git -C "$repo_dir" rev-parse --short=7 HEAD)
  branch_part=$(sanitize_tag_part "$BRANCH")
  AUTO_TAG="${branch_part}-${short}"
  REPO_FULL_SHA="$full"
  META_BRANCH="$BRANCH"
  if [[ "$USED_LOCAL_MOUNT" == "1" ]]; then
    # local-mount 不切分支：记录 /gitee 里实际所在分支，而不是下拉框里的值
    META_BRANCH=$(git -C "$repo_dir" symbolic-ref --short -q HEAD 2>/dev/null || echo "detached")
  fi
  if [[ -z "$IMAGE_TAG" || "$IMAGE_TAG" == "auto" || "$IMAGE_TAG" == "local" ]]; then
    IMAGE_TAG="$AUTO_TAG"
    echo "==> IMAGE_TAG 自动设为 ${IMAGE_TAG}（${MODULE} ${full}）"
  else
    echo "==> 使用用户指定 IMAGE_TAG=${IMAGE_TAG}（HEAD ${full}）"
  fi
}

# 阶段标记：stage <n> <name> [skipped]。只在阶段开始时输出一行；失败时 set -e 直接退出，后续阶段不会输出
STAGE_TOTAL=4
STAGE_PREFIX="${STAGE_PREFIX:-}"
stage() {
  local n="$1" name="$2" skipped="${3:-}"
  printf '==> STAGE %s/%s %s%s%s\n' "$n" "$STAGE_TOTAL" "${STAGE_PREFIX:+${STAGE_PREFIX} }" "$name" "${skipped:+ SKIPPED}"
}

# ---------- main ----------
init_modules

if [[ -z "$MODULE" || -z "${MOD_KIND[$MODULE]+x}" ]]; then
  echo "ERROR: 请设置 MODULE=gateway|auth|system-server|admin-server|ecommerce-server|freedom-web|ecommerce-web" >&2
  echo "       当前 MODULE='${MODULE}'" >&2
  exit 1
fi

# 环境允许的 MODE：prod 只允许 promote/rollback，从脚本层面杜绝在 prod 重新构建
if [[ " ${ALLOWED_MODES} " != *" ${MODE} "* ]]; then
  echo "ERROR: OVERLAY=${OVERLAY} 只允许 MODE=${ALLOWED_MODES// /|}（当前 ${MODE}）" >&2
  if [[ "$MODE" == "build-deploy" ]]; then
    echo "       该环境不重新构建：先在 test 构建验证，再用 MODE=promote 晋升同一个镜像 digest" >&2
  fi
  exit 1
fi

rm -f "${WORKSPACE:-.}/.wealth-meta-${MODULE}"
if [[ "$PREPARE_ONLY" != "1" ]]; then rm -f "${WORKSPACE:-.}/.wealth-digest-${MODULE}"; fi
rewrite_kubeconfig_for_docker_desktop

echo "==> 预检 ENV=${ENV_NAME} MODULE=${MODULE} MODE=${MODE} OVERLAY=${OVERLAY} SOURCE=${SOURCE} REGISTRY=${REGISTRY:-<empty>} IMAGE_BUILDER=${IMAGE_BUILDER} DEPLOY_MODE=${DEPLOY_MODE}"
if [[ "$PREPARE_ONLY" != "1" ]]; then   # PREPARE_ONLY 只拉码解析 SHA，不需要镜像构建器/K8s
  preflight
fi

# ---------- rollback ----------
if [[ "$MODE" == "rollback" ]]; then
  if [[ -z "$IMAGE_TAG" || "$IMAGE_TAG" == "auto" || "$IMAGE_TAG" == "local" ]]; then
    echo "ERROR: MODE=rollback 时必须显式指定历史 IMAGE_TAG（不可为 auto/local/空）" >&2
    exit 1
  fi
  stage 1 checkout SKIPPED   # rollback 不拉码；分支/SHA 取自镜像 label
  stage 2 build SKIPPED
  rb_img="${MOD_IMAGE[$MODULE]}:${IMAGE_TAG}"
  if [[ -n "$REGISTRY" ]] && command -v crane >/dev/null 2>&1; then
    rb_remote="$(image_ref "${MOD_IMAGE[$MODULE]}" "$IMAGE_TAG")"
    write_meta "$(remote_label "$rb_remote" wealth.git.branch)" "$(remote_label "$rb_remote" wealth.git.sha)" "$IMAGE_TAG"
  else
    write_meta "$(image_label "$rb_img" wealth.git.branch)" "$(image_label "$rb_img" wealth.git.sha)" "$IMAGE_TAG"
  fi
  if [[ "$PREPARE_ONLY" == "1" ]]; then
    echo "==> PREPARE_ONLY=1：rollback 仅写元数据，不执行回滚"
    exit 0
  fi
  # 镜像阶段：本机镜像存在性检查；走 REGISTRY 时由集群节点 pull，无本机检查 → SKIPPED
  if [[ -n "${REGISTRY}" ]]; then stage 3 push SKIPPED; else stage 3 push; fi
  verify_one_image "$IMAGE_TAG"
  if [[ -n "$REGISTRY" ]] && command -v crane >/dev/null 2>&1; then
    rb_digest=$(crane digest "$(image_ref "${MOD_IMAGE[$MODULE]}" "$IMAGE_TAG")" 2>/dev/null || true)
    if [[ -n "$rb_digest" ]]; then save_digest "${REGISTRY%/}/${MOD_IMAGE[$MODULE]}@${rb_digest}"; fi
  fi
  stage 4 deploy
  deploy_image "$IMAGE_TAG"
  persist_image_tag "$IMAGE_TAG"
  show_acceptance
  echo "==> 完成 MODE=rollback MODULE=${MODULE} IMAGE_TAG=${IMAGE_TAG}（历史版本已启动）"
  exit 0
fi

# ---------- promote：不编译不构建，把源仓库（test）里验证过的同一个 digest 复制到本环境仓库再部署 ----------
if [[ "$MODE" == "promote" ]]; then
  if [[ -z "$PROMOTE_DIGEST" && ( -z "$IMAGE_TAG" || "$IMAGE_TAG" == "auto" || "$IMAGE_TAG" == "local" ) ]]; then
    die "MODE=promote 需要显式 IMAGE_TAG（test 上验证过的 tag）或 PROMOTE_DIGEST=sha256:..."
  fi
  [[ -n "$PROMOTE_SOURCE_REGISTRY" ]] || die "MODE=promote 需要 PROMOTE_SOURCE_REGISTRY（源仓库，如 test Harbor）"
  [[ -n "$REGISTRY" ]] || die "MODE=promote 需要 REGISTRY（目标仓库）"
  stage 1 checkout SKIPPED
  stage 2 build SKIPPED
  pm_image="${MOD_IMAGE[$MODULE]}"
  if [[ -n "$PROMOTE_DIGEST" ]]; then
    pm_src="${PROMOTE_SOURCE_REGISTRY%/}/${pm_image}@${PROMOTE_DIGEST}"
  else
    pm_src="${PROMOTE_SOURCE_REGISTRY%/}/${pm_image}:${IMAGE_TAG}"
  fi
  pm_dst="$(image_ref "$pm_image" "$IMAGE_TAG")"
  write_meta "$(remote_label "$pm_src" wealth.git.branch)" "$(remote_label "$pm_src" wealth.git.sha)" "$IMAGE_TAG"
  if [[ "$PREPARE_ONLY" == "1" ]]; then
    echo "==> PREPARE_ONLY=1：promote 仅写元数据"
    exit 0
  fi
  stage 3 push
  echo "==> crane copy ${pm_src} → ${pm_dst}（同一个 digest，不重新构建）"
  crane copy "$pm_src" "$pm_dst"
  pm_digest=$(crane digest "$pm_dst")
  if [[ -n "$PROMOTE_DIGEST" && "$pm_digest" != "$PROMOTE_DIGEST" ]]; then
    die "复制后 digest 不一致：期望 ${PROMOTE_DIGEST}，实际 ${pm_digest}"
  fi
  save_digest "${pm_dst%:*}@${pm_digest}"
  stage 4 deploy
  deploy_image "$IMAGE_TAG"
  persist_image_tag "$IMAGE_TAG"
  show_acceptance
  echo "==> 完成 MODE=promote MODULE=${MODULE} ${IMAGE_DIGEST_REF}"
  exit 0
fi

if [[ "$MODE" != "build-deploy" ]]; then
  echo "ERROR: 未知 MODE=${MODE}（期望 build-deploy|rollback|promote）" >&2
  exit 1
fi

stage 1 checkout
prepare_repos
resolve_auto_tag
write_meta "$META_BRANCH" "$REPO_FULL_SHA" "$IMAGE_TAG" "$(capture_related "$REPO_FULL_SHA" "$META_BRANCH")"
if [[ "$PREPARE_ONLY" == "1" ]]; then
  echo "==> PREPARE_ONLY=1：已解析分支与 SHA，不构建不部署"
  exit 0
fi
if [[ -n "$MAVEN_REACTOR_MODULES" ]]; then
  run_maven_reactor
  echo "==> Maven reactor 完成 @ ${REPO_FULL_SHA}"
  exit 0
fi
build_one_module      # 内部输出 STAGE 2 build（Maven / SKIPPED）与 STAGE 3 push（构建镜像）
push_if_registry
stage 4 deploy
deploy_image "$IMAGE_TAG"
persist_image_tag "$IMAGE_TAG"
if [[ "$IMAGE_BUILDER" == "docker" ]]; then prune_image_history "${MOD_IMAGE[$MODULE]}"; fi
if command -v python3 >/dev/null 2>&1; then
  JENKINS_HOME="$JENKINS_HOME" python3 "${SCRIPT_DIR}/write-ui-meta.py" >/dev/null 2>&1 || true
fi

show_acceptance
echo "==> 完成 MODE=build-deploy MODULE=${MODULE} IMAGE_TAG=${IMAGE_TAG}${IMAGE_DIGEST_REF:+ (${IMAGE_DIGEST_REF})}"
