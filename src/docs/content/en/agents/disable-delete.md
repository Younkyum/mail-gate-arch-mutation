---
title: Stop an agent
description: Choose whether to stop sending, cut the connection, or stop receiving. Delete an agent you no longer use.
keywords: [delete agent, deactivate, disable agent]
group: agents
order: 3
updated: 2026-10-13
related: [email/emergency-stop, connect/tokens, identity/publish]
---
How you stop an agent depends on what you want to stop. You can combine these.

| To stop | Do this | To undo |
|---|---|---|
| Sending mail | **Emergency stop** at the bottom of Overview | **Resume** |
| All API and MCP access | On **Tokens**, open the arrow (▾) next to **Rotate all** and choose **Revoke all** | Issue a new token |
| Receiving mail | Save **Block all** under **Email › Inbound** | Save another mode |
| The public identity | Turn off the **Public identity** switch under **Identity** | Turn it back on |
| The whole agent | **Delete agent** at the bottom of Overview | Can't be undone |

## Which one to use

- **The agent is sending odd mail**: Use an emergency stop. Receiving and reading continue, so you can look into it. See [Emergency stop](/email/emergency-stop).
- **A token may have leaked**: Revoke that token instead of an emergency stop. An emergency stop doesn't revoke tokens. During the stop, a leaked token can still read received mail, and after you resume it can send again. See [Tokens](/connect/tokens#leak).
- **You no longer use the agent**: [Delete it](#delete). That revokes its tokens and stops sending and receiving in one step. If you might use it again, revoke all its tokens instead and turn on the emergency stop and **Block all** inbound.

:::danger Revoking can't be undone
A revoked token can't be restored. To reconnect, issue a new token and update the agent's configuration.
:::

## Deleting an agent {#delete}

Choose **Delete agent** at the bottom of Overview. Only owners and admins can do this. **Deleting can't be undone.**

When you delete an agent, right away:

- All its tokens are revoked, so API and MCP access stops.
- It no longer sends or receives mail. Scheduled mail is canceled, and pending approvals won't send even if approved.
- Its primary address and aliases are deleted. Mail to them is rejected.
- Its webhooks are turned off, and its public identity shows as **Revoked**.
- Its waiting [policy change requests](/email/allow-block-lists#requests) are closed and can no longer be approved.
- It leaves the agent list and no longer counts toward your plan's agent limit. See [How agents are counted](/agents/create#counting).

Received mail, logs, audit records, and the transparency log are kept.

:::danger After 30 days, another organization can take the address
Your organization can create a deleted address again right away. After 30 days, another organization can take it too, and then mail to that address goes to them. That includes password-reset and verification mail from services the agent signed up for. Change the address on those services before you delete.
:::

You can't delete an agent the operator has put on hold. To delete an organization or account, [contact support](/help/contact).
