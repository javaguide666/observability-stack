#!/usr/bin/env bash
# 把 Wealth CI 控制台拷到 Jenkins userContent（不重建镜像也能看效果）
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
HOME_DIR="${JENKINS_HOME:-/Users/eric_brewer/.docker/jenkins/home}"
UI_DEST="${HOME_DIR}/userContent/wealth"
LEGACY_DEST="${HOME_DIR}/userContent/wealth-legacy"
DATA_DEST="${HOME_DIR}/userContent/wealth-data"
INIT_DEST="${HOME_DIR}/init.groovy.d"

mkdir -p "$UI_DEST" "$LEGACY_DEST" "$DATA_DEST" "$INIT_DEST"

# 新控制台（Vue）：没有 dist/ 或 SKIP_BUILD 未设时先构建（需要 Node >= 22）
if [ "${SKIP_BUILD:-0}" != "1" ] && { [ ! -f "$ROOT/console/dist/index.html" ] || [ "${REBUILD:-0}" = "1" ]; }; then
  (cd "$ROOT/console" && npx --yes pnpm@12.8.1 install --frozen-lockfile && npx --yes pnpm@12.8.1 build)
fi
if [ -f "$ROOT/console/dist/index.html" ]; then
  rsync -a --delete "$ROOT/console/dist/" "$UI_DEST/"
else
  echo "!! console/dist 不存在，回退为旧页面" >&2
  rsync -a --delete --exclude data "$ROOT/ui/" "$UI_DEST/"
fi
# 旧页面保留作回退
rsync -a --delete --exclude data "$ROOT/ui/" "$LEGACY_DEST/"
cp "$ROOT/init.groovy.d/wealth-ui.groovy" "$INIT_DEST/wealth-ui.groovy"

export JENKINS_HOME="$HOME_DIR"
export BRANCH_CACHE_DIR="${BRANCH_CACHE_DIR:-$ROOT/cache/branches}"
export WEALTH_UI_DATA="$DATA_DEST"
python3 "$SCRIPT_DIR/write-ui-meta.py"

echo "==> 控制台: http://localhost:18080/userContent/wealth/"
echo "    旧页面:  http://localhost:18080/userContent/wealth-legacy/"
echo "    注意: 新控制台需要放开 userContent 的 CSP（见 docker-compose.jenkins.yml 的 JAVA_OPTS）"
echo "    若横幅未出现，重启容器: docker restart obs-jenkins"
