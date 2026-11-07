# Atmark 자체 실행기 이미지 — GitHub Actions runner(linux-arm64) + CI·배포 도구. 런북: docs/runbooks/ci-cd.md §11
#
# 이 이미지는 colima 프로필 `atmark-runner`(집 디렉터리를 마운트하지 않는 VM) 안에서만 돈다.
# 컨테이너 하나 = job 하나(--ephemeral). job 이 끝나면 컨테이너가 지워지고 supervise.sh 가 새 컨테이너를 띄운다.
# 등록 토큰은 이미지에 없다 — 실행할 때 stdin 으로 들어온다(entrypoint.sh).
#
# 바탕을 ubuntu:24.04 로 둔 것은 GitHub 호스팅 ubuntu-latest(24.04)와 같은 glibc·로캘을 쓰려는 것이다 — CI 결과가 러너에 따라 갈리지 않게.

FROM ubuntu:24.04

ARG RUNNER_VERSION
ARG NODE_MAJOR=22
ARG PNPM_VERSION=10.10.0
ARG PG_MAJOR=17

ENV DEBIAN_FRONTEND=noninteractive \
    LANG=C.UTF-8 \
    LC_ALL=C.UTF-8 \
    TZ=UTC

SHELL ["/bin/bash", "-euo", "pipefail", "-c"]

# 기본 도구 — 워크플로가 부르는 것: git · jq · curl · unzip · procps(free) · xz(Node 압축) · gnupg(apt 키) ·
# python3(Python SDK 테스트 `python3 -m unittest discover -s sdk/python/tests` — 표준 라이브러리만 쓰므로 pip · venv 는 없다. ubuntu 24.04 = 3.12)
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates curl git gnupg jq lsb-release procps python3 unzip xz-utils zip \
 && rm -rf /var/lib/apt/lists/*

# PostgreSQL 17(운영 RDS 와 같은 주 버전) — PGDG. 패키지가 기본 클러스터를 만들지 않게 한다(CI 스텝이 initdb 로 매번 새로 만든다).
RUN install -d /usr/share/postgresql-common/pgdg /etc/postgresql-common \
 && curl -fsSL -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc https://www.postgresql.org/media/keys/ACCC4CF8.asc \
 && echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] https://apt.postgresql.org/pub/repos/apt $(lsb_release -cs)-pgdg main" \
      > /etc/apt/sources.list.d/pgdg.list \
 && echo 'create_main_cluster = false' > /etc/postgresql-common/createcluster.conf \
 && apt-get update \
 && apt-get install -y --no-install-recommends "postgresql-${PG_MAJOR}" "postgresql-client-${PG_MAJOR}" \
 && rm -rf /var/lib/apt/lists/*

# GitHub CLI — 배포 워크플로의 CI 게이트(`gh api …/runs`)가 부른다.
RUN curl -fsSL -o /usr/share/keyrings/githubcli-archive-keyring.gpg https://cli.github.com/packages/githubcli-archive-keyring.gpg \
 && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
      > /etc/apt/sources.list.d/github-cli.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends gh \
 && rm -rf /var/lib/apt/lists/*

# AWS CLI v2 — 배포 스텝(describe-stacks · lambda invoke · scheduler · logs)이 부른다. 자격증명은 job 마다 OIDC 로 받는다(이미지에 없음).
RUN curl -fsSL -o /tmp/awscliv2.zip https://awscli.amazonaws.com/awscli-exe-linux-aarch64.zip \
 && unzip -q /tmp/awscliv2.zip -d /tmp \
 && /tmp/aws/install \
 && rm -rf /tmp/aws /tmp/awscliv2.zip

# Node 22(최신 22.x, SHASUMS256 로 검증) + pnpm. 워크플로의 setup-node·pnpm/action-setup 이 같은 판을 다시 깔아도 된다 — 이것은 손으로 들어와 볼 때 쓴다.
RUN cd /tmp \
 && curl -fsSLO "https://nodejs.org/dist/latest-v${NODE_MAJOR}.x/SHASUMS256.txt" \
 && file=$(grep -oE "node-v${NODE_MAJOR}\.[0-9]+\.[0-9]+-linux-arm64\.tar\.xz" SHASUMS256.txt | head -1) \
 && curl -fsSLO "https://nodejs.org/dist/latest-v${NODE_MAJOR}.x/${file}" \
 && grep " ${file}\$" SHASUMS256.txt | sha256sum -c - \
 && tar -xJf "${file}" -C /usr/local --strip-components=1 --exclude='*/CHANGELOG.md' --exclude='*/README.md' --exclude='*/LICENSE' \
 && rm -f "${file}" SHASUMS256.txt \
 && npm install -g "pnpm@${PNPM_VERSION}" \
 && npm cache clean --force

# 실행 사용자 — GitHub 호스팅 러너와 같은 uid 1001 · sudo 없음(root 가 필요한 스텝은 이 러너에서 돌지 않는다).
RUN useradd --create-home --uid 1001 --shell /bin/bash runner

# actions/runner(linux-arm64). 판은 setup.sh 가 최신 릴리스로 넘기고, 압축 파일의 sha256 을 릴리스 본문의 값과 맞춘다.
WORKDIR /home/runner/actions-runner
RUN test -n "${RUNNER_VERSION}" || { echo "RUNNER_VERSION 빌드 인자가 필요하다(setup.sh 가 넘긴다)"; exit 1; } \
 && tarball="actions-runner-linux-arm64-${RUNNER_VERSION}.tar.gz" \
 && curl -fsSLO "https://github.com/actions/runner/releases/download/v${RUNNER_VERSION}/${tarball}" \
 && expected=$(curl -fsSL "https://api.github.com/repos/actions/runner/releases/tags/v${RUNNER_VERSION}" \
      | jq -r '.body' | grep -oE "<!-- BEGIN SHA linux-arm64 -->[0-9a-f]{64}" | grep -oE '[0-9a-f]{64}') \
 && test -n "${expected}" \
 && echo "${expected}  ${tarball}" | sha256sum -c - \
 && tar -xzf "${tarball}" \
 && rm -f "${tarball}" \
 && ./bin/installdependencies.sh \
 && rm -rf /var/lib/apt/lists/* \
 && chown -R runner:runner /home/runner

# 레거시 빌더(buildx 없는 docker CLI)에서도 되게 COPY --chmod 대신 chmod.
COPY entrypoint.sh /usr/local/bin/atmark-runner-entrypoint
RUN chmod 0755 /usr/local/bin/atmark-runner-entrypoint

USER runner
ENTRYPOINT ["/usr/local/bin/atmark-runner-entrypoint"]
