#!/usr/bin/env bash
# scripts/admin/secrets-to-ssm.sh — Secrets Manager 비밀 20 개의 값을 SSM Parameter Store SecureString(standard)으로 **복사**한다.
# (2026-10-12 진윤겸 결정 "안전한 부분만 이전" · 배포 런북 docs/runbooks/deploy.md §49) — **진윤겸이 직접 실행한다.**
#
#   bash scripts/admin/secrets-to-ssm.sh --dry-run   # 이름만(옛 이름 → 새 이름). AWS 를 부르지 않는다.
#   bash scripts/admin/secrets-to-ssm.sh             # 복사(Secrets Manager → SSM). 항목마다 이름과 OK / SKIP(이미 같은 값·같은 키) / FAIL 만 찍는다.
#   bash scripts/admin/secrets-to-ssm.sh --reverse   # 되돌리기용 역복사(SSM → **이미 있는** Secrets Manager 비밀). 런북 §49 ⑤ 전까지만 쓸모가 있다.
#
# 규칙:
#   - 값은 **화면·파일·셸 기록에 남지 않는다.** 읽은 값은 파이프로 바로 쓰는 쪽(`--value` / `--secret-string file:///dev/stdin`)에 들어간다.
#     비교는 SHA-256 으로만 한다(해시도 찍지 않는다). xtrace 는 끈다(`set +x`). AWS CLI 기록(`cli_history`)이 켜져 있으면 **실행을 거부한다**
#     (그 기록은 요청 본문 — 값 — 을 로컬 DB 에 남긴다).
#   - **재생성하지 않는다** — 값을 그대로 옮긴다. DB 롤 비밀번호가 바뀌지 않아야 전환 중 연결이 끊기지 않는다.
#   - 멱등: 대상에 이미 같은 값(+ SSM 이면 같은 키)이 있으면 SKIP, 다르거나 없으면 덮어쓴다(`--overwrite`).
#   - 새 이름 = `/` + 옛 이름(`atmark/db/app` → `/atmark/db/app`). KMS 키 = 고객 관리형 `alias/atmark-ssm-secrets`(AtmarkSecretsKey 스택 —
#     **먼저 손 배포**). 키가 없으면 아무것도 쓰지 않고 멈춘다. AWS 관리형 `alias/aws/ssm` 은 쓰지 않는다(계정의 모든 주체가 SSM 경유로 푼다).
#   - 값이 4096 바이트를 넘으면(standard 상한) 그 항목은 FAIL.
#   - 값은 항목마다 원본을 세 번 읽는다(크기 · 해시 · 쓰기). 변수·임시 파일에 값을 두지 않으려는 선택이다 — 그 사이 원본이 바뀌면 쓴 뒤 다시 읽은
#     해시가 원본 해시와 달라 FAIL 로 드러난다(조용히 틀린 값이 남지 않는다).
#   - 남기는 넷(atmark/db/master · atmark/webhook-secret-keys · atmark/dlp-keys · atmark/agent-keypairs/*)은 목록에 없다.
#   - 이 스크립트는 아무것도 지우지 않는다. 옛 비밀 삭제는 다음 PR(런북 §49 ⑤).
#
# 이름 목록은 `src/runtime/ssm-secret-names.ts` `SSM_SECRET_NAMES` 와 같아야 한다(test/unit/admin/secrets-to-ssm.test.ts 가 대조).

set +x
set -euo pipefail
export AWS_PAGER=""

PROFILE="${ATMARK_AWS_PROFILE:-atmark}"
REGION="ap-northeast-2"
EXPECTED_ACCOUNT="123456789012"
KEY_ALIAS="alias/atmark-ssm-secrets"
MAX_BYTES=4096

SECRET_NAMES=(
  atmark/db/owner
  atmark/db/app
  atmark/db/admin
  atmark/db/login-mailer
  atmark/db/passport-signer
  atmark/db/tlog
  atmark/db/tlog-anchor
  atmark/db/billing
  atmark/db/billing-operator
  atmark/db/ops
  atmark/db/domain-tick
  atmark/db/ai-watch
  atmark/approval-link-keys
  atmark/owner-login-keys
  atmark/ops-keys
  atmark/ops-login-keys
  atmark/contact-forward-to
  atmark/billing/paddle/admin-api-key
  atmark/billing/paddle/sync-api-key
  atmark/billing/paddle/webhook-secret
)

