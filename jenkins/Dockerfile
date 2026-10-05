# Wealth CI 用 Jenkins：docker build / kubectl apply / mvn package（Java 25）
# JDK 来自 eclipse-temurin 多阶段。
# docker / buildx / kubectl / maven 在本文件构建时下载；这一层不变就由 Docker 缓存复用，不必提交二进制。
FROM eclipse-temurin:25-jdk AS jdk

FROM jenkins/jenkins:lts
USER root
ARG TARGETARCH
ENV DEBIAN_FRONTEND=noninteractive \
    JAVA_HOME=/opt/java/jdk-25 \
    MAVEN_HOME=/opt/maven \
    PATH=/opt/java/jdk-25/bin:/opt/maven/bin:/usr/local/bin:${PATH}

RUN apt-get update && apt-get install -y --no-install-recommends \
      curl ca-certificates gnupg git unzip openssh-client \
    && rm -rf /var/lib/apt/lists/*

COPY --from=jdk /opt/java/openjdk /opt/java/jdk-25

RUN set -eux; \
    case "${TARGETARCH}" in \
      arm64) DARCH=aarch64; KARCH=arm64 ;; \
      amd64) DARCH=x86_64; KARCH=amd64 ;; \
      *) echo "unsupported TARGETARCH=${TARGETARCH}" >&2; exit 1 ;; \
    esac; \
    mkdir -p /tmp/ci-tools /usr/local/lib/docker/cli-plugins; \
    fetch() { \
      out="$1"; shift; \
      rm -f "${out}.partial"; \
      for url in "$@"; do \
        echo "==> ${url}"; \
        if curl -fL --retry 5 --retry-delay 2 --connect-timeout 20 --max-time 900 -o "${out}.partial" "$url"; then \
          mv "${out}.partial" "$out"; \
          return 0; \
        fi; \
        rm -f "${out}.partial"; \
      done; \
      echo "FAILED ${out}" >&2; \
      return 1; \
    }; \
    fetch /tmp/ci-tools/docker.tgz \
      "https://mirrors.aliyun.com/docker-ce/linux/static/stable/${DARCH}/docker-27.5.1.tgz" \
      "https://mirrors.huaweicloud.com/docker-ce/linux/static/stable/${DARCH}/docker-27.5.1.tgz" \
      "https://download.docker.com/linux/static/stable/${DARCH}/docker-27.5.1.tgz"; \
    fetch /usr/local/lib/docker/cli-plugins/docker-buildx \
      "https://github.com/docker/buildx/releases/download/v0.20.1/buildx-v0.20.1.linux-${KARCH}"; \
    KVER="$(curl -fsSL --retry 5 --connect-timeout 20 https://dl.k8s.io/release/stable.txt)"; \
    fetch /usr/local/bin/kubectl "https://dl.k8s.io/release/${KVER}/bin/linux/${KARCH}/kubectl"; \
    fetch /tmp/ci-tools/maven.tgz \
      "https://mirrors.huaweicloud.com/apache/maven/maven-3/3.9.9/binaries/apache-maven-3.9.9-bin.tar.gz" \
      "https://repo.maven.apache.org/maven2/org/apache/maven/apache-maven/3.9.9/apache-maven-3.9.9-bin.tar.gz" \
      "https://archive.apache.org/dist/maven/maven-3/3.9.9/binaries/apache-maven-3.9.9-bin.tar.gz"; \
    tar -xzf /tmp/ci-tools/docker.tgz -C /tmp/ci-tools; \
    mv /tmp/ci-tools/docker/docker /usr/local/bin/docker; \
    chmod +x /usr/local/bin/docker /usr/local/lib/docker/cli-plugins/docker-buildx /usr/local/bin/kubectl; \
    tar -xzf /tmp/ci-tools/maven.tgz -C /opt; \
    ln -sfn /opt/apache-maven-3.9.9 /opt/maven; \
    rm -rf /tmp/ci-tools; \
    groupadd -f docker; \
    usermod -aG docker jenkins; \
    java -version; mvn -v; docker --version; docker buildx version; kubectl version --client=true

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
