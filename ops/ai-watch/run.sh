#!/bin/bash
# LaunchDaemon ai.atmark.aiwatch 의 진입점 — **root 로** 돈다(시스템 키체인 항목은 root 만 복호화한다). 런북: docs/runbooks/ai-watch.md §2
#
#   0. 실행할 것(Node 런타임 · 워커 번들 · 네이티브 모듈 · 샌드박스 프로필 · 잠금 · 모델)이 전부 root 소유 · 그룹/기타 쓰기 없음인지 본다(보안 리뷰
#      HIGH-2). 어긋나면 **키를 읽지 않고** 멈춘다 — 하트비트가 끊기므로 알람 55 로 드러난다.
#   1. 시스템 키체인에서 `ACCESS_KEY_ID:SECRET` 을 꺼낸다(셸 변수 — argv·env·파일에 쓰지 않는다).
#   2. sandbox-exec 아래 node 로 exec 하면서 그 값을 **FD 3 파이프**로만 넘긴다(printf 는 내장 명령 — ps 에 보이지 않는다).
#   3. 워커는 FD 3 을 읽고 닫은 뒤 곧바로 `_atmarkaiwatch` 로 내려간다(main.ts) — 메시지·모델은 그 뒤에만 연다.
# 이 파일은 setup.sh 가 "$APP_DIR/run.sh" 로 복사한다(root 소유 0755). 리포 사본을 직접 돌리지 않는다.
set -euo pipefail
ulimit -c 0

AW_HOME="/Library/Application Support/AtmarkAiWatch"
APP_DIR="$AW_HOME/app"
NODE="$APP_DIR/runtime/bin/node"
# shellcheck source=lib.sh
. "$APP_DIR/lib.sh"
# 검사 도구(find · stat …)는 시스템 것만 — lib.sh 의 PATH 에서 Homebrew 를 뺀다.
export PATH="/usr/bin:/bin:/usr/sbin:/sbin"

fatal() { printf '{"ts":"%s","level":"error","event":"fatal","reason":"%s"}\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$1"; exit 78; }

# 모델은 current 가 가리키는 버전 디렉터리까지(링크 자체 + 대상).
model_dir="$(cd "$AW_HOME/models/current" 2> /dev/null && pwd -P)" || fatal "model_current_missing"
if ! bad="$(root_owned_check "$APP_DIR/runtime" "$APP_DIR/worker.mjs" "$APP_DIR/node_modules" "$APP_DIR/sandbox.sb" "$APP_DIR/models.lock" \
  "$APP_DIR/lib.sh" "$APP_DIR/run.sh" "$OPENSSL_DIR" "$AW_HOME/models/current" "$model_dir")"; then
  # 경로는 우리 설치 경로라 로그에 실어도 된다(본문 · 키 아님) — 다만 JSON 을 깨지 않게 따옴표·역슬래시를 뺀다.
  printf '{"ts":"%s","level":"error","event":"fatal","reason":"untrusted_runtime_path","path":"%s"}\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$(printf '%s' "$bad" | tr -d '"\\')"
  exit 78
fi

# EX_CONFIG(78) — launchd 가 ThrottleInterval 마다 다시 시도한다(store-key.sh 뒤 저절로 뜬다).
secret="$(/usr/bin/security find-generic-password -s ai.atmark.aiwatch -a aws -w /Library/Keychains/System.keychain 2> /dev/null)" || fatal "keychain_item_missing"

# 환경은 **비우고 다시 쓴다**(재검증 HIGH) — NODE_OPTIONS · NODE_PATH · NODE_EXTRA_CA_CERTS · DYLD_* · SSL_* 등 로드 경로를 바꾸는 변수가
#   launchd·상속으로 들어와도 node 에 닿지 않는다. 넘기는 것은 아래 목록뿐(값은 plist 의 우리 값 — 모양을 워커가 다시 검사한다).
#   OpenSSL 은 root 소유 빈 설정 · 빈 모듈 디렉터리로(lib.sh 머리말) — --openssl-config 도 같은 파일.
#   --use-bundled-ca: Homebrew node 는 기본 CA 저장소가 OpenSSL 의 것(/opt/homebrew/etc/openssl@3/cert.pem — 로그인 사용자가 쓸 수 있다 = 가짜 CA 로
#   SQS TLS 가로채기)이다. node 에 내장된 Mozilla CA 만 믿는다. 샌드박스도 그 파일 읽기를 막으므로 이 플래그가 빠지면 TLS 가 실패한다(조용히 넓어지지 않는다).
tmp_dir="$AW_HOME/tmp"
exec /usr/bin/env -i \
  PATH=/usr/bin:/bin HOME=/var/empty TMPDIR="$tmp_dir" LANG=C \
  AIWATCH_HOME="$AW_HOME" \
  AIWATCH_RUN_AS_UID="${AIWATCH_RUN_AS_UID:-}" AIWATCH_RUN_AS_GID="${AIWATCH_RUN_AS_GID:-}" \
  AIWATCH_WORKER_ID="${AIWATCH_WORKER_ID:-}" AIWATCH_THREADS="${AIWATCH_THREADS:-}" OMP_NUM_THREADS="${AIWATCH_THREADS:-4}" \
  OPENSSL_CONF="$OPENSSL_CONF_FILE" OPENSSL_MODULES="$OPENSSL_EMPTY_DIR" OPENSSL_ENGINES="$OPENSSL_EMPTY_DIR" \
  /usr/bin/sandbox-exec -f "$APP_DIR/sandbox.sb" -D "NODE=$NODE" -D "TMP_DIR=$tmp_dir" \
  "$NODE" --use-bundled-ca --openssl-config="$OPENSSL_CONF_FILE" --max-old-space-size=1024 "$APP_DIR/worker.mjs" 3< <(printf '%s' "$secret")
