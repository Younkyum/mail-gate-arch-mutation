---
title: 메일이 안 나갈 때
description: 발송 결과와 사유 코드로 메일이 막힌 이유를 찾고 고칩니다.
keywords: [메일 안 감, 전송 실패, 발송 실패]
group: help
order: 2
updated: 2026-10-13
related: [api/errors, email/sending, team/logs]
---
먼저 결과를 봅니다. 에이전트가 받은 결과, 또는 콘솔 **로그 › 발신** 탭의 결과와 사유입니다.

## 결과가 `denied`

사유 코드에 따라 고칩니다. 막힌 메일은 저절로 다시 나가지 않습니다. 원인을 고친 뒤 에이전트에게 다시 보내 달라고 하되, **새 멱등 키**로 보내게 합니다. MCP라면 `idempotency_key`에 새 값을 넣고, REST라면 새 `Idempotency-Key` 헤더를 씁니다. 같은 키(MCP에서는 같은 인자)로 다시 보내면 원인을 고친 뒤에도 처음의 거부가 그대로 돌아옵니다.

| 사유 | 해결 |
|---|---|
| `recipient_not_allowlisted` | **이메일 › 발신**의 허용 목록에 받는 사람을 넣거나, 그 화면 맨 위의 에이전트 변경 요청을 승인합니다. [허용/차단 목록](/email/allow-block-lists) |
| `recipient_blocklisted` | 발신 차단 목록에서 뺍니다. 차단 목록이 허용 목록을 이깁니다. |
| `outbound_disabled` | 발신 모드가 **모두 막기**입니다. 다른 모드로 저장합니다. |
| `org_pending_review` | 운영자 검토 중입니다. 새로 가입한 조직은 이 사유를 받지 않고, 예전에 가입한 조직에만 남아 있을 수 있습니다. 끝나면 발송이 열립니다. [요금제와 운영자 조치](/get-started/beta-and-review) |
| `org_owner_paused` · `agent_not_active` | 조직이나 에이전트가 긴급 정지 중입니다. [긴급 정지](/email/emergency-stop) |
| `rate_limit_per_minute` 등 | 한도에 닿았습니다. [발송 한도](/email/limits-and-deliverability) |
| `suppression_list` | 반송됐거나 스팸으로 신고한 이력이 있는 주소입니다. 주소를 확인합니다. |
| `daily_send_limit` | 조직의 하루 발송 한도에 닿았습니다. 새 조직은 첫 발송 뒤 몇 주에 걸쳐 한도가 오릅니다. 나중에 다시 보냅니다. |
| `plan_daily_cap` | 요금제의 조직 하루 수신자 한도에 닿았습니다. 내일 보냅니다. 베타 기간에는 결제가 열리지 않아 요금제를 올릴 수 없습니다. |

자주 보는 사유는 [오류 코드](/api/errors#reasons)에 더 있습니다.

## 결과가 `pending_approval`

예전 발신 모드의 에이전트입니다. 주 소유자 메일로 온 승인 링크에서 승인합니다. 에이전트는 다시 보내지 않고 기다립니다. [승인](/email/approvals)

## 결과가 `sent`인데 받는 사람이 못 받음

- 받는 사람의 스팸함을 확인하게 합니다.
- **로그 › 발신**에서 그 기록을 열어 배달 이벤트(배달됨, 반송, 스팸 신고)를 봅니다.

## 회신이 막힘

회신도 발신 정책을 따릅니다. 허용 목록 모드라면 회신할 상대도 목록에 있어야 합니다.
