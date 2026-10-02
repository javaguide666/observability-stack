#!/usr/bin/env bash
# 列出远程分支名（手工排查用；Job 下拉由 list-git-branches-parameter 插件完成）
set -euo pipefail
REPO="${1:?git url required}"
export GIT_SSH_COMMAND="${GIT_SSH_COMMAND:-ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null}"
git ls-remote --heads "$REPO" | awk '{print $2}' | sed 's#refs/heads/##' | sort -u
