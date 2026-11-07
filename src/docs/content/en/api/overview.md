---
title: Get started with the REST API
nav_title: API overview
description: Base URL, token authentication, agent_id, idempotency keys, cursors, and the error shape. Rules shared by every API page.
group: api
order: 1
updated: 2026-10-08
related: [api/discovery, api/messages, api/errors, connect/sdks]
---
## Base URL

```text
https://api.atmark.ai
```

Only the public identity lookup uses `https://id.atmark.ai`. See [Identity lookup](/api/identity).

An agent can set itself up from two public documents: the OpenAPI 3.1 description at `https://api.atmark.ai/v1/openapi.json` and the discovery document at `https://api.atmark.ai/.well-known/atmark.json`. See [Discovery](/api/discovery).

:::feature !sdkPublished
[SDKs for TypeScript and Python](/connect/sdks) are coming soon.
:::

:::feature sdkPublished
There are also [SDKs for TypeScript and Python](/connect/sdks): `npm install atmark-sdk` or `pip install atmark-sdk`.
:::

## Authentication {#auth}

Send the agent token in a header with every request. Never put it in the query string or body.

```http
Authorization: Bearer atk_agent_...
```

- A missing, wrong, revoked, or expired token returns `401 unauthorized`.
- A token without the needed scope, or a request for another agent's data, returns `403 forbidden`.
- Organization API keys (`atk_org_…`) don't work here. See [Organization API keys](/team/org-api-keys).

## agent_id {#agent-id}

An agent token belongs to exactly one agent, so you don't need to pass `agent_id`. Leave it out and the request uses the token's agent.

- `agent_id` in a body or query is **optional**. If you pass it, it must be the token's agent ID (32 lowercase hex characters). Another agent's ID returns `403 forbidden`, and a malformed one returns `400 invalid_request`.
- In paths, use `me` in place of `{agentId}`: `GET /v1/agents/me/policy` reads the token's agent. A real agent ID still works.
- Want the ID anyway? It's `agent.agent_id` in [`GET /v1/agents/me/capabilities`](/api/discovery#capabilities), and it's under **Identity › Identifiers** in the console.

## Idempotency keys {#idempotency}

Requests that send mail (new mail, replies, forwards, [sending a draft](/api/drafts#send)) or create schedules need an `Idempotency-Key` header (1–255 characters). Without it you get `400 idempotency_key_required`.

- Keys are scoped per agent and have no set expiry. Sending, replying, and forwarding share one key space; creating schedules has its own.
- Repeat the same request with the same key and no second email goes out. Instead you get the message's **current state** with `replayed: true`. See [Replayed requests](/api/messages#replay).
- Use the same key for a different request and you get `409 idempotency_key_reused`.
- After a timeout, a network error, a `500`, or a `503`, wait a little and retry with **the same key**. If the mail already went out, it won't go out twice.
- A key that got `403 policy_denied` stays denied. After fixing the cause, or waiting `retry_after_seconds`, send with a **new key**.

:::feature attachments
[Creating an attachment upload](/api/attachments) takes an `Idempotency-Key` too, optionally.
:::

## Lists and cursors {#pagination}

Lists take `limit` and `cursor` and return `next_cursor`. A `null` `next_cursor` means you've reached the end. Keep the same filters when asking for the next page.

## Error shape {#errors}

```json
{ "error": "invalid_request", "detail": "…" }
```

Only branch on `error`. `detail` is for people and its wording can change. A first `403 policy_denied` response carries `message_id` and `decision` instead of `detail`. See [Messages](/api/messages#results). See [Error codes](/api/errors).

## Times

All times are ISO 8601 UTC strings, for example `2026-09-27T09:00:00.000Z`.

## Endpoints

| Method | Path | Docs |
|---|---|---|
| `POST` | `/v1/messages` | [Messages](/api/messages) |
| `POST` | `/v1/threads/{threadId}/reply` | [Messages](/api/messages#reply) |
| `POST` | `/v1/messages/{messageId}/forward` | [Messages](/api/messages#forward) |
| `GET` | `/v1/messages/inbound` | [Received mail](/api/inbound) |
| `GET` | `/v1/messages/inbound/{messageId}` | [Received mail](/api/inbound#get) |
| `GET` | `/v1/messages/inbound/{messageId}/attachments/{index}` | [Received mail](/api/inbound#attachment) |
| `GET` | `/v1/messages/inbound/{messageId}/attachments/{index}/content` | [Received mail](/api/inbound#attachment-content) |
| `PUT` | `/v1/messages/inbound/{messageId}/labels` | [Labels](/api/labels) |
| `GET` | `/v1/labels` | [Labels](/api/labels#list) |
| `POST` · `GET` | `/v1/drafts` | [Drafts](/api/drafts) |
| `GET` · `PATCH` | `/v1/drafts/{draftId}` | [Drafts](/api/drafts#update) |
| `POST` | `/v1/drafts/{draftId}/discard` · `/v1/drafts/{draftId}/send` | [Drafts](/api/drafts#send) |
| `GET` | `/v1/threads/{threadId}` | [Threads](/api/threads) |
| `GET` | `/v1/approvals/{approvalId}` | [Approvals](/api/approvals) |
| `GET` | `/v1/agents/{agentId}/policy` | [Policy](/api/policy) |
| `POST` · `GET` | `/v1/messages/scheduled` | [Scheduled email](/api/scheduled) |
| `GET` | `/v1/messages/scheduled/{scheduleId}` | [Scheduled email](/api/scheduled#get) |
| `POST` | `/v1/messages/scheduled/{scheduleId}/cancel` | [Scheduled email](/api/scheduled#cancel) |
| `GET` | `/v1/messages/verification-code` | [Verification codes](/api/verification-code) |
| `GET` | `/v1/audit` | [Audit records](/api/audit) |
| `POST` · `GET` · `DELETE` | `/v1/agents/{agentId}/webhook-endpoints…` | [Webhooks](/api/webhooks) |
| `GET` · `POST` | `/v1/agents/{agentId}/webhook-deliveries…` | [Webhooks](/api/webhooks#deliveries) |
| `POST` | `/v1/agents` | [Create agents](/api/agents) |
| `GET` | `/v1/agents/{agentId}/capabilities` | [Discovery](/api/discovery#capabilities) |
| `GET` | `/v1/agents/{agentId}/realtime` | [Realtime](/api/realtime) |
| `GET` | `/v1/openapi.json` · `/.well-known/atmark.json` | [Discovery](/api/discovery) |
| `GET` | `https://id.atmark.ai/v1/identity/{address}` | [Identity lookup](/api/identity) |

:::feature attachments
| Method | Path | Docs |
|---|---|---|
| `POST` | `/v1/attachments` | [Attachments](/api/attachments) |
:::
