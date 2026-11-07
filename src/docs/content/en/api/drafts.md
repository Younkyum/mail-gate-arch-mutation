---
title: Drafts API
nav_title: Drafts API
description: Save an email as a draft, change it as often as you like, then send it once through the same policy as every other send.
group: api
order: 4
updated: 2026-10-15
keywords: [draft, save for later, compose]
related: [api/messages, api/inbound, api/errors]
---
A draft is an email that hasn't gone out yet. Nothing is checked or sent while you save it. The owner's policy applies once, when you send it. Every draft path needs the **Send** (`messages:send`) scope, including reading drafts.

## Create a draft {#create}

```http
POST /v1/drafts
```

Every field is optional, so a draft can be incomplete.

| Field | Required | Description |
|---|---|---|
| `agent_id` | No | Defaults to the token's agent. If given, it must be the token's agent ID. |
| `from` | No | A sending address of this agent, lowercase and without a `+tag` |
| `to` | No | Up to 50 recipient addresses |
| `subject` | No | Up to 998 characters |
| `text` · `html` | No | The body. Together up to 10 MiB. |
| `in_reply_to` | No | The ID of a received email, to make this a reply draft |
| `attachments` | No | Up to 10 uploaded attachment IDs |

```bash
curl -sS https://api.atmark.ai/v1/drafts \
  -H "Authorization: Bearer $ATMARK_AGENT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "from": "scout@atmark.ai",
    "to": ["partner@example.com"],
    "subject": "Weekly report",
    "text": "Draft. Numbers to follow."
  }'
```

```json title="Example 201 response"
{
  "id": "5d1e…0b7c",
  "agent_id": "7c21…f5a1",
  "revision": 1,
  "status": "active",
  "from": "scout@atmark.ai",
  "to": ["partner@example.com"],
  "subject": "Weekly report",
  "in_reply_to": null,
  "attachments": [],
  "size_bytes": 54,
  "created_at": "2026-10-08T09:00:00.000Z",
  "updated_at": "2026-10-08T09:00:00.000Z",
  "discarded_at": null,
  "sent_at": null,
  "message_id": null,
  "text": "Draft. Numbers to follow.",
  "html": null
}
```

- A reply draft (`in_reply_to`) must point to a received email this agent can see. Held or unknown mail gives `404 message_not_found`. When it's sent, empty fields default the way a [reply](/api/messages#reply) does: to the sender, with `Re: …`, from the address that received it.
- An agent can have up to 500 open drafts. Past that you get `429 draft_limit`.

## List and read {#list}

```http
GET /v1/drafts
GET /v1/drafts/{draftId}
```

The list is newest change first, without bodies. Filter with `status`: `active` (default), `sent`, `discarded`, or `all`. It takes `limit` (1–100) and `cursor`. Reading one draft returns its `text` and `html` too.

| `status` | Meaning |
|---|---|
| `active` | Can still change and be sent |
| `sending` | A send has started. It can't change. |
| `sent` | Sent. `message_id` is the outbound email. |
| `discarded` | Discarded. Kept for the record. |

## Change a draft {#update}

```http
PATCH /v1/drafts/{draftId}
```

Send only the fields you want to change. A missing field stays as it was; `null` clears it. Each change raises `revision` by one.

To avoid overwriting someone else's change, send the `revision` you last read. If the draft changed since then, you get `409 draft_revision_conflict`; read it again and retry. A draft that's being sent, sent, or discarded can't change.

## Discard {#discard}

```http
POST /v1/drafts/{draftId}/discard
```

Nothing is deleted. The draft stays with `status: "discarded"` and can't be changed or sent. Discarding it again returns the same result.

## Send {#send}

```http
POST /v1/drafts/{draftId}/send
Idempotency-Key: 2026-10-08-weekly-report
```

The draft goes out as saved. To change it, `PATCH` first. The send body is optional and only takes `agent_id` and `trace_id`, both optional.

- It passes the same gate as [`POST /v1/messages`](/api/messages): the policy, limits, risk checks, and the owner's [send approval](/security/watch#send-approval). The results are the same (`sent`, `pending_approval`, `403 policy_denied`), with `draft_id` and `draft_status` added.
- `Idempotency-Key` is required. Retrying with the same key returns the first result. A draft is sent at most once: once the gate has decided (sent, denied, awaiting approval, or failed), the draft is closed, and a different key gets `409 draft_already_sent` with the `message_id`.
- If the send stops before the gate, such as for a missing field or an attachment error, the draft stays `active`. Fix it and send again.
- A missing `from`, recipient, or subject gives `400 draft_incomplete`. `detail` says which.

## Errors {#errors}

| Status | `error` | Meaning |
|---|---|---|
| `400` | `draft_incomplete` | The draft is missing something it needs to be sent. |
| `400` | `path_body_mismatch` | `agent_id` in the body isn't the token's agent. |
| `404` | `draft_not_found` | No such draft for this agent. |
| `409` | `draft_revision_conflict` | The draft changed since the `revision` you sent. Read it again. |
| `409` | `draft_send_in_progress` | It's being sent with another key. Retry with that key to get the result. |
| `409` | `draft_already_sent` | It was already sent. `message_id` is in the body. |
| `409` | `draft_discarded` | It was discarded. |
| `413` | `draft_too_large` | `text` and `html` together are over 10 MiB. |
| `429` | `draft_limit` | The agent has 500 open drafts. Send or discard some. |
