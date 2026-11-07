#!/bin/bash
# 자체 실행기 설치 — 몇 번 돌려도 같은 상태가 된다(멱등). 런북: docs/runbooks/ci-cd.md §11-3
#
#   bash ops/runner/setup.sh
#
# 1) 도구 확인(colima · docker · gh — 없으면 brew 로 설치) · gh 로그인과 리포 admin 권한 확인
# 2) colima 프로필 atmark-runner 시작(마운트 없음) · VM 방화벽
# 3) 실행기 이미지 빌드(actions/runner 최신판)
# 4) 스크립트를 ~/.atmark-runner 로 복사 · LaunchAgent 설치·재시작 → 슬롯마다 실행기 컨테이너
# 5) GitHub 에 실행기가 online 으로 보이는지 · 격리 확인(verify-isolation.sh)
#
# VM 크기·슬롯은 환경 변수로 바꾼다(ATMARK_RUNNER_CPUS · _MEMORY · _DISK · _SLOTS) — ~/.atmark-runner/config.env 에 남아 launchd 도 같은 값을 쓴다.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=lib.sh
. "$HERE/lib.sh"

[ "$(uname -s)/$(uname -m)" = "Darwin/arm64" ] || { echo "Apple Silicon macOS 에서만 쓴다(이미지가 linux-arm64)"; exit 1; }

log "1/5 도구"
command -v brew > /dev/null || { echo "Homebrew 가 필요하다: https://brew.sh"; exit 1; }
for f in colima docker gh; do
  command -v "$f" > /dev/null || { log "brew install $f"; brew install "$f"; }
done
gh auth status > /dev/null 2>&1 || { echo "gh 로그인이 필요하다: gh auth login (리포 admin 권한이 있는 계정)"; exit 1; }
[ "$(gh api "repos/$ATMARK_REPO" --jq .permissions.admin)" = "true" ] \
  || { echo "$ATMARK_REPO 의 admin 권한이 필요하다(실행기 등록 토큰)"; exit 1; }

log "2/5 colima $PROFILE (cpu $VM_CPUS · mem ${VM_MEMORY}GiB · disk ${VM_DISK}GiB · 마운트 없음)"
mkdir -p "$STATE_DIR" "$LOG_DIR"
cat > "$STATE_DIR/config.env" << EOF
ATMARK_RUNNER_CPUS=$VM_CPUS
ATMARK_RUNNER_MEMORY=$VM_MEMORY
ATMARK_RUNNER_DISK=$VM_DISK
ATMARK_RUNNER_SLOTS=$SLOTS
EOF
# 이미 떠 있으면 설정만 맞춘다(colima start 는 떠 있는 프로필에 아무것도 하지 않으므로, 크기를 바꿨다면 멈췄다 다시 켠다).
if vm_running; then
  cur="$(colima list -j 2> /dev/null | grep "\"name\":\"$PROFILE\"" || true)"
  if ! printf '%s' "$cur" | grep -q "\"cpus\":$VM_CPUS," || ! printf '%s' "$cur" | grep -q "\"memory\":$((VM_MEMORY * 1073741824)),"; then
    log "VM 크기가 달라 다시 시작한다"
    colima stop "$PROFILE"
  fi
fi
vm_running || vm_start
docker_ok || { echo "docker($DOCKER_HOST)에 닿지 않는다"; exit 1; }
vm_firewall

log "3/5 이미지 $IMAGE"
runner_version="$(gh api repos/actions/runner/releases/latest --jq .tag_name)"
runner_version="${runner_version#v}"
docker build --build-arg "RUNNER_VERSION=$runner_version" -t "$IMAGE" "$HERE"
docker image prune -f > /dev/null

log "4/5 LaunchAgent $LAUNCH_LABEL"
install -m 0644 "$HERE/lib.sh" "$STATE_DIR/lib.sh"
install -m 0755 "$HERE/supervise.sh" "$STATE_DIR/supervise.sh"
install -m 0755 "$HERE/teardown.sh" "$STATE_DIR/teardown.sh"
install -m 0755 "$HERE/verify-isolation.sh" "$STATE_DIR/verify-isolation.sh"
mkdir -p "$(dirname "$PLIST")"
sed "s|__HOME__|$HOME|g" "$HERE/ai.atmark.runner.plist.template" > "$PLIST.tmp"
plutil -lint "$PLIST.tmp" > /dev/null
mv -f "$PLIST.tmp" "$PLIST"
domain="gui/$(id -u)"
launchctl bootout "$domain/$LAUNCH_LABEL" 2> /dev/null || true
# bootout 은 비동기다 — 감독이 정리(컨테이너 · 오프라인 등록)를 마칠 때까지 기다린다.
for _ in $(seq 1 30); do launchctl print "$domain/$LAUNCH_LABEL" > /dev/null 2>&1 || break; sleep 2; done
launchctl bootstrap "$domain" "$PLIST"
launchctl enable "$domain/$LAUNCH_LABEL"

log "5/5 확인"
want="$SLOTS"
for _ in $(seq 1 45); do
  online="$(gh api "repos/$ATMARK_REPO/actions/runners?per_page=100" \
    --jq "[.runners[] | select(.name | startswith(\"$NAME_PREFIX-\")) | select(.status == \"online\")] | length")"
  [ "$online" -ge "$want" ] && break
  sleep 4
done
gh api "repos/$ATMARK_REPO/actions/runners?per_page=100" \
  --jq ".runners[] | select(.name | startswith(\"$NAME_PREFIX-\")) | \"  \(.name)  \(.status)  [\([.labels[].name] | join(\",\"))]\""
[ "$online" -ge "$want" ] || { echo "실행기 $want 개가 online 이 되지 않았다 — $LOG_DIR/*.log 를 본다"; exit 1; }
bash "$HERE/verify-isolation.sh"
log "끝 — 로그: $LOG_DIR · 멈추기/옮기기: bash ops/runner/teardown.sh"
