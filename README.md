# observability-stack：开发 / 测试环境中间件（Docker Compose）

**一软件一个 Compose 文件**（共用项目名 `obs-stack`、网络 `obs-net`、固定容器名 `obs-*`），每个文件都能单独 `docker compose -f docker-compose.<组件>.yml up -d`。主流程只依赖 `docker compose`，Windows / macOS / Linux 通用；`scripts/` 里的 sh 脚本是 Mac / Linux 的可选便捷封装（见文末附注）。

## 快速开始

前置：Docker Engine / Docker Desktop（Compose ≥ 2.20，`docker-compose.all.yml` 用了 `include`）、内存建议 8GB+（只跑数据栈约 4GB）。amd64 / arm64 通用，所有镜像固定 tag。

```bash
cd observability-stack
cp .env.example .env        # Windows（CMD）：copy .env.example .env；PowerShell：Copy-Item .env.example .env
                            # .env 可选：不建 .env 时各变量用 compose 文件里的默认值（与模板一致）
```

日常开发数据栈（MySQL + Redis + Nacos + PostgreSQL + ClickHouse）：
```bash
docker compose -f docker-compose.all.yml up -d
```

只装其中一个：

```bash
docker compose -f docker-compose.mysql.yml up -d
docker compose -f docker-compose.redis.yml up -d
docker compose -f docker-compose.nacos.yml up -d   # 需 MySQL 已就绪（没就绪时 Nacos 会自动重试到连上）
docker compose -f docker-compose.postgres.yml up -d
docker compose -f docker-compose.clickhouse.yml up -d
docker compose -f docker-compose.jenkins.yml up -d --build
```

构建 Jenkins 镜像时会按 CPU 架构下载 docker、buildx、kubectl、maven。这一层没有变化时直接复用，这些文件不用提交到 git。

可观测性（与数据栈同一网络，可随时追加）。日志栈复用已有 ClickHouse，先起数据栈或单独起 ClickHouse：

```bash
docker compose -f docker-compose.clickhouse.yml up -d
docker compose -f docker-compose.loki.yml up -d          # qryn（服务名 loki），日志写入 ClickHouse
docker compose -f docker-compose.clickvisual.yml up -d   # 日志查询 UI，需 MySQL
docker compose -f docker-compose.skywalking.yml up -d    # 链路追踪，UI 在 http://localhost:18089
docker compose -f docker-compose.prometheus.yml up -d    # 服务器指标
docker compose -f docker-compose.grafana.yml up -d       # http://localhost:3002
```

停止：`docker compose -f docker-compose.<组件>.yml down`（保留数据目录；`all.yml` 同理）。

**已有旧数据的机器**（例如本机旧数据在 `~/.docker/mysql/data`）：`.env` 里必须把 `DOCKER_DATA_DIR` 设为旧目录（如 `DOCKER_DATA_DIR=/Users/<你>/.docker`），否则会在 `./data` 新建空库。

**MySQL 账号密码在 SQL 里**：`config/mysql/init/01-users.sql` 里写死了 `nacos` / `admin` 账号及密码（开发约定默认值，与 IDEA、K8s dev secret 一致）。该脚本只在数据目录为空时执行一次；要改这两个账号的密码，需同步改 `01-users.sql` 和 `.env` 的 `MYSQL_NACOS_PASSWORD`（Nacos 用它连库），已有数据则需在 MySQL 里 `ALTER USER`。`MYSQL_ROOT_PASSWORD` 由 `.env` 控制，不受影响。

可用组件文件：`mysql redis postgres clickhouse nacos skywalking loki prometheus grafana clickvisual jenkins`；Alloy（可选日志采集）是 `docker-compose.loki.yml` 里的 `logs` profile：`docker compose -f docker-compose.loki.yml --profile logs up -d`。

## 一、组件与文件

