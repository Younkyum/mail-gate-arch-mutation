---
title: 오류 코드
description: API가 돌려주는 error 코드와 발송 거부 사유 코드, 그리고 각각 할 일.
group: api
order: 18
updated: 2026-10-15
related: [api/overview, help/troubleshooting-sending, help/troubleshooting-connection]
---
오류 응답은 대개 `{"error": "...", "detail": "..."}` 모양입니다. 분기에는 `error`만 씁니다. `403 policy_denied`의 첫 응답에는 `detail` 대신 `decision`이 옵니다.

## HTTP 오류 {#http}

| 상태 | `error` | 뜻과 할 일 |
|---|---|---|
| `400` | `invalid_request` | 요청 모양이 틀렸습니다. `detail`을 보고 고칩니다. |
| `400` | `invalid_recipient` | 받을 수 없는 주소 모양입니다. 일반적인 `로컬@도메인` 주소만 됩니다. |
| `400` | `idempotency_key_required` | `Idempotency-Key` 헤더를 넣습니다. |
| `401` | `unauthorized` | 토큰이 없거나 틀렸거나 폐기·만료됐습니다. |
| `403` | `forbidden` | 토큰에 권한이 없거나 다른 에이전트의 것을 요청했습니다. |
| `403` | `policy_denied` | 정책이 발송을 막았습니다. `decision.reasons`를 봅니다(아래 표). |
| `404` | `message_not_found` · `thread_not_found` · `approval_not_found` · `attachment_not_found` · `schedule_not_found` · `audit_not_found` | 없거나 볼 수 없는 대상입니다. 보류된 메일도 없는 것과 같게 보입니다. |
| `409` | `idempotency_key_reused` | 같은 키를 다른 요청에 썼습니다. 새 키를 씁니다. |
| `409` | `policy_changing` | 정책이 바뀌는 중입니다. 잠시 뒤 다시 합니다. |
| `422` | `forward_refused_injection_risk` | 이 메일의 전달은 거부됐습니다. 자기 말로 새 메일을 씁니다. |
| `429` | `cancel_rate_limited` | 예약 취소가 너무 잦습니다. 소유자에게 알립니다. |
| `502` | `send_failed` | 메일이 나가지 않았습니다. 새 멱등 키로 다시 보낼 수 있습니다. |
| `503` | `exposure_unavailable` | 받은 메일(상세 · 스레드 · 첨부 · 인증 코드)을 읽었다는 기록을 남기지 못해 열지 않았습니다. 아무것도 돌려주지 않았습니다. 잠시 뒤 다시 합니다. |

## 모든 경로에 공통인 오류 {#platform}

| 상태 | `error` | 뜻과 할 일 |
|---|---|---|
| `400` | `invalid_json` | 본문이 올바른 JSON이 아닙니다. |
| `400` | `invalid_request` | 같은 쿼리 파라미터가 두 번 왔습니다. |
| `404` | `route_not_found` | 없는 경로입니다. 경로와 메서드를 확인합니다. |
| `405` | `method_not_allowed` | 이 경로가 받지 않는 메서드입니다. `Allow` 응답 헤더에 받는 메서드가 있습니다. |
| `413` | `payload_too_large` | 요청 본문은 10 MiB(10,485,760바이트)까지입니다. |
| `500` | `internal_error` | 서버에서 처리하지 못했습니다. `detail`에 요청 ID가 있습니다. |
| `503` | `service_unavailable` | 잠시 쓸 수 없습니다. `detail`에 요청 ID가 있습니다. |

`500`, `503`, 타임아웃, 네트워크 오류가 나면 잠시 기다렸다 **같은** `Idempotency-Key`로 다시 보냅니다. 이미 나간 메일은 두 번 나가지 않습니다. 요청이 몰리면 `429`가 올 수 있고, 이때 본문은 이 표의 모양이 아닐 수 있습니다. 역시 기다렸다 같은 키로 다시 보냅니다. 계속되면 요청 ID를 적어 [지원팀](/help/contact)에 알려 주세요.

