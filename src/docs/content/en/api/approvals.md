---
title: Check approval status API
nav_title: Approvals API
description: When a send returns pending_approval, check the approval request's status with its approval_id.
group: api
order: 8
updated: 2026-09-27
related: [email/approvals, api/webhooks, api/messages]
---
```http
GET /v1/approvals/{approvalId}
```

Needs the **Read** (`messages:read`) scope. `approvalId` is the `approval_id` from a `202` send result.

| Field | Meaning |
|---|---|
| `id` · `agent_id` | Approval request and agent IDs |
| `kind` | `message` (one email) or `batch` (several at once) |
| `status` | One of `pending`, `approved`, `rejected`, `expired` |
| `created_at` · `expires_at` · `decided_at` | When it was requested, its deadline, and when it was decided |
| `granted_scope` | The approved scope: `recipient` (those recipients), `thread` (that thread), `domain` (the whole recipient domain), or `once` (this one email only — always the case for a send held for risk signals, `risk_review`; it doesn't let later emails to those recipients skip approval). `null` before approval and when rejected or expired |
| `message_ids` | The messages tied to this request |

If it doesn't exist, you get `404 approval_not_found`.

## How to wait

- Don't resend the same mail. A new send just creates a new approval request.
- Rather than polling, listen for the `approval.resolved` and `approval.expired` webhooks. See [Webhooks](/api/webhooks).
- Once approved, Atmark sends the mail. The agent doesn't need to send it again.

Approvals only happen for agents on an old outbound mode. See [Handle send approval requests](/email/approvals).
