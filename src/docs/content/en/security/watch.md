---
title: Watch received mail and agent activity
nav_title: Watch
description: Risk and Block levels for received mail, held mail and releasing it, trusted senders, send approval, self-enrollment, and sign-up detection.
group: security
order: 2
updated: 2026-10-15
keywords: [prompt injection, held mail, release, trusted sender, risk, block, send approval]
related: [security/how-we-protect, connect/untrusted-mail, api/inbound, api/agents]
---
The console's **Watch** tab is where you decide how your agents handle mail that may be trying to steer them, and where you see what they've been doing. It has six sections: Held mail, Trusted senders, AI-flagged mail, Per-agent settings, Sign-ups, and Self-enroll.

## Two levels: Block and Risk {#levels}

Every email an agent receives is checked for prompt injection before the agent can see it. That includes mail from trusted senders and mail stopped by an inbound policy. Mail the check flags lands in one of two levels.

| Level | What it is | What happens |
|---|---|---|
| **Block** | A clear attempt to steer the agent, or mail that couldn't be fully scanned | Always held from the agent. You're always notified. It waits until you release it. |
| **Risk** | Wording that tries to make the agent act, or hidden text | Delivered or held, depending on the agent's setting. Notices are your choice. |

Everything else is delivered normally. Agents see the level as `risk.level` on every received email (`none`, `risk`, or `block`) and are told to treat anything but `none` as hostile. See [risk](/api/inbound#risk).

:::warning Detection can miss attacks
Some attacks are written to look like ordinary mail and get through. That's why reading risky mail also changes what the agent can send next: after an agent reads a Risk email or a released email, its sends to someone new wait for your approval. See [Security commitments](/security/how-we-protect#received).
:::

## Per-agent settings {#agent-settings}

Each agent has three settings. Admins and owners can change them.

| Setting | Options | Default |
|---|---|---|
| Risk mail | **Deliver now:** the agent reads it right away; after that, mail it sends to someone new needs your approval. **Hold for my review:** hidden until you release it. | Deliver now |
| Risk mail notices | Email the owner when Risk mail arrives | On |
| Sending | **Automatic:** mail that fits the policy (lists and limits) goes out right away. **Approve everything:** every outside email waits for your approval. | Automatic |

Block is fixed: always held, always notified.

### Send approval {#send-approval}

With **Approve everything**, a send the policy allows comes back as `pending_approval` with the reason `owner_requires_approval`. Drafts and replies go through the same check. The policy can still deny a send outright; approval only ever adds a step.

## Notices {#notices}

Notices go to the owner's email.

- Block notices are always sent. Risk notices follow the agent's setting.
- The first notice goes out a couple of minutes after the first email, and later mail is gathered into the next notice instead of one email each.
- A notice says how many emails were held or delivered and the sender's domain when it was authenticated. It never includes the subject, the body, or addresses.
- There's a daily cap on notices per organization. Block notices have their own cap, so a flood of Risk notices can't crowd them out.

## Held mail and releasing it {#release}

**Watch › Held mail** lists mail kept from your agents: Block mail and Risk mail an agent was set to hold. Subjects and bodies aren't shown, only the agent, level, reason, sender domain, and whether the sender was authenticated. Admins and owners can release mail.

- Released mail becomes visible to the agent, and the agent gets the usual new-mail webhook and realtime event.
- Releasing is one way. Released mail can't be hidden again.
- Releasing doesn't mean the mail is safe. After the agent reads it, mail it sends to someone new needs your approval.
- Mail that couldn't be fully scanned can't be released.
- Mail stopped by an inbound policy (allowlist or blocklist) isn't listed here. Change the inbound policy instead; see [Allowlists and blocklists](/email/allow-block-lists).

## Trusted senders {#trusted}

When routine mail from someone you work with keeps getting flagged, add them as a trusted sender. Only owners can change this list.

- Add an exact address (`billing@partner.example`) or an exact domain (`partner.example`). A domain covers only that domain; add subdomains separately. Wildcards aren't allowed.
- Public email provider domains can't be added whole, since anyone can create an address there. Add the exact address instead.
- The list holds up to 200 entries.

Detection is skipped only when **all** of these hold:

- The mail passes DMARC, and its From matches an entry exactly.
- Any Reply-To is on the same domain as From.
- The mail was fully scanned.

Otherwise it's checked as usual. Even when detection is skipped, the scan still runs and is recorded. The inbound policy still applies, and attachment text is still checked when the agent reads it. Removing a sender doesn't hide mail that was already delivered.

:::danger A trusted sender turns detection off for that sender
If a trusted sender's mailbox is taken over, its mail reaches your agent unchecked. Add only senders you exchange routine mail with, and remove ones you no longer need.
:::

## Sign-ups {#signups}

**Watch › Sign-ups** shows where your agents seem to have created accounts. Atmark spots this from the sign-up confirmation, welcome, and account-created emails the agents receive.

- Only DMARC-authenticated senders count, and only mail the agent can see. Held mail doesn't count.
- Each row is a service domain, with the agent, kind, first and last time seen, and the number of emails. Subjects and bodies aren't shown.
- Turn on **Notify me when an agent signs up somewhere** to get an email the first time an agent signs up to a new service. It's on by default and only owners can change it.

## Self-enroll {#self-enroll}

Self-enrollment lets an agent create new agents in your organization, each with its own address and token. It's **off by default**, and only owners can turn it on.

- Turning it on isn't enough. You also grant the **Self-enroll** (`agents:enroll`) scope to specific tokens, on the agent's Tokens page. Only owners can grant it.
- The daily cap is how many attempts the organization gets in any 24 hours: 5 by default, from 1 to 20. Failed attempts count. Your plan's agent limit still applies.
- **Notify me when a new agent is created** is on by default.

Agents created this way start with fixed safe defaults:

- Sending: allowlist only, empty to start, and every send needs your approval.
- Receiving: from anyone, with Risk mail held.
- Token: send, read, and self only. No self-enroll, webhook, or audit scope.
- They can't self-enroll in turn.

:::warning If a self-enroll token leaks
Someone else could create agents in your organization, up to the daily cap. Give the scope only where it's needed, and revoke the token if in doubt.
:::

For the agent side, see [Create agents](/api/agents).

## Who can do what {#roles}

| Action | Member | Admin | Owner |
|---|---|---|---|
| See held mail, settings, and sign-ups | Yes | Yes | Yes |
| Release held mail | | Yes | Yes |
| Change per-agent settings (risk mail, notices, sending) | | Yes | Yes |
| Change trusted senders | | | Yes |
| Turn self-enroll on or off, set its cap and notices | | | Yes |
| Grant the self-enroll scope to a token | | | Yes |
| Turn sign-up notices on or off | | | Yes |

Every change is recorded in the console logs.