| 组件 | Compose 文件 | 镜像 tag | 说明 | 备注 |
|---|---|---|---|---|
| MySQL | `docker-compose.mysql.yml` | 9.7.2 | 开发主库；首次初始化执行 `config/mysql/init/01-users.sql`（建 `nacos` / `admin`）与 `02-nacos-schema.sql` | all.yml |
| Redis | `docker-compose.redis.yml` | 8.10.1 | 缓存 / 锁 | all.yml |
| Nacos | `docker-compose.nacos.yml` | v3.2.4-slim | 注册 / 配置；`nacos-init` 一次性幂等创建控制台 admin | all.yml |
| PostgreSQL | `docker-compose.postgres.yml` | 18.6-alpine | 可选主库 | all.yml |
| ClickHouse | `docker-compose.clickhouse.yml` | 25.8 | 指标 / 日志存储 | all.yml |
| 日志搬运 qryn | `docker-compose.loki.yml` | 3.2.39 | Loki Push / LogQL；可选 Alloy 采集（`alloy`，`--profile logs`） |  |
| ClickVisual | `docker-compose.clickvisual.yml` | 1.0.4 | 日志查询 UI（元数据复用 MySQL） |  |
| SkyWalking | `docker-compose.skywalking.yml` | OAP/UI 10.4.0 + BanyanDB 0.10.0 | 链路追踪 |  |
| Prometheus + node-exporter | `docker-compose.prometheus.yml` | v3.15.0 / v1.12.1 | 服务器指标 |  |
| Grafana | `docker-compose.grafana.yml` | 13.0.10 | 统一查询（日志 / 指标 / ClickHouse） |  |
| Jenkins | `docker-compose.jenkins.yml` | 本地构建 wealth-jenkins:lts-ci | CI |  |
| 聚合 | `docker-compose.all.yml` | — | include：mysql redis nacos postgres clickhouse | — |

**统一约定**：所有端口 / 版本 / 账号 / 数据目录来自 `.env`（模板 `.env.example`，缺省值与模板一致）；`restart: unless-stopped`；日志轮转；有 healthcheck（Alloy 镜像无 shell，例外）；`REGISTRY_MIRROR` 可给全部镜像加前缀；`CONTAINER_PREFIX` / `OBS_NETWORK` 可起第二套隔离环境（默认 `obs` / `obs-net` 不变）。
数据目录：`DOCKER_DATA_DIR`（默认 `./data`，放 mysql / redis / nacos / postgres / clickhouse / jenkins）与 `LOCAL_DATA_DIR`（默认 `./data`，放 banyandb / prometheus / grafana）。**已有旧数据的机器**：在 `.env` 里把 `DOCKER_DATA_DIR` 指向旧目录（见快速开始），不迁移、不改动数据。

## 二、端口与访问入口

默认值如下，冲突时只改 `.env` 里的变量（Mac / Linux 可用 `scripts/check.sh` 检查冲突项）。

| 服务 | 宿主端口（变量） | 地址 / 说明 |
|---|---|---|
| MySQL | 3306（`MYSQL_PORT`） | `root` 密码见 `.env`；`nacos` / `admin` 账号密码在 `config/mysql/init/01-users.sql`（开发约定默认值） |
| Redis | 6379（`REDIS_PORT`） | `requirepass` 见 `.env` |
| PostgreSQL | 5432（`POSTGRES_PORT`） | `POSTGRES_USER` / `POSTGRES_DB` 见 `.env` |
| Nacos | 控制台 8080（`NACOS_CONSOLE_PORT`）· 8848 · 9848 · 9849 | http://localhost:8080 ；账号 `nacos`，初始密码 `NACOS_ADMIN_PASSWORD`（默认 `NacosAdmin`） |
| **SkyWalking UI** | **18089**（`SW_UI_PORT`） | **http://localhost:18089**（容器内 8080；已避开 Nacos 控制台） |
| SkyWalking OAP | 11800 gRPC（Agent 上报）· 12800 HTTP | Agent：`-Dskywalking.collector.backend_service=localhost:11800` |
| BanyanDB | 17912 · 17913 | http://localhost:17913 |
| ClickHouse | HTTP 8123 · Native 9001 | http://localhost:8123/ping |
| 日志搬运（qryn） | 3100（`LOKI_PORT`） | http://localhost:3100/loki/api/v1/labels（`/ready` 返回 capabilities JSON，属正常）。Loki 协议入口，日志写入 ClickHouse 库 `obs_logs`，默认保留 `LOG_RETENTION_DAYS=7` 天；K8s dev 的 Alloy 推送到这里 |
| ClickVisual | 19001（`CLICKVISUAL_PORT`） | 首次打开 `/install/init` 点一次初始化；账号 `clickvisual` / `clickvisual`；ClickHouse 实例 DSN 见 `config/clickvisual/docker.toml`。日志库 `cv_logs`：`stdout` 是演示表，`qryn_logs` 对应 qryn 写入 `obs_logs` 的日志 |
| Grafana | 3002（`GRAFANA_PORT`） | http://localhost:3002 ，账号密码见 `.env`；避开 K8s 电商前端 :3000 与 K8s 日志 Grafana :3001 |
| Prometheus / node-exporter | 9090 · 9100 | http://localhost:9090/targets 里 `node` 为 UP 即正常 |
| Jenkins | 18080（`JENKINS_PORT`）· 50000 | http://localhost:18080 ；初始密码见容器日志 |

容器内主机名（同一网络）：`mysql`、`redis`、`nacos`、`postgres`、`clickhouse`、`loki`、`oap`。宿主机或 K8s（`host.docker.internal`）访问用上表端口。

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

日志方案详见 `obsidian-doc/build_doc/Loki日志，可视化平台搭建.md`（本机 = qryn + ClickHouse + ClickVisual；K8s test/prod = Loki + RustFS）。

日志（可选）：应用或 Alloy 按 Loki Push API 推到 `http://loki:3100/loki/api/v1/push`（宿主机用 `http://localhost:3100`）。qryn 写入 ClickHouse 库 `obs_logs`。查询打开 ClickVisual（http://localhost:19001），实例 DSN 指向同一台 ClickHouse。

把日志文件放进 `./data/host-logs/`，然后

```bash
docker compose -f docker-compose.loki.yml --profile logs up -d
```

## 四、Jenkins CI/CD（Wealth K8s）

可以用本栈的 **obs-jenkins** 跑 GitHub 上的 Wealth 三仓 CI/CD，直接复用  
`wealth-freedom/deploy/k8s/scripts/build-images.sh` 与 `deploy.sh`（dev / test / prod / local）。

自定义UI地址：http://localhost:18080/userContent/wealth/ （需先登录 Jenkins；旧页面回退：http://localhost:18080/userContent/wealth-legacy/）

| 项 | 说明 |
| --- | --- |
| Compose | `docker-compose.jenkins.yml`（控制台 http://localhost:18080，端口 `JENKINS_PORT`） |
| 脚本备份 | 本仓库 `jenkins/`（`Jenkinsfile.wealth`、`scripts/pipeline-wealth.sh`） |
| 代码源 | GitHub `javaguide666/wealth-freedom{,-web}` / `wealth-ecommerce-web` |
| 日常 overlay | **dev**（连本机 obs MySQL/Redis/Nacos） |
| 测试/生产 | OVERLAY=`test` / `prod` |

```bash
# 启动 Jenkins（已建议挂载 docker.sock + ~/.kube + ~/.ssh，仅本机开发用）
# 镜像内的 docker / kubectl / maven 在本次构建中下载；Dockerfile 那一层有缓存就不再下载
docker compose -f docker-compose.jenkins.yml up -d --build

# 手动跑一遍与 Pipeline 相同的脚本（在宿主机验证）
OVERLAY=dev ./jenkins/scripts/pipeline-wealth.sh
```

Job：New Item → Pipeline → Script Path `jenkins/Jenkinsfile.wealth`（SCM 指向本 observability-stack 仓库），或粘贴该 Jenkinsfile。  
容器内还需具备 `docker` / `kubectl` / `git` / `mvn`（可在首次进容器安装，或改用宿主机永久 Agent）。详细见 `jenkins/README.md`。

---

## 五、测试环境一键全开 / 迁移 / 清理

```bash
# 测试机（已装 docker engine + compose plugin，Linux / Windows / macOS 均可）
git clone <本仓库> && cd observability-stack
cp .env.example .env                  # Windows：copy .env.example .env；按需改密码 / 端口 / DOCKER_DATA_DIR
# 国内网络拉镜像慢：在 .env 里设 REGISTRY_MIRROR=docker.1ms.run/   （须以 / 结尾）

# 全开（约需 8GB+ 内存；Nacos 在 MySQL 之后，先起数据栈）
docker compose -f docker-compose.all.yml up -d
docker compose -f docker-compose.skywalking.yml up -d
docker compose -f docker-compose.clickhouse.yml -f docker-compose.loki.yml up -d
docker compose -f docker-compose.prometheus.yml up -d
docker compose -f docker-compose.grafana.yml up -d
docker compose -f docker-compose.clickvisual.yml up -d
docker compose -f docker-compose.jenkins.yml up -d --build      # 可选

# 清理：逐个 down，保留 data/
docker compose -f docker-compose.jenkins.yml down      # 其余同理，把文件名换成对应组件
# 彻底重来（会清空数据，谨慎）：先 down，再手动删除 .env 里 DOCKER_DATA_DIR / LOCAL_DATA_DIR 下对应子目录
```

要点：

