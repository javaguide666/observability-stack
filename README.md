# 本地开发栈（数据面按需 + 可观测性按需）

适用：**MacBook M1（arm64）本地开发**；整套目录原样可迁移到 **Linux x86_64 测试环境**（镜像均为 multi-arch；Nacos 在 ARM 上用 `v3.2.4-slim`）。

**不需要另起一套目录。** 现有「一软件一个 Compose、共用项目名 `obs-stack` 与网络 `obs-net`」已经适合开发环境：MySQL / Redis / Nacos 与 ClickHouse 走同一网络，后装的组件能直接访问先装的。需要改的是职责，而不是模式——`docker-compose.all.yml` 改为日常开发数据栈，不再一键拉起 SkyWalking / Loki / Grafana。

各组件拆成独立 Compose 文件，**默认按需启动，互不强制依赖**（Nacos 单独启动时若 MySQL 尚未定义会跳过 `depends_on`）。

| 组件 | Compose 文件 | 版本 | 角色 | 在 all.yml |
|---|---|---|---|---|
| MySQL | `docker-compose.mysql.yml` | 9.7.2 LTS | 开发主库；首次初始化创建 `nacos` / `admin` | 是 |
| Redis | `docker-compose.redis.yml` | 8.10.1 GA | 缓存 / 锁 | 是 |
| Nacos | `docker-compose.nacos.yml` | 3.2.4 GA | 注册 / 配置（直连已有 MySQL，无 db-init） | 是 |
| PostgreSQL | `docker-compose.postgres.yml` | 18.6 | 可选主库 | 是 |
| ClickHouse | `docker-compose.clickhouse.yml` | 25.8 | 指标 / 日志长期分析库 | 是 |
| Jenkins | `docker-compose.jenkins.yml` | LTS | CI | 否 |
| SkyWalking OAP / UI | `docker-compose.skywalking.yml` | 10.4.0 | APM 链路追踪、服务指标 | 否 |
| BanyanDB | （含在 SkyWalking 文件中） | 0.10.0 | SkyWalking 官方推荐存储 | 否 |
| 日志（qryn） | `docker-compose.loki.yml` | 3.2.39 | Loki Push / LogQL 搬运层，日志写入已有 ClickHouse 库 `obs_logs` | 否 |
| ClickVisual | `docker-compose.clickvisual.yml` | 1.0.4 | 日志查询 UI（元数据用已有 MySQL，日志查已有 ClickHouse） | 否 |
| Grafana | `docker-compose.grafana.yml` | latest | 统一查询（Prometheus 指标 / LogQL / ClickHouse SQL） | 否 |
| Grafana Alloy | （日志文件的 `logs` profile） | latest | 可选日志采集（Promtail 已 EOL），推到 qryn | 否 |
| Prometheus | `docker-compose.prometheus.yml` | 3.15.0 | 服务器指标采集与存储 | 否 |
| Node Exporter | （含在 Prometheus 文件中） | 1.12.1 | 宿主机 CPU / 内存 / 磁盘 / 网络 | 否 |

数据落盘：`DOCKER_DATA_DIR`（默认 `/Users/eric_brewer/.docker/<组件>`）。Grafana / SkyWalking / Prometheus 仍用本目录 `data/`。日志在 ClickHouse 数据目录里，qryn 无状态。

## 一、按需启动

```bash
cd observability-stack
cp .env.example .env        # 建议修改版本与密码
```

日常开发数据栈（MySQL + Redis + Nacos + PostgreSQL + ClickHouse）：

```bash
docker compose -f docker-compose.all.yml up -d
```

只装其中一个：

```bash
docker compose -f docker-compose.mysql.yml up -d
docker compose -f docker-compose.redis.yml up -d
docker compose -f docker-compose.nacos.yml up -d   # 需 MySQL 已就绪
docker compose -f docker-compose.postgres.yml up -d
docker compose -f docker-compose.clickhouse.yml up -d
docker compose -f docker-compose.jenkins.yml up -d
```

