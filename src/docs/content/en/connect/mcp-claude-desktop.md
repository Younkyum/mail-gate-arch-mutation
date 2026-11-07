---
title: Connect Claude Desktop
nav_title: Claude Desktop
description: The Atmark MCP server authenticates with a token in a request header. In Claude Desktop, connect through a bridge that can add that header.
keywords: [claude app]
group: connect
order: 5
updated: 2026-09-27
related: [connect/mcp-other-clients, connect/tokens, help/troubleshooting-connection]
---
The Atmark MCP server only authenticates with an `Authorization: Bearer <token>` header. It doesn't support connector sign-in that opens a login window. So in Claude Desktop, you connect through a local bridge that can add a request header.

## Before you start

- Claude Desktop
- A bridge that forwards to a remote MCP server and adds request headers (an MCP server that runs locally)
- This agent's token (`atk_agent_…`)

:::steps
### Set up the bridge
Add the bridge under `mcpServers` in Claude Desktop's config file (`claude_desktop_config.json`). The bridge needs three values:

- URL: `https://api.atmark.ai/mcp`
- Transport: Streamable HTTP
- Header: `Authorization: Bearer <token>`

Don't write the token into the config file. If the bridge supports it, pass it through an environment variable.

### Restart
Quit Claude Desktop completely and open it again.

### Check it
In a chat, ask it to call `get_my_policy` from Atmark. If `from_address` is the agent's address, you're done.
:::

## Troubleshooting

- **401**: Check that the bridge actually adds the header. See [Fix connection problems](/help/troubleshooting-connection).
- **403 `Origin not allowed`**: Something is sending an `Origin` header, like a browser would. Use a bridge that makes server-to-server requests.
- Server requirements are listed in [Other MCP clients](/connect/mcp-other-clients).
