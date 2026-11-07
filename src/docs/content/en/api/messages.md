---
title: Send, reply, and forward API
nav_title: Messages API
description: Send new mail with POST /v1/messages, replies with /reply, and forwards with /forward. All three pass the same sending gate.
group: api
order: 2
updated: 2026-09-27
related: [api/overview, api/errors, email/sending]
---
All three paths need an `Idempotency-Key` header and the **Send** (`messages:send`) scope.

## Send new mail {#send}

```http
POST /v1/messages
```

| Field | Required | Description |
|---|---|---|
| `agent_id` | No | Defaults to the token's agent. If given, it must be the token's agent ID. |
| `from` | Yes | The agent's address, lowercase and without a `+tag` |
| `to` | Yes | An array of recipient addresses (not empty) |
| `subject` | Yes | Subject |
| `text` | Yes | Plain-text body |
| `html` | No | HTML body |
| `trace_id` | No | Your own tracking string. Kept in the audit record. |

:::feature attachments
To attach files, put an array of attachment IDs (up to 10) in `attachments`. Uploading and attachment errors are in the [Attachments API](/api/attachments).
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
    "text": "Hello, here is this week'"'"'s report."
  }'
```

## Results {#results}

| Status | Result | Body |
|---|---|---|
| `200` | Sent | `status: "sent"`, `message_id`, `message_id_header`, `provider_message_id`, `decision` |
| `202` | Awaiting approval | `status: "pending_approval"`, `message_id`, `approval_id`, `expires_at`, `decision` |
| `403` | Denied by policy | `error: "policy_denied"`, `message_id`, `decision` |
| `409` | Idempotency key conflict | `error: "idempotency_key_reused"` |
| `502` | Send failed | `error: "send_failed"`. Nothing went out. You can retry with a new key. |
| As above | Replayed | `replayed: true` with the message's current state. See [below](#replay). |

`provider_message_id` is the delivery ID assigned when the mail goes out. It's `null` until then.

`decision` holds the verdict (`verdict`), an array of reasons (`reasons`), the policy version (`policy_version`), when it was evaluated (`evaluated_at`), and how long to wait (`retry_after_seconds`).

```json title="Example 200 response"
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

Allowed sends carry `reasons` too. `allowlist_match` in the example above means every recipient was on the outbound allowlist. All codes are in [Reason codes](/api/errors#all-reasons).

A `403` isn't an outage; it's the policy doing its job. Retrying with the same key returns the same denial. After fixing the cause, or waiting `retry_after_seconds`, send with a **new** `Idempotency-Key`.

## Replayed requests {#replay}

Repeat the same request with the same `Idempotency-Key` and no second email goes out; you get the message's **current state** with `replayed: true`. The body has `status`, `message_id`, `message_id_header`, and `provider_message_id`, but no `decision`, `approval_id`, or `expires_at`. Read the decision with [`GET /v1/audit?message_id=…`](/api/audit) and the approval with [`GET /v1/approvals/{id}`](/api/approvals).

| Status | Current state |
|---|---|
| `200` | `status: "sent"`: went out |
| `202` | `status: "pending"` or `"dispatching"`: not sent yet (including awaiting approval) |
| `403` | `status: "denied"`, `error: "policy_denied"` |
| `502` | `status: "failed"`, `error: "send_failed"` |

## Reply {#reply}

```http
POST /v1/threads/{threadId}/reply
```

`threadId` is the received email's `thread_id`.

| Field | Required | Description |
|---|---|---|
| `agent_id` | No | Defaults to the token's agent. If given, it must be the token's agent ID. |
| `in_reply_to` | Yes | The `id` of the received email you're replying to |
| `text` | Yes | Plain-text body |
| `html` | No | HTML body |
| `to` | No | Defaults to the sender of that email |
| `subject` | No | Defaults to `Re: original subject` |
| `from` | No | Defaults to the address that received the email |

If the received email doesn't exist, you get `404 message_not_found`. Results are the same as for new mail.

:::feature attachments
Replies can carry files too, through `attachments`. [Attachments API](/api/attachments#attach)
:::

## Forward {#forward}

```http
POST /v1/messages/{messageId}/forward
```

`messageId` is the received email's `id`.

| Field | Required | Description |
|---|---|---|
| `agent_id` | No | Defaults to the token's agent. If given, it must be the token's agent ID. |
| `from` | Yes | The agent's address |
| `to` | Yes | An array of recipient addresses |
| `text` | No | A note placed above the forwarded email |
| `subject` | No | Defaults to `Fwd: original subject` |

- Only the original body text is carried over. Sending `html` returns `400`. Attachments aren't forwarded; `attachments_omitted` in the response says how many were left out.
- If the received email's `injection_risk` is anything other than `none`, the forward is refused with `422 forward_refused_injection_risk`. If the content matters, write a new email in your own words.
