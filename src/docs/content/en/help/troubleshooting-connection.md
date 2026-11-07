---
title: Fix connection problems
description: Work through 401 and 403 errors, protocol version errors, and missing tools.
group: help
order: 1
updated: 2026-09-27
related: [connect/tokens, connect/mcp-other-clients, connect/mcp-hermes]
---
First, use [the curl check](/connect/mcp-other-clients) to tell a client problem from a server problem.

## 401 Unauthorized

The token isn't reaching the server correctly.

- Check that the token is actually in the agent's environment. If a variable isn't defined, text like `${…}` goes to the server as is.
- On the console's **Tokens** screen, check that the token hasn't been revoked or expired. Match it by the last four characters in the list.
- Make sure you're not using an organization API key (`atk_org_…`). Agents connect with `atk_agent_` tokens.
- If you lost the value, [rotate](/connect/tokens#rotate) that token and use the new value.

## 403

| Response | Cause and fix |
|---|---|
| `Origin not allowed` | The request carried an `Origin` header. Call it from a server, not a browser. |
| `forbidden` | The token lacks the needed scope, or you used another agent's `agent_id`. Check the [scopes](/connect/tokens#scopes). |

## 400, code -32022

The MCP protocol version your client sent isn't supported. Supported versions are `2025-11-25`, `2025-06-18`, and `2025-03-26`. Update your client.

## Tools don't show up

- Reload the MCP servers in your client (`/reload-mcp` in Hermes, `/mcp` in Claude Code).
- With a read-only token, it's expected that the send tools don't appear.
- In Hermes, check that no tool names are missing from the `tools.include` list.

## 405

A `GET` request. The MCP server only accepts `POST`. This is expected.