可观测性（与数据栈同一网络，可随时追加）。日志栈复用已有 ClickHouse，先起数据栈或单独起 ClickHouse：

```bash
docker compose -f docker-compose.clickhouse.yml up -d
docker compose -f docker-compose.loki.yml up -d
docker compose -f docker-compose.skywalking.yml up -d
docker compose -f docker-compose.grafana.yml up -d
docker compose -f docker-compose.clickvisual.yml up -d
```

服务器核心指标（Prometheus 抓 node-exporter；看板在 Grafana，文件夹「服务器」）：

```bash
docker compose -f docker-compose.prometheus.yml up -d
docker compose -f docker-compose.grafana.yml up -d
```

查看 / 停止 **当前文件里的服务**（不会误删其它栈）：

```bash
docker compose -f docker-compose.mysql.yml ps
docker compose -f docker-compose.all.yml down
```

## 二、访问入口

| 服务 | 地址 | 说明 |
|---|---|---|
| MySQL | localhost:3306 | `nacos` / `admin` / `root`，密码均为 `Admin13278@`；库 `nacos_config` 已建且含 Nacos 3.2.4 表结构 |
| Redis | localhost:6379 | `requirepass` = `Admin13278@` |
| Nacos 控制台 | http://localhost:8080 | 默认 `nacos` / `nacos`；客户端 8848 / 9848 |
| PostgreSQL | localhost:5432 | `admin` / `Admin13278@`，库 `myapp_db` |
| ClickHouse | http://localhost:8123/ping | HTTP 探活无需登录；查询账号见 `.env`（默认 `default` / `Admin13278`） |
| Jenkins | http://localhost:18080 | 避开 3000（K8s 电商前端占用）；初始密码见容器日志 |
| SkyWalking UI | http://localhost:8080 | 与 Nacos 控制台端口冲突，不要同时映射 8080 |
| ClickVisual | http://localhost:19001 | 日志查询。首次打开 `/install/init` 点一次初始化；账号 `clickvisual` / `clickvisual`。实例 DSN：`clickhouse://default:Admin13278@clickhouse:9000/default?dial_timeout=10s&max_execution_time=60`。日志库在 `cv_logs`：`stdout` 是演示表，`qryn_logs` 是 qryn 写进 `obs_logs` 的日志 |
| Grafana | http://localhost:3002 | 本机唯一入口（不再另起 :3001）。宿主端口由 `.env` 的 `GRAFANA_PORT` 控制（默认 3002，避开电商前端 :3000）。同一套里：Loki 数据源查 Pod 日志（qryn），Prometheus 数据源查服务器指标，看板在文件夹「服务器」→「服务器核心指标」。账号密码见 `.env`；未启动的数据源会显示异常，可忽略 |
| Prometheus | http://localhost:9090 | 指标查询与采集状态。`Status → Targets` 里 `node` 为 UP 即 node-exporter 正常。宿主端口由 `PROMETHEUS_PORT` 控制（默认 9090） |
| Node Exporter | http://localhost:9100/metrics | 宿主机 CPU / 内存 / 负载 / 磁盘 / 网络原文。Mac 上是 Docker Desktop Linux 虚拟机，Linux 上是该机宿主机 |
| 日志搬运（qryn） | http://localhost:3100/loki/api/v1/labels | 返回 JSON 即正常。兼容 Loki Push / LogQL，数据在 ClickHouse 库 `obs_logs` |
| BanyanDB | http://localhost:17913 | BanyanDB Web UI |

端口约定：宿主 `9001`=ClickHouse native，`8123`=ClickHouse HTTP，`3100`=日志搬运，`9090`=Prometheus，`9100`=node-exporter。Nacos 占用 `8080` 时不要再起 SkyWalking UI。

## 三、接入应用

容器内主机名（同一 `obs-net`）：`mysql`、`redis`、`nacos`、`postgres`、`clickhouse`。

Java 应用接入 SkyWalking（agent 版本与 OAP 一致）：

