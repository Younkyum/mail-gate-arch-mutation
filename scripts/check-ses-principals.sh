#!/usr/bin/env bash
# AC-c8b — ses:SendEmail 을 실제로 행사할 수 있는 IAM 주체를 열거해 allowlist와 대조한다.
#
# 왜 정책 이름 매칭이 아니라 simulate-principal-policy 인가:
#   "AdministratorAccess 가 붙었는가"로 판정하면 인라인 정책·고객 관리형 정책·권한 경계·
#   SCP 를 전부 놓친다. IAM 정책 시뮬레이터는 그 평가를 AWS 가 직접 수행한 결과를 돌려주므로
#   "이 주체가 지금 메일을 보낼 수 있는가"라는 질문에 대한 유일하게 정직한 답이다.
#
# 계획 §5.0 Layer E / R23 / AC-c8b. ADR-0006(로그인 메일 발송 주체 분리) — 발신 주소별 probe.
# 사용: AWS_PROFILE=atmark [ATMARK_CONTACT_ROUTING=<배포한 모드>] ./scripts/check-ses-principals.sh
#   ATMARK_CONTACT_ROUTING(없으면 agent_and_notify) — 배포한 CDK 컨텍스트 `atmark:contactRouting` 과 같은 값을 준다. 없을 때의 값은
#   infra/cdk/stacks/compute-stack.ts 의 `CONTACT_ROUTING_DEFAULT`(2026-10-04 굳힘 — 운영 배포값)와 같다 — 그 상수를 바꾸면 여기도 바꾼다(테스트가 잡는다).
#   forward 면 발송 역할은 support@ 를 거부해야 하고(함수 문맥 밖), 그 밖의 모드면 보낼 수 있어야 한다(지원 에이전트의 대표 주소 — deploy §29).
#
# ADR-0014 단계 2 — **자원 기반 발송 권한(identity policy) 검사**를 더했다(아래 "[SES identity 자원 정책]"). IAM 시뮬레이터는 주체의 identity 기반
#   정책만 보므로 고객 도메인 identity 에 붙은 정책(자원 기반)으로 생긴 발송 권한은 위 열거에 나오지 않는다. 그래서 계정의 identity 를 전부 읽어
#   정책 문서를 직접 대조한다: 고객 identity 의 모든 Statement 는 Allow · Principal = 발송 역할 ARN **하나** · Action ⊆ {SendEmail, SendRawEmail} ·
#   Resource = 그 identity · Condition = `StringEquals ses:FromAddress`(그 도메인의 주소 목록)뿐이어야 하고, 플랫폼 identity(atmark.ai 와 하위)에는 정책이
#   없어야 한다. 기대값은 allowlist 의 `resourcePolicyGrants`. 발송 주체 수(mustEqual 2)는 그대로다 — 자원 정책의 Principal 이 발송 역할이므로
#   주체가 늘지 않는다(ADR-0006 2026-10 개정 절).

set -uo pipefail

PROFILE="${AWS_PROFILE:-atmark}"
ALLOWLIST="$(dirname "$0")/../docs/ops/ses-principals-allowlist.json"
ACTION="ses:SendEmail"
ACCOUNT_ID="${ATMARK_ACCOUNT_ID:-123456789012}"
CONTACT_ROUTING="${ATMARK_CONTACT_ROUTING:-agent_and_notify}"
case "$CONTACT_ROUTING" in
  forward|agent_and_forward|agent_and_notify|agent) ;;
  *) echo "ATMARK_CONTACT_ROUTING 은 forward | agent_and_forward | agent_and_notify | agent 중 하나: $CONTACT_ROUTING"; exit 2 ;;
esac
fail=0

command -v jq >/dev/null || { echo "jq 가 필요하다: brew install jq"; exit 2; }
[ -f "$ALLOWLIST" ] || { echo "allowlist 없음: $ALLOWLIST"; exit 2; }

