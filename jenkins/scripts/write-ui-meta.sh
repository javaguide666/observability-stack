#!/usr/bin/env bash
# 生成控制台用的 meta.json（分支 + 最近 N 个镜像 tag）。纯 bash，不依赖 python3。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
CACHE="${BRANCH_CACHE_DIR:-$ROOT/cache/branches}"
KEEP="${HISTORY_KEEP:-10}"
HOME_DIR="${JENKINS_HOME:-/var/jenkins_home}"
OUT_DIRS=()
[[ -n "${WEALTH_UI_DATA:-}" ]] && OUT_DIRS+=("$WEALTH_UI_DATA")
[[ "${WEALTH_UI_DATA:-}" != "$HOME_DIR/userContent/wealth-data" ]] && OUT_DIRS+=("$HOME_DIR/userContent/wealth-data")

REPOS=(wealth-freedom wealth-freedom-web wealth-ecommerce-web wealth-all)
IMAGES=(wealth-gateway wealth-auth wealth-system-server wealth-admin-server wealth-ecommerce-server wealth-freedom-web wealth-ecommerce-web)

esc() { printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g'; }

branches_json() {
  local name="$1" f="$CACHE/$1.txt" first=1 b
  local list=()
  if [[ -s "$f" ]]; then
    while IFS= read -r b; do
      b="${b//[$'\r']/}"
      [[ -z "$b" || "$b" == \#* ]] && continue
      list+=("$b")
    done < <(awk 'NF' "$f" | sort -u)
  fi
  [[ ${#list[@]} -eq 0 ]] && list=(main)
  printf '['
  # main 排最前
  local ordered=() has_main=0
  for b in "${list[@]}"; do [[ "$b" == main ]] && has_main=1; done
  [[ $has_main == 1 ]] && ordered+=(main)
  for b in "${list[@]}"; do [[ "$b" == main ]] || ordered+=("$b"); done
  for b in "${ordered[@]}"; do
    [[ $first == 1 ]] || printf ', '
    first=0
    printf '"%s"' "$(esc "$b")"
  done
  printf ']'
}

tags_json() {
  local img="$1" first=1 n=0 tag created size
  printf '['
  while IFS=$'\t' read -r tag created size; do
    [[ -z "$tag" || "$tag" == "<none>" || "$tag" == latest ]] && continue
    [[ $first == 1 ]] || printf ', '
    first=0
    printf '{"tag": "%s", "created": "%s", "size": "%s"}' "$(esc "$tag")" "$(esc "$created")" "$(esc "$size")"
    n=$((n + 1))
    [[ $n -ge $KEEP ]] && break
  done < <(docker images --format '{{.Tag}}'$'\t''{{.CreatedSince}}'$'\t''{{.Size}}' "$img" 2>/dev/null || true)
  printf ']'
}

tmp="$(mktemp)"
{
  printf '{\n  "keep": %s,\n  "branches": {\n' "$KEEP"
  i=0
  for r in "${REPOS[@]}"; do
    i=$((i + 1))
    printf '    "%s": %s' "$r" "$(branches_json "$r")"
    [[ $i -lt ${#REPOS[@]} ]] && printf ','
    printf '\n'
  done
  printf '  },\n  "tags": {\n'
  i=0
  for img in "${IMAGES[@]}"; do
    i=$((i + 1))
    printf '    "%s": %s' "$img" "$(tags_json "$img")"
    [[ $i -lt ${#IMAGES[@]} ]] && printf ','
    printf '\n'
  done
  printf '  }\n}\n'
} >"$tmp"

written=0
for d in "${OUT_DIRS[@]}"; do
  if mkdir -p "$d" 2>/dev/null && cp "$tmp" "$d/meta.json" 2>/dev/null; then
    echo "ui-meta OK $d/meta.json"
    written=$((written + 1))
  else
    echo "ui-meta skip $d"
  fi
done
rm -f "$tmp"
[[ $written -gt 0 ]] || { echo "ui-meta WARN: no writable output dir" >&2; exit 1; }
