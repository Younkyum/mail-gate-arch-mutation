---
title: Get a thread API
nav_title: Threads API
description: GET /v1/threads/{threadId} returns the sent and received mail of one conversation, oldest first.
group: api
order: 7
updated: 2026-10-15
related: [api/inbound, api/messages]
---
```http
GET /v1/threads/{threadId}
```

Needs the **Read** (`messages:read`) scope. `threadId` is a received email's `thread_id`.

| Field | Meaning |
|---|---|
| `id` · `agent_id` | Thread and agent IDs |
| `started_by` | Who started the conversation |
| `subject` | The thread subject |
| `created_at` · `last_message_at` | When it started and when the last message came |
| `messages` | Sent and received mail, oldest first. Each entry has a `direction` (`outbound` or `inbound`). |
| `quarantined.count` | How many messages in this thread were held |

A missing thread returns `404 thread_not_found`. Send replies with the [reply API](/api/messages#reply).
