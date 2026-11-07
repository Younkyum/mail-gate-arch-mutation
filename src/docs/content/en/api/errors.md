---
title: Error codes
description: The error codes the API returns, the send denial reasons, and what to do about each.
group: api
order: 18
updated: 2026-10-15
related: [api/overview, help/troubleshooting-sending, help/troubleshooting-connection]
---
Error responses usually look like `{"error": "...", "detail": "..."}`. Only branch on `error`. A first `403 policy_denied` response carries `decision` instead of `detail`.

## HTTP errors {#http}

| Status | `error` | Meaning and what to do |
|---|---|---|
| `400` | `invalid_request` | The request is malformed. Fix it using `detail`. |
| `400` | `invalid_recipient` | An address can't receive mail in that form. Use plain `local@domain` addresses. |
| `400` | `idempotency_key_required` | Add an `Idempotency-Key` header. |
| `401` | `unauthorized` | The token is missing, wrong, revoked, or expired. |
| `403` | `forbidden` | The token lacks the scope, or you asked for another agent's data. |
| `403` | `policy_denied` | The policy blocked the send. Check `decision.reasons` (table below). |
| `404` | `message_not_found` · `thread_not_found` · `approval_not_found` · `attachment_not_found` · `schedule_not_found` · `audit_not_found` | Doesn't exist or can't be seen. Held mail looks the same as missing mail. |
| `409` | `idempotency_key_reused` | The key was used for a different request. Use a new key. |
| `409` | `policy_changing` | The policy is being changed. Try again shortly. |
| `422` | `forward_refused_injection_risk` | Forwarding this email was refused. Write a new email in your own words. |
| `429` | `cancel_rate_limited` | Too many schedule cancellations. Tell the owner. |
| `502` | `send_failed` | Nothing went out. You can retry with a new idempotency key. |
| `503` | `exposure_unavailable` | A received email (detail, thread, attachment, or verification code) couldn't be opened because Atmark couldn't record that it was read. Nothing was returned. Try again shortly. |

## Errors on every path {#platform}

| Status | `error` | Meaning and what to do |
|---|---|---|
| `400` | `invalid_json` | The body isn't valid JSON. |
| `400` | `invalid_request` | A query parameter was given more than once. |
| `404` | `route_not_found` | No such path. Check the path and method. |
| `405` | `method_not_allowed` | This path doesn't take that method. The `Allow` response header lists the ones it takes. |
| `413` | `payload_too_large` | Request bodies can be up to 10 MiB (10,485,760 bytes). |
| `500` | `internal_error` | The server couldn't process the request. `detail` includes a request ID. |
| `503` | `service_unavailable` | Temporarily unavailable. `detail` includes a request ID. |

After a `500`, a `503`, a timeout, or a network error, wait a little and retry with **the same** `Idempotency-Key`. Mail that already went out won't go out twice. Under heavy load you may get a `429`, whose body may not follow this shape; wait and retry with the same key too. If it keeps happening, [contact support](/help/contact) with the request ID.