# 발신 주소 probe. 일반 주소 하나 + 로그인 전용 주소 하나(ADR-0006) — 둘 중 하나라도 allowed 면 "발송 가능" 으로 센다.
GENERIC_PROBE="probe@atmark.ai"
LOGIN_FROM="login@atmark.ai"
# 로그인 메일 역할(fromAddressesOnly)이 **거부해야** 하는 주소들 — 일반·에이전트 모양·승인 알림·문의(US-009) 주소.
FOREIGN_PROBES=("probe@atmark.ai" "agent-probe@atmark.ai" "notify@atmark.ai" "support@atmark.ai")
# 예약 주소의 대소문자·하위 주소 변형 — **모든** 런타임 발송 역할이 거부해야 한다(2026-09-24 검증 F1).
#   IAM 의 StringEquals/StringLike 는 대소문자를 가린다 — 정확 일치 Deny 만 있으면 `LOGIN@atmark.ai` 가 비켜 간다. 발송 역할은
#   StringEqualsIgnoreCase + 정규형 밖 문자 Deny(SesDenyNonCanonicalFromAddress), login-mailer 는 소문자 정확 일치 허용만이라 암묵 거부다.
#   2026-09-24 최종 검증 M3a: 접힘 공백(FWS)·제어문자 변형 — 앞에 붙은 TAB·CRLF+TAB·VT·FF·ESC·DEL. 발송 역할은 예약 접미사
#   Deny(SesDenyReservedSuffixFromAddress — 앞 글자가 `[a-z0-9._-]` 가 아니면 거부)로 거부한다. 제어문자를 정책에 직접 적는 패턴은
#   없다 — IAM API 가 인쇄 가능 ASCII 밖을 거부한다(2026-09-24 운영 배포 실측). 예약 주소 **사이**에 낀 제어문자(`lo\tgin@`)는 IAM 이
#   막지 못해 probe 에 넣지 않는다 — 런타임 assertHeaderSafe·알람 10 의 몫(ADR-0006 M3). `$'…'` 인용이라 제어문자가 그대로 값에 들어간다.
#   DEL 은 변수로 따로 만든다 — macOS 기본 bash 3.2 는 배열 리터럴 안의 `$'\x7f'` 앞에 CTLESC(\001)를 남긴다(실측).
DEL=$'\x7f'
RESERVED_VARIANT_PROBES=(
  "LOGIN@atmark.ai" "Login@atmark.ai" "login+x@atmark.ai" "Support@atmark.ai" "SUPPORT@atmark.ai" "support+x@atmark.ai"
  $'\tlogin@atmark.ai' $'\r\n\tlogin@atmark.ai' $'\vlogin@atmark.ai' $'\flogin@atmark.ai' $'\elogin@atmark.ai' "${DEL}login@atmark.ai"
  $'\tsupport@atmark.ai' $'\vsupport@atmark.ai' $'\fsupport@atmark.ai'
  # 2026-09-30 — 환영 메일·지원 에이전트 별칭 onve@ 도 예약 주소다(ADR-0006 개정). 발송 역할은 정규형 밖 문자 Deny·예약 접미사 Deny, login-mailer 는
  #   소문자 정확 일치 허용만이라 암묵 거부.
  "ONVE@atmark.ai" "Onve@atmark.ai" "onve+x@atmark.ai" $'\tonve@atmark.ai' $'\vonve@atmark.ai' $'\fonve@atmark.ai'
  # 202609301540 — 수신 전용 abuse@·postmaster@(지원 에이전트의 별칭 — deploy §33). 발송 역할은 대소문자 무시 정확 일치 Deny(SesDenyReceiveOnlyFromAddress)·
  #   정규형 밖 문자 Deny, login-mailer 는 암묵 거부. 소문자 정확 주소 자신은 allowlist 의 deniedFromAddresses 가 본다. 앞 제어문자 변형은 IAM 이 막지
  #   않는다(예약 접미사 Deny 밖 — compute-stack `SES_RECEIVE_ONLY_FROM_ADDRESSES` 주석) — probe 에 넣지 않는다.
  "ABUSE@atmark.ai" "Abuse@atmark.ai" "abuse+x@atmark.ai" "POSTMASTER@atmark.ai" "Postmaster@atmark.ai" "postmaster+x@atmark.ai"
)

