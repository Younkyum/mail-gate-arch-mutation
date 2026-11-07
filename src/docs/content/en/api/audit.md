---
title: Send decision records API
nav_title: Audit records API
description: GET /v1/audit shows why one email went out or was blocked.
group: api
order: 12
updated: 2026-09-27
related: [api/messages, api/errors, team/logs]
---
```http
GET /v1/audit?message_id={messageId}
```

Needs the **Audit** (`audit:read`) scope. `message_id` is the `message_id` from the send response.

The `attempts` array in the response has one record per attempt, usually just one.

| Field | Meaning |
|---|---|
| `decision` | One of `allowed`, `denied`, `pending_approval` |
| `reasons` | An array of reason codes. See [All reason codes](/api/errors#all-reasons). |
| `policy_version` | The policy version used for the decision |
| `evaluated_at` | When it was decided |
| `trace_id` | The tracking string you sent |
| `resolved_at` · `resolution_reason` | When the attempt ended, and how. Set for sends as well as approvals. Values: `sent`, `send_failed`, `approval_rejected`, `approval_expired`, `release_denied:<reason>` (blocked when re-checked after approval), `not_sent` (didn't go out for another reason) |

With no record you get `404 audit_not_found`; for another agent's message, `403 forbidden`.