```bash
# 下载 java agent
curl -L -o skywalking-agent.tgz https://dlcdn.apache.org/skywalking/java-agent/10.4.0/apache-skywalking-java-agent-10.4.0.tgz
tar xzf skywalking-agent.tgz

# 启动参数示例
java -javaagent:/path/to/skywalking-agent/skywalking-agent.jar \
     -Dskywalking.agent.service_name=my-demo \
     -Dskywalking.collector.backend_service=localhost:11800 \
     -jar your-app.jar
```

日志（可选）：应用或 Alloy 按 Loki Push API 推到 `http://loki:3100/loki/api/v1/push`（宿主机用 `http://localhost:3100`）。qryn 写入 ClickHouse 库 `obs_logs`。查询打开 ClickVisual（http://localhost:19001），实例 DSN 指向同一台 ClickHouse。

把日志文件放进 `./data/host-logs/`，然后

```bash
docker compose -f docker-compose.loki.yml --profile logs up -d
```

## 四、Jenkins CI/CD（Wealth K8s）

可以用本栈的 **obs-jenkins** 跑 GitHub 上的 Wealth 三仓 CI/CD，直接复用  
`wealth-freedom/deploy/k8s/scripts/build-images.sh` 与 `deploy.sh`（dev / test / prod / local）。

| 项 | 说明 |
| --- | --- |
| Compose | `docker-compose.jenkins.yml`（控制台 http://localhost:18080） |
| 脚本备份 | 本仓库 `jenkins/`（`Jenkinsfile.wealth`、`scripts/pipeline-wealth.sh`） |
| 代码源 | GitHub `javaguide666/wealth-freedom{,-web}` / `wealth-ecommerce-web` |
| 日常 overlay | **dev**（连本机 obs MySQL/Redis/Nacos） |
| 测试/生产 | OVERLAY=`test` / `prod` |

```bash
# 启动 Jenkins（已建议挂载 docker.sock + ~/.kube + ~/.ssh，仅本机开发用）
docker compose -f docker-compose.jenkins.yml up -d

# 手动跑一遍与 Pipeline 相同的脚本（在宿主机验证）
OVERLAY=dev ./jenkins/scripts/pipeline-wealth.sh
```

Job：New Item → Pipeline → Script Path `jenkins/Jenkinsfile.wealth`（SCM 指向本 observability-stack 仓库），或粘贴该 Jenkinsfile。  
容器内还需具备 `docker` / `kubectl` / `git` / `mvn`（可在首次进容器安装，或改用宿主机永久 Agent）。详细见 `jenkins/README.md`。

---

## 五、迁移到测试环境

数据栈数据在 `DOCKER_DATA_DIR`（本机默认 `/Users/eric_brewer/.docker`）；可观测性数据在本项目 `data/`。配置全部在项目内。

```bash
# 本地：先停已启动的栈，保证数据一致
docker compose -f docker-compose.all.yml stop
# 若还起了其它栈，对对应文件同样 stop

# 打包（如数据量大可排除 data/，测试环境从零开始）
cd .. && tar czf obs-stack.tar.gz observability-stack

# 测试机（Linux，已装 docker engine + compose plugin）
scp obs-stack.tar.gz user@test-host:/opt/
ssh user@test-host
cd /opt && tar xzf obs-stack.tar.gz && cd observability-stack
cp .env.example .env
# 修改 DOCKER_DATA_DIR、NACOS_VERSION（x86 可用 v3.2.4）、密码
docker compose -f docker-compose.all.yml up -d
```

迁移要点：

- **架构差异无感**：本地 arm64、测试机 x86_64，镜像自动拉取对应架构；Nacos 在 ARM 用 `-slim`。
- **固定版本**：compose 中除 grafana/jenkins/alloy 外均已固定 tag（qryn 固定 3.2.39）。
- **端口冲突**：测试机端口冲突时，只改对应 `docker-compose.*.yml` 左侧（宿主侧）端口即可。
- **MySQL 初始化只跑一次**：`nacos` / `admin` 与 Nacos 表结构仅在数据目录为空时写入。已有数据目录不会重跑 `config/mysql/init/`。
- **升级为多机 HA**：按生产拓扑拆分（BanyanDB×3、OAP×2、qryn 多副本、ClickHouse 集群 + Keeper）。qryn 无状态，日志在 ClickHouse。