# 문맥 항목은 **JSON 으로** 넘긴다 — 단축 문법(`ContextKeyValues=…`)은 값 앞뒤 공백을 벗기고 `,` 에서 끊어, 제어문자·공백이 붙은
# probe(M3a)가 다른 값으로 바뀐 채 물어진다. jq 가 이스케이프한다.
context_entries() {
  jq -nc --arg v "$1" '[{ContextKeyName: "ses:FromAddress", ContextKeyValues: [$v], ContextKeyType: "string"}]'
}

# 출력용 — 제어문자를 `$'\t…'` 꼴로 보인다(터미널을 흐트리지 않는다). 인쇄 가능한 주소는 그대로다.
shown() { printf '%q' "$1"; }

# 주체가 해당 액션을 `from` 주소로 허용받는지 AWS 에게 직접 묻는다.
can_send_from() {
  local arn="$1" from="$2"
  local d
  # 발송 역할은 `ses:FromAddress = *@atmark.ai` 조건과 구체 리소스(도메인 identity)로 좁혀져 있다(AtmarkCompute).
  # 조건·리소스 없이 시뮬레이션하면 그 역할도 implicitDeny 로 나와 "런타임 발송 주체 0" 으로 잘못 센다.
  # 그래서 **실제 발송과 같은 문맥**으로 묻는다. 이 문맥으로도 allowed 가 아니면 그 주체는 그 주소로 못 보낸다.
  d=$(aws iam simulate-principal-policy \
        --policy-source-arn "$arn" \
        --action-names "$ACTION" \
        --resource-arns "arn:aws:ses:ap-northeast-2:${ACCOUNT_ID}:identity/atmark.ai" \
        --context-entries "$(context_entries "$from")" \
        --profile "$PROFILE" \
        --query 'EvaluationResults[0].EvalDecision' \
        --output text 2>/dev/null) || return 1
  [ "$d" = "allowed" ]
}

# 어느 probe 로든 보낼 수 있으면 발송 가능 주체다. 무조건 발송 권한을 가진 주체는 둘 다 allowed 라 탐지 범위가 좁아지지 않는다.
can_send() {
  can_send_from "$1" "$GENERIC_PROBE" || can_send_from "$1" "$LOGIN_FROM"
}

# allowlist 항목의 선택 필드(없으면 빈 문자열).
runtime_field() { jq -r --arg n "$1" --arg f "$2" '.runtimeRoles.allowed[]? | select(.name == $n) | .[$f] // empty' "$ALLOWLIST"; }

in_list() { jq -e --arg n "$2" ".${1}.allowed[]? | select(.name == \$n)" "$ALLOWLIST" >/dev/null 2>&1; }

echo "AC-c8b — ${ACTION} 을 행사할 수 있는 주체 감사 (profile: ${PROFILE}, 문의 라우팅: ${CONTACT_ROUTING})"
echo

# ── 사람 주체 ────────────────────────────────────────────────────────────────
echo "[사람 사용자]"
while read -r u; do
  [ -z "$u" ] && continue
  arn="$(aws iam get-user --user-name "$u" --profile "$PROFILE" --query 'User.Arn' --output text)"
  can_send "$arn" || { printf "  ok   %-24s 발송 불가\n" "$u"; continue; }

  mfa="$(aws iam list-mfa-devices --user-name "$u" --profile "$PROFILE" --query 'length(MFADevices)' --output text)"
  if ! in_list humanPrincipals "$u"; then
    printf "  FAIL %-24s 발송 가능하나 allowlist 에 없음\n" "$u"; fail=1
  elif [ "$mfa" -lt 1 ]; then
    printf "  FAIL %-24s allowlist 에 있으나 MFA 미등록\n" "$u"; fail=1
  else
    printf "  ok   %-24s allowlist + MFA\n" "$u"
  fi
