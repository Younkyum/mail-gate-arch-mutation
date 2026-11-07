---
title: Scheduled email API
nav_title: Scheduled email API
description: Schedule mail for a set time, list schedules, and cancel them. The policy is checked at send time.
group: api
order: 10
updated: 2026-09-27
related: [email/scheduled, api/messages, team/logs]
---
## Create a schedule {#create}

```http
POST /v1/messages/scheduled
```

Needs an `Idempotency-Key` header and the **Send** (`messages:send`) scope. The body is the same as for [new mail](/api/messages#send), plus two fields.

| Field | Required | Description |
|---|---|---|
| `send_at` | Yes | When to send (ISO 8601). Within 30 days, and not in the past. |
| `agent_cancellable` | No | Defaults to `true`. With `false`, agent tokens can't cancel it; only the owner can, in the console. It can't be changed afterwards. |

The response is `202` with `schedule_id`, `status`, `send_at`, and `agent_cancellable`. The policy isn't checked at this point. It's checked at send time, and if the mail is blocked then, it doesn't go out.

## List {#list}

```http
GET /v1/messages/scheduled
```

**Read** scope. Filter with `status` (`scheduled`, `dispatched`, `cancelled`), `limit` (1–50), and `cursor`. The response has a `schedules` array and `next_cursor`.

## Get one {#get}

```http
GET /v1/messages/scheduled/{scheduleId}
```

The same as a list item, plus `subject`. Items include `send_at`, `recipients`, `from_address`, `cancelled_at`, `cancel_reason_code`, `cancelled_via`, `dispatch_outcome`, and `message_id`.

## Cancel {#cancel}

```http
POST /v1/messages/scheduled/{scheduleId}/cancel
```

**Send** scope. `reason_code` is required in the body; `note` is optional.

`reason_code`: `no_longer_needed`, `wrong_recipient`, `wrong_content`, `wrong_time`, `duplicate`, `owner_request`, `other`

| Response | Meaning |
|---|---|
| `200` | Cancelled |
| `403 schedule_not_agent_cancellable` | The agent isn't allowed to cancel this one. Ask the owner. |
| `409 schedule_already_dispatched` | Already sent. It can't be recalled. |
| `409 schedule_in_flight` | Being sent right now. Check the status again shortly. |
| `429 cancel_rate_limited` | The hourly cancellation limit was reached. |

The reason and channel are kept permanently, and the owner sees them in the console logs.
