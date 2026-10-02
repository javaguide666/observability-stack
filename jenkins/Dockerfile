# Wealth CI 用 Jenkins：docker build / kubectl apply / mvn package（Java 25）
# JDK 来自 eclipse-temurin 多阶段；其余工具优先 jenkins/cache/（宿主机 prefetch）
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

COPY cache/docker.tgz /tmp/docker.tgz
COPY cache/kubectl /usr/local/bin/kubectl
COPY cache/maven.tgz /tmp/maven.tgz

RUN set -eux; \
  tar -xzf /tmp/docker.tgz -C /tmp; \
  mv /tmp/docker/docker /usr/local/bin/docker; \
  chmod +x /usr/local/bin/docker /usr/local/bin/kubectl; \
  tar -xzf /tmp/maven.tgz -C /opt; \
  ln -sfn /opt/apache-maven-3.9.9 /opt/maven; \
  rm -rf /tmp/docker /tmp/docker.tgz /tmp/maven.tgz; \
  groupadd -f docker; \
  usermod -aG docker jenkins; \
  java -version; mvn -v; docker --version; kubectl version --client=true

USER jenkins
RUN jenkins-plugin-cli --plugins \
  workflow-aggregator git credentials credentials-binding ssh-credentials \
  pipeline-stage-view timestamper ws-cleanup configuration-as-code \
  list-git-branches-parameter git-parameter simple-theme-plugin
