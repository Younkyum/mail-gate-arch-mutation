---
title: Edit allowlists and blocklists
nav_title: Allowlists and blocklists
description: Add or remove addresses and domains on the outbound and inbound lists. Changes apply right away.
keywords: [whitelist, blacklist]
group: email
order: 4
updated: 2026-10-15
related: [email/sending, email/receiving, connect/mcp-tools]
---
## Before you start

- You need the owner or admin role.

:::steps
### Open the Email screen
On the agent's screen, choose **Email** and find the column you want to change: **Outbound** or **Inbound**.

### Add an entry
Choose **Add** next to **Allowlist** or **Blocklist**, enter an address (`name@example.com`) or a domain (`example.com`) in the dialog, and choose **Add**.

### Remove an entry
Choose **Remove** next to the entry and confirm.
:::

Adding and removing apply right away, without **Save**, and each change makes a new policy version.

## Let your agent ask for changes {#requests}

You can let the agent ask you for a change instead of failing. With the **Request policy changes** (`policy:request`) scope, which new tokens have by default (and tokens issued before October 13, 2026 include too), it calls `request_policy_change` (or `POST /v1/agents/me/policy/requests`) with one change and a one-line reason. Nothing changes until you approve.

- **What it can ask for:** add or remove one address or domain on the outbound or inbound allowlist or blocklist, or switch the outbound or inbound mode. Nothing else: not the emergency stop, risk handling, send approval, trusted senders, tokens, scopes, webhooks, or limits.
- **Where you decide:** you get an email, and the request appears at the top of the agent's **Email** screen with the exact change (now → if approved), the agent's reason, and a warning if it read mail marked risky in the 4 hours before asking. Choose **Approve** or **Reject**. You need the owner or admin role.
- **Risk warning:** the warning also appears if the agent read risky mail after asking. Approving such a request needs you to tick the confirmation.
- **What approving does:** the same as making the change yourself: a new policy version, recorded under **Logs › Console** as your action. If the policy changed after the request, the screen shows the change against the current policy. A request that no longer applies, for example because you already added the address, is closed as `stale`. For blocklist requests the agent only ever sees `approved` or `rejected`, so it can't learn what's on your blocklist.
- **Approving an outbound allowlist address:** the agent can then email that address. Because the agent asked for it, mail to that address is still held for your approval after the agent reads mail marked risky. An address you add yourself isn't held that way, unless it's the sender of the risky mail.
- **When you can't approve:** if Atmark's operator has put the agent on hold, approval is refused until the operator lifts the hold. You can still reject.
- **Limits:** the same change is asked only once while it waits, an agent can have 5 requests waiting and make 20 a day, and requests expire after 7 days. After you reject a change, the agent can't ask for the same change again for 24 hours.
- The agent checks the result with `get_policy_request`. Only approve what you expected: a request can come from instructions hidden in an email.

## Matching rules {#rules}

| You enter | It matches |
|---|---|
| `name@example.com` | That address only. Case doesn't matter. On an allowlist any `+tag` must match exactly; on a blocklist the `+tag` is ignored, so `name+x@example.com` is blocked too. |
| `example.com` | That domain only, not its subdomains. |
| `*.example.com` | Subdomains only, not `example.com` itself. |

To cover both, add two lines: `example.com` and `*.example.com`.

## Good to know

- Outbound and inbound lists are separate.
- **The blocklist always wins.** Even in allowlist mode, anyone on the blocklist is blocked.
- The list the current mode doesn't use is collapsed. It applies once you switch modes.
- Each list holds up to 1,000 entries.
- You can't add the `atmark.ai` domain to the **outbound allowlist**. To email other agents, add their addresses one by one.
- You can't add the agent's own address to the **outbound allowlist**.
