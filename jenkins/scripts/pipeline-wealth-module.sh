#!/usr/bin/env bash
# 单模块 Wealth CI/CD：只构建并滚动更新一个 Deployment
# 必需：MODULE=gateway|auth|system-server|admin-server|ecommerce-server|freedom-web|ecommerce-web
# MODE=build-deploy|rollback  SOURCE=github|local-mount
# 参数：OVERLAY IMAGE_TAG BRANCH GIT_SHA SKIP_MVN(仅 Java) REGISTRY(可选，测试/生产仓库前缀)
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
IMAGE_TAG="${IMAGE_TAG:-auto}"
WORKSPACE_ROOT="${WORKSPACE_ROOT:-${WORKSPACE:-$(pwd)/workspace-wealth}/repos}"
SKIP_MVN="${SKIP_MVN:-0}"
SOURCE="${SOURCE:-github}"
BRANCH="${BRANCH:-main}"
# List Git Branches 参数可能带回 refs/heads/ 或 origin/ 前缀
BRANCH="${BRANCH#refs/heads/}"
BRANCH="${BRANCH#origin/}"
GIT_SHA="${GIT_SHA:-}"
# 测试/生产私有仓库前缀，例如 registry.example.com/wealth；空=本机 Desktop 短名镜像
REGISTRY="${REGISTRY:-}"
HISTORY_KEEP="${HISTORY_KEEP:-10}"
PREPARE_ONLY="${PREPARE_ONLY:-0}"
USED_LOCAL_MOUNT=0
META_BRANCH=""
REPO_FULL_SHA=""

export JAVA_HOME="${JAVA_HOME:-/opt/java/jdk-25}"
export PATH="${JAVA_HOME}/bin:/opt/maven/bin:/usr/local/bin:${PATH:-/usr/bin}"

GH_FREEDOM="${GH_FREEDOM:-git@github.com:javaguide666/wealth-freedom.git}"
GH_WEB="${GH_WEB:-git@github.com:javaguide666/wealth-freedom-web.git}"
GH_MALL="${GH_MALL:-git@github.com:javaguide666/wealth-ecommerce-web.git}"

# 容器是 Linux：忽略本机挂载的 macOS ~/.ssh/config（含 UseKeychain 等非法选项会直接让 ssh 退出）
# 与 refresh-branch-cache.sh / resolve-commit.sh 一致；Jenkins 凭据 github-ssh 不注入本脚本，靠挂载私钥
if [[ -z "${GIT_SSH_COMMAND:-}" ]]; then
  _ssh_opts="-F /dev/null -o BatchMode=yes -o StrictHostKeyChecking=accept-new -o ConnectTimeout=15"
  GIT_SSH_COMMAND="ssh ${_ssh_opts}"
  for _k in \
    /var/jenkins_home/.ssh/id_ed25519 \
    /var/jenkins_home/.ssh/id_rsa.github \
    /var/jenkins_home/.ssh/git-rsa \
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

