---
title: 예약 발송 API
nav_title: 예약 발송 API
description: 보낼 시각을 정해 메일을 예약하고, 목록을 보고, 취소합니다. 정책은 보낼 때 확인합니다.
group: api
order: 10
updated: 2026-09-27
related: [email/scheduled, api/messages, team/logs]
---
## 예약 만들기 {#create}

```http
POST /v1/messages/scheduled
```

`Idempotency-Key` 헤더와 **보내기**(`messages:send`) 권한이 필요합니다. 본문은 [새 메일](/api/messages#send)과 같고 두 필드가 더해집니다.

| 필드 | 필수 | 설명 |
|---|---|---|
| `send_at` | 예 | 보낼 시각(ISO 8601). 30일 이내여야 하고 과거면 안 됩니다. |
| `agent_cancellable` | 아니요 | 기본 `true`. `false`면 에이전트 토큰으로 취소할 수 없고 소유자만 콘솔에서 취소합니다. 만든 뒤에는 바꿀 수 없습니다. |

응답은 `202`이고 `schedule_id`, `status`, `send_at`, `agent_cancellable`이 옵니다. 이 단계에서는 정책을 확인하지 않습니다. 보낼 시각에 확인하고, 그때 막히면 나가지 않습니다.

## 목록 {#list}

```http
GET /v1/messages/scheduled
```

**읽기** 권한. `status`(`scheduled`·`dispatched`·`cancelled`), `limit`(1~50), `cursor`로 거릅니다. 응답은 `schedules` 배열과 `next_cursor`입니다.

## 한 건 보기 {#get}

```http
GET /v1/messages/scheduled/{scheduleId}
```

목록 항목에 제목(`subject`)이 더해집니다. 항목에는 `send_at`, `recipients`, `from_address`, `cancelled_at`, `cancel_reason_code`, `cancelled_via`, `dispatch_outcome`, `message_id`가 있습니다.

## 취소 {#cancel}

```http
POST /v1/messages/scheduled/{scheduleId}/cancel
```

**보내기** 권한. 본문에 `reason_code`가 필수이고 `note`는 선택입니다.

`reason_code`: `no_longer_needed`, `wrong_recipient`, `wrong_content`, `wrong_time`, `duplicate`, `owner_request`, `other`

| 응답 | 뜻 |
|---|---|
| `200` | 취소됨 |
| `403 schedule_not_agent_cancellable` | 에이전트가 취소할 수 없는 예약. 소유자에게 요청합니다. |
| `409 schedule_already_dispatched` | 이미 나갔습니다. 거둘 수 없습니다. |
| `409 schedule_in_flight` | 지금 나가는 중입니다. 잠시 뒤 상태를 다시 봅니다. |
| `429 cancel_rate_limited` | 시간당 취소 한도에 닿았습니다. |

취소 사유와 경로는 기록에 영구히 남고 소유자가 콘솔 로그에서 봅니다.