done < <(aws iam list-users --profile "$PROFILE" --query 'Users[].UserName' --output text | tr '\t' '\n')

# ── 역할 ────────────────────────────────────────────────────────────────────
# AWS 서비스 연결 역할(/aws-service-role/)은 AWS 가 소유하므로 제외한다.
echo
echo "[역할]"
runtime_count=0
while read -r r; do
  [ -z "$r" ] && continue
  arn="$(aws iam get-role --role-name "$r" --profile "$PROFILE" --query 'Role.Arn' --output text)"
  can_send "$arn" || continue

  if in_list deploymentRoles "$r"; then
    printf "  ok   %-56s 배포 역할(allowlist)\n" "$r"
  elif in_list runtimeRoles "$r"; then
    runtime_count=$((runtime_count + 1))
    # fromAddressesOnly(배열 — 옛 fromAddressOnly 문자열도 받는다): 이 주소들로만 보낼 수 있어야 한다.
    only_list="$(jq -r --arg n "$r" '.runtimeRoles.allowed[]? | select(.name == $n) | ((.fromAddressesOnly // []) + [.fromAddressOnly // empty]) | .[]' "$ALLOWLIST")"
    only="$(printf '%s' "$only_list" | tr '\n' ' ' | sed 's/ $//; s/ / · /g')"
    # deniedFromAddress(문자열 하나) + deniedFromAddresses(배열) — 둘 다 "이 역할로는(함수 문맥 없이) 거부" 여야 한다.
    #   support@atmark.ai 는 ATMARK_CONTACT_ROUTING=forward 일 때 발송 역할 안에서도 contact-forwarder 함수의 요청(lambda:SourceFunctionArn)만
    #   허락된다 — 시뮬레이터는 그 문맥 키 없이 묻으므로 거부가 나와야 정상이다(ADR-0009). 그 밖의 모드에서는 보낼 수 있어야 한다(allowed…WhenContactRoutingAgent).
    if [ "$CONTACT_ROUTING" = "forward" ]; then
      denied="$(jq -r --arg n "$r" '.runtimeRoles.allowed[]? | select(.name == $n) | ([.deniedFromAddress // empty] + (.deniedFromAddresses // []) + (.deniedFromAddressesWhenContactRoutingForward // [])) | .[]' "$ALLOWLIST")"
      allowed="$(jq -r --arg n "$r" '.runtimeRoles.allowed[]? | select(.name == $n) | (.allowedFromAddresses // []) | .[]' "$ALLOWLIST")"
    else
      denied="$(jq -r --arg n "$r" '.runtimeRoles.allowed[]? | select(.name == $n) | ([.deniedFromAddress // empty] + (.deniedFromAddresses // [])) | .[]' "$ALLOWLIST")"
      allowed="$(jq -r --arg n "$r" '.runtimeRoles.allowed[]? | select(.name == $n) | ((.allowedFromAddresses // []) + (.allowedFromAddressesWhenContactRoutingAgent // [])) | .[]' "$ALLOWLIST")"
    fi
    role_ok=1
    if [ -n "$only_list" ]; then
      # 주소 몇 개에 묶인 역할(login-mailer): 그 주소들은 되고, 다른 주소는 **전부** 안 돼야 한다.
      while read -r o; do
        [ -z "$o" ] && continue
        can_send_from "$arn" "$o" || { printf "  FAIL %-56s %s 로 보낼 수 없다(fromAddressesOnly)\n" "$r" "$o"; role_ok=0; }
      done <<< "$only_list"
      for probe in "${FOREIGN_PROBES[@]}"; do
        if can_send_from "$arn" "$probe"; then
          printf "  FAIL %-56s %s 로 보낼 수 있다 — %s 로만 묶여야 한다\n" "$r" "$probe" "$only"; role_ok=0
        fi
      done
    fi
    while read -r a; do
      [ -z "$a" ] && continue
      can_send_from "$arn" "$a" || { printf "  FAIL %-56s %s 로 보낼 수 없다 — 보낼 수 있어야 한다(allowedFromAddresses, 문의 라우팅 %s)\n" "$r" "$a" "$CONTACT_ROUTING"; role_ok=0; }
    done <<< "$allowed"
    while read -r d; do
      [ -z "$d" ] && continue
      if can_send_from "$arn" "$d"; then
        printf "  FAIL %-56s %s 로 보낼 수 있다 — 그 주소는 다른 역할·함수 전용이다(deniedFromAddress)\n" "$r" "$d"; role_ok=0
      fi
    done <<< "$denied"
    for probe in "${RESERVED_VARIANT_PROBES[@]}"; do
      if can_send_from "$arn" "$probe"; then
        printf "  FAIL %-56s %s 로 보낼 수 있다 — 예약 주소의 대소문자·하위 주소·제어문자 변형이다(reservedVariant)\n" "$r" "$(shown "$probe")"; role_ok=0
      fi
    done
    if [ "$role_ok" -eq 1 ]; then
      printf "  ok   %-56s 런타임 역할(allowlist)%s\n" "$r" "${only:+ — ${only} 로만}"
    else
      fail=1
    fi
  else
    printf "  FAIL %-56s 발송 가능하나 allowlist 에 없음\n" "$r"; fail=1
  fi
