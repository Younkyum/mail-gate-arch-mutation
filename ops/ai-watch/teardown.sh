#!/bin/bash
# AI 의심 메일 감시 워커 멈추기 · 걷어 내기. 런북: docs/runbooks/ai-watch.md §5 · §8
#
#   sudo bash ops/ai-watch/teardown.sh --pause     # 일시 정지(SIGUSR1) — 하트비트 draining:true → inbound 가 곧바로 30초 보류를 멈춘다. 업데이트·재부팅 전.
#   sudo bash ops/ai-watch/teardown.sh --resume    # 재개(SIGUSR2)
#   sudo bash ops/ai-watch/teardown.sh             # 데몬 내림(SIGTERM → 배수 하트비트) · plist 삭제. 앱·모델·키·사용자는 남긴다.
#   sudo bash ops/ai-watch/teardown.sh --purge     # + 앱·모델·로그·newsyslog·키체인 항목·전용 사용자/그룹 삭제(기계를 옮길 때)
#
# --purge 뒤에도 **IAM 액세스 키는 AWS 에 살아 있다** — 진윤겸이 비활성화한다(마지막 줄의 명령). 몇 번 돌려도 된다.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=lib.sh
. "$HERE/lib.sh"

mode="down"
for a in "$@"; do
  case "$a" in
    --pause) mode="pause" ;;
    --resume) mode="resume" ;;
    --purge) mode="purge" ;;
    *) echo "모르는 인자: $a"; exit 64 ;;
  esac
done
need_root

case "$mode" in
  pause | resume)
    daemon_loaded || { echo "$LABEL 이 올라가 있지 않다"; exit 1; }
    sig=SIGUSR1
    [ "$mode" = resume ] && sig=SIGUSR2
    launchctl kill "$sig" "system/$LABEL"
    sleep 2
    log "$mode — 최근 로그:"
    tail -n 3 "$LOG_DIR/worker.log" 2> /dev/null || true
    exit 0
    ;;
esac

log "LaunchDaemon $LABEL 내림"
launchctl bootout "system/$LABEL" 2> /dev/null || true
for _ in $(seq 1 15); do daemon_loaded || break; sleep 2; done
rm -f "$PLIST"

if [ "$mode" = purge ]; then
  log "앱·모델·tmp·로그·newsyslog 삭제"
  rm -rf "${AW_HOME:?}" "${LOG_DIR:?}" "$NEWSYSLOG_CONF"
  log "키체인 항목 삭제"
  security delete-generic-password -s "$KC_SERVICE" -a "$KC_ACCOUNT" "$KEYCHAIN" > /dev/null 2>&1 || true
  log "전용 사용자·그룹 $SVC_USER 삭제"
  dscl . -delete "/Users/$SVC_USER" 2> /dev/null || true
  dscl . -delete "/Groups/$SVC_USER" 2> /dev/null || true
  echo
  echo "AWS 의 액세스 키는 남아 있다. 진윤겸이(관리자 프로필로) 비활성화한다:"
  echo "    aws iam list-access-keys --user-name $IAM_USER --profile $AWS_PROFILE_NAME"
  echo "    aws iam update-access-key --user-name $IAM_USER --access-key-id <AKIA…> --status Inactive --profile $AWS_PROFILE_NAME"
fi
log "끝"
