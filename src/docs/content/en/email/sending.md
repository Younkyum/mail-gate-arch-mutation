---
title: Choose who your agent can email
nav_title: Sending
description: Pick one of four outbound modes to decide who your agent can email. New agents start in All; narrow them to an allowlist once you know the recipients.
keywords: [whitelist, outbound restrictions]
group: email
order: 2
updated: 2026-10-13
related: [email/allow-block-lists, email/limits-and-deliverability, help/troubleshooting-sending]
---
## Before you start

- You need the owner or admin role.

## Outbound modes {#modes}

| Mode | Behavior |
|---|---|
| All | Sends to anyone. Limits, the suppression list, content checks, and the risk hold still apply. **The default for new agents.** |
| Allowlist | Sends only to addresses and domains on the allowlist. Everything else is blocked. **Recommended** once you know who the agent writes to. |
| Blocklist | Blocks only people on the blocklist and sends to everyone else. |
| Block all | Sends to no one. Every send is denied. |

Mail to anyone outside the list is blocked without an approval request. If a message has several recipients and any one of them is blocked, the whole message isn't sent.

Agents an owner or admin creates in the console start in **All** (since October 13, 2026). Agents created with an organization API key or by [self-enrollment](/api/agents) start with an empty allowlist, and existing agents keep the mode they had.

:::steps
### Open the Email screen
On the agent's screen, choose **Email**. On a narrow screen, pick the **Outbound** tab at the top.

### Pick a mode
In the **Outbound** column, choose a mode. The mode in use is marked **Current**.

### Save
Choose **Save** at the bottom of the column. Each save creates a new policy version and applies right away.
:::

![The Outbound column on the Email screen](shot:agent-email)

:::warning Staying on All
All means the agent can email anyone. If its token leaks, or the agent is tricked by instructions in an email, mail can go to strangers. The risk hold catches sends to new recipients right after the agent reads suspicious mail, but it can't see everything. If you know who it should write to, add them to the allowlist and switch to Allowlist.
:::

## Send results

Every send returns one result to the agent.

| Result | Meaning | What the agent should do |
|---|---|---|
| `sent` | It went out. | Nothing |
| `denied` | A policy or limit blocked it. A reason code comes with it. | Don't retry; tell the owner. |
| `pending_approval` | A person has to approve it: the risk hold after suspicious mail, send approval set to always, or an old outbound mode. | Don't resend; wait. See [Approvals](/email/approvals). |

Common denial reasons are listed in [When mail doesn't go out](/help/troubleshooting-sending).

## What the agent can't do

The agent can only read its policy with `get_my_policy`. Only owners and admins change modes and lists, in the console. The agent can [ask for a change](/email/allow-block-lists#requests) with `request_policy_change`, but nothing changes until an owner or admin approves it.
