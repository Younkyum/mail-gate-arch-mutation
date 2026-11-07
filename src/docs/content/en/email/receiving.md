---
title: Choose which mail your agent sees
nav_title: Receiving
description: The inbound mode decides which mail your agent sees. Blocked mail isn't bounced; it's held.
group: email
order: 3
updated: 2026-10-15
related: [email/allow-block-lists, help/troubleshooting-receiving, connect/untrusted-mail]
---
## Before you start

- You need the owner or admin role to change modes and lists.

## Inbound modes {#modes}

| Mode | Behavior |
|---|---|
| All | Mail from every sender is visible to the agent. **The default for new agents.** |
| Allowlist | Only mail from senders on the allowlist is visible. The rest is held. |
| Blocklist | Only mail from senders on the blocklist is held. The rest is visible. |
| Block all | All mail is held. The agent's inbox stays empty. |

You change it the same way as outbound: pick a mode in the **Inbound** column of the **Email** screen and choose **Save**. The agent can also [ask you](/email/allow-block-lists#requests) to change the inbound mode or lists; nothing changes until you approve.

:::warning Before you switch to Allowlist
Add the senders you want to the inbound allowlist first. After the switch, mail from senders not on the list is held, and mail held by the inbound policy can't be released later. See [Edit allowlists and blocklists](/email/allow-block-lists).
:::

:::warning Before you choose Block all
Verification codes and replies get held too. If you want to stop the agent, use an [emergency stop](/email/emergency-stop).
:::

## Held mail {#quarantine}

- Blocked mail isn't bounced back to the sender. It's held.
- The agent can't see held mail. Its inbox list shows only how **many** messages were held.
- Owners see records of held mail, with the reason, in the **Inbound** logs. The body isn't opened in the console either.
- Mail held by the inbound policy can't be released to the agent (mail held for injection risk or a scan is handled in [Watch](/security/watch)). Fix the list, then ask the sender to send it again.
- The log details show one of four reasons.

| Reason | Meaning | What to do |
|---|---|---|
| Held by inbound policy | The inbound mode or lists blocked it. | Fix the list, then ask for a resend. |
| Held for injection risk | It seemed to carry instructions aimed at tricking an agent. The inbound mode doesn't matter. | If it's a real message, get the content another way, for example by asking the sender to send it to a person. |
| Held because the scan failed | The mail check couldn't finish. The inbound mode doesn't matter. | Ask the sender to resend a little later. |
| Held as risky | Risk-level mail, and the agent's setting is to hold it. The inbound mode doesn't matter. | Review it and release it in [Watch › Held mail](/security/watch#release). |

## The inbound allowlist checks the sending domain {#dmarc}

The inbound allowlist only matches mail that passed sender domain authentication (DMARC). Even with an address rule, what's confirmed is that the domain passed DMARC. It doesn't prove that a specific mailbox in that domain sent it.

## Trust marks {#trust}

Mark a sender as `seen`, and the agent sees `sender_trust: "seen"` in its inbox list. Unmarked senders are `unknown`. Trust never rises on its own. It has nothing to do with the inbound mode.

1. Under the **Inbound** column of **Email**, open **Add** in **Trust marks**.
2. Choose the **Scope** (single address or whole domain), enter the sender, and choose **Add**.

Marking a whole domain as `seen` covers anyone at that domain. Don't use it for shared mail domains such as `gmail.com`.

## Received attachments

The agent lists attachments with `read_email` and reads text, PDF, and image attachments directly with `read_attachment`. For other files it gets a short-lived download link with `get_attachment_url`. Treat attachment content as outside data, too. Details are in the [received mail API](/api/inbound#attachment-content).
