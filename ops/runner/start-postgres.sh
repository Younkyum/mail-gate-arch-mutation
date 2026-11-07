#!/usr/bin/env bash
# CI 통합 테스트용 Postgres 17 을 job 안에서 띄운다 — 자체 실행기(이미지에 설치됨)와 GitHub 호스팅(ubuntu-latest, 여기서 설치) **같은 한 경로**.
# 런북: docs/runbooks/ci-cd.md §8 · §11. 예전 `services: postgres:17` 컨테이너와 같은 설정:
#   - 주 버전 17(운영 RDS 와 같다) · 슈퍼유저 `postgres` · localhost:5432
#   - 인증 trust(통합 테스트 몇은 비밀번호를 비운 롤 URL 을 만든다 — test/integration/tlog/*.test.ts `url.password = ''`)
#   - 클러스터 기본 로캘 C.UTF-8(테스트 DB 는 "테스트 DB" 스텝이 `--locale=C.UTF-8` 로 따로 만든다)
# 자체 실행기 컨테이너에는 docker.sock 이 없으므로 서비스 컨테이너를 쓸 수 없다 — 그래서 job 프로세스로 띄운다.
# 데이터는 $RUNNER_TEMP 아래 일회용(job 이 끝나면 컨테이너·VM 과 함께 사라진다) — 그래서 fsync 를 끈다.
set -euo pipefail

PG_MAJOR=17
PGBIN="/usr/lib/postgresql/$PG_MAJOR/bin"

if [ ! -x "$PGBIN/postgres" ]; then
  # GitHub 호스팅 러너: 기본 설치는 16 이고 서비스는 꺼져 있다. PGDG 에서 17 을 받되 패키지가 클러스터를 만들어 띄우지 않게 한다.
  echo "Postgres $PG_MAJOR 설치(PGDG)"
  sudo install -d /etc/postgresql-common
  echo 'create_main_cluster = false' | sudo tee -a /etc/postgresql-common/createcluster.conf > /dev/null
  if [ ! -x /usr/share/postgresql-common/pgdg/apt.postgresql.org.sh ]; then
    sudo apt-get update -qq
    sudo apt-get install -y -qq --no-install-recommends postgresql-common > /dev/null
  fi
  sudo /usr/share/postgresql-common/pgdg/apt.postgresql.org.sh -y > /dev/null
  sudo apt-get install -y -qq --no-install-recommends "postgresql-$PG_MAJOR" > /dev/null
fi

DATA="${RUNNER_TEMP:-/tmp}/pg$PG_MAJOR"
rm -rf "$DATA"
"$PGBIN/initdb" -D "$DATA" -U postgres --auth=trust --encoding=UTF8 --locale=C.UTF-8 > /dev/null
"$PGBIN/pg_ctl" -D "$DATA" -l "$DATA/server.log" -w -t 60 start \
  -o "-p 5432 -c listen_addresses=localhost -k $DATA -c fsync=off -c synchronous_commit=off -c full_page_writes=off" > /dev/null
"$PGBIN/pg_isready" -h localhost -p 5432 -U postgres
"$PGBIN/psql" -h localhost -U postgres -d postgres -Atc 'SELECT version()'
