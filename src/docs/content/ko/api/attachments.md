---
title: 첨부 올리기 API
nav_title: 첨부 API
description: POST /v1/attachments로 올릴 자리를 받고 파일을 올린 뒤, 첨부 id를 새 메일과 회신의 attachments에 넣습니다.
group: api
order: 3
feature: attachments
updated: 2026-10-08
related: [email/attachments, api/messages, api/errors]
---
첨부는 세 단계입니다. 올릴 자리를 만들고, 파일을 올리고, 메일에 id를 적어 보냅니다. 올리기에도 **보내기**(`messages:send`) 권한이 필요합니다. 여기서 `Idempotency-Key` 헤더는 선택입니다.

- **키를 주면** 같은 요청을 다시 보냈을 때 같은 첨부 id와 새로 서명한 올릴 주소가 옵니다(`200`, `replayed: true`). 새 첨부가 생기지 않고 하루 한도에도 세지 않습니다. 같은 키로 다른 요청을 보내면 `409 idempotency_key_reused`입니다. 첨부가 만료된 뒤 그 키를 쓰면 `409 attachment_expired`이니 새 키를 씁니다.
- **키가 없으면** 부를 때마다 새 첨부 id가 생깁니다.

## 올릴 자리 만들기 {#create}

```http
POST /v1/attachments
```

| 필드 | 필수 | 설명 |
|---|---|---|
| `agent_id` | 아니요 | 빼면 토큰의 에이전트. 넣으면 토큰의 에이전트 ID여야 합니다. |
| `filename` | 예 | 받는 사람에게 보일 파일 이름. 1–255자. 끝이 종류와 맞아야 합니다. 점이 없으면 종류에 맞는 끝을 붙입니다. |
| `mime_type` | 예 | `application/pdf` · `image/png` · `image/jpeg` · `text/plain` |
| `bytes` | 예 | 파일 크기(바이트) |
| `sha256` | 예 | 파일의 SHA-256. 소문자 16진수 64자 |

```bash
curl -sS https://api.atmark.ai/v1/attachments \
  -H "Authorization: Bearer $ATMARK_AGENT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "filename": "보고서.pdf",
    "mime_type": "application/pdf",
    "bytes": 48213,
    "sha256": "9f86…0a08"
  }'
```

```json title="201 응답 예시"
{
  "replayed": false,
  "attachment_id": "3b0c…9e21",
  "filename": "보고서.pdf",
  "expires_at": "2026-09-30T09:00:00.000Z",
  "upload": {
    "method": "PUT",
    "url": "https://…",
    "headers": { "…": "…" },
    "expires_at": "2026-09-28T09:15:00.000Z"
  }
}
```

- `filename`은 실제로 저장된 이름입니다. 끝을 붙였으면 붙인 이름이 옵니다.
- `expires_at`(첨부)은 2일 뒤입니다. 그 전에 보내야 합니다.
- `upload.expires_at`(올릴 주소)은 15분 뒤입니다.

## 파일 올리기 {#upload}

`upload.url`에 `upload.method`로 파일 바이트를 보냅니다. **`upload.headers`를 하나도 빼거나 바꾸지 말고 그대로** 붙입니다. 크기·SHA-256이 선언과 다르거나 같은 주소로 두 번 올리면 거부됩니다. 이 요청에는 에이전트 토큰을 붙이지 않습니다.

```js title="Node.js 예시"
const res = await fetch(upload.url, { method: upload.method, headers: upload.headers, body: fileBytes });
if (!res.ok) throw new Error(`upload failed: ${res.status}`);
```

올린 뒤 악성코드 검사가 곧바로 시작됩니다. 보통 몇 초면 끝납니다. 따로 알림은 없습니다. 보내 보면 결과로 알 수 있습니다.

## 메일에 붙이기 {#attach}

[새 메일](/api/messages#send)과 [회신](/api/messages#reply) 본문에 `attachments`를 넣습니다.

| 필드 | 필수 | 설명 |
|---|---|---|
| `attachments` | 아니요 | 첨부 id 배열. 10개까지, 같은 id는 한 번만. 순서대로 붙습니다. |

```json
{ "from": "scout@atmark.ai", "to": ["partner@example.com"], "subject": "보고서", "text": "첨부를 보세요.", "attachments": ["3b0c…9e21"] }
```

- 검사가 아직이면 `409 attachment_scan_pending`입니다. 메시지가 만들어지지 않으니 **같은 `Idempotency-Key`로** 잠시 뒤 다시 보냅니다.
- 같은 첨부는 여러 메일에 쓸 수 있습니다(첨부 하나당 50통까지).
- 전달(`/forward`)과 예약 발송은 `attachments`를 받지 않습니다. 넣으면 `400 attachments_not_supported`입니다.

## 오류 {#errors}

올릴 자리를 만들 때:

| 상태 | `error` | 뜻 |
|---|---|---|
| `400` | `invalid_request` | 필드가 없거나 모양이 틀렸습니다. |
| `400` | `attachment_type_not_allowed` | 받지 않는 `mime_type`입니다. |
| `400` | `attachment_filename_extension_mismatch` | 파일 이름 끝이 `mime_type`과 맞지 않습니다. |
| `400` | `attachment_filename_invalid` | 파일 이름에 쓸 수 없는 꼴이 들어 있습니다. |
| `400` | `attachment_too_large` | 파일 하나가 메일 한 통 첨부 한도보다 큽니다. `text/plain`은 1 MB까지입니다. |
| `403` | `agent_not_active` · `organization_not_sending` | 지금 이 에이전트나 조직은 보낼 수 없습니다. |
| `429` | `attachment_daily_limit` | 에이전트의 하루 한도(24시간 100개 또는 200 MB)에 닿았습니다. |
| `409` | `idempotency_key_reused` | 그 `Idempotency-Key`를 다른 올리기에 썼습니다. |
| `409` | `attachment_expired` | 이 `Idempotency-Key`로 만든 첨부가 만료됐습니다. 새 키를 씁니다. |
| `429` | `attachment_org_daily_limit` | 조직의 하루 한도(24시간 1 GB)에 닿았습니다. |

메일에 붙일 때:

| 상태 | `error` | 뜻 |
|---|---|---|
| `400` | `attachment_malicious` | 악성코드가 나왔습니다. 그 파일은 보낼 수 없습니다. |
| `400` | `attachment_scan_failed` | 검사를 끝내지 못했습니다. 다시 올립니다. |
| `400` | `attachment_integrity_mismatch` | 올린 파일의 크기나 SHA-256이 선언과 다릅니다. |
| `400` | `attachment_content_mismatch` | 내용이 선언한 종류가 아닙니다. |
| `400` | `attachment_bytes_exceeded` | 첨부 합계가 메일 한 통 한도를 넘습니다. |
| `400` | `attachment_type_not_allowed` | 이 에이전트의 정책이 그 종류를 허용하지 않습니다. |
| `404` | `attachment_not_found` | 없거나 다른 에이전트의 첨부입니다. |
| `409` | `attachment_scan_pending` | 검사 중입니다. 같은 요청을 잠시 뒤 다시 보냅니다. |
| `409` | `attachment_not_uploaded` | 아직 파일을 올리지 않았습니다. |
| `409` | `attachment_expired` | 올린 지 2일이 지났습니다. 다시 올립니다. |
| `409` | `attachment_link_limit` | 이 첨부를 이미 50통에 썼습니다. 다시 올립니다. |
| `503` | `attachment_check_timeout` | 확인이 오래 걸렸습니다. 같은 `Idempotency-Key`로 다시 보냅니다. |

첨부 오류가 오면 메일은 나가지 않습니다.
