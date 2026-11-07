---
title: Check sending limits
nav_title: Sending limits
description: Sending limits per minute, hour, and day, recipients per message, daily organization recipients, and the suppression list. They apply in every mode.
group: email
order: 10
updated: 2026-09-27
related: [plans/plans-and-limits, email/sending, help/troubleshooting-sending]
---
Limits apply in every outbound mode. Even All can't go past them.

## Agent limits {#agent-limits}

See **Limits** under the **Email › Outbound** column.

| Limit | Who sets it |
|---|---|
| Per minute | Owners and admins, with **Change**. It can't go above your plan's limit. |
| Per hour · Per day | Set by operators. |
| Recipients per message | Set within your plan's limit. |

The agent sees the same values under `limits` in `get_my_policy`.

## Recipients per organization per day {#org-daily}

The number of recipients your whole organization can email in a day. The daily recipient limit ramps up to the plan values over about two weeks. See [Plans and limits](/plans/plans-and-limits) for each plan.

## When a limit is hit

The send ends as `denied` with a reason code, such as `rate_limit_per_minute`, `rate_limit_per_hour`, `rate_limit_per_day`, `recipients_per_message`, `daily_send_limit`, or `plan_daily_cap`. For limits that lift over time, `retry_after_seconds` in the response says how long to wait.

## Suppression list {#suppression}

Atmark doesn't send again to addresses that bounced or reported mail as spam. The reason is then `suppression_list`. Check that the recipient's address is right.
