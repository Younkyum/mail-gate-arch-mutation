#!/bin/bash
# launchd(LaunchAgent ai.atmark.runner)가 로그인 때 띄우는 감독 루프. 런북: docs/runbooks/ci-cd.md §11
#
# - colima 프로필이 꺼져 있으면 켜고, VM 방화벽을 건다(VM 이 다시 뜨면 규칙이 사라지므로 매번).
# - 슬롯마다: 새 등록 토큰 → 새 컨테이너(--ephemeral, job 하나) → 컨테이너가 끝나면(지워진다) 다시 새 컨테이너.
# - 끝낼 때(launchctl bootout · TERM): 컨테이너를 지우고 이 Mac 의 오프라인 등록을 GitHub 에서 지운다.
# 토큰은 셸 변수로만 들고 stdin 으로 컨테이너에 넘긴다 — 로그·인자·환경에 남지 않는다.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=lib.sh
. "$HERE/lib.sh"

mkdir -p "$LOG_DIR"
pids=()

slot_container() { echo "atmark-runner-s$1"; }

cleanup() {
  log "감독 종료 — 컨테이너 정리 · 오프라인 등록 삭제"
  local p s
  for p in "${pids[@]+"${pids[@]}"}"; do kill "$p" 2> /dev/null; done
  s=1
  while [ "$s" -le "$SLOTS" ]; do docker rm -f "$(slot_container "$s")" > /dev/null 2>&1; s=$((s + 1)); done
  sleep 3
  # shellcheck disable=SC2046
  delete_runners $(runner_ids offline 2> /dev/null)
  exit 0
}
trap cleanup TERM INT

ensure_vm() {
  if ! docker_ok; then
    vm_running || { log "colima $PROFILE 시작"; vm_start >> "$LOG_DIR/colima.log" 2>&1 || return 1; }
    docker_ok || return 1
  fi
  vm_firewall || { log "VM 방화벽을 걸지 못했다 — 실행기를 띄우지 않는다"; return 1; }
  docker image inspect "$IMAGE" > /dev/null 2>&1 || { log "이미지 $IMAGE 없음 — setup.sh 를 다시 돌린다"; return 1; }
}

slot_loop() {
  local slot="$1" backoff=10 name token rc
  local cname
  cname="$(slot_container "$slot")"
  while :; do
    if ! ensure_vm; then
      sleep "$backoff"; backoff=$((backoff < 300 ? backoff * 2 : 300)); continue
    fi
    docker rm -f "$cname" > /dev/null 2>&1
    if ! token="$(reg_token 2> /dev/null)" || [ -z "$token" ]; then
      log "s$slot: 등록 토큰을 받지 못했다(네트워크·gh 인증) — ${backoff}초 뒤 다시"
      sleep "$backoff"; backoff=$((backoff < 300 ? backoff * 2 : 300)); continue
    fi
    backoff=10
    name="$NAME_PREFIX-s$slot-$(date +%Y%m%d%H%M%S)"
    log "s$slot: $name 시작"
    printf '%s\n' "$token" | docker run -i --name "$cname" "${RUNNER_RUN_ARGS[@]}" \
      -e RUNNER_URL="https://github.com/$ATMARK_REPO" -e RUNNER_NAME="$name" -e RUNNER_LABELS="$LABELS" \
      "$IMAGE" >> "$LOG_DIR/runner-s$slot.log" 2>&1
    rc=$?
    token=""
    log "s$slot: $name 끝(종료 코드 $rc)"
    # 등록 실패 등으로 바로 끝나면 GitHub 를 두드리지 않게 잠깐 쉰다.
    sleep 5
  done
}

# 로그가 끝없이 자라지 않게 — 10MB 넘으면 하나만 남기고 돌린다.
for f in "$LOG_DIR"/*.log; do
  [ -f "$f" ] && [ "$(stat -f%z "$f")" -gt 10485760 ] && mv -f "$f" "$f.1"
done

log "감독 시작: 프로필 $PROFILE · 슬롯 $SLOTS · 접두사 $NAME_PREFIX"
# 지난번에 깨끗이 끝나지 못한 등록(오프라인)을 지운다.
# shellcheck disable=SC2046
delete_runners $(runner_ids offline 2> /dev/null)

s=1
while [ "$s" -le "$SLOTS" ]; do
  slot_loop "$s" &
  pids+=("$!")
  sleep 2
  s=$((s + 1))
done
wait
