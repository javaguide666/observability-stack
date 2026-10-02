#!/usr/bin/env bash
# 刷新远程分支 → 本地缓存 → 同步到各 Job 的 BRANCH 紧凑下拉（不再每次打开页面 ls-remote）
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
JENKINS_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
CACHE_DIR="${BRANCH_CACHE_DIR:-$JENKINS_ROOT/cache/branches}"
mkdir -p "$CACHE_DIR"

SSH_CMD="${GIT_SSH_COMMAND:-}"
if [[ -z "$SSH_CMD" ]]; then
  SSH_CMD="ssh -F /dev/null -o StrictHostKeyChecking=accept-new -o ConnectTimeout=15"
  for k in \
    /var/jenkins_home/.ssh/id_ed25519 \
    /var/jenkins_home/.ssh/id_rsa.github \
    /var/jenkins_home/.ssh/git-rsa \
    "$HOME/.ssh/id_ed25519" \
    "$HOME/.ssh/id_rsa.github"
  do
    if [[ -f "$k" ]]; then
      SSH_CMD="ssh -F /dev/null -o StrictHostKeyChecking=accept-new -o ConnectTimeout=15 -i $k"
      break
    fi
  done
fi
export GIT_SSH_COMMAND="$SSH_CMD"

have_timeout=0
command -v timeout >/dev/null 2>&1 && have_timeout=1

fetch_heads() {
  local name="$1" url="$2" local_dir="${3:-}"
  local tmp out ec=0
  tmp="$(mktemp)"
  out="$CACHE_DIR/${name}.txt"
  echo "==> 刷新分支缓存: ${name}"

  set +e
  if [[ "$have_timeout" == 1 ]]; then
    timeout 60 git ls-remote --heads "$url" >"$tmp" 2>"$tmp.err"
    ec=$?
  else
    git ls-remote --heads "$url" >"$tmp" 2>"$tmp.err"
    ec=$?
  fi
  set -e

  if [[ $ec -eq 0 && -s "$tmp" ]]; then
    awk '{print $2}' "$tmp" | sed 's#^refs/heads/##' | sed '/^$/d' | sort -u >"$out"
  elif [[ -n "$local_dir" && -d "$local_dir/.git" ]]; then
    echo "WARN: ls-remote 失败(ec=$ec)，回退本地仓 $local_dir" >&2
    [[ -s "$tmp.err" ]] && cat "$tmp.err" >&2 || true
    git -C "$local_dir" for-each-ref --format='%(refname:short)' refs/remotes/origin 2>/dev/null \
      | sed 's#^origin/##' | sed '/^HEAD$/d' | sed '/^$/d' | sort -u >"$out" || true
    if [[ ! -s "$out" ]]; then
      git -C "$local_dir" for-each-ref --format='%(refname:short)' refs/heads \
        | sed '/^$/d' | sort -u >"$out" || true
    fi
  else
    echo "ERROR: 无法获取 $name 分支" >&2
    [[ -s "$tmp.err" ]] && cat "$tmp.err" >&2 || true
    if [[ ! -f "$out" || ! -s "$out" ]]; then
      echo main >"$out"
    else
      echo "WARN: 保留旧缓存 $out" >&2
    fi
  fi

  [[ -s "$out" ]] || echo main >"$out"
  echo "   → $(wc -l <"$out" | tr -d ' ') branches → $out"
  rm -f "$tmp" "$tmp.err"
}

fetch_heads wealth-freedom       git@github.com:javaguide666/wealth-freedom.git       "${GITEE_FREEDOM:-/gitee/wealth-freedom}"
fetch_heads wealth-freedom-web   git@github.com:javaguide666/wealth-freedom-web.git   "${GITEE_WEB:-/gitee/wealth-freedom-web}"
fetch_heads wealth-ecommerce-web git@github.com:javaguide666/wealth-ecommerce-web.git "${GITEE_MALL:-/gitee/wealth-ecommerce-web}"

# 本机未挂 /gitee 时再试宿主机路径
if [[ ! -s "$CACHE_DIR/wealth-freedom.txt" || $(wc -l <"$CACHE_DIR/wealth-freedom.txt") -le 1 ]]; then
  if [[ -d /Users/eric_brewer/gitee/wealth-freedom/.git ]]; then
    export GITEE_FREEDOM=/Users/eric_brewer/gitee/wealth-freedom
    export GITEE_WEB=/Users/eric_brewer/gitee/wealth-freedom-web
    export GITEE_MALL=/Users/eric_brewer/gitee/wealth-ecommerce-web
  fi
fi

sort -u "$CACHE_DIR"/wealth-freedom.txt "$CACHE_DIR"/wealth-freedom-web.txt "$CACHE_DIR"/wealth-ecommerce-web.txt \
  >"$CACHE_DIR/wealth-all.txt"

export BRANCH_CACHE_DIR="$CACHE_DIR"
export JENKINS_HOME_JOBS="${JENKINS_HOME_JOBS:-}"
python3 "$SCRIPT_DIR/sync-branch-choices.py"

echo "==> 完成：BRANCH 已改为本地缓存下拉（样式与 SOURCE 相同）"
