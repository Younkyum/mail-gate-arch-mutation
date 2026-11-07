#!/usr/bin/env bash
# 컨테이너 안 — 등록 토큰을 stdin 에서 한 줄 읽어 --ephemeral 로 등록하고 job 하나를 받는다. 런북: docs/runbooks/ci-cd.md §11
#
# 토큰을 환경 변수·인자로 받지 않는 이유: 환경 변수는 `docker inspect` 와 job 스텝(러너의 자식 프로세스)에 그대로 보이고,
# 인자는 `ps` 에 보인다. stdin 으로 받아 config.sh 에만 넘기고 바로 지운다. 출력하지 않는다.
set -euo pipefail

: "${RUNNER_URL:?RUNNER_URL 이 필요하다}"
: "${RUNNER_NAME:?RUNNER_NAME 이 필요하다}"
: "${RUNNER_LABELS:?RUNNER_LABELS 가 필요하다}"

IFS= read -r token || true
[ -n "${token:-}" ] || { echo "등록 토큰이 stdin 으로 오지 않았다" >&2; exit 64; }

cd /home/runner/actions-runner
./config.sh --unattended --ephemeral --replace \
  --url "$RUNNER_URL" \
  --name "$RUNNER_NAME" \
  --labels "$RUNNER_LABELS" \
  --work _work \
  --token "$token" > /dev/null
unset token

# 등록 정보가 job 환경으로 새지 않게 실행에 필요 없는 변수는 지운다.
unset RUNNER_URL RUNNER_LABELS
echo "등록됨: $RUNNER_NAME — job 하나를 기다린다"
exec ./run.sh