clone_or_update() {
  local url="$1" dir="$2" branch="$3" sha="${4:-}"
  local full detected
  branch="${branch:-main}"
  if [[ -d "$dir/.git" ]]; then
    GIT_SSH_COMMAND="${GIT_SSH_COMMAND:-ssh -F /dev/null -o BatchMode=yes -o StrictHostKeyChecking=accept-new}" \
      git -C "$dir" fetch --all --prune
  else
    mkdir -p "$(dirname "$dir")"
    if [[ -n "$sha" ]]; then
      GIT_SSH_COMMAND="${GIT_SSH_COMMAND:-ssh -F /dev/null -o BatchMode=yes -o StrictHostKeyChecking=accept-new}" \
        git clone "$url" "$dir"
    else
      GIT_SSH_COMMAND="${GIT_SSH_COMMAND:-ssh -F /dev/null -o BatchMode=yes -o StrictHostKeyChecking=accept-new}" \
        git clone --branch "$branch" --single-branch "$url" "$dir" || \
      GIT_SSH_COMMAND="${GIT_SSH_COMMAND:-ssh -F /dev/null -o BatchMode=yes -o StrictHostKeyChecking=accept-new}" \
        git clone "$url" "$dir"
    fi
    GIT_SSH_COMMAND="${GIT_SSH_COMMAND:-ssh -F /dev/null -o BatchMode=yes -o StrictHostKeyChecking=accept-new}" \
      git -C "$dir" fetch --all --prune || true
  fi

  if [[ -n "$sha" ]]; then
    git -C "$dir" fetch origin "$sha" 2>/dev/null || true
    git -C "$dir" fetch origin "+refs/heads/${branch}:refs/remotes/origin/${branch}" 2>/dev/null || true
    full=$(resolve_sha "$dir" "$sha")
    detected=$(detect_branch_for_sha "$dir" "$full" "$branch" || true)
    if [[ -n "$detected" ]]; then
      BRANCH="$detected"
      echo "==> SHA ${full:0:12} 自动选择分支 BRANCH=${BRANCH}"
    else
      echo "WARN: 无法从 SHA 反查分支，继续使用 BRANCH=${branch}" >&2
    fi
    echo "==> checkout $(basename "$dir") @ ${full} (requested ${sha})"
    git -C "$dir" checkout --detach "$full"
  else
    if ! git -C "$dir" rev-parse --verify "origin/${branch}" >/dev/null 2>&1; then
      GIT_SSH_COMMAND="${GIT_SSH_COMMAND:-ssh -F /dev/null -o BatchMode=yes -o StrictHostKeyChecking=accept-new}" \
        git -C "$dir" fetch origin "${branch}:refs/remotes/origin/${branch}" || \
      GIT_SSH_COMMAND="${GIT_SSH_COMMAND:-ssh -F /dev/null -o BatchMode=yes -o StrictHostKeyChecking=accept-new}" \
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

# 写构建元数据，供 Job 的 Groovy 写入构建描述（只含分支名/SHA/tag，无敏感信息）
write_meta() {
  local branch="$1" sha="$2" tag="$3" out
  out="${WORKSPACE:-.}/.wealth-meta-${MODULE}"
  {
    printf 'MODULE=%s\n' "$MODULE"
    printf 'MODE=%s\n' "$MODE"
    printf 'BRANCH=%s\n' "$(printf '%s' "$branch" | tr -d '\r\n')"
    printf 'SHA=%s\n' "$sha"
    printf 'IMAGE_TAG=%s\n' "$tag"
  } > "$out"
  echo "==> 构建元数据 分支=${branch} | SHA ${sha} | tag ${tag} → ${out}"
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
    echo "       首次请在本机执行一次全量部署：" >&2
    echo "       cd /Users/eric_brewer/gitee/wealth-freedom && ./deploy/k8s/scripts/deploy.sh ${OVERLAY}" >&2
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
  if [[ -z "${REGISTRY}" ]]; then
    return 0
  fi
  remote="$(image_ref "$short" "$tag")"
  echo "==> docker tag ${short}:${tag} → ${remote}"
  docker tag "${short}:${tag}" "$remote"
  echo "==> docker push ${remote}"
  docker push "$remote"
}

set_one_image() {
  local tag="$1"
  local deploy="${MOD_DEPLOY[$MODULE]}"
  local ctn="${MOD_CTN[$MODULE]}"
  local image="${MOD_IMAGE[$MODULE]}"
  local full
  ensure_deploy_exists "$deploy"
  full="$(image_ref "$image" "$tag")"
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
    command -v mvn >/dev/null
    local pl="${MOD_PL[$MODULE]}"
    local jar_pat="${MOD_JAR[$MODULE]}"
    if [[ "$SKIP_MVN" != "1" ]]; then stage 2 build; else stage 2 build SKIPPED; fi
    echo "==> Maven package -pl ${pl} -am (SKIP_MVN=${SKIP_MVN})"
    if [[ "$SKIP_MVN" != "1" ]]; then
      (cd "$WEALTH_FREEDOM_ROOT" && mvn -T 1C -DskipTests package -pl "$pl" -am)
    else
      echo "SKIP_MVN=1，跳过 Maven"
    fi
    cd "$WEALTH_FREEDOM_ROOT"
    local jar rel
    jar=$(pick_jar "$jar_pat")
    rel="${jar#"$WEALTH_FREEDOM_ROOT"/}"
    stage 3 push
    echo "==> docker build ${image}:${tag} from ${rel}"
    docker build -f deploy/docker/Dockerfile.java \
      --build-arg JAVA_IMAGE="$JAVA_IMAGE" \
      --build-arg "JAR_FILE=$rel" \
      --label "wealth.git.sha=${REPO_FULL_SHA:-}" --label "wealth.git.branch=${META_BRANCH:-$BRANCH}" \
      -t "${image}:${tag}" .
  elif [[ "$kind" == "web" ]]; then
    stage 2 build SKIPPED   # 前端 pnpm 编译在 Dockerfile 多阶段内，随下一阶段 docker build 执行
    stage 3 push
    echo "==> docker build ${image}:${tag} (wealth-freedom-web)"
    (cd "$WEALTH_FREEDOM_WEB_ROOT" && docker build \
      --label "wealth.git.sha=${REPO_FULL_SHA:-}" --label "wealth.git.branch=${META_BRANCH:-$BRANCH}" \
      -t "${image}:${tag}" .)
  elif [[ "$kind" == "mall" ]]; then
    stage 2 build SKIPPED   # 同上：前端编译在 Dockerfile 内
    stage 3 push
    echo "==> docker build ${image}:${tag} -f apps/web/Dockerfile"
    (cd "$WEALTH_ECOMMERCE_WEB_ROOT" && docker build -f apps/web/Dockerfile \
      --label "wealth.git.sha=${REPO_FULL_SHA:-}" --label "wealth.git.branch=${META_BRANCH:-$BRANCH}" \
      -t "${image}:${tag}" .)
  else
    echo "ERROR: 未知 kind=${kind}" >&2
    exit 1
  fi
  echo "==> 构建完成 ${image}:${tag}"
  docker images "${image}" --format '{{.Repository}}:{{.Tag}}\t{{.ID}}\t{{.CreatedSince}}' | head -5 || true
}

prepare_repos() {
  local repo_kind="${MOD_REPO[$MODULE]}"

  if [[ "$SOURCE" == "local-mount" && -d /gitee/wealth-freedom ]]; then
    export WEALTH_FREEDOM_ROOT=/gitee/wealth-freedom
    export WEALTH_FREEDOM_WEB_ROOT=/gitee/wealth-freedom-web
    export WEALTH_ECOMMERCE_WEB_ROOT=/gitee/wealth-ecommerce-web
    USED_LOCAL_MOUNT=1
    echo "==> SOURCE=local-mount：使用 /gitee（不切换分支/SHA）"
    if [[ -n "$GIT_SHA" ]]; then
      echo "WARN: local-mount 忽略 GIT_SHA；请改 SOURCE=github"
    fi
  else
    if [[ "$SOURCE" == "local-mount" ]]; then
      echo "WARN: /gitee 不可用，回退 SOURCE=github"
    fi
    mkdir -p "$WORKSPACE_ROOT"
    case "$repo_kind" in
      freedom)
        clone_or_update "$GH_FREEDOM" "$WORKSPACE_ROOT/wealth-freedom" "$BRANCH" "$GIT_SHA"
        export WEALTH_FREEDOM_ROOT="$WORKSPACE_ROOT/wealth-freedom"
        ;;
      web)
        clone_or_update "$GH_WEB" "$WORKSPACE_ROOT/wealth-freedom-web" "$BRANCH" "$GIT_SHA"
        export WEALTH_FREEDOM_WEB_ROOT="$WORKSPACE_ROOT/wealth-freedom-web"
        # Java Dockerfile 不需要，但 OVERLAY Desktop 无关；保留 freedom 根可选
        if [[ -d /gitee/wealth-freedom ]]; then
          export WEALTH_FREEDOM_ROOT=/gitee/wealth-freedom
        elif [[ -d "$WORKSPACE_ROOT/wealth-freedom" ]]; then
          export WEALTH_FREEDOM_ROOT="$WORKSPACE_ROOT/wealth-freedom"
        fi
        ;;
      mall)
        clone_or_update "$GH_MALL" "$WORKSPACE_ROOT/wealth-ecommerce-web" "$BRANCH" "$GIT_SHA"
        export WEALTH_ECOMMERCE_WEB_ROOT="$WORKSPACE_ROOT/wealth-ecommerce-web"
        if [[ -d /gitee/wealth-freedom ]]; then
          export WEALTH_FREEDOM_ROOT=/gitee/wealth-freedom
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