done < <(aws iam list-roles --profile "$PROFILE" --path-prefix / --query 'Roles[].RoleName' --output text | tr '\t' '\n')

# ── SES identity 자원 정책(ADR-0014 단계 2) ──────────────────────────────────
# identity 마다 정책 문서를 읽어 allowlist `resourcePolicyGrants` 와 대조한다. 위반 하나가 FAIL 하나다(값은 출력하지 않는다 — 정책 이름 · 사유만).
echo
echo "[SES identity 자원 정책]"
GRANT_ROLE="$(jq -r '.resourcePolicyGrants.allowedPrincipalRole' "$ALLOWLIST")"
GRANT_PREFIX="$(jq -r '.resourcePolicyGrants.policyNamePrefix' "$ALLOWLIST")"
GRANT_ACTIONS="$(jq -c '.resourcePolicyGrants.allowedActions' "$ALLOWLIST")"
GRANT_ARN="arn:aws:iam::${ACCOUNT_ID}:role/${GRANT_ROLE}"
identities="$(aws sesv2 list-email-identities --profile "$PROFILE" --query 'EmailIdentities[].IdentityName' --output text 2>/dev/null)" || {
  echo "  FAIL identity 목록을 읽지 못했다(sesv2 list-email-identities)"; fail=1; identities="";
}
identity_count=0
while read -r identity; do
  [ -z "$identity" ] && continue
  identity_count=$((identity_count + 1))
  policies="$(aws sesv2 get-email-identity-policies --email-identity "$identity" --profile "$PROFILE" --output json 2>/dev/null)" || {
    printf "  FAIL %-40s 정책을 읽지 못했다\n" "$identity"; fail=1; continue;
  }
  is_platform="$(jq -r --arg id "$identity" '($id | ascii_downcase) as $l | [.resourcePolicyGrants.platformIdentities[] as $p | ($l == $p or ($l | endswith("." + $p)))] | any' "$ALLOWLIST" 2>/dev/null)"
  # 닫힌 쪽(보안 리뷰 L2) — 판정이 true/false 가 아니면(allowlist 손상 · jq 실패) 그 identity 를 FAIL 로 센다.
  case "$is_platform" in
    true|false) ;;
    *) printf "  FAIL %-40s 플랫폼 여부를 판정하지 못했다(allowlist resourcePolicyGrants.platformIdentities)\n" "$identity"; fail=1; continue ;;
  esac
  problems="$(printf '%s' "$policies" | jq -r \
    --arg id "$identity" --arg principal "$GRANT_ARN" --arg prefix "$GRANT_PREFIX" --argjson actions "$GRANT_ACTIONS" \
    --arg resource "arn:aws:ses:ap-northeast-2:${ACCOUNT_ID}:identity/${identity}" --arg platform "$is_platform" '
      def arr: if type == "array" then . else [.] end;
      (.Policies // {}) | to_entries[] | .key as $name |
      if $platform == "true" then "\($name): 플랫폼 identity 에 자원 정책이 있다"
      else
        (if ($name | startswith($prefix)) then empty else "\($name): 이름이 \($prefix) 로 시작하지 않는다" end),
        ((.value | fromjson? // null) as $doc |
          if $doc == null then "\($name): JSON 이 아니다"
          else ($doc.Statement | arr)[] |
            (if .Effect != "Allow" then "\($name): Allow 가 아닌 문장" else empty end),
            (if (has("NotPrincipal") or has("NotAction") or has("NotResource")) then "\($name): Not* 칸" else empty end),
            (if .Principal != {"AWS": $principal} then "\($name): Principal 이 발송 역할 하나가 아니다" else empty end),
            (if ((.Action | arr) - $actions | length) > 0 or ((.Action | arr) | length) == 0 then "\($name): 허용 밖 Action" else empty end),
            (if (.Resource | arr) != [$resource] then "\($name): Resource 가 이 identity 가 아니다" else empty end),
            (if ((.Condition // {}) | keys) != ["StringEquals"] or ((.Condition.StringEquals // {}) | keys) != ["ses:FromAddress"]
               then "\($name): 조건이 StringEquals ses:FromAddress 하나가 아니다"
             elif ((.Condition.StringEquals["ses:FromAddress"] | arr) | length) == 0
               or ([(.Condition.StringEquals["ses:FromAddress"] | arr)[] | select((type != "string") or (endswith("@" + $id) | not) or ((split("@") | length) != 2))] | length) > 0
               then "\($name): 발신 주소가 이 도메인의 주소 목록이 아니다"
             else empty end)
          end)
      end')" || { printf "  FAIL %-40s 정책 문서를 해석하지 못했다\n" "$identity"; fail=1; continue; }
  if [ -n "$problems" ]; then
    while read -r problem; do
      [ -z "$problem" ] && continue
      printf "  FAIL %-40s %s\n" "$identity" "$problem"
    done <<< "$problems"
    fail=1
  else
    count="$(printf '%s' "$policies" | jq -r '(.Policies // {}) | length')"
    if [ "$is_platform" = "true" ]; then
      printf "  ok   %-40s 플랫폼 identity — 자원 정책 0\n" "$identity"
    else
      printf "  ok   %-40s 정책 %s개 — 발송 역할 하나 · 발급 주소 StringEquals\n" "$identity" "$count"
    fi
  fi
done < <(printf '%s\n' "$identities" | tr '\t' '\n')
echo "       identity ${identity_count}개 검사"

# Layer E 의 본체: 런타임 발송 주체는 정확히 mustEqual 개여야 한다(ADR-0006 이후 2 — 둘째는 login@·onve@atmark.ai 로만).
echo
expected="$(jq -r '.runtimeRoles.mustEqual' "$ALLOWLIST")"
if [ "$runtime_count" -ne "$expected" ]; then
  echo "FAIL  런타임 역할 ${runtime_count}개 (기대 ${expected}개) — Layer E 단언 위반"
  fail=1
else
  echo "ok    런타임 역할 ${runtime_count}개 = 기대 ${expected}개"
fi

echo
[ "$fail" -eq 0 ] && echo "AC-c8b: 통과" || echo "AC-c8b: 미통과"
exit "$fail"
