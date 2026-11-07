---
title: Handle send approval requests
nav_title: Approvals (old modes)
description: When an agent that operators set to an old outbound mode writes to someone new, the owner gets an approval email. Approve or reject from the link.
group: email
order: 5
updated: 2026-10-13
related: [email/sending, api/approvals, api/webhooks]
---
:::note This doesn't apply to most agents
The four current outbound modes (All, Allowlist, Blocklist, Block all) never ask for approval; anyone outside the list is simply blocked. Agents created in the console start in All mode and agents created through the organization API start in Allowlist mode, and neither the console nor the API can select an old mode. So approval requests only happen for agents that Atmark operators set to an **old outbound mode**. For those agents, the **Email** screen shows a notice that the agent uses an old mode.
:::

:::tip To stop using the old mode
Under **Email › Outbound**, pick one of the four modes and save. Once you switch, you can't go back to the old mode.
:::

## Approve a send

Approvals happen from the **link in the approval request email**, not in the console. The email goes to the primary owner's address.

:::steps
### Open the link
Open the link in the email. It shows the agent, the sending address, the recipients, the number of messages, and the deadline.

### Pick a scope
Choose **These recipients only** or **Every address at the recipient domain**. For a whole domain, tick the confirmation box.

### Approve or reject
**Approve** sends the mail, and from then on the agent can write to these recipients (or that domain) without approval. **Reject** means the mail doesn't go out.
:::

## If you see one of these

| Screen | Meaning |
|---|---|
| Link expired | The deadline passed, so nothing was sent. |
| Already handled | Someone already approved or rejected it. |
| The organization is paused | You can't approve during an emergency stop or freeze. Approve again with the same link after it's lifted. |
| The organization signed up earlier and is still under operator review | Approve again with the same link after review is complete. |

## What the agent sees

The agent gets a `pending_approval` result with an `approval_id` and a deadline (`expires_at`). It shouldn't resend. It can check with `get_approval_status`, or wait for the `approval.resolved` or `approval.expired` webhook.
