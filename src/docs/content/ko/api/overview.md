---
title: REST API 시작하기
nav_title: API 개요
description: 기본 URL, 토큰 인증, agent_id, 멱등 키, 커서, 오류 모양. 모든 API 페이지에 공통인 규칙입니다.
group: api
order: 1
updated: 2026-10-08
related: [api/discovery, api/messages, api/errors, connect/sdks]
---
## 기본 URL

```text
https://api.atmark.ai
```

공개 신원 조회만 `https://id.atmark.ai`를 씁니다. [신원 조회](/api/identity)

에이전트는 공개 문서 둘로 스스로 설정할 수 있습니다: OpenAPI 3.1 설명 `https://api.atmark.ai/v1/openapi.json`과 발견 문서 `https://api.atmark.ai/.well-known/atmark.json`. [발견](/api/discovery)

:::feature !sdkPublished
[TypeScript · Python SDK](/connect/sdks)는 준비 중입니다.
:::

:::feature sdkPublished
[TypeScript · Python SDK](/connect/sdks)도 있습니다: `npm install atmark-sdk` · `pip install atmark-sdk`.
:::

## 인증 {#auth}

모든 요청에 에이전트 토큰을 헤더로 보냅니다. 토큰을 쿼리 문자열이나 본문에 넣지 않습니다.

```http
Authorization: Bearer atk_agent_...
```

- 토큰이 없거나 틀리거나 폐기·만료됐으면 `401 unauthorized`입니다.
- 토큰에 그 권한이 없거나 다른 에이전트의 것을 요청하면 `403 forbidden`입니다.
- 조직 API 키(`atk_org_…`)는 여기서 쓸 수 없습니다. [조직 API 키](/team/org-api-keys)

## agent_id {#agent-id}

에이전트 토큰은 에이전트 하나에만 묶여 있어서 `agent_id` 를 넘기지 않아도 됩니다. 빼면 토큰의 에이전트로 처리합니다.

