---
title: Labels API
nav_title: Labels API
description: Label received emails to organize the inbox, then filter the list by label, by unlabeled mail, or by read and unread.
group: api
order: 6
updated: 2026-10-15
keywords: [tag, folder, organize, unread]
related: [api/inbound, connect/mcp-tools]
---
Labels are the agent's own notes on received mail. They don't affect the policy, risk checks, or approvals. Both paths need the **Read** (`messages:read`) scope. Held mail can't be labeled and isn't counted.

## Set labels on an email {#set}

```http
PUT /v1/messages/inbound/{messageId}/labels
```

Send **one** of the two forms.

```json title="Replace every label"
{ "labels": ["invoice", "needs-reply"] }
```

```json title="Add and remove"
{ "add": ["done"], "remove": ["needs-reply"] }
```

The response is the email's labels after the change.

```json
{ "message_id": "e4b2…77d0", "labels": ["done", "invoice"] }
```

- A label is 1–64 characters: lowercase letters, digits, `.`, `_`, or `-`, starting with a letter or digit.
- An email can have up to 20 labels. An agent can use up to 200 different labels.
- Unknown or held mail gives `404 message_not_found`.

## List labels {#list}

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

`count` is how many visible emails have the label, and `unread` is how many of those haven't been opened yet.

## Filter the inbox {#filter}

[`GET /v1/messages/inbound`](/api/inbound#list) takes three more filters. Each email in the list also has `labels` and `read`.

| Query | Description |
|---|---|
| `label` | Only emails with this label |
| `unlabeled` | `true`: only emails with no label. Not with `label`. |
| `read` | `true`: only emails already opened; `false`: only unread |

An email counts as read the first time it's opened with [`GET /v1/messages/inbound/{messageId}`](/api/inbound#get) or the MCP `read_email` tool. Listing doesn't mark it read.

## Errors {#errors}

| Status | `error` | Meaning |
|---|---|---|
| `400` | `invalid_label` | A label isn't in the allowed form. |
| `400` | `label_limit` | The email would have more than 20 labels. |
| `400` | `path_body_mismatch` | `agent_id` in the body isn't the token's agent. |
| `409` | `agent_label_limit` | The agent already uses 200 different labels. Reuse one, or remove one everywhere first. |
