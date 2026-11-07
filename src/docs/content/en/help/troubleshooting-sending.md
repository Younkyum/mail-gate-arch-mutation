---
title: When mail doesn't go out
description: Use the send result and reason code to find out why mail was blocked, and fix it.
keywords: [email not sent, delivery failed]
group: help
order: 2
updated: 2026-10-13
related: [api/errors, email/sending, team/logs]
---
Start with the result: the one the agent got, or the result and reason on the console's **Logs › Outbound** tab.

## The result is `denied`

Fix it based on the reason code. Blocked mail isn't retried on its own. After fixing the cause, ask the agent to send it again **with a new idempotency key**: over MCP, pass a new `idempotency_key`; over REST, use a new `Idempotency-Key` header. Retrying with the same key (over MCP, the same arguments) returns the original denial even after the fix.

| Reason | Fix |
|---|---|
| `recipient_not_allowlisted` | Add the recipient to the allowlist under **Email › Outbound**, or approve the agent's change request at the top of that screen. See [Allowlists and blocklists](/email/allow-block-lists). |
| `recipient_blocklisted` | Remove them from the outbound blocklist. The blocklist beats the allowlist. |
| `outbound_disabled` | The outbound mode is **Block all**. Save another mode. |
| `org_pending_review` | Operator review is in progress. New sign-ups don't get this reason; it can only remain on organizations that signed up earlier. Sending opens when it's done. See [Plans and operator actions](/get-started/beta-and-review). |
| `org_owner_paused` · `agent_not_active` | The organization or agent is under an emergency stop. See [Emergency stop](/email/emergency-stop). |
| `rate_limit_per_minute` and similar | A limit was reached. See [Sending limits](/email/limits-and-deliverability). |
| `suppression_list` | The address has a history of bounces or spam reports. Check the address. |
| `daily_send_limit` | The organization's daily sending limit was reached. For new organizations it rises over the first weeks after the first send. Send later. |
| `plan_daily_cap` | The plan's daily recipient limit was reached. Send tomorrow. Payments aren't open during the beta, so you can't upgrade yet. |

More common reasons are in [Error codes](/api/errors#reasons).

## The result is `pending_approval`

The agent is on an old outbound mode. Approve from the link in the email sent to the primary owner. The agent should wait, not resend. See [Approvals](/email/approvals).

## The result is `sent` but it never arrived

- Ask the recipient to check their spam folder.
- Open the record in **Logs › Outbound** and check its delivery events (delivered, bounced, reported as spam).

## A reply is blocked

Replies follow the outbound policy too. In allowlist mode, the person you're replying to must be on the list.