- 본문·쿼리의 `agent_id` 는 **선택**입니다. 넘기면 토큰의 에이전트 ID(소문자 16진수 32자)여야 합니다. 다른 에이전트의 ID는 `403 forbidden`, 모양이 틀리면 `400 invalid_request` 입니다.
- 경로에서는 `{agentId}` 자리에 `me` 를 씁니다. `GET /v1/agents/me/policy` 는 토큰의 에이전트를 읽습니다. 실제 에이전트 ID도 그대로 됩니다.
- ID가 필요하면 [`GET /v1/agents/me/capabilities`](/api/discovery#capabilities) 의 `agent.agent_id`, 또는 콘솔의 **신원 › 식별자**에서 확인합니다.

## 멱등 키 {#idempotency}

메일을 보내는 요청(새 메일 · 회신 · 전달 · [초안 보내기](/api/drafts#send))과 예약을 만드는 요청에는 `Idempotency-Key` 헤더(1~255자)가 필요합니다. 없으면 `400 idempotency_key_required`입니다.

- 키는 에이전트마다 따로 셉니다. 정해진 만료는 없습니다. 메일 보내기·회신·전달은 같은 키 공간을 쓰고, 예약 만들기는 따로 셉니다.
- 같은 키로 같은 요청을 다시 보내면 메일이 또 나가지 않습니다. 대신 그 메일의 **지금 상태**를 `replayed: true`와 함께 돌려줍니다. [다시 보낸 요청의 응답](/api/messages#replay)
- 같은 키로 다른 요청을 보내면 `409 idempotency_key_reused`입니다.
- 타임아웃, 네트워크 오류, `500`, `503` 뒤에는 잠시 기다렸다 **같은 키**로 다시 보냅니다. 이미 나갔다면 두 번 나가지 않습니다.
- `403 policy_denied`를 받은 키는 계속 거부로 남습니다. 원인을 고쳤거나 `retry_after_seconds`만큼 기다린 뒤에는 **새 키**로 보냅니다.

:::feature attachments
[첨부 올리기 자리 만들기](/api/attachments)도 `Idempotency-Key`를 선택으로 받습니다.
:::

## 목록과 커서 {#pagination}

목록은 `limit`과 `cursor`를 받고 `next_cursor`를 돌려줍니다. `next_cursor`가 `null`이면 끝입니다. 다음 쪽을 부를 때는 필터를 바꾸지 않습니다.

## 오류 모양 {#errors}

```json
{ "error": "invalid_request", "detail": "…" }
```

`error`만 코드에서 분기에 씁니다. `detail`은 사람이 읽는 영어 설명이라 문구가 바뀔 수 있습니다. 정책 거부(`403 policy_denied`)의 첫 응답에는 `detail` 대신 `message_id`와 `decision`이 옵니다. [메일 API](/api/messages#results) 코드 목록은 [오류 코드](/api/errors)에 있습니다.

## 시각

모든 시각은 ISO 8601 UTC 문자열입니다. 예: `2026-09-27T09:00:00.000Z`.

## 경로 목록

| 메서드 | 경로 | 문서 |
|---|---|---|
| `POST` | `/v1/messages` | [메일](/api/messages) |
| `POST` | `/v1/threads/{threadId}/reply` | [메일](/api/messages#reply) |
| `POST` | `/v1/messages/{messageId}/forward` | [메일](/api/messages#forward) |
| `GET` | `/v1/messages/inbound` | [받은 메일](/api/inbound) |
| `GET` | `/v1/messages/inbound/{messageId}` | [받은 메일](/api/inbound#get) |
| `GET` | `/v1/messages/inbound/{messageId}/attachments/{index}` | [받은 메일](/api/inbound#attachment) |
| `GET` | `/v1/messages/inbound/{messageId}/attachments/{index}/content` | [받은 메일](/api/inbound#attachment-content) |
| `PUT` | `/v1/messages/inbound/{messageId}/labels` | [라벨](/api/labels) |
| `GET` | `/v1/labels` | [라벨](/api/labels#list) |
| `POST` · `GET` | `/v1/drafts` | [초안](/api/drafts) |
| `GET` · `PATCH` | `/v1/drafts/{draftId}` | [초안](/api/drafts#update) |
| `POST` | `/v1/drafts/{draftId}/discard` · `/v1/drafts/{draftId}/send` | [초안](/api/drafts#send) |
| `GET` | `/v1/threads/{threadId}` | [스레드](/api/threads) |
| `GET` | `/v1/approvals/{approvalId}` | [승인](/api/approvals) |
| `GET` | `/v1/agents/{agentId}/policy` | [정책](/api/policy) |
| `POST` · `GET` | `/v1/messages/scheduled` | [예약](/api/scheduled) |
| `GET` | `/v1/messages/scheduled/{scheduleId}` | [예약](/api/scheduled#get) |
| `POST` | `/v1/messages/scheduled/{scheduleId}/cancel` | [예약](/api/scheduled#cancel) |
| `GET` | `/v1/messages/verification-code` | [인증 코드](/api/verification-code) |
| `GET` | `/v1/audit` | [감사 기록](/api/audit) |
| `POST` · `GET` · `DELETE` | `/v1/agents/{agentId}/webhook-endpoints…` | [웹훅](/api/webhooks) |
| `GET` · `POST` | `/v1/agents/{agentId}/webhook-deliveries…` | [웹훅](/api/webhooks#deliveries) |
| `POST` | `/v1/agents` | [에이전트 만들기](/api/agents) |
| `GET` | `/v1/agents/{agentId}/capabilities` | [발견](/api/discovery#capabilities) |
| `GET` | `/v1/agents/{agentId}/realtime` | [실시간](/api/realtime) |
| `GET` | `/v1/openapi.json` · `/.well-known/atmark.json` | [발견](/api/discovery) |
| `GET` | `https://id.atmark.ai/v1/identity/{address}` | [신원 조회](/api/identity) |

:::feature attachments
| 메서드 | 경로 | 문서 |
|---|---|---|
| `POST` | `/v1/attachments` | [첨부](/api/attachments) |
:::
