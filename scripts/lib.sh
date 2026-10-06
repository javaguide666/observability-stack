#!/usr/bin/env bash
# 公共函数：被 init-env.sh / up.sh / down.sh / check.sh 引用（兼容 bash 3.2 / Linux / macOS）。
# 各 compose 文件仍可脱离脚本单独 `docker compose -f docker-compose.xxx.yml up -d`。

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${ENV_FILE:-$ROOT/.env}"

# 组件规范启动顺序（先库后应用）
ALL_COMPONENTS="mysql redis postgres clickhouse nacos skywalking loki prometheus grafana clickvisual jenkins"

comp_file() {
  case "$1" in
    mysql|redis|postgres|clickhouse|nacos|skywalking|loki|prometheus|grafana|clickvisual|jenkins)
      echo "$ROOT/docker-compose.$1.yml" ;;
    alloy) echo "$ROOT/docker-compose.loki.yml" ;;
    *) return 1 ;;
  esac
}

# 组件依赖（跨文件无法 depends_on，由脚本保证顺序）
comp_needs() {
  case "$1" in
    nacos) echo "mysql" ;;
    loki) echo "clickhouse" ;;
    clickvisual) echo "mysql clickhouse" ;;
    *) echo "" ;;
  esac
}

# 一次性任务容器（不参与"是否在运行"判断）
ONESHOT_SERVICES="nacos-init clickvisual-init"

expand_group() {
  case "$1" in
    core) echo "mysql redis nacos" ;;
    logging|log) echo "clickhouse loki grafana" ;;
    metrics) echo "prometheus" ;;
    observability|observe) echo "clickhouse loki prometheus grafana" ;;
    monitor) echo "skywalking prometheus grafana" ;;
    ci) echo "jenkins" ;;
    full|all) echo "mysql redis postgres nacos skywalking clickhouse loki prometheus grafana jenkins" ;;
    *) echo "$1" ;;
  esac
}

# 解析参数为"去重 + 补依赖 + 规范排序"的组件列表
resolve_components() {
  local want="" a x n
  [[ $# -eq 0 ]] && set -- core
  for a in "$@"; do
    for x in $(expand_group "$a"); do
      comp_file "$x" >/dev/null || { echo "未知组件/分组: $x" >&2; return 1; }
      want="$want $x"
      for n in $(comp_needs "$x"); do want="$want $n"; done
    done
  done
  local out="" c
  for c in $ALL_COMPONENTS alloy; do
    case " $want " in *" $c "*) out="$out $c" ;; esac
  done
  echo $out
}

# 读取 .env 中的变量（环境变量优先，其次 .env，最后默认值）；不 source，避免特殊字符被 shell 解释
envget() {
  local key="$1" def="${2:-}" v
  v="${!key:-}"
  if [[ -z "$v" && -f "$ENV_FILE" ]]; then
    v="$(grep -E "^${key}=" "$ENV_FILE" 2>/dev/null | tail -1 | cut -d= -f2- || true)"
    v="${v%\"}"; v="${v#\"}"
  fi
  echo "${v:-$def}"
}

prefix() { envget CONTAINER_PREFIX obs; }

# docker compose 封装：自动带 --env-file；OBS_PROJECT 非空时用 -p 覆盖项目名（仅用于隔离测试）
dc() {
  local file="$1"; shift
  local args=(-f "$file")
  [[ -f "$ENV_FILE" ]] && args=(--env-file "$ENV_FILE" "${args[@]}")
  [[ -n "${OBS_PROJECT:-}" ]] && args=(-p "$OBS_PROJECT" "${args[@]}")
  (cd "$ROOT" && docker compose "${args[@]}" "$@")
}

# 组件 -> "名称|变量|默认端口|说明|URL后缀(空=非HTTP)"
comp_ports() {
  case "$1" in
    mysql) echo "MySQL|MYSQL_PORT|3306|jdbc:mysql://localhost:PORT|" ;;
    redis) echo "Redis|REDIS_PORT|6379|redis://localhost:PORT|" ;;
    postgres) echo "PostgreSQL|POSTGRES_PORT|5432|localhost:PORT|" ;;
    nacos) printf '%s\n' "Nacos 控制台|NACOS_CONSOLE_PORT|8080|http://localhost:PORT/|/" \
                         "Nacos 客户端 HTTP|NACOS_PORT|8848|localhost:PORT|" \
                         "Nacos 客户端 gRPC|NACOS_GRPC_PORT|9848|localhost:PORT|" \
                         "Nacos 服务端 gRPC|NACOS_RAFT_PORT|9849|localhost:PORT|" ;;
    skywalking) printf '%s\n' "SkyWalking UI|SW_UI_PORT|18089|http://localhost:PORT/|/" \
                              "SkyWalking Agent gRPC|SW_OAP_GRPC_PORT|11800|localhost:PORT|" \
                              "SkyWalking OAP HTTP|SW_OAP_HTTP_PORT|12800|http://localhost:PORT/|" \
                              "BanyanDB gRPC|BANYANDB_GRPC_PORT|17912|localhost:PORT|" \
                              "BanyanDB HTTP|BANYANDB_HTTP_PORT|17913|http://localhost:PORT/|" ;;
    clickhouse) printf '%s\n' "ClickHouse HTTP|CLICKHOUSE_HTTP_PORT|8123|http://localhost:PORT/ping|/ping" \
                              "ClickHouse Native|CLICKHOUSE_NATIVE_PORT|9001|localhost:PORT|" ;;
    loki) echo "Loki(qryn)|LOKI_PORT|3100|http://localhost:PORT/ready|" ;;
    alloy) echo "Alloy|ALLOY_PORT|12345|http://localhost:PORT/|" ;;
    clickvisual) echo "ClickVisual|CLICKVISUAL_PORT|19001|http://localhost:PORT/|/" ;;
    grafana) echo "Grafana|GRAFANA_PORT|3002|http://localhost:PORT/|/" ;;
    prometheus) printf '%s\n' "Prometheus|PROMETHEUS_PORT|9090|http://localhost:PORT/|/" \
                              "node-exporter|NODE_EXPORTER_PORT|9100|http://localhost:PORT/metrics|" ;;
    jenkins) printf '%s\n' "Jenkins|JENKINS_PORT|18080|http://localhost:PORT/|/" \
                           "Jenkins Agent|JENKINS_AGENT_PORT|50000|localhost:PORT|" ;;
  esac
}

