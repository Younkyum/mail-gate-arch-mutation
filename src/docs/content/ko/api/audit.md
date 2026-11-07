---
title: 발송 판정 기록 API
nav_title: 감사 기록 API
description: GET /v1/audit로 메일 한 통이 왜 나갔는지, 왜 막혔는지 판정 기록을 봅니다.
group: api
order: 12
updated: 2026-09-27
related: [api/messages, api/errors, team/logs]
---
```http
GET /v1/audit?message_id={messageId}
```

**감사**(`audit:read`) 권한이 필요합니다. `message_id`는 발송 응답의 `message_id`입니다.

응답의 `attempts` 배열에 시도마다 기록이 하나씩 있습니다. 보통 하나입니다.

| 필드 | 뜻 |
|---|---|
| `decision` | `allowed`, `denied`, `pending_approval` 중 하나 |
| `reasons` | 판정 사유 코드 배열. [사유 코드 전체](/api/errors#all-reasons) |
| `policy_version` | 판정에 쓴 정책 버전 |
| `evaluated_at` | 판정 시각 |
| `trace_id` | 보낼 때 넣은 추적 문자열 |
| `resolved_at` · `resolution_reason` | 시도가 끝난 시각과 결과. 발송으로 끝난 시도와 승인으로 끝난 시도 모두에 채워집니다. 값: `sent`, `send_failed`, `approval_rejected`, `approval_expired`, `release_denied:<사유>`(승인 뒤 다시 판정해 막힘), `not_sent`(그 밖에 나가지 않음) |

기록이 없으면 `404 audit_not_found`, 다른 에이전트의 메일이면 `403 forbidden`입니다.
