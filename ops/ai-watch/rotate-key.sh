#!/bin/bash
# 액세스 키 회전(90일 — 설계 §1.2). 런북: docs/runbooks/ai-watch.md §4. **진윤겸이 직접**(관리자 AWS 프로필 + sudo).
#
#   bash ops/ai-watch/rotate-key.sh            # 새 키 → 키체인 → 워커 재시작 → 하트비트 확인 → 옛 키 비활성
#
# 옛 키는 **지우지 않는다** — 7일 뒤 마지막 줄의 delete 명령을 진윤겸이 돌린다(문제가 생기면 Active 로 되살릴 수 있게).
# IAM 사용자당 키는 둘까지라, 이미 둘이면 멈춘다(비활성 키부터 정리).
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=lib.sh
. "$HERE/lib.sh"
[ "$(id -u)" != 0 ] || { echo "sudo 없이 돌린다(aws 는 진윤겸의 프로필을 쓴다 — 안에서 필요한 곳만 sudo 를 묻는다)"; exit 1; }
command -v aws > /dev/null || { echo "aws CLI 가 필요하다"; exit 1; }

aws_iam() { aws iam "$@" --profile "$AWS_PROFILE_NAME" --output text; }

keys="$(aws_iam list-access-keys --user-name "$IAM_USER" --query 'AccessKeyMetadata[].[AccessKeyId,Status,CreateDate]')"
count="$(printf '%s\n' "$keys" | grep -c AKIA || true)"
[ "$count" -le 1 ] || { echo "키가 이미 $count 개다 — 비활성 키를 먼저 지운다:"; printf '  %s\n' "$keys"; exit 1; }
old="$(printf '%s\n' "$keys" | awk '/AKIA/{print $1; exit}')"
log "옛 키: ${old:+${old:0:8}…${old: -4}}"

started="$(date -u +%Y-%m-%dT%H:%M:%S)"
log "1/4 새 키 발급 → 키체인(값은 파이프로만 지나간다)"
aws iam create-access-key --user-name "$IAM_USER" --profile "$AWS_PROFILE_NAME" --output json | sudo bash "$HERE/store-key.sh"

log "2/4 워커 하트비트 확인(최대 3분) — 새 키로 결과 큐에 보냈는가"
ok=0
for _ in $(seq 1 36); do
  if sudo tail -n 50 "$LOG_DIR/worker.log" | awk -v t="$started" -F'"ts":"' 'NF>1 && substr($2,1,19) >= t && /"event":"heartbeat"/ {found=1} END {exit !found}'; then ok=1; break; fi
  sleep 5
done
if [ "$ok" != 1 ]; then
  echo "새 키로 하트비트가 보이지 않는다 — 옛 키는 그대로 Active 다. 로그: sudo tail $LOG_DIR/worker.log"
  echo "되돌리기(옛 키 값이 없으므로): 새 키를 지우고 옛 키를 다시 발급받지 않는다 — 원인(정책·키 모양)을 고친 뒤 store-key 를 다시 한다."
  exit 1
fi

if [ -n "$old" ]; then
  log "3/4 옛 키 비활성"
  aws_iam update-access-key --user-name "$IAM_USER" --access-key-id "$old" --status Inactive > /dev/null
fi
log "4/4 끝 — 7일 뒤(이상 없으면) 옛 키 삭제:"
[ -n "$old" ] && echo "    aws iam delete-access-key --user-name $IAM_USER --access-key-id $old --profile $AWS_PROFILE_NAME"
echo "    다음 회전: $(date -v+90d +%Y-%m-%d)"