rm -f "${WORKSPACE:-.}/.wealth-meta-${MODULE}"
rewrite_kubeconfig_for_docker_desktop

echo "==> 预检 MODULE=${MODULE} MODE=${MODE} OVERLAY=${OVERLAY} SOURCE=${SOURCE} REGISTRY=${REGISTRY:-<empty>}"
if [[ "$PREPARE_ONLY" != "1" ]]; then   # PREPARE_ONLY 只拉码解析 SHA，不需要 docker/K8s
  command -v docker >/dev/null
  command -v kubectl >/dev/null
  docker info >/dev/null
  kubectl cluster-info >/dev/null
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
  write_meta "$(image_label "$rb_img" wealth.git.branch)" "$(image_label "$rb_img" wealth.git.sha)" "$IMAGE_TAG"
  if [[ "$PREPARE_ONLY" == "1" ]]; then
    echo "==> PREPARE_ONLY=1：rollback 仅写元数据，不执行回滚"
    exit 0
  fi
  # 镜像阶段：本机镜像存在性检查；走 REGISTRY 时由集群节点 pull，无本机检查 → SKIPPED
  if [[ -n "${REGISTRY}" ]]; then stage 3 push SKIPPED; else stage 3 push; fi
  verify_one_image "$IMAGE_TAG"
  stage 4 deploy
  set_one_image "$IMAGE_TAG"
  wait_one_rollout
  persist_image_tag "$IMAGE_TAG"
  echo "==> 验收"
  kubectl -n "$NS" get pods -l "app=${MOD_DEPLOY[$MODULE]}" -o wide 2>/dev/null || \
    kubectl -n "$NS" get pods -o wide | grep "${MOD_DEPLOY[$MODULE]}" || true
  kubectl -n "$NS" get deploy "${MOD_DEPLOY[$MODULE]}" -o wide || true
  echo "==> 完成 MODE=rollback MODULE=${MODULE} IMAGE_TAG=${IMAGE_TAG}（历史版本已启动）"
  exit 0
