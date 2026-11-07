#!/bin/bash
# 격리 확인 — 실행기와 **같은 인자로** 일회용 컨테이너를 띄워 Mac 의 파일·localhost·LAN 에 닿지 않는지 본다. 런북: docs/runbooks/ci-cd.md §11-2
# 하나라도 어긋나면 종료 코드 1. setup.sh 가 마지막에 부르고, 손으로도 돌린다: bash ops/runner/verify-isolation.sh
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=lib.sh
. "$HERE/lib.sh"

fail=0
ok() { echo "  ok   $*"; }
bad() { echo "  FAIL $*"; fail=1; }

echo "[VM] colima $PROFILE"
mounts="$(colima ssh -p "$PROFILE" -- sh -c 'mount | grep -Ei " type (virtiofs|9p|fuse\.sshfs|sshfs) " || true')"
[ -z "$mounts" ] && ok "Mac 디렉터리 마운트 0(virtiofs·9p·sshfs)" || bad "마운트가 있다: $mounts"
colima ssh -p "$PROFILE" -- test -e /Users 2> /dev/null && bad "VM 에 /Users 가 보인다" || ok "VM 에 /Users 없음"
colima ssh -p "$PROFILE" -- test -e "$HOME" 2> /dev/null && bad "VM 에 $HOME 가 보인다" || ok "VM 에 $HOME 없음"

# Mac 이 듣고 있는 포트(localhost 포함)를 모아 컨테이너에서 192.168.5.2(=Mac localhost)와 LAN 주소로 두드린다.
ports="$(lsof -nP -iTCP -sTCP:LISTEN 2> /dev/null | awk 'NR>1{n=split($9,a,":"); print a[n]}' | sort -un | head -20 | tr '\n' ' ')"
lan="$(ipconfig getifaddr en0 2> /dev/null || true)"
echo "[컨테이너] $IMAGE · 네트워크 $NETWORK · Mac 포트: ${ports:-없음} · LAN: ${lan:-없음}"

docker run "${RUNNER_RUN_ARGS[@]}" --entrypoint /bin/bash "$IMAGE" -c '
  ports="$1"; lan="$2"; fail=0
  ok() { echo "  ok   $*"; }; bad() { echo "  FAIL $*"; fail=1; }
  [ "$(id -u)" = 1001 ] && ok "uid 1001(root 아님)" || bad "uid $(id -u)"
  [ -e /Users ] && bad "/Users 가 보인다" || ok "/Users 없음"
  [ -S /var/run/docker.sock ] && bad "docker.sock 이 있다" || ok "docker.sock 없음"
  ls -A "$HOME/.aws" "$HOME/.ssh" > /dev/null 2>&1 && bad "~/.aws 또는 ~/.ssh 가 있다" || ok "~/.aws · ~/.ssh 없음"
  grep -q "^CapEff:\s*0000000000000000" /proc/self/status && ok "유효 capability 0" || bad "capability: $(grep CapEff /proc/self/status)"
  sudo -n true 2> /dev/null && bad "sudo 가 된다" || ok "sudo 없음"
  for host in 192.168.5.2 192.168.5.1 $lan; do
    for p in $ports 22; do
      if timeout 3 bash -c "exec 3<>/dev/tcp/$host/$p" 2> /dev/null; then bad "$host:$p 에 붙었다"; fi
    done
  done
  [ "$fail" = 0 ] && ok "192.168.5.2(Mac localhost) · 192.168.5.1(VM) · LAN ${lan:-–} 의 포트 [$ports 22] 전부 거절"
  timeout 10 bash -c "exec 3<>/dev/tcp/api.github.com/443" 2> /dev/null && ok "인터넷(api.github.com:443) 됨" || bad "인터넷이 안 된다"
  exit "$fail"
' _ "$ports" "$lan" || fail=1

[ "$fail" = 0 ] && echo "격리 확인: 통과" || echo "격리 확인: 실패"
exit "$fail"
