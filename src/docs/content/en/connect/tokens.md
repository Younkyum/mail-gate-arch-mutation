---
title: Manage agent tokens
nav_title: Tokens
description: Issue tokens, choose scopes and expiry, and rotate or revoke them. A token's value is shown only once, when it's issued.
keywords: [api key, secret, regenerate, reset token]
group: connect
order: 7
updated: 2026-10-15
related: [connect/overview, agents/disable-delete, team/org-api-keys]
---
An agent token is the secret your agent uses for MCP and the REST API. It starts with `atk_agent_`. The value is shown **only once**, right after it's issued or rotated. The list shows only the last four characters, like `atk_agent_••••••••abcd`.

:::warning Token leaked?
[Jump to the leak steps](#leak): rotate or revoke that token first.
:::

## Before you start

- You need the owner or admin role to create or change tokens.

![The Tokens screen](shot:agent-tokens)

## Issue a new token {#issue}

Give each place that uses a token its own named token, so you can revoke just the one that leaks.

:::steps
### Open New token
On the agent's **Tokens** screen, choose **Issue token**.

### Pick a name, scopes, and expiry
The **Name** tells you where it's used (up to 60 characters). Pick at least one **Scope**. For **Expires**, choose Never, 30, 90, or 365 days.

### Issue it and keep it
Choose **Issue**. The token window opens. Copy the token or send the setup message to your agent, then choose **Close**. Once it's closed, you can't see the token again.
:::

![The token window, shown only once](shot:token-once)

Your plan sets how many active tokens an agent can have (up to 5).

## Scopes {#scopes}

| Scope | What it allows |
|---|---|
| Send `messages:send` | New mail, replies, forwards, creating and cancelling schedules |
| Read `messages:read` | Reading received mail, threads, and attachments; approval status; verification codes; listing and reading schedules; listing webhooks; webhook delivery records |
| Audit `audit:read` | Reading send decision records |
| Self `agent:read_self` | Reading its own policy (`get_my_policy`) and its policy change requests (`get_policy_request`) |
| Request policy changes `policy:request` | Asking the owner to change its own lists or modes (`request_policy_change`). It changes nothing by itself; the owner approves in the console. See [Let your agent ask for changes](/email/allow-block-lists#requests). |
| Manage webhooks `webhooks:manage` | Registering and deleting webhooks, rotating their secrets, redelivering webhooks |

The first four and **Request policy changes** are on by default for a new token; **Manage webhooks** is off. A webhook sends events to an outside URL, so grant it only when the agent itself needs to manage webhooks. Until December 31, 2026, tokens issued before this scope existed can still register (with Read too), delete, and redeliver webhooks with the **Send** scope. Secret rotation has no exception, and a rotated token doesn't inherit it. See [Receive webhooks](/api/webhooks#scopes).

Tokens issued before October 13, 2026 also include **Request policy changes**. You don't need to reissue them, and the token list shows the scope. It isn't included for tokens narrowed to neither Send nor Read (webhooks only, for example), tokens without **Self**, or tokens of agents that another agent created. Rotating one of these tokens carries the scope over to the new token.

Agents on addresses Atmark reserves for its own operations (such as `support@atmark.ai`) never have **Request policy changes**, even if it's selected; their policy is changed only by Atmark's operator.

For a read-only agent, leave out **Send**. MCP clients then won't see the send tools.

## Rotate a token {#rotate}

Use this if you missed the value, or to change tokens on a schedule.

1. In the token row's **⋯** menu, choose **Rotate**.
2. A new token with the same name, scopes, and lifetime is issued, and the current one is revoked right away.
3. Put the new token in the agent's configuration and reload MCP.

The arrow (▾) next to **Rotate all** at the top opens a menu. **Rotate all** revokes every live token and issues one new token. **Revoke all** revokes them all without issuing a new one.

## Revoke a token {#revoke}

In the token row's **⋯** menu, choose **Revoke**. Anything using that token is cut off right away. Other tokens keep working.

:::danger Revoking can't be undone
A revoked token can't be restored.
:::

## If a token leaked {#leak}

Keep this order: cut it off first, then reconnect.

:::steps
### Find the leaked token
On the agent's **Tokens** screen, find it by the last four characters in the **Token** column.

### Rotate or revoke it
In that row's **⋯** menu, choose **Rotate** (or **Revoke** if you won't need it again). The old token stops working at that moment. Rotating opens a new-token window, and the new token is shown there **only once**. Copy it right away.

### Reconnect with the new token
Put the new token where the old one was used and reconnect. See [Hermes](/connect/mcp-hermes) · [Claude Code](/connect/mcp-claude-code) · [Cursor](/connect/mcp-cursor) · [Other clients](/connect/mcp-other-clients).

### Look for misuse
Check the **Last used** column in the token list and the **Logs › Outbound** tab for sends you don't recognize.

### Delete where you pasted it
If you pasted the token into a chat, document, issue, or messenger, delete that message.
:::

An emergency stop doesn't revoke tokens. During the stop, a leaked token can still read received mail, and after you resume it can send again. That's why a leak calls for revoking or rotating, not stopping.

## What tokens can't do

An agent token can't change the policy, pay for a plan, create agents, or read organization API keys. It only reaches its own agent's mail and information.
