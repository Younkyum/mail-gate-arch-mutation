---
title: 메일 보내기, 회신, 전달 API
nav_title: 메일 API
description: POST /v1/messages로 새 메일을, /reply로 회신을, /forward로 전달을 보냅니다. 세 경로 모두 같은 발송 관문을 지납니다.
group: api
order: 2
updated: 2026-09-27
related: [api/overview, api/errors, email/sending]
---
세 경로 모두 `Idempotency-Key` 헤더와 **보내기**(`messages:send`) 권한이 필요합니다.

## 새 메일 보내기 {#send}

```http
POST /v1/messages
```

| 필드 | 필수 | 설명 |
|---|---|---|
| `agent_id` | 아니요 | 빼면 토큰의 에이전트. 넣으면 토큰의 에이전트 ID여야 합니다. |
| `from` | 예 | 에이전트 주소. 소문자이고 `+태그`가 없어야 합니다. |
| `to` | 예 | 받는 사람 주소 배열(비어 있으면 안 됨) |
| `subject` | 예 | 제목 |
| `text` | 예 | 텍스트 본문 |
| `html` | 아니요 | HTML 본문 |
| `trace_id` | 아니요 | 내 쪽 추적용 문자열. 감사 기록에 남습니다. |

:::feature attachments
파일을 붙이려면 `attachments`에 첨부 id 배열(10개까지)을 넣습니다. 올리는 법과 첨부 오류는 [첨부 API](/api/attachments)에 있습니다.
:::

```bash
curl -sS https://api.atmark.ai/v1/messages \
  -H "Authorization: Bearer $ATMARK_AGENT_TOKEN" \
  -H "Idempotency-Key: 2026-09-27-weekly-report" \
  -H "Content-Type: application/json" \
  -d '{
    "from": "scout@atmark.ai",
    "to": ["partner@example.com"],
    "subject": "Weekly report",
    "text": "Hello, here is this week's report."
  }'
```

## 결과 {#results}

| 상태 코드 | 결과 | 본문 |
|---|---|---|
| `200` | 나감 | `status: "sent"`, `message_id`, `message_id_header`, `provider_message_id`, `decision` |
| `202` | 승인 대기 | `status: "pending_approval"`, `message_id`, `approval_id`, `expires_at`, `decision` |
| `403` | 정책 거부 | `error: "policy_denied"`, `message_id`, `decision` |
| `409` | 멱등 키 충돌 | `error: "idempotency_key_reused"` |
| `502` | 발송 실패 | `error: "send_failed"`. 메일은 나가지 않았습니다. 새 키로 다시 보낼 수 있습니다. |
| 위와 같음 | 다시 보낸 요청 | `replayed: true`와 그 메일의 지금 상태. [아래](#replay) |

`provider_message_id`는 메일이 나갈 때 붙는 배달 추적 ID입니다. 나가기 전에는 `null`입니다.

`decision`에는 판정(`verdict`), 사유 배열(`reasons`), 정책 버전(`policy_version`), 판정 시각(`evaluated_at`), 기다릴 시간(`retry_after_seconds`)이 들어 있습니다.

```json title="200 응답 예"
{
  "status": "sent",
  "message_id": "0f8a…",
  "message_id_header": "<…@atmark.ai>",
  "provider_message_id": "…",
  "decision": {
    "verdict": "allowed",
    "reasons": ["allowlist_match"],
    "policy_version": 3,
    "evaluated_at": "2026-09-27T09:00:00.000Z",
    "retry_after_seconds": null
  }
}
```

허용된 발송에도 `reasons`가 옵니다. 위 예의 `allowlist_match`는 받는 사람이 모두 발신 허용 목록에 있어서 나갔다는 뜻입니다. 모든 코드는 [사유 코드](/api/errors#all-reasons)에 있습니다.

`403`은 장애가 아니라 정책이 막은 정상 결과입니다. 같은 키로 다시 보내면 같은 거부가 돌아옵니다. 원인을 고쳤거나 `retry_after_seconds`만큼 기다린 뒤에는 **새** `Idempotency-Key`로 보냅니다.

## 다시 보낸 요청의 응답 {#replay}

같은 `Idempotency-Key`로 같은 요청을 다시 보내면 메일은 또 나가지 않고, 그 메일의 **지금 상태**가 `replayed: true`와 함께 옵니다. 본문에는 `status`, `message_id`, `message_id_header`, `provider_message_id`가 들어 있고, `decision`·`approval_id`·`expires_at`은 없습니다. 판정은 [`GET /v1/audit?message_id=…`](/api/audit), 승인은 [`GET /v1/approvals/{id}`](/api/approvals)로 읽습니다.

| 상태 코드 | 지금 상태 |
|---|---|
| `200` | `status: "sent"` 나감 |
| `202` | `status: "pending"` 또는 `"dispatching"` 아직 나가지 않음(승인 대기 포함) |
| `403` | `status: "denied"`, `error: "policy_denied"` |
| `502` | `status: "failed"`, `error: "send_failed"` |

## 회신 {#reply}

```http
POST /v1/threads/{threadId}/reply
```

`threadId`는 받은 메일의 `thread_id`입니다.

| 필드 | 필수 | 설명 |
|---|---|---|
| `agent_id` | 아니요 | 빼면 토큰의 에이전트. 넣으면 토큰의 에이전트 ID여야 합니다. |
| `in_reply_to` | 예 | 회신할 받은 메일의 `id` |
| `text` | 예 | 텍스트 본문 |
| `html` | 아니요 | HTML 본문 |
| `to` | 아니요 | 생략하면 그 메일을 보낸 사람 |
| `subject` | 아니요 | 생략하면 `Re: 원래 제목` |
| `from` | 아니요 | 생략하면 그 메일을 받은 주소 |

받은 메일이 없으면 `404 message_not_found`입니다. 결과는 새 메일과 같습니다.

:::feature attachments
회신에도 `attachments`로 파일을 붙일 수 있습니다. [첨부 API](/api/attachments#attach)
:::

## 전달 {#forward}

```http
POST /v1/messages/{messageId}/forward
```

`messageId`는 받은 메일의 `id`입니다.

| 필드 | 필수 | 설명 |
|---|---|---|
| `agent_id` | 아니요 | 빼면 토큰의 에이전트. 넣으면 토큰의 에이전트 ID여야 합니다. |
| `from` | 예 | 에이전트 주소 |
| `to` | 예 | 받는 사람 주소 배열 |
| `text` | 아니요 | 전달 메일 위에 붙일 메모 |
| `subject` | 아니요 | 생략하면 `Fwd: 원래 제목` |

- 원 메일의 본문 텍스트만 옮깁니다. `html`을 보내면 `400`입니다. 첨부는 전달하지 않고, 응답의 `attachments_omitted`에 빠진 개수가 옵니다.
- 받은 메일의 `injection_risk`가 `none`이 아니면 `422 forward_refused_injection_risk`로 거부합니다. 내용이 필요하면 자기 말로 새 메일을 씁니다.
