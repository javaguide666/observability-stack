#!/usr/bin/env bash
# 把 Wealth CI 控制台拷到 Jenkins userContent（不重建镜像也能看效果）
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
HOME_DIR="${JENKINS_HOME:-/Users/eric_brewer/.docker/jenkins/home}"
UI_DEST="${HOME_DIR}/userContent/wealth"
DATA_DEST="${HOME_DIR}/userContent/wealth-data"
INIT_DEST="${HOME_DIR}/init.groovy.d"

mkdir -p "$UI_DEST" "$DATA_DEST" "$INIT_DEST"
rsync -a --delete --exclude data "$ROOT/ui/" "$UI_DEST/"
cp "$ROOT/init.groovy.d/wealth-ui.groovy" "$INIT_DEST/wealth-ui.groovy"

export JENKINS_HOME="$HOME_DIR"
export BRANCH_CACHE_DIR="${BRANCH_CACHE_DIR:-$ROOT/cache/branches}"
export WEALTH_UI_DATA="$DATA_DEST"
python3 "$SCRIPT_DIR/write-ui-meta.py"

echo "==> 控制台: http://localhost:18080/userContent/wealth/"
echo "    若横幅未出现，重启容器: docker restart obs-jenkins"