fi

if [[ "$MODE" != "build-deploy" ]]; then
  echo "ERROR: 未知 MODE=${MODE}（期望 build-deploy|rollback）" >&2
  exit 1
fi

stage 1 checkout
prepare_repos
resolve_auto_tag
write_meta "$META_BRANCH" "$REPO_FULL_SHA" "$IMAGE_TAG"
if [[ "$PREPARE_ONLY" == "1" ]]; then
  echo "==> PREPARE_ONLY=1：已解析分支与 SHA，不构建不部署"
  exit 0
fi
build_one_module      # 内部输出 STAGE 2 build（Maven / SKIPPED）与 STAGE 3 push（docker build）
push_if_registry
stage 4 deploy
set_one_image "$IMAGE_TAG"
wait_one_rollout
persist_image_tag "$IMAGE_TAG"
prune_image_history "${MOD_IMAGE[$MODULE]}"
if command -v python3 >/dev/null 2>&1; then
  JENKINS_HOME="${JENKINS_HOME:-/var/jenkins_home}" \
    python3 /jenkins-backup/scripts/write-ui-meta.py >/dev/null 2>&1 || true
fi

echo "==> 验收"
kubectl -n "$NS" get deploy "${MOD_DEPLOY[$MODULE]}" -o custom-columns=NAME:.metadata.name,IMAGE:.spec.template.spec.containers[0].image 2>/dev/null || true
kubectl -n "$NS" get pods -o wide 2>/dev/null | grep "${MOD_DEPLOY[$MODULE]}" || true
echo "==> 完成 MODE=build-deploy MODULE=${MODULE} IMAGE_TAG=${IMAGE_TAG}"
