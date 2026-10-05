#!/usr/bin/env bash
# 只读：按 Commit SHA 反查所属分支（不 build、不 docker、不 kubectl、不改集群）
# 输入（Jenkins 参数 → 环境变量，脚本里一律带引号使用，且先校验再进 git）：
#   SHA   必填，40 位十六进制（大写会转小写）
#   REPO  wealth-freedom（默认） | wealth-freedom-web | wealth-ecommerce-web（白名单）
# 输出：resolve.json（默认 $WORKSPACE/resolve.json），并同样打印到控制台
#   {"exists":bool,"sha":"<40位小写>"|null,"branches":[...],"preferred":"..."|null,"repo":"...","fetched":bool[,"error":"..."]}
# 退出码约定（控制台最易处理）：
#   0 = 已得出结论（含：SHA 非法 → error:"invalid"；SHA 不存在 → exists:false），结果以 resolve.json 为准
#   1 = 基础设施问题（镜像仓库建不起来 → error:"repo_unavailable"）；2 = REPO 不在白名单 → error:"bad_repo"
# 仓库来源：只读镜像缓存 /var/jenkins_home/cache/repos/<REPO>.git（git clone --mirror）；
#   优先 GitHub（github-ssh 对应的容器内 SSH 私钥，BatchMode 不会卡住等密码），
#   取不到时回退本机 /gitee/<REPO>（只读 clone，不 fetch、不写 /gitee），此时 fetched=false。
set -uo pipefail

RAW_SHA="${SHA:-}"
REPO="${REPO:-wealth-freedom}"
OUT="${RESOLVE_OUT:-${WORKSPACE:-$(pwd)}/resolve.json}"
DESC_OUT="${OUT%.json}.desc"
CACHE_REPOS="${RESOLVE_CACHE_DIR:-/var/jenkins_home/cache/repos}"
GITEE_ROOT="${RESOLVE_GITEE_ROOT:-/gitee}"
PRIORITY="main master dev develop"   # 与 pipeline-wealth-module.sh 的 detect_branch_for_sha 保持一致
rm -f "$OUT" "${OUT}.tmp" "$DESC_OUT"   # 工作区复用时不留上次结果

json_str() { # 转义 \ 与 "（git 引用名允许出现 "），其余字符 git 不允许控制符
  printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g'
}

# emit <exists:true|false> <sha|""> <fetched:true|false> <error|""> <branches(换行分隔)>
emit() {
  local exists="$1" sha="$2" fetched="$3" err="$4" lines="$5"
  local sorted="" pre="" rest="" b p first="" arr="" preferred="null" shaj="null" j
  if [[ -n "$lines" ]]; then
    sorted="$(printf '%s\n' "$lines" | sed '/^$/d' | LC_ALL=C sort -u)"
    for p in $PRIORITY; do
      if printf '%s\n' "$sorted" | grep -qxF -- "$p"; then pre="${pre}${p}"$'\n'; fi
    done
    rest="$(printf '%s\n' "$sorted" | grep -vxF -f <(printf '%s\n' $PRIORITY) || true)"
    sorted="$(printf '%s%s\n' "$pre" "$rest" | sed '/^$/d')"
  fi
  while IFS= read -r b; do
    [[ -z "$b" ]] && continue
    [[ -z "$first" ]] && first="$b"
    j="\"$(json_str "$b")\""
    if [[ -z "$arr" ]]; then arr="$j"; else arr="${arr},${j}"; fi
  done <<< "$sorted"
  [[ -n "$first" ]] && preferred="\"$(json_str "$first")\""
  [[ -n "$sha" ]] && shaj="\"${sha}\""
  local body="{\"exists\":${exists},\"sha\":${shaj},\"branches\":[${arr}],\"preferred\":${preferred},\"repo\":\"$(json_str "$REPO")\",\"fetched\":${fetched}"
  [[ -n "$err" ]] && body="${body},\"error\":\"${err}\""
  body="${body}}"
  mkdir -p "$(dirname "$OUT")"
  printf '%s\n' "$body" >"${OUT}.tmp" && mv "${OUT}.tmp" "$OUT"
  printf 'repo=%s sha=%s exists=%s preferred=%s%s\n' "$(printf '%s' "$REPO" | tr -cd 'A-Za-z0-9_.-')" "${sha:-n/a}" "$exists" \
    "$(printf '%s' "$first" | tr -cd 'A-Za-z0-9_./-')" "${err:+ error=$err}" >"$DESC_OUT"
  echo "==> resolve.json:"
  cat "$OUT"
}

# ---------- 1) 参数校验（先于任何 git 调用）----------
case "$REPO" in
  wealth-freedom|wealth-freedom-web|wealth-ecommerce-web) ;;
  *) echo "ERROR: REPO 不在白名单" >&2; REPO="invalid"; emit false "" false bad_repo ""; exit 2 ;;
esac

if [[ ! "$RAW_SHA" =~ ^[0-9a-fA-F]{40}$ ]]; then
  echo "==> SHA 非法（需 40 位十六进制），不访问仓库"
  emit false "" false invalid ""
  exit 0
fi
SHA_LC="$(printf '%s' "$RAW_SHA" | tr '[:upper:]' '[:lower:]')"