예약·인증 코드·웹훅 전용 코드는 각 페이지에 있습니다: [예약](/api/scheduled#cancel), [인증 코드](/api/verification-code), [웹훅](/api/webhooks).


## 초안 · 라벨 · 첨부 · 새 에이전트 {#new}

| 상태 | `error` | 뜻과 할 일 |
|---|---|---|
| `400` | `draft_incomplete` | 초안에 `from` · 받는 사람 · 제목이 빠졌습니다. 고친 뒤 보냅니다. |
| `400` | `path_body_mismatch` | 본문의 `agent_id`가 토큰의 에이전트가 아닙니다. |
| `400` | `invalid_label` · `label_limit` | 라벨 모양이 틀렸거나 한 통의 라벨이 20개를 넘게 됩니다. |
| `403` | `self_enroll_disabled` | 소유자가 자가 등록을 켜지 않았습니다. |
| `403` | `enroll_chain_forbidden` | 자가 등록으로 만든 에이전트는 에이전트를 만들 수 없습니다. |
| `404` | `draft_not_found` | 이 에이전트에게 그런 초안이 없습니다. |
| `409` | `draft_revision_conflict` | 읽은 뒤에 초안이 바뀌었습니다. 다시 읽고 고칩니다. |
| `409` | `draft_send_in_progress` · `draft_already_sent` · `draft_discarded` | 초안을 고치거나 다시 보낼 수 없습니다. |
| `409` | `agent_label_limit` | 서로 다른 라벨을 이미 200개 씁니다. |
| `409` | `attachment_expired` | 첨부가, 또는 이 `Idempotency-Key`로 만든 첨부가 만료됐습니다. 새 키로 다시 올립니다. |
| `409` | `address_taken` · `agent_limit` | 쓸 수 없는 주소이거나 요금제의 에이전트 한도에 닿았습니다. |
| `413` | `draft_too_large` | 초안 본문이 10 MiB를 넘습니다. |
| `429` | `draft_limit` | 열린 초안이 500개입니다. |
| `429` | `enroll_daily_cap` | 오늘 자가 등록 시도를 다 썼습니다. |
| `503` | `enroll_busy` · `enroll_timeout` · `enroll_unavailable` | 자가 등록을 마치지 못했습니다. `enroll_timeout` 뒤에는 만들어졌을 수 있으니 바로 다시 부르지 않습니다. |

자세히: [초안](/api/drafts#errors) · [라벨](/api/labels#errors) · [에이전트 만들기](/api/agents#errors). 실시간 연결은 연결 단계의 HTTP 상태로 거부를 알립니다. [실시간](/api/realtime#connect)

## 정책 변경 요청 {#policy-requests}

| 상태 | `error` | 뜻과 할 일 |
|---|---|---|
| `400` | `invalid_request` · `invalid_action` · `invalid_direction` · `invalid_list` · `invalid_mode` · `invalid_rule_value` | 요청 모양이 틀렸거나, 요청할 수 없는 것을 요청했습니다. |
| `400` | `rule_platform_domain` · `rule_self_address` | 발신 허용 목록에는 `atmark.ai` 도메인이나 에이전트 자기 주소를 넣을 수 없습니다. |
| `400` | `reason_required` · `reason_too_long` | 이유를 한 줄로, 500자까지 적습니다. |
| `403` | `forbidden`(`capability_not_granted`) | 토큰에 **정책 변경 요청** 권한이 없습니다. |
| `404` | `policy_request_not_found` | 이 에이전트의 그런 요청이 없습니다. |
| `409` | `no_change` | 정책이 이미 그 상태입니다. |
| `409` | `policy_request_recently_rejected` | 소유자가 24시간 안에 같은 변경을 거절했습니다. 소유자가 시키지 않았다면 다시 요청하지 않습니다. |
| `429` | `policy_request_pending_limit` · `policy_request_daily_limit` | 기다리는 요청이 5건이거나 24시간에 20건을 요청했습니다. 소유자의 결정을 기다립니다. |

자세히: [정책 API](/api/policy#requests)

## 자주 보는 거부 사유 {#reasons}

`policy_denied`의 `decision.reasons`, MCP의 `denied` 결과에 오는 코드 가운데 자주 보는 것입니다. 원인이 그대로면 다시 보내도 결과가 같습니다. 같은 멱등 키로 다시 보내면 원인을 고친 뒤에도 같은 거부가 돌아오므로, 원인을 고쳤거나 `retry_after_seconds`만큼 기다린 뒤에는 **새** 멱등 키로 보냅니다.

| 사유 | 뜻 | 할 일 |
|---|---|---|
| `recipient_not_allowlisted` | 받는 사람이 발신 허용 목록에 없습니다. | 소유자가 허용 목록에 넣거나, 에이전트가 [요청](/api/policy#requests)합니다. |
| `recipient_blocklisted` | 받는 사람이 발신 차단 목록에 있습니다. | 소유자가 차단 목록에서 뺍니다. |
| `outbound_disabled` | 발신 모드가 "모두 막기"입니다. | 소유자가 모드를 바꿉니다. |
| `recipient_is_self` | 에이전트 자기 주소로 보내려 했습니다. | 자기에게는 보낼 수 없습니다. |
| `suppression_list` | 반송됐거나 스팸으로 신고한 이력이 있는 주소입니다. | 주소를 확인합니다. |
| `rate_limit_per_minute` · `rate_limit_per_hour` · `rate_limit_per_day` | 발송 한도에 닿았습니다. | 기다렸다 보냅니다. |
| `recipients_per_message` · `plan_recipients_per_message` | 메일당 받는 사람이 너무 많습니다. | 나눠 보냅니다. |
| `daily_send_limit` | 조직의 하루 발송 한도에 닿았습니다. 새 조직의 이 한도는 첫 발송 뒤 몇 주에 걸쳐 오릅니다. | 기다렸다 나중에 보냅니다. 요금제로 풀리지 않습니다. |
| `plan_daily_cap` | 요금제의 조직 하루 수신자 한도에 닿았습니다. | 내일 보냅니다. 요금제를 올리면 풀리지만, 베타 기간에는 결제가 열리지 않습니다. |
| `org_pending_review` | 조직이 운영자 검토 중입니다. 새로 가입한 조직은 바로 활성이라 이 사유를 받지 않고, 예전에 가입한 조직에만 남아 있을 수 있습니다. | 검토가 끝날 때까지 기다립니다. |
| `org_review_rejected` | 가입이 승인되지 않았습니다. | 지원팀에 문의합니다. |
| `org_owner_paused` | 조직 전체가 긴급 정지 중입니다. | 소유자가 정지를 풉니다. |
| `org_abuse_freeze` | 조직의 발송이 동결됐습니다 — 운영자가 걸었거나, atmark.ai 주소에서 나간 메일의 반송·스팸 신고가 기준을 넘어 자동으로 걸렸습니다. | support@atmark.ai 로 문의합니다. 운영자만 풉니다. |
| `org_billing_blocked` | 결제 문제로 발송이 막혔습니다. | 소유자가 **설정 › 요금제 · 사용량**를 확인합니다. |
| `agent_not_active` | 에이전트가 긴급 정지 중이거나 활성 상태가 아닙니다. | 소유자가 확인합니다. |
| `from_forgery` | `from`이 이 에이전트의 주소가 아닙니다. | 에이전트 자기 주소를 씁니다. |
| `from_inactive` | `from`이 이 에이전트의 주소지만 지금은 쓸 수 없습니다(폐기한 별칭). | 에이전트가 지금 쓰는 주소로 다시 보냅니다. |
| `evaluation_error` | 판정하지 못해 안전하게 막았습니다. | 잠시 뒤 새 멱등 키로 다시 보냅니다. 계속되면 지원팀에 문의합니다. |

## 사유 코드 전체 {#all-reasons}

공개 API가 지금 `decision.reasons`와 감사 기록의 `reasons`로 돌려주는 코드입니다. 오래된 감사 기록에는 예전 이름이 보일 수 있습니다. 허용된 발송에도 사유가 붙습니다. "예전 모드"는 Atmark 운영자가 설정한 예전 발신 모드(승인 필요·회신만)를 뜻합니다. [승인](/email/approvals)

### 거부

| 코드 | 뜻 |
|---|---|
| `org_pending_review` | 조직이 운영자 검토 중입니다. 새 가입은 이 상태를 거치지 않습니다. 예전 조직에만 남아 있을 수 있습니다. |
| `org_review_rejected` | 가입이 승인되지 않았습니다. |
| `org_owner_paused` | 조직 전체가 긴급 정지 중입니다. |
| `org_abuse_freeze` | 조직의 발송이 동결됐습니다(운영자가 걸었거나, atmark.ai 메일의 반송·스팸 신고가 많아 자동으로). |
| `org_billing_blocked` | 결제 문제로 발송이 막혔습니다. |
| `agent_not_active` | 에이전트가 긴급 정지 중이거나 활성 상태가 아닙니다. |
| `outbound_disabled` | 발신 모드가 "모두 막기"입니다. |
| `from_forgery` | `from`이 이 에이전트의 주소가 아닙니다. |
| `from_inactive` | `from`이 이 에이전트의 주소지만 지금은 쓸 수 없습니다(폐기한 별칭). |
| `recipient_is_self` | 에이전트 자기 주소로 보내려 했습니다. |
| `suppression_list` | 반송되거나 스팸으로 신고된 이력이 있는 주소입니다. |
| `recipient_blocklisted` | 받는 사람이 발신 차단 목록에 있습니다. |
| `recipient_not_allowlisted` | 받는 사람이 발신 허용 목록에 없습니다. |
| `rate_limit_per_minute` · `rate_limit_per_hour` · `rate_limit_per_day` | 에이전트의 분당·시간당·하루 발송 한도에 닿았습니다. |
| `recipients_per_message` | 메일당 받는 사람 수가 에이전트 정책의 한도를 넘었습니다. |
| `plan_recipients_per_message` | 메일당 받는 사람 수가 요금제 한도를 넘었습니다. |
| `recipient_ceiling_exceeded` | 메일당 받는 사람 수가 어떤 요금제로도 넘을 수 없는 상한을 넘었습니다. |
| `daily_send_limit` | 조직의 하루 발송 한도에 닿았습니다. 새 조직은 첫 발송 뒤 몇 주에 걸쳐 오릅니다. |
| `plan_daily_cap` | 요금제의 조직 하루 수신자 한도에 닿았습니다. |
| `budget_exhausted` | 에이전트의 발송 예산에 닿았습니다. 지원팀에 문의합니다. |
| `evaluation_error` | 판정하지 못해 안전하게 막았습니다. |
| `release_window_expired` | 승인은 됐지만 정해진 시간 안에 보내지 못해 닫혔습니다(예전 모드). |
| `reply_only_no_inbound_thread` | 받은 메일의 스레드 밖으로 보내려 했습니다(예전 모드 "회신만"). |
| `reply_only_inbound_quarantined` | 회신하려는 받은 메일이 보류돼 있습니다(예전 모드 "회신만"). |
| `reply_only_owner_approval` | 이 에이전트의 발신 승인이 "모두 내 승인 후"인데 예전 모드 "회신만"에는 승인할 사람이 없어 회신을 막았습니다. |
| `reply_only_risk_hold` | 회신에 위험 신호가 있습니다(위험한 받은 메일을 읽은 직후이거나 민감한 내용이 담김). 예전 모드 "회신만"에는 승인할 사람이 없어 막았습니다. |

### 허용

| 코드 | 뜻 |
|---|---|
| `allowlist_match` | 받는 사람이 모두 발신 허용 목록에 있습니다. |
| `unrestricted_mode` | 발신 모드가 "전체"입니다. |
| `not_blocklisted` | "차단 목록" 모드에서 받는 사람이 차단 목록에 없습니다. |
| `approval_granted` | 사람이 승인했습니다. |
| `standing_approval` | 전에 승인한 상대(또는 도메인)입니다(예전 모드). |
| `seed_relationship` | 에이전트를 만들 때 소유자가 넣어 둔 상대입니다(예전 모드). |
| `reply_within_thread` · `auto_approve_reply_within_thread` | 같은 스레드 안의 회신이라 허용됐습니다(예전 모드). |
| `auto_approve_verification_sender` | 인증 메일을 보낸 쪽에 대한 회신이라 허용됐습니다(예전 모드). |
| `auto_approve_domain` | 소유자가 자동 허용한 도메인입니다(예전 모드). |

### 승인 대기

| 코드 | 뜻 |
|---|---|
| `new_recipient` | 처음 보내는 상대라 사람의 승인이 필요합니다(예전 모드 "승인 필요"). |
| `risk_review` | 발송에 위험 신호가 있습니다 — 에이전트가 최근 위험한 받은 메일을 읽었거나, 내용이 민감해 보입니다(자격 증명 · 받은 인증 코드 · 받은 메일을 크게 옮긴 내용). 소유자에게 사유가 적힌 승인 메일이 갑니다. 승인은 이 한 통에만 적용됩니다. 표현을 바꿔 피하려 하지 말고 소유자를 기다립니다. |
| `owner_requires_approval` | 소유자가 이 에이전트의 [발신 승인](/security/watch#send-approval)을 "모두 내 승인 후"로 정했습니다. 정책이 허용한 발송은 모두 소유자를 기다립니다. 다시 보내지 않습니다. |
| `bootstrap_grace` | 예전 모드 "회신만"의 시작 기간에 내려진 판정이라는 표시입니다. |
