# 자체 실행기 공용 설정·함수 — setup.sh · supervise.sh · teardown.sh · verify-isolation.sh 가 source 한다. 런북: docs/runbooks/ci-cd.md §11
# macOS 기본 bash(3.2)에서 돈다 — 연관 배열·mapfile 을 쓰지 않는다. **토큰을 출력하지 않는다.**

export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

# setup.sh 가 고른 값(VM 크기·슬롯)을 launchd 아래에서도 쓰도록 남긴 파일. 없으면 아래 기본값.
# shellcheck source=/dev/null
[ -f "$HOME/.atmark-runner/config.env" ] && . "$HOME/.atmark-runner/config.env"

ATMARK_REPO="${ATMARK_REPO:-Younkyum/Atmark}"
PROFILE="${ATMARK_RUNNER_PROFILE:-atmark-runner}"
# VM 크기 — 이 Mac(11코어 · 18GB · 디스크 여유 62GB, 2026-10-01) 기준. 새 Mac 에서는 환경 변수로 바꾼다.
VM_CPUS="${ATMARK_RUNNER_CPUS:-8}"
VM_MEMORY="${ATMARK_RUNNER_MEMORY:-10}"
VM_DISK="${ATMARK_RUNNER_DISK:-40}"
# 동시에 job 을 받는 컨테이너 수. 2 = CI 와 arch-mutation(또는 배포)이 서로를 기다리지 않는다.
SLOTS="${ATMARK_RUNNER_SLOTS:-2}"

IMAGE="atmark-runner:latest"
NETWORK="atmark-runner"
BRIDGE="br-atmark"
LABELS="atmark"   # config.sh 가 self-hosted · Linux · ARM64 를 기본으로 붙인다 → runs-on [self-hosted, linux, arm64, atmark]
LAUNCH_LABEL="ai.atmark.runner"
STATE_DIR="$HOME/.atmark-runner"            # 설치된 스크립트(~/Documents 밖 — launchd 가 TCC 동의 없이 읽는다)
LOG_DIR="$HOME/Library/Logs/atmark-runner"
PLIST="$HOME/Library/LaunchAgents/$LAUNCH_LABEL.plist"

# 사용자의 docker 컨텍스트를 건드리지 않고 이 프로필의 소켓만 쓴다(colima 는 --activate=false 로 띄운다).
export DOCKER_HOST="unix://$HOME/.colima/$PROFILE/docker.sock"

host_slug() {
  scutil --get LocalHostName 2>/dev/null | tr '[:upper:]' '[:lower:]' | tr -c 'a-z0-9-\n' '-' | cut -c1-24
}
NAME_PREFIX="atmark-$(host_slug)"

log() { printf '%s %s\n' "$(date '+%Y-%m-%dT%H:%M:%S%z')" "$*"; }

vm_running() { colima status -p "$PROFILE" > /dev/null 2>&1; }
docker_ok() { docker info > /dev/null 2>&1; }

# 격리의 첫 겹: 집 디렉터리를 포함해 **아무것도 마운트하지 않는다**(--mount none). 컨텍스트를 바꾸지 않고(--activate=false),
# ~/.ssh/config 를 고치지 않고(--ssh-config=false), 컨테이너 포트를 Mac localhost 로 넘기지 않는다(--port-forwarder none).
vm_start() {
  colima start "$PROFILE" \
    --cpus "$VM_CPUS" --memory "$VM_MEMORY" --disk "$VM_DISK" \
    --vm-type vz --runtime docker --mount-type virtiofs --mount none \
    --activate=false --ssh-config=false --port-forwarder none --binfmt=false
}

# 격리의 둘째 겹: VM 안 방화벽. 컨테이너(브리지 br-atmark)에서 나가는 연결 중 사설·링크로컬·CGNAT 대역을 막는다.
# 192.168.5.2 는 lima 가 **Mac 의 localhost** 로 넘기는 게이트웨이라(로컬 Postgres · 데몬들이 열려 있다) 이것이 없으면 job 이 Mac localhost 에 붙는다.
# INPUT 도 막는다(VM 의 sshd 등). 응답 패킷은 -i br-atmark 가 아니므로 영향이 없다. VM 이 다시 뜨면 규칙이 사라지므로 supervise.sh 가 매번 건다.
vm_firewall() {
  docker network inspect "$NETWORK" > /dev/null 2>&1 \
    || docker network create --driver bridge -o "com.docker.network.bridge.name=$BRIDGE" "$NETWORK" > /dev/null
  colima ssh -p "$PROFILE" -- sudo sh -s "$BRIDGE" << 'SH'
set -e
br="$1"
add() { iptables -C "$@" 2> /dev/null || iptables -I "$@"; }
for net in 10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 169.254.0.0/16 100.64.0.0/10; do
  add DOCKER-USER -i "$br" -d "$net" -j REJECT
done
add INPUT -i "$br" -j REJECT
if command -v ip6tables > /dev/null 2>&1; then
  ip6tables -C FORWARD -i "$br" -j REJECT 2> /dev/null || ip6tables -I FORWARD -i "$br" -j REJECT || true
  ip6tables -C INPUT -i "$br" -j REJECT 2> /dev/null || ip6tables -I INPUT -i "$br" -j REJECT || true
fi
SH
}

# 컨테이너 실행 인자 — 권한 0(cap-drop ALL · no-new-privileges · uid 1001), docker.sock 없음, 마운트 없음.
RUNNER_RUN_ARGS=(
  --rm --init
  --network "$NETWORK"
  --cap-drop ALL --security-opt no-new-privileges
  --shm-size 1g
  --pids-limit 4096
)

# 등록 토큰(1시간 유효). 변수로만 받고 **출력하지 않는다**.
reg_token() { gh api -X POST "repos/$ATMARK_REPO/actions/runners/registration-token" --jq .token; }

# 이 Mac 이 등록한 실행기 id(이름 접두사로 고른다). 인자 offline 이면 오프라인인 것만.
runner_ids() {
  local filter=".runners[] | select(.name | startswith(\"$NAME_PREFIX-\"))"
  [ "${1:-}" = offline ] && filter="$filter | select(.status == \"offline\")"
  gh api --paginate "repos/$ATMARK_REPO/actions/runners?per_page=100" --jq "$filter | .id"
}

delete_runners() {
  local id
  for id in "$@"; do
    gh api -X DELETE "repos/$ATMARK_REPO/actions/runners/$id" > /dev/null 2>&1 && log "등록 삭제: runner $id"
  done
}