旧目录 `docker/dev`、`docker/nacos`、`docker/PostgreSQL`、`docker/jenkins` 已由本栈替代，请勿再混用两套数据目录。

## 六、常见问题

- **Nacos 起不来**：确认 MySQL 已 healthy，且 `nacos_config` 里已有表。全新数据目录用 `docker-compose.mysql.yml` 首次启动即可导入 schema；旧数据目录需自行执行 `config/mysql/init/02-nacos-schema.sql`。Nacos **不会**开机自启（`restart: "no"`），主机重启后需手动 `up -d`。
- **Nacos 与 SkyWalking 抢 8080**：不要同时启动两者的 8080 映射；Nacos 控制台优先保留 8080。
- **oap 反复重启**：BanyanDB 尚未就绪，等 `banyandb` healthy 后 OAP 会自动恢复（`restart: unless-stopped` 兜底）；首次启动 OAP 需 1~2 分钟。
- **日志栈起不来**：先确认 ClickHouse 已 healthy。qryn 启动时会在该实例建库 `obs_logs` 并建表；`CLICKHOUSE_PASSWORD` 里不要含冒号。看日志：`docker compose -f docker-compose.loki.yml logs loki`。
- **Grafana 里 Loki 数据源红了**：日志栈还没起，或 qryn 还连不上 ClickHouse。补装 `docker-compose.loki.yml` 后刷新。
- **Grafana 里 Prometheus 数据源红了，或看板无数据**：先起 `docker-compose.prometheus.yml`。打开 http://localhost:9090/targets ，`node` 应为 UP。Mac 上的数字是 Docker Desktop Linux 虚拟机，对不上 macOS 活动监视器属正常。
- **node-exporter 起不来**：确认 Docker 允许 `pid: host`，以及能只读挂载 `/proc`、`/sys`、`/`。这三项由容器引擎解析，Mac 上指向虚拟机，Linux 上指向宿主机。
- **BanyanDB 与 OAP 版本不匹配（API 兼容报错）**：到 SkyWalking 官方 Downloads 页核对兼容版本，修改 `.env` 后重新 `up -d`。
- **M1 内存不足**：Docker Desktop 设置里给容器预留 8G+ 内存；OAP 堆已通过 `JAVA_OPTS` 限制在 2G。只装数据栈时内存占用明显低于全量可观测性。
- **Grafana 里 ClickHouse 数据源红了**：尚未启动 ClickHouse，属正常；补装 `docker-compose.clickhouse.yml` 后刷新即可。日志查询走 Loki 数据源，不依赖这个 SQL 数据源。不需要该数据源时可删掉 `config/grafana/provisioning/datasources/clickhouse.yml`。
- **ClickHouse Code 194 / Authentication failed**：25.x 镜像未设 `CLICKHOUSE_PASSWORD` 时会禁止 `default` 远程登录。本仓库已默认 `default` / `Admin13278`（改 `.env` 后需 `docker compose -f docker-compose.clickhouse.yml up -d` 重建容器）。查询示例：`curl 'http://localhost:8123/?user=default&password=Admin13278' --data-binary 'SELECT 1'`。
- **`docker compose up` 找不到文件**：已取消默认的 `docker-compose.yml`，必须带 `-f` 指定栈文件，避免误装全部。

## 七、镜像加速配置
```
{
  "builder": {
    "gc": {
      "defaultKeepStorage": "20GB",
      "enabled": true
    }
  },
  "experimental": false,
  "registry-mirrors": [
    "https://docker.1ms.run",
    "https://docker.m.daocloud.io",
    "https://docker.xuanyuan.me"
  ]
}
```