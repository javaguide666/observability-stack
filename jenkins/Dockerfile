# syntax=docker/dockerfile:1
# Wealth CI 用 Jenkins：docker build / kubectl apply / mvn package（Java 25）
# JDK 来自 eclipse-temurin 多阶段。
# docker / buildx / kubectl / maven：优先国内镜像；BuildKit 缓存断点续下；
# 宿主机若已跑 scripts/prefetch-ci-tools.sh，COPY cache/ 会直接复用。
FROM eclipse-temurin:25-jdk AS jdk

FROM jenkins/jenkins:lts
USER root
ARG TARGETARCH
ENV DEBIAN_FRONTEND=noninteractive \
    JAVA_HOME=/opt/java/jdk-25 \
    MAVEN_HOME=/opt/maven \
    PATH=/opt/java/jdk-25/bin:/opt/maven/bin:/usr/local/bin:${PATH} \
    JENKINS_UC=https://mirrors.tuna.tsinghua.edu.cn/jenkins/updates \
    JENKINS_UC_DOWNLOAD=https://mirrors.tuna.tsinghua.edu.cn/jenkins

RUN apt-get update && apt-get install -y --no-install-recommends \
      curl ca-certificates gnupg git unzip openssh-client \
    && rm -rf /var/lib/apt/lists/*

COPY --from=jdk /opt/java/openjdk /opt/java/jdk-25

COPY scripts/install-ci-tools.sh /tmp/install-ci-tools.sh
COPY cache/ /tmp/ci-host-cache/
RUN --mount=type=cache,id=wealth-ci-tools-${TARGETARCH},target=/var/cache/ci-tools \
    mkdir -p /var/cache/ci-tools; \
    for f in docker.tgz docker-buildx kubectl maven.tgz; do \
      if [ -f "/tmp/ci-host-cache/$f" ]; then cp -f "/tmp/ci-host-cache/$f" "/var/cache/ci-tools/$f"; fi; \
    done; \
    TARGETARCH="${TARGETARCH}" CI_TOOLS_CACHE=/var/cache/ci-tools INSTALL=1 \
      bash /tmp/install-ci-tools.sh; \
    rm -rf /tmp/ci-host-cache /tmp/install-ci-tools.sh

# 全局 settings：Central 走阿里云。用户家目录里的 settings.xml 仍可覆盖。
# 单独一层，改镜像地址不会让上面的工具重新下载。
RUN printf '%s\n' \
      '<settings>' \
      '  <mirrors>' \
      '    <mirror>' \
      '      <id>aliyun-central</id>' \
      '      <mirrorOf>central</mirrorOf>' \
      '      <url>https://maven.aliyun.com/repository/public</url>' \
      '    </mirror>' \
      '  </mirrors>' \
      '</settings>' \
      > /opt/apache-maven-3.9.9/conf/settings.xml

USER jenkins
RUN jenkins-plugin-cli --plugins \
  workflow-aggregator git credentials credentials-binding ssh-credentials \
  pipeline-stage-view timestamper ws-cleanup configuration-as-code \
  list-git-branches-parameter git-parameter simple-theme-plugin