Codes specific to schedules, verification codes, and webhooks are on their pages: [Scheduled email](/api/scheduled#cancel), [Verification codes](/api/verification-code), [Webhooks](/api/webhooks).

## Drafts, labels, attachments, and new agents {#new}

| Status | `error` | Meaning and what to do |
|---|---|---|
| `400` | `draft_incomplete` | The draft is missing `from`, a recipient, or a subject. Change it, then send. |
| `400` | `path_body_mismatch` | `agent_id` in the body isn't the token's agent. |
| `400` | `invalid_label` · `label_limit` | A label has the wrong form, or an email would have more than 20. |
| `403` | `self_enroll_disabled` | The owner hasn't turned on self-enrollment. |
| `403` | `enroll_chain_forbidden` | An agent created by self-enrollment can't create agents. |
| `404` | `draft_not_found` | No such draft for this agent. |
| `409` | `draft_revision_conflict` | The draft changed since you read it. Read it again and retry. |
| `409` | `draft_send_in_progress` · `draft_already_sent` · `draft_discarded` | The draft can't change or be sent again. |
| `409` | `agent_label_limit` | The agent already uses 200 different labels. |
| `409` | `attachment_expired` | The attachment, or the one created with this `Idempotency-Key`, has expired. Upload again with a new key. |
| `409` | `address_taken` · `agent_limit` | The address isn't available, or the plan's agent limit was reached. |
| `413` | `draft_too_large` | The draft body is over 10 MiB. |
| `429` | `draft_limit` | The agent has 500 open drafts. |
| `429` | `enroll_daily_cap` | Today's self-enrollment attempts are used up. |
| `503` | `enroll_busy` · `enroll_timeout` · `enroll_unavailable` | Self-enrollment didn't finish. After `enroll_timeout` the agent may exist; don't retry right away. |

Details: [Drafts](/api/drafts#errors), [Labels](/api/labels#errors), [Create agents](/api/agents#errors). The realtime connection reports its refusals as HTTP statuses on the handshake; see [Realtime](/api/realtime#connect).

## Policy change requests {#policy-requests}

| Status | `error` | Meaning and what to do |
|---|---|---|
| `400` | `invalid_request` · `invalid_action` · `invalid_direction` · `invalid_list` · `invalid_mode` · `invalid_rule_value` | The request has the wrong shape, or asks for something that can't be requested. |
| `400` | `rule_platform_domain` · `rule_self_address` | An `atmark.ai` domain or the agent's own address can't go on the outbound allowlist. |
| `400` | `reason_required` · `reason_too_long` | Give a one-line reason, up to 500 characters. |
| `403` | `forbidden` (`capability_not_granted`) | The token lacks the **Request policy changes** scope. |
| `404` | `policy_request_not_found` | No such request for this agent. |
| `409` | `no_change` | The policy already looks like that. |
| `409` | `policy_request_recently_rejected` | The owner rejected the same change in the last 24 hours. Don't ask again unless the owner tells you to. |
| `429` | `policy_request_pending_limit` · `policy_request_daily_limit` | 5 requests are waiting, or 20 were made in 24 hours. Wait for the owner. |

Details: [Policy API](/api/policy#requests).

## Common denial reasons {#reasons}

These are the codes you'll see most often in `decision.reasons` of `policy_denied` and in MCP `denied` results. While the cause remains, retrying gives the same result. Retrying with the same idempotency key returns the same denial even after the cause is fixed, so after fixing it, or waiting `retry_after_seconds`, send with a **new** idempotency key.

| Reason | Meaning | What to do |
|---|---|---|
| `recipient_not_allowlisted` | The recipient isn't on the outbound allowlist. | The owner adds them, or the agent [asks for it](/api/policy#requests). |
| `recipient_blocklisted` | The recipient is on the outbound blocklist. | The owner removes them. |
| `outbound_disabled` | The outbound mode is Block all. | The owner changes the mode. |
| `recipient_is_self` | The agent tried to email its own address. | It can't email itself. |
| `suppression_list` | The address has a history of bounces or spam reports. | Check the address. |
| `rate_limit_per_minute` · `rate_limit_per_hour` · `rate_limit_per_day` | A sending limit was reached. | Wait, then send. |
| `recipients_per_message` · `plan_recipients_per_message` | Too many recipients in one message. | Split it up. |
| `daily_send_limit` | The organization's daily sending limit was reached. For new organizations this limit rises over the first weeks after the first send. | Wait and send later. Upgrading doesn't lift it. |
| `plan_daily_cap` | The plan's daily recipient limit for the organization was reached. | Send tomorrow. Upgrading lifts it, but payments aren't open during the beta. |
| `org_pending_review` | The organization is under operator review. New sign-ups are active right away and don't get this; it can only remain on organizations that signed up earlier. | Wait until review is done. |
| `org_review_rejected` | Sign-up wasn't approved. | Contact support. |
| `org_owner_paused` | Emergency stop is on for the whole organization. | The owner resumes it. |
| `org_abuse_freeze` | Sending is frozen for the organization — by operators, or automatically when mail from its atmark.ai addresses gets too many bounces or spam reports. | Contact support@atmark.ai. Only operators can lift it. |
| `org_billing_blocked` | Sending is blocked by a billing problem. | The owner checks **Settings › Plan & usage**. |
| `agent_not_active` | The agent is stopped or not active. | The owner checks. |
| `from_forgery` | `from` isn't this agent's address. | Use the agent's own address. |
| `from_inactive` | `from` is one of this agent's addresses, but it can't send right now (a retired alias). | Send again from an address the agent uses now. |
| `evaluation_error` | The send couldn't be evaluated, so it was blocked to be safe. | Try again later with a new idempotency key. If it keeps happening, contact support. |

## All reason codes {#all-reasons}

These are the codes the public API currently returns in `decision.reasons` and in audit `reasons`. Older audit records may show earlier names. Allowed sends carry reasons too. "Old mode" means an old outbound mode (Approval required, Replies only) that Atmark operators set. See [Approvals](/email/approvals).

### Denied

| Code | Meaning |
|---|---|
| `org_pending_review` | The organization is under operator review. New sign-ups skip this state; it can only remain on older organizations. |
| `org_review_rejected` | Sign-up wasn't approved. |
| `org_owner_paused` | Emergency stop is on for the whole organization. |
| `org_abuse_freeze` | Sending is frozen for the organization (by operators, or automatically for too many bounces or spam reports on atmark.ai mail). |
| `org_billing_blocked` | Sending is blocked by a billing problem. |
| `agent_not_active` | The agent is stopped or not active. |
| `outbound_disabled` | The outbound mode is Block all. |
| `from_forgery` | `from` isn't this agent's address. |
| `from_inactive` | `from` is one of this agent's addresses, but it can't send right now (a retired alias). |
| `recipient_is_self` | The agent tried to email its own address. |
| `suppression_list` | The address has a history of bounces or spam reports. |
| `recipient_blocklisted` | A recipient is on the outbound blocklist. |
| `recipient_not_allowlisted` | A recipient isn't on the outbound allowlist. |
| `rate_limit_per_minute` · `rate_limit_per_hour` · `rate_limit_per_day` | The agent's per-minute, hourly, or daily sending limit was reached. |
| `recipients_per_message` | Too many recipients for the agent's policy limit. |
| `plan_recipients_per_message` | Too many recipients for the plan's limit. |
| `recipient_ceiling_exceeded` | Too many recipients for the hard cap no plan can exceed. |
| `daily_send_limit` | The organization's daily sending limit was reached. For new organizations it rises over the first weeks after the first send. |
| `plan_daily_cap` | The plan's daily recipient limit for the organization was reached. |
| `budget_exhausted` | The agent's sending budget was used up. Contact support. |
| `evaluation_error` | The send couldn't be evaluated, so it was blocked to be safe. |
| `release_window_expired` | It was approved but couldn't be sent within the allowed time, so it was closed (old mode). |
| `reply_only_no_inbound_thread` | It tried to send outside a received thread (old mode "Replies only"). |
| `reply_only_inbound_quarantined` | The received email being replied to is held (old mode "Replies only"). |
| `reply_only_owner_approval` | The agent's send approval is "always", and the old mode "Replies only" has no one to approve, so the reply was blocked. |
| `reply_only_risk_hold` | The reply had risk signals (it came soon after reading a risky email, or it contains sensitive content), and the old mode "Replies only" has no one to approve it, so it was blocked. |

### Allowed

| Code | Meaning |
|---|---|
| `allowlist_match` | Every recipient is on the outbound allowlist. |
| `unrestricted_mode` | The outbound mode is All. |
| `not_blocklisted` | In Blocklist mode, no recipient is on the blocklist. |
| `approval_granted` | A person approved it. |
| `standing_approval` | A recipient (or domain) approved before (old mode). |
| `seed_relationship` | A recipient the owner listed when creating the agent (old mode). |
| `reply_within_thread` · `auto_approve_reply_within_thread` | Allowed as a reply within the same thread (old mode). |
| `auto_approve_verification_sender` | Allowed as a reply to a verification-mail sender (old mode). |
| `auto_approve_domain` | A domain the owner allowed automatically (old mode). |

### Awaiting approval

| Code | Meaning |
|---|---|
| `new_recipient` | A first-time recipient needs a person's approval (old mode "Approval required"). |
| `risk_review` | The send has risk signals — the agent recently read a risky received email, or the content looks sensitive (a credential, a code it received, or a large copy of a received email). The owner gets an approval email with the reason. An approval covers this one email only. Don't try to get around it by rewording; wait for the owner. |
| `owner_requires_approval` | The owner set this agent's [send approval](/security/watch#send-approval) to "always". Every send the policy allows waits for the owner. Don't resend. |
| `bootstrap_grace` | Marks a decision made during the starting period of the old mode "Replies only". |