port_in_use() { # 0 = 已被监听
  local p="$1"
  if command -v lsof >/dev/null 2>&1; then
    lsof -nP -iTCP:"$p" -sTCP:LISTEN >/dev/null 2>&1
  elif command -v ss >/dev/null 2>&1; then
    ss -ltn 2>/dev/null | awk '{print $4}' | grep -Eq "[:.]${p}$"
  else
    (exec 3<>"/dev/tcp/127.0.0.1/$p") 2>/dev/null
  fi
}

# 某端口是否由本项目（CONTAINER_PREFIX-*）容器发布（兼容 docker ps 里 9848-9849 这种端口区间写法）
port_owner() {
  local p="$1" pre; pre="$(prefix)"
  docker ps --format '{{.Names}}	{{.Ports}}' 2>/dev/null | awk -F'\t' -v p="$p" -v pre="$pre-" '
    index($1,pre)==1 {
      n=split($2, parts, ", ")
      for (i=1;i<=n;i++) {
        split(parts[i], a, "->"); if (a[2]=="") continue
        h=a[1]; sub(/^.*:/,"",h)
        lo=h; hi=h
        if (index(h,"-")>0) { split(h, r, "-"); lo=r[1]; hi=r[2] }
        if (p+0>=lo+0 && p+0<=hi+0) { print $1; exit }
      }
    }'
}

wait_healthy() { # file timeout
  local file="$1" timeout="${2:-300}" start now ids id st all
  start=$(date +%s)
  while :; do
    all=1
    ids="$(dc "$file" ps -q --orphans=false 2>/dev/null || true)"
    for id in $ids; do
      st="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$id" 2>/dev/null || echo unknown)"
      case "$st" in healthy|running) ;; *) all=0 ;; esac
    done
    [[ -n "$ids" && $all -eq 1 ]] && return 0
    now=$(date +%s)
    if (( now - start > timeout )); then return 1; fi
    sleep 3
  done
}