# ---------- 2) 准备只读镜像仓库 ----------
case "$REPO" in
  wealth-freedom)       GH_URL="${GH_FREEDOM:-git@github.com:javaguide666/wealth-freedom.git}" ;;
  wealth-freedom-web)   GH_URL="${GH_WEB:-git@github.com:javaguide666/wealth-freedom-web.git}" ;;
  wealth-ecommerce-web) GH_URL="${GH_MALL:-git@github.com:javaguide666/wealth-ecommerce-web.git}" ;;
esac
LOCAL_DIR="${GITEE_ROOT}/${REPO}"
GITDIR="${CACHE_REPOS}/${REPO}.git"
MARKER="${GITDIR}/wealth-source"

SSH_OPTS="-F /dev/null -o BatchMode=yes -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=${CACHE_REPOS}/.known_hosts -o ConnectTimeout=15"
SSH_CMD="${GIT_SSH_COMMAND:-}"
if [[ -z "$SSH_CMD" ]]; then
  SSH_CMD="ssh ${SSH_OPTS}"
  for k in /var/jenkins_home/.ssh/id_ed25519 /var/jenkins_home/.ssh/id_rsa.github /var/jenkins_home/.ssh/git-rsa \
           "$HOME/.ssh/id_ed25519" "$HOME/.ssh/id_rsa.github"; do
    if [[ -f "$k" ]]; then SSH_CMD="ssh ${SSH_OPTS} -i $k"; break; fi
  done
fi
export GIT_SSH_COMMAND="$SSH_CMD" GIT_TERMINAL_PROMPT=0

tmo() { # tmo <秒> cmd...（没有 timeout 命令时直接执行）
  local s="$1"; shift
  if command -v timeout >/dev/null 2>&1; then timeout "$s" "$@"; else "$@"; fi
}

mkdir -p "$CACHE_REPOS"
LOCK="${CACHE_REPOS}/.lock-${REPO}"
n=0
until mkdir "$LOCK" 2>/dev/null; do
  n=$((n + 1))
  if [[ $n -gt 90 ]]; then rm -rf "$LOCK"; fi   # 持锁超过 90 秒视为残留
  sleep 1
done
trap 'rm -rf "$LOCK"' EXIT

FETCHED=false
if [[ ! -d "$GITDIR" ]]; then
  echo "==> 首次建立镜像仓库 ${GITDIR}"
  if tmo 120 git clone --mirror "$GH_URL" "$GITDIR" >/dev/null 2>&1; then
    echo github >"$MARKER"; FETCHED=true
    echo "==> 已从 GitHub 建立镜像"
  else
    rm -rf "$GITDIR"
    if [[ -d "${LOCAL_DIR}/.git" ]] && git -c safe.directory='*' clone --mirror --no-hardlinks "$LOCAL_DIR" "$GITDIR" >/dev/null 2>&1; then
      echo local >"$MARKER"
      echo "WARN: GitHub 不可达（github-ssh 未配置或网络问题），已回退本机 ${LOCAL_DIR} 建镜像；只含本机已有分支，fetched=false" >&2
    else
      echo "ERROR: 既无法访问 GitHub，也无可用的本机仓库 ${LOCAL_DIR}" >&2
      emit false "$SHA_LC" false repo_unavailable ""
      exit 1
    fi
  fi
else
  SRC="$(cat "$MARKER" 2>/dev/null || echo github)"
  if [[ "$SRC" == "local" ]] && tmo 20 git ls-remote "$GH_URL" HEAD >/dev/null 2>&1; then
    git -C "$GITDIR" remote set-url origin "$GH_URL" && echo github >"$MARKER" && SRC=github
    echo "==> GitHub 已可达，镜像切回 GitHub"
  fi
  if [[ "$SRC" == "github" ]]; then
    if tmo 120 git -C "$GITDIR" remote update --prune >/dev/null 2>&1; then
      FETCHED=true
    else
      echo "WARN: GitHub 刷新失败，使用已有镜像（可能不是最新）" >&2
    fi
  else
    # 本机回退：从 /gitee 只读拉取（对 /gitee 无写入）
    git -c safe.directory='*' -C "$GITDIR" remote update --prune >/dev/null 2>&1 \
      || echo "WARN: 本机仓库刷新失败，使用已有镜像" >&2
  fi
fi

# ---------- 3) 识别 ----------
# SHA 已通过 40 位十六进制校验；仍然全部带引号，不拼进任何命令串
if ! git -C "$GITDIR" cat-file -e "${SHA_LC}^{commit}" 2>/dev/null; then
  echo "==> commit 不存在于 ${REPO}（fetched=${FETCHED}）"
  emit false "$SHA_LC" "$FETCHED" "" ""
  exit 0
fi

# 镜像仓库的分支在 refs/heads（直接 clone --mirror）或 refs/remotes/origin（由本机仓库镜像而来）
# 相当于 git branch -r --contains；去掉 origin/ 前缀与 HEAD 指针
BRANCHES="$(git -C "$GITDIR" for-each-ref --contains "$SHA_LC" --format='%(refname)' refs/heads refs/remotes/origin 2>/dev/null \
  | sed -e 's#^refs/heads/##' -e 's#^refs/remotes/origin/##' -e '/^HEAD$/d' -e '/^$/d' | LC_ALL=C sort -u || true)"
emit true "$SHA_LC" "$FETCHED" "" "$BRANCHES"
exit 0
