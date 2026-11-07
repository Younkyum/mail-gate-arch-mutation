---
title: 초안 API
nav_title: 초안 API
description: 메일을 초안으로 저장하고 몇 번이든 고친 뒤, 다른 발송과 같은 정책을 거쳐 한 번 보냅니다.
group: api
order: 4
updated: 2026-10-15
keywords: [초안, 임시 저장, draft]
related: [api/messages, api/inbound, api/errors]
---
초안은 아직 나가지 않은 메일입니다. 저장하는 동안에는 아무것도 검사하거나 보내지 않습니다. 소유자의 정책은 보낼 때 한 번 적용됩니다. 초안 경로는 읽기까지 모두 **보내기**(`messages:send`) 권한이 필요합니다.

## 초안 만들기 {#create}

```http
POST /v1/drafts
```

모든 필드가 선택이라, 덜 쓴 초안도 저장됩니다.

| 필드 | 필수 | 설명 |
|---|---|---|
| `agent_id` | 아니요 | 빼면 토큰의 에이전트. 넣으면 토큰의 에이전트 ID여야 합니다. |
| `from` | 아니요 | 이 에이전트의 발신 주소. 소문자, `+태그` 없이 |
| `to` | 아니요 | 받는 사람 주소 최대 50개 |
| `subject` | 아니요 | 998자까지 |
| `text` · `html` | 아니요 | 본문. 합쳐서 10 MiB까지 |
| `in_reply_to` | 아니요 | 받은 메일의 ID. 답장 초안이 됩니다. |
| `attachments` | 아니요 | 올린 첨부 ID 최대 10개 |

```bash
curl -sS https://api.atmark.ai/v1/drafts \
  -H "Authorization: Bearer $ATMARK_AGENT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "from": "scout@atmark.ai",
    "to": ["partner@example.com"],
    "subject": "주간 보고",
    "text": "초안입니다. 숫자는 곧 채웁니다."
  }'
```

응답은 `201`이고 초안 전체가 옵니다: `id`, `revision`(처음엔 `1`), `status`(`active`), `from`, `to`, `subject`, `in_reply_to`, `attachments`, `size_bytes`, `created_at`, `updated_at`, `discarded_at`, `sent_at`, `message_id`, `text`, `html`.

- 답장 초안(`in_reply_to`)은 이 에이전트가 볼 수 있는 받은 메일이어야 합니다. 보류됐거나 없는 메일이면 `404 message_not_found`입니다. 보낼 때 빈 필드는 [회신](/api/messages#reply)과 같이 채워집니다: 받는 사람은 보낸 사람, 제목은 `Re: …`, 발신은 그 메일을 받은 주소.
- 에이전트마다 열린 초안은 500개까지입니다. 넘으면 `429 draft_limit`입니다.

## 목록과 읽기 {#list}

```http
GET /v1/drafts
GET /v1/drafts/{draftId}
```

목록은 최근에 바뀐 순서이고 본문은 빠집니다. `status`로 거릅니다: `active`(기본), `sent`, `discarded`, `all`. `limit`(1~100)과 `cursor`를 받습니다. 한 통을 읽으면 `text`와 `html`도 옵니다.

| `status` | 뜻 |
|---|---|
| `active` | 아직 고치고 보낼 수 있음 |
| `sending` | 보내기가 시작됨. 바꿀 수 없음 |
| `sent` | 보냄. `message_id`가 나간 메일 |
| `discarded` | 버림. 기록으로 남음 |

## 고치기 {#update}

```http
PATCH /v1/drafts/{draftId}
```

바꿀 필드만 보냅니다. 빠진 필드는 그대로, `null`은 비웁니다. 고칠 때마다 `revision`이 하나 오릅니다.

다른 요청의 변경을 덮어쓰지 않으려면 마지막으로 읽은 `revision`을 함께 보냅니다. 그 사이 바뀌었으면 `409 draft_revision_conflict`이니 다시 읽고 고칩니다. 보내는 중이거나 보냈거나 버린 초안은 바꿀 수 없습니다.

## 버리기 {#discard}

```http
POST /v1/drafts/{draftId}/discard
```

지우지 않습니다. `status: "discarded"`로 남고 고치거나 보낼 수 없습니다. 다시 버려도 같은 결과입니다.

## 보내기 {#send}

```http
POST /v1/drafts/{draftId}/send
Idempotency-Key: 2026-10-08-weekly-report
```

저장된 그대로 나갑니다. 바꾸려면 먼저 `PATCH`합니다. 보내기 본문은 생략할 수 있고, 받는 것은 `agent_id`와 `trace_id`(둘 다 선택)뿐입니다.

- [`POST /v1/messages`](/api/messages)와 같은 관문을 지납니다: 정책, 한도, 위험 검사, 소유자의 [발신 승인](/security/watch#send-approval). 결과도 같고(`sent`, `pending_approval`, `403 policy_denied`) `draft_id`와 `draft_status`가 더해집니다.
- `Idempotency-Key`가 필요합니다. 같은 키로 다시 부르면 첫 결과가 옵니다. 초안은 한 번만 나갑니다. 관문이 판정하면(보냄 · 거부 · 승인 대기 · 실패) 초안은 닫히고, 다른 키로 부르면 `409 draft_already_sent`와 `message_id`가 옵니다.
- 관문 앞에서 멈추면(필드가 모자라거나 첨부 오류) 초안은 `active`로 남습니다. 고쳐서 다시 보냅니다.
- `from`, 받는 사람, 제목이 없으면 `400 draft_incomplete`입니다. 무엇이 빠졌는지는 `detail`에 있습니다.

## 오류 {#errors}

| 상태 | `error` | 뜻 |
|---|---|---|
| `400` | `draft_incomplete` | 보내는 데 필요한 것이 빠졌습니다. |
| `400` | `path_body_mismatch` | 본문의 `agent_id`가 토큰의 에이전트가 아닙니다. |
| `404` | `draft_not_found` | 이 에이전트에게 그런 초안이 없습니다. |
| `409` | `draft_revision_conflict` | 보낸 `revision` 뒤에 초안이 바뀌었습니다. 다시 읽습니다. |
| `409` | `draft_send_in_progress` | 다른 키로 보내는 중입니다. 그 키로 다시 불러 결과를 받습니다. |
| `409` | `draft_already_sent` | 이미 보냈습니다. 본문에 `message_id`가 있습니다. |
| `409` | `draft_discarded` | 버린 초안입니다. |
| `413` | `draft_too_large` | `text`와 `html`이 합쳐서 10 MiB를 넘습니다. |
| `429` | `draft_limit` | 열린 초안이 500개입니다. 보내거나 버립니다. |
