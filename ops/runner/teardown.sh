#!/bin/bash
# 자체 실행기 걷어 내기 — 기계를 옮길 때 옛 Mac 에서 돌린다. 런북: docs/runbooks/ci-cd.md §11-4
#
#   bash ops/runner/teardown.sh                 # LaunchAgent 내림 · 컨테이너 정리 · 이 Mac 의 등록 삭제 · VM 멈춤
#   bash ops/runner/teardown.sh --purge         # + colima 프로필 삭제(VM 디스크·이미지까지) · ~/.atmark-runner 삭제
#   bash ops/runner/teardown.sh --all-hosts     # + 다른 Mac 이 남긴 등록까지 삭제(라벨 atmark 인 자체 실행기 전부 — 옛 Mac 이 없어졌을 때)
#
# 몇 번 돌려도 된다. `default` colima 프로필과 사용자 docker 컨텍스트는 건드리지 않는다.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=lib.sh
. "$HERE/lib.sh"

purge=0
all_hosts=0
for a in "$@"; do
  case "$a" in
    --purge) purge=1 ;;
    --all-hosts) all_hosts=1 ;;
    *) echo "모르는 인자: $a"; exit 64 ;;
  esac
done

domain="gui/$(id -u)"
log "LaunchAgent $LAUNCH_LABEL 내림"
launchctl bootout "$domain/$LAUNCH_LABEL" 2> /dev/null || true
for _ in $(seq 1 30); do launchctl print "$domain/$LAUNCH_LABEL" > /dev/null 2>&1 || break; sleep 2; done
rm -f "$PLIST"

if docker_ok; then
  ids="$(docker ps -aq --filter "name=^atmark-runner-s")"
  [ -n "$ids" ] && { log "컨테이너 정리"; docker rm -f $ids > /dev/null; }
fi

log "이 Mac($NAME_PREFIX-*)의 등록 삭제"
# shellcheck disable=SC2046
delete_runners $(runner_ids)
if [ "$all_hosts" = 1 ]; then
  log "라벨 atmark 인 자체 실행기 등록 전부 삭제"
  # shellcheck disable=SC2046
  delete_runners $(gh api --paginate "repos/$ATMARK_REPO/actions/runners?per_page=100" \
    --jq '.runners[] | select([.labels[].name] | index("atmark")) | .id')
fi

if [ "$purge" = 1 ]; then
  log "colima $PROFILE 삭제 · $STATE_DIR 삭제"
  colima delete -f "$PROFILE" 2> /dev/null || true
  rm -rf "$STATE_DIR"
else
  log "colima $PROFILE 멈춤"
  colima stop "$PROFILE" 2> /dev/null || true
fi

left="$(gh api "repos/$ATMARK_REPO/actions/runners?per_page=100" --jq '[.runners[] | select([.labels[].name] | index("atmark"))] | map(.name) | join(" ")')"
log "남은 atmark 실행기 등록: ${left:-없음}"
