#!/usr/bin/env bash
# 环境自检 + 访问地址表。用法：scripts/check.sh [--urls] [名称或分组 ...]   默认检查全部组件
#   检查：Docker/Compose 版本、CPU 架构、Docker 内存、.env、数据目录、端口冲突
#   --urls  只输出访问地址表（up.sh 启动结束时使用）
set -euo pipefail
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

URLS_ONLY=0; args=()
for a in "$@"; do
  case "$a" in
    --urls) URLS_ONLY=1 ;;
    -h|--help) sed -n '2,5p' "$0"; exit 0 ;;
    *) args+=("$a") ;;
  esac
done
[[ ${#args[@]} -eq 0 ]] && args=(full)
comps="$(resolve_components "${args[@]}")"
warn=0; bad=0
ok()   { echo "  [OK]   $*"; }
wn()   { echo "  [WARN] $*"; warn=$((warn+1)); }
err()  { echo "  [FAIL] $*"; bad=$((bad+1)); }

if [[ $URLS_ONLY -eq 0 ]]; then
  echo "== 环境"
  if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
    ok "Docker $(docker version --format '{{.Server.Version}}' 2>/dev/null)"
    cv="$(docker compose version --short 2>/dev/null || true)"
    if [[ -n "$cv" ]]; then
      ok "Docker Compose $cv"
      major="${cv#v}"; maj="${major%%.*}"; rest="${major#*.}"; min="${rest%%.*}"
      if [[ "$maj" -lt 2 || ( "$maj" -eq 2 && "$min" -lt 20 ) ]]; then
        err "Compose 版本过低，需 >= 2.20（docker-compose.all.yml 使用 include）"
      fi
    else err "未找到 docker compose 插件"; fi
    mem="$(docker info --format '{{.MemTotal}}' 2>/dev/null || echo 0)"
    gb=$(( mem / 1024 / 1024 / 1024 ))
    need=4; case " $comps " in *" skywalking "*|*" jenkins "*|*" clickhouse "*) need=8 ;; esac
    if [[ "$gb" -lt "$need" ]]; then wn "Docker 可用内存约 ${gb}GB，所选组件建议 >= ${need}GB（Docker Desktop → Settings → Resources）"
    else ok "Docker 可用内存约 ${gb}GB"; fi
  else
    err "Docker 未安装或守护进程未运行"
  fi
  arch="$(uname -m)"; ok "CPU 架构 ${arch}（所用镜像均为 multi-arch：amd64 / arm64）"

  if [[ -f "$ENV_FILE" ]]; then ok ".env 已存在"; else wn "缺少 .env，请先运行 scripts/init-env.sh（up.sh 也会自动执行）"; fi
  dd="$(envget DOCKER_DATA_DIR ./data)"
  case "$dd" in /*) abs="$dd" ;; *) abs="$ROOT/${dd#./}" ;; esac
  if [[ -d "$abs" ]]; then ok "数据目录 $abs"; else ok "数据目录 $abs 尚不存在，首次启动会创建"; fi
  if [[ ! -f "$ENV_FILE" && -d "$HOME/.docker/mysql/data" ]]; then
    wn "检测到旧版数据 ~/.docker/mysql/data：请先 init-env.sh（会沿用该目录），否则会在 ./data 新建空库"
  fi
  case " $comps " in *" mysql "*|*" nacos "*)
    sqlpw="$(sed -n "s/.*CREATE USER IF NOT EXISTS 'nacos'@'%' IDENTIFIED BY '\([^']*\)'.*/\1/p" "$ROOT/config/mysql/init/01-users.sql" | head -1)"
    if [[ -n "$sqlpw" && "$(envget MYSQL_NACOS_PASSWORD Admin13278@)" != "$sqlpw" ]]; then
      wn "MYSQL_NACOS_PASSWORD 与 config/mysql/init/01-users.sql 里 nacos 账号密码不一致（Nacos 会连不上库）；改密码需同步改 SQL"
    fi ;; esac
  if grep -R -n -E 'image:.*:latest' "$ROOT"/docker-compose.*.yml >/dev/null 2>&1; then wn "存在 :latest 镜像标签"; fi
  case " $comps " in *" jenkins "*)
    [[ -S "$(envget DOCKER_SOCK /var/run/docker.sock)" ]] || wn "docker.sock 不存在：$(envget DOCKER_SOCK /var/run/docker.sock)（Jenkins 用）"
    for v in "JENKINS_KUBE_DIR|$HOME/.kube" "JENKINS_SSH_DIR|$HOME/.ssh" "JENKINS_WORKSPACE_DIR|$HOME/gitee"; do
      p="$(envget "${v%%|*}" "${v#*|}")"; [[ -d "$p" ]] || wn "Jenkins 挂载目录不存在：${p}（${v%%|*}）"
    done ;; esac

  echo "== 端口"
  conflicts=0
  for c in $comps; do
    comp_ports "$c" | while IFS='|' read -r label var def tmpl suffix; do
      [[ -z "$var" ]] && continue
      port="$(envget "$var" "$def")"
      if port_in_use "$port"; then
        owner="$(port_owner "$port")"
        if [[ -n "$owner" ]]; then echo "  [OK]   $port ($label) 已由本项目容器 $owner 占用"
        else echo "  [FAIL] $port ($label) 被其它进程占用 → 在 .env 改 $var"; fi
      fi
    done
  done > /tmp/obs-check-ports.$$ 2>&1 || true
  cat /tmp/obs-check-ports.$$; grep -q 'FAIL' /tmp/obs-check-ports.$$ && bad=$((bad+1)) || ok "所选组件端口无冲突"
  rm -f /tmp/obs-check-ports.$$
  echo
fi

echo "== 访问地址（组件：$(echo $comps)）"
printf '%-22s %-8s %s\n' "服务" "宿主端口" "地址"
for c in $comps; do
  comp_ports "$c" | while IFS='|' read -r label var def tmpl suffix; do
    [[ -z "$var" ]] && continue
    port="$(envget "$var" "$def")"
    printf '%-22s %-8s %s\n' "$label" "$port" "${tmpl//PORT/$port}"
  done
done
if [[ $URLS_ONLY -eq 0 ]]; then
  echo; echo "结果：FAIL=$bad WARN=$warn"
  [[ $bad -eq 0 ]]
fi
