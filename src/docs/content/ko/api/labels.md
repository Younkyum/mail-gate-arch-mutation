---
title: 라벨 API
nav_title: 라벨 API
description: 받은 메일에 라벨을 붙여 받은편지함을 정리하고, 라벨 · 라벨 없음 · 읽음 여부로 목록을 거릅니다.
group: api
order: 6
updated: 2026-10-15
keywords: [태그, 폴더, 정리, 안 읽음]
related: [api/inbound, connect/mcp-tools]
---
라벨은 에이전트가 받은 메일에 붙이는 자기 메모입니다. 정책 · 위험 검사 · 승인에 쓰이지 않습니다. 두 경로 모두 **읽기**(`messages:read`) 권한이 필요합니다. 보류된 메일에는 붙일 수 없고 개수에도 들어가지 않습니다.

## 메일에 라벨 붙이기 {#set}

```http
PUT /v1/messages/inbound/{messageId}/labels
```

두 모양 중 **하나**만 보냅니다.

```json title="라벨을 통째로 바꾸기"
{ "labels": ["invoice", "needs-reply"] }
```

```json title="더하고 빼기"
{ "add": ["done"], "remove": ["needs-reply"] }
```

응답은 바뀐 뒤의 라벨입니다.

```json
{ "message_id": "e4b2…77d0", "labels": ["done", "invoice"] }
```

- 라벨은 1~64자: 영문 소문자, 숫자, `.`, `_`, `-`. 첫 글자는 영문자나 숫자입니다.
- 메일 한 통에 20개, 에이전트 하나가 쓰는 서로 다른 라벨은 200개까지입니다.
- 없거나 보류된 메일이면 `404 message_not_found`입니다.

## 라벨 목록 {#list}

```http
GET /v1/labels
```

```json
{
  "agent_id": "7c21…f5a1",
  "labels": [
    { "label": "invoice", "count": 12, "unread": 3 },
    { "label": "needs-reply", "count": 4, "unread": 4 }
  ],
  "limits": { "per_message": 20, "per_agent": 200 }
}
```

`count`는 그 라벨이 붙은 보이는 메일 수, `unread`는 그중 아직 열지 않은 메일 수입니다.

## 받은편지함 거르기 {#filter}

[`GET /v1/messages/inbound`](/api/inbound#list)가 필터 셋을 더 받습니다. 목록의 메일마다 `labels`와 `read`도 옵니다.

| 쿼리 | 설명 |
|---|---|
| `label` | 이 라벨이 붙은 메일만 |
| `unlabeled` | `true`: 라벨이 없는 메일만. `label`과 함께 쓸 수 없습니다. |
| `read` | `true`: 이미 연 메일만, `false`: 안 읽은 메일만 |

메일은 [`GET /v1/messages/inbound/{messageId}`](/api/inbound#get)나 MCP `read_email`로 처음 열 때 읽음이 됩니다. 목록만 봐서는 읽음이 되지 않습니다.

## 오류 {#errors}

| 상태 | `error` | 뜻 |
|---|---|---|
| `400` | `invalid_label` | 라벨 모양이 틀렸습니다. |
| `400` | `label_limit` | 메일 한 통의 라벨이 20개를 넘게 됩니다. |
| `400` | `path_body_mismatch` | 본문의 `agent_id`가 토큰의 에이전트가 아닙니다. |
| `409` | `agent_label_limit` | 서로 다른 라벨을 이미 200개 씁니다. 있는 라벨을 쓰거나 하나를 모든 메일에서 뺀 뒤 씁니다. |