usage() {
  echo "사용법: bash scripts/admin/secrets-to-ssm.sh [--dry-run | --reverse]" >&2
}

MODE=copy
case "${1:-}" in
  "") ;;
  --dry-run) MODE=dry-run ;;
  --reverse) MODE=reverse ;;
  -h | --help) usage; exit 0 ;;
  *) usage; exit 2 ;;
esac
if [[ $# -gt 1 ]]; then usage; exit 2; fi

if [[ "$MODE" == "dry-run" ]]; then
  echo "dry-run — ${#SECRET_NAMES[@]} 개 (Secrets Manager → SSM SecureString · 키 ${KEY_ALIAS}, 프로필 ${PROFILE} · ${REGION})"
  for name in "${SECRET_NAMES[@]}"; do
    echo "  ${name} -> /${name}"
  done
  exit 0
fi

aws_() {
  aws --profile "$PROFILE" --region "$REGION" "$@"
}

# AWS CLI 기록이 켜져 있으면(`~/.aws/cli/history`) 요청 본문 — 값 — 이 로컬에 남는다. 거부한다.
history_setting="$(aws configure get cli_history --profile "$PROFILE" 2>/dev/null || true)"
if [[ "$(printf '%s' "$history_setting" | tr '[:upper:]' '[:lower:]')" == "enabled" ]]; then
  echo "AWS CLI 기록(cli_history)이 켜져 있다(프로필 ${PROFILE}) — 값이 ~/.aws/cli/history 에 남는다. 'aws configure set cli_history disabled --profile ${PROFILE}' 뒤에 다시. 멈춘다." >&2
  exit 1
fi

account="$(aws_ sts get-caller-identity --query Account --output text)"
if [[ "$account" != "$EXPECTED_ACCOUNT" ]]; then
  echo "계정이 ${EXPECTED_ACCOUNT} 이 아니다(${account}) — 멈춘다." >&2
  exit 1
fi

# `--output text` 가 붙이는 끝 줄바꿈 하나만 뗀다(값 자체는 바꾸지 않는다).
strip_last_newline() {
  awk 'NR > 1 { print prev } { prev = $0 } END { if (NR > 0) printf "%s", prev }'
}

sha256() {
  if command -v shasum >/dev/null 2>&1; then shasum -a 256 | cut -d' ' -f1; else sha256sum | cut -d' ' -f1; fi
}

# 옛 비밀 값을 stdout 으로 — 파이프로만 쓴다.
secret_value() {
  aws_ secretsmanager get-secret-value --secret-id "$1" --query SecretString --output text | strip_last_newline
}

# SSM 값을 stdout 으로(같은 줄바꿈 처리). 없으면 실패(호출자가 처리).
parameter_value() {
  aws_ ssm get-parameter --name "$1" --with-decryption --query Parameter.Value --output text 2>/dev/null | strip_last_newline
}

ok=0
skipped=0
failed=0

if [[ "$MODE" == "reverse" ]]; then
  # ── 되돌리기: SSM → 이미 있는 Secrets Manager 비밀(새로 만들지 않는다) ──────────────────────
  for name in "${SECRET_NAMES[@]}"; do
    param="/${name}"
    if ! aws_ secretsmanager describe-secret --secret-id "$name" --query Name --output text >/dev/null 2>&1; then
      echo "FAIL ${param} -> ${name} (Secrets Manager 비밀이 없다 — 만들지 않는다)"
      failed=$((failed + 1))
      continue
    fi
    if ! size="$(parameter_value "$param" | wc -c | tr -d ' ')" || [[ "$size" -eq 0 ]]; then
      echo "FAIL ${param} -> ${name} (SSM 에서 읽지 못함)"
      failed=$((failed + 1))
      continue
    fi
    source_hash="$(parameter_value "$param" | sha256)"
    current_hash="$(secret_value "$name" 2>/dev/null | sha256 || true)"
    if [[ "$current_hash" == "$source_hash" ]]; then
      echo "SKIP ${param} -> ${name} (이미 같은 값)"
      skipped=$((skipped + 1))
      continue
    fi
    if parameter_value "$param" | aws_ secretsmanager put-secret-value --secret-id "$name" --secret-string file:///dev/stdin >/dev/null; then
      written_hash="$(secret_value "$name" | sha256 || true)"
      if [[ "$written_hash" == "$source_hash" ]]; then
        echo "OK   ${param} -> ${name}"
        ok=$((ok + 1))
      else
        echo "FAIL ${param} -> ${name} (쓴 뒤 다시 읽은 값이 다르다)"
        failed=$((failed + 1))
      fi
    else
      echo "FAIL ${param} -> ${name} (put-secret-value 실패)"
      failed=$((failed + 1))
    fi
  done
  echo "합계(역복사): OK ${ok} · SKIP ${skipped} · FAIL ${failed} (전체 ${#SECRET_NAMES[@]})"
  if [[ "$failed" -gt 0 ]]; then exit 1; fi
  exit 0
fi

# ── 복사: Secrets Manager → SSM SecureString(고객 관리형 키) ─────────────────────────────
if ! key_ids="$(aws_ kms describe-key --key-id "$KEY_ALIAS" --query 'KeyMetadata.[KeyId,Arn]' --output text 2>/dev/null)"; then
  echo "KMS 키 ${KEY_ALIAS} 가 없다 — AtmarkSecretsKey 스택을 먼저 손 배포한다(런북 §49 ①). 아무것도 쓰지 않았다." >&2
  exit 1
fi
read -r key_id key_arn <<<"$key_ids"

for name in "${SECRET_NAMES[@]}"; do
  param="/${name}"
  if ! size="$(secret_value "$name" | wc -c | tr -d ' ')"; then
    echo "FAIL ${name} -> ${param} (Secrets Manager 에서 읽지 못함)"
    failed=$((failed + 1))
    continue
  fi
  if [[ "$size" -eq 0 ]]; then
    echo "FAIL ${name} -> ${param} (값이 비었다)"
    failed=$((failed + 1))
    continue
  fi
  if [[ "$size" -gt "$MAX_BYTES" ]]; then
    echo "FAIL ${name} -> ${param} (${size} 바이트 > ${MAX_BYTES} — standard 상한)"
    failed=$((failed + 1))
    continue
  fi
  source_hash="$(secret_value "$name" | sha256)"
  current_hash=""
  current_key="$(aws_ ssm describe-parameters --parameter-filters "Key=Name,Values=${param}" --query 'Parameters[0].[Type,KeyId]' --output text 2>/dev/null || true)"
  read -r current_type current_key_id <<<"${current_key:-None None}"
  if [[ "$current_type" == "SecureString" ]] && [[ "$current_key_id" == "$KEY_ALIAS" || "$current_key_id" == "$key_id" || "$current_key_id" == "$key_arn" ]]; then
    current_hash="$(parameter_value "$param" | sha256 || true)"
  fi
  if [[ -n "$current_hash" && "$current_hash" == "$source_hash" ]]; then
    echo "SKIP ${name} -> ${param} (이미 같은 값 · 같은 키)"
    skipped=$((skipped + 1))
    continue
  fi
  if secret_value "$name" | aws_ ssm put-parameter \
    --name "$param" \
    --type SecureString \
    --key-id "$KEY_ALIAS" \
    --tier Standard \
    --overwrite \
    --description "Atmark secret migrated from Secrets Manager ${name} (deploy runbook 49)" \
    --value file:///dev/stdin >/dev/null; then
    written_hash="$(parameter_value "$param" | sha256 || true)"
    if [[ "$written_hash" == "$source_hash" ]]; then
      echo "OK   ${name} -> ${param}"
      ok=$((ok + 1))
    else
      echo "FAIL ${name} -> ${param} (쓴 뒤 다시 읽은 값이 다르다)"
      failed=$((failed + 1))
    fi
  else
    echo "FAIL ${name} -> ${param} (put-parameter 실패)"
    failed=$((failed + 1))
  fi
done

echo "합계: OK ${ok} · SKIP ${skipped} · FAIL ${failed} (전체 ${#SECRET_NAMES[@]})"
if [[ "$failed" -gt 0 ]]; then exit 1; fi