- **架构无感**：本地 arm64、测试机 x86_64 均自动拉取对应架构；Nacos 用 `-slim`。
- **初始化幂等**：MySQL 的 `config/mysql/init/` 仅在数据目录为空时执行（`01-users.sql` 建 `nacos` / `admin` 账号，密码写在 SQL 里；`02-nacos-schema.sql` 导 Nacos 表）；已有数据不会被覆盖。`nacos-init` 重复执行无副作用。
- **改密码**：`MYSQL_ROOT_PASSWORD`、Redis、Postgres、Grafana、ClickHouse 等密码改 `.env` 即可；MySQL 的 `nacos` / `admin` 密码在 `01-users.sql` 里，改它要同步改 `.env` 的 `MYSQL_NACOS_PASSWORD`。ClickHouse 密码还写在 `config/clickvisual/docker.toml` 的 DSN 里，需同步。改完同步 wealth-freedom 的 K8s dev secret / IDEA 配置。
- 旧目录 `docker/dev`、`docker/nacos`、`docker/PostgreSQL`、`docker/jenkins` 已由本栈替代，请勿再混用两套数据目录。

### 附注：Mac / Linux 可选便捷脚本（非必须）

`scripts/` 下的 bash 脚本只是对上述 compose 文件的封装，Windows 不支持，主流程不依赖它们：

```bash
scripts/init-env.sh [--random]      # 生成 .env；--random 只随机 MySQL root、Redis、Postgres、Nacos、Grafana 等 .env 控制的密码
scripts/check.sh                    # 自检（Docker/Compose 版本、内存、架构、端口冲突）并打印访问地址表
scripts/up.sh core|logging|skywalking|metrics|grafana|ci|full|<组件名>   # 按名称启动，自动补依赖并等 healthy；已在运行的默认跳过
scripts/down.sh <同上>              # 停止，保留数据目录
```

`init-env.sh` 检测到 `~/.docker/mysql/data` 时会把 `DOCKER_DATA_DIR` 指向 `~/.docker`。`--random` **不会**改 MySQL 的 `nacos` / `admin` 账号密码（它们写在 `01-users.sql` 里），也不改 ClickHouse 密码（写在 `docker.toml` 里）。

## 六、常见问题

- **端口冲突**：在 `.env` 改对应变量（表见上）后重新 `docker compose -f … up -d`（Mac / Linux 可先 `scripts/check.sh` 找出冲突项）。常见：8080（Nacos 控制台）、3000（K8s 电商前端）、3306 / 6379（本机已装 MySQL / Redis）。SkyWalking UI 固定走 18089，不再和 Nacos 抢 8080。
- **内存不足**：Docker Desktop → Settings → Resources 给 8GB+；只开 core 约 2–3GB。OAP 堆可用 `SW_OAP_JAVA_OPTS` 调小。
- **镜像拉取失败 / 超时**：在 `.env` 设 `REGISTRY_MIRROR=docker.1ms.run/`（或 `docker.m.daocloud.io/`，须以 `/` 结尾），也可在 Docker Desktop 配置 registry-mirrors（见文末）。
- **Nacos 起不来**：确认 MySQL 已 healthy。Nacos 带 `restart: unless-stopped`，MySQL 晚于它起来时会自动重连。旧数据目录若没有 Nacos 表，手动执行 `config/mysql/init/02-nacos-schema.sql`。
- **Nacos 控制台登录失败**：`nacos-init` 只在 admin 尚未初始化时设置密码；已初始化过的库保持原密码。
- **MySQL 改了 `.env` 密码没生效**：`nacos` / `admin` 账号只在首次初始化时创建，已有数据需在 MySQL 里手动 `ALTER USER`。
- **oap 反复重启**：BanyanDB 尚未 healthy，等待即可；首次启动 OAP 需 1–2 分钟。BanyanDB 与 OAP 需用官方验证过的版本组合。
- **日志栈起不来**：先确认 ClickHouse healthy；`CLICKHOUSE_PASSWORD` 不要含冒号。`docker compose -f docker-compose.loki.yml logs loki`。
- **Grafana 数据源红了**：对应组件（loki / prometheus / clickhouse）没起，补起后刷新；用不到的数据源可从 `config/grafana/provisioning/datasources/` 删掉。
- **node-exporter**：需要 Docker 允许 `pid: host` 与只读挂载 `/proc`、`/sys`、`/`；Mac 上采到的是 Docker Desktop 虚拟机。
- **Jenkins 挂载目录**：默认挂 `~/.kube`、`~/.ssh`、`~/gitee` 与 `docker.sock`，路径不同在 `.env` 设 `JENKINS_KUBE_DIR` / `JENKINS_SSH_DIR` / `JENKINS_WORKSPACE_DIR` / `DOCKER_SOCK`。
- **`docker compose up` 找不到文件**：没有默认的 `docker-compose.yml`，必须 `-f` 指定组件文件。

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