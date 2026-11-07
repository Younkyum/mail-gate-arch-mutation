#!/bin/bash
# IAM 사용자 atmark-ai-watch 의 액세스 키를 **시스템 키체인**에 넣는다 — 화면 · 셸 기록 · 프로세스 인자 · 파일 어디에도 값이 나오지 않게.
# 런북: docs/runbooks/ai-watch.md §3. **진윤겸이 직접** 돌린다(Claude 는 키를 만들지도 보지도 않는다 — CLAUDE.md §4 안전).
#
#   aws iam create-access-key --user-name atmark-ai-watch --profile atmark | sudo bash ops/ai-watch/store-key.sh
#
# 입력: `create-access-key` 의 JSON(표준 입력). 값은 셸 변수에만 있다가 `security -i` 의 **표준 입력**으로 들어간다(argv 아님).
# 저장 모양: 서비스 ai.atmark.aiwatch · 계정 aws · 값 `ACCESS_KEY_ID:SECRET` · 접근 허용 앱 /usr/bin/security(run.sh 가 root 로 읽는다).
# 출력: 키 id 의 앞 8자와 마지막 4자만(어느 키가 들어갔는지 확인용).
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=lib.sh
. "$HERE/lib.sh"
need_root
[ ! -t 0 ] || { echo "키 JSON 을 파이프로 넘긴다: aws iam create-access-key --user-name $IAM_USER --profile $AWS_PROFILE_NAME | sudo bash $0"; exit 64; }

set +x
json="$(cat)"
extract() { printf '%s' "$json" | /usr/bin/plutil -extract "AccessKey.$1" raw -o - - 2> /dev/null; }
akid="$(extract AccessKeyId)" || { echo "입력에 AccessKey.AccessKeyId 가 없다"; exit 1; }
secret="$(extract SecretAccessKey)" || { echo "입력에 AccessKey.SecretAccessKey 가 없다"; exit 1; }
user="$(extract UserName || true)"
unset json
[ "$user" = "$IAM_USER" ] || { echo "다른 IAM 사용자의 키다(UserName ≠ $IAM_USER) — 넣지 않는다"; exit 1; }
case "$akid" in AKIA????????????*) ;; *) echo "액세스 키 id 모양이 아니다"; exit 1 ;; esac
case "$secret" in *[!A-Za-z0-9/+=]* | "") echo "비밀 키 모양이 아니다"; exit 1 ;; esac

# security -i 는 명령 줄을 표준 입력에서 읽는다 — 값이 ps 에 보이지 않는다. -U = 있으면 갱신.
printf 'add-generic-password -U -s %s -a %s -l "Atmark AI mail watch (IAM %s)" -T /usr/bin/security -w "%s:%s" %s\n' \
  "$KC_SERVICE" "$KC_ACCOUNT" "$IAM_USER" "$akid" "$secret" "$KEYCHAIN" | /usr/bin/security -i > /dev/null
unset secret

key_present || { echo "키체인 항목을 확인하지 못했다"; exit 1; }
log "저장했다: ${akid:0:8}…${akid: -4} → $KEYCHAIN ($KC_SERVICE/$KC_ACCOUNT)"
if daemon_loaded; then
  launchctl kickstart -k "system/$LABEL"
  log "워커를 다시 띄웠다 — 하트비트 확인: sudo bash ops/ai-watch/verify.sh"
else
  log "워커가 아직 없다 — sudo bash ops/ai-watch/setup.sh --install"
fi
