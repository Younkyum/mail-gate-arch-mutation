---
title: Connect Hermes
nav_title: Hermes
description: Put the token in Hermes's environment file yourself, paste the setup message from the Connect screen, and Hermes connects the MCP server and checks it.
group: connect
order: 2
updated: 2026-10-13
related: [connect/tokens, connect/mcp-tools, help/troubleshooting-connection]
---
Hermes is Nous Research's open-source AI agent. You put the token into Hermes's environment file yourself, then send Hermes the console's setup message (without the token), and Hermes sets up the rest on its own.

## Before you start

- An environment with Hermes installed
- This agent's token. Tokens are only shown right after they're issued or rotated. If you don't have it, issue a [new token](/connect/tokens).

:::steps
### Put the token in the environment file
If `~/.hermes/.env` already has an `ATMARK_AGENT_TOKEN` line, change only that line's value in an editor instead.

Otherwise run this in a terminal, paste the token, and press Enter. The file is limited to you (mode 600) before the token is written, and the token doesn't show on screen or in your shell history.

```bash
(umask 077 && mkdir -p ~/.hermes && touch ~/.hermes/.env) && chmod 600 ~/.hermes/.env && read -rs ATMARK_AGENT_TOKEN && printf 'ATMARK_AGENT_TOKEN=%s\n' "$ATMARK_AGENT_TOKEN" >> ~/.hermes/.env; unset ATMARK_AGENT_TOKEN
```

### Copy the message from the Connect screen
On the agent's **Connect** screen, pick the message language (**EN** or **KO**) and choose **Copy message**. This message has no token. Instead, it tells Hermes the token is already in `~/.hermes/.env` and not to open, print, or edit that file.

### Paste it into Hermes
Paste the message into your chat with Hermes, as is. You don't need to add anything. Hermes edits `~/.hermes/config.yaml`, runs `/reload-mcp`, and checks with `get_my_policy`.

### Check the reply
Hermes replies with "Atmark connected" and the result of `get_my_policy`. Check that `from_address` is the agent's address.
:::

![The agent's Connect screen](shot:agent-connect)

## Use the setup message with the token {#token-message}

Right after a token is issued, the token window also offers a setup message that includes the token. It's convenient, because you only paste it, but it has a cost.

- The token stays in the Hermes chat history and in the model provider's logs.
- So when you use it, issue a separate token just for this and set an **expiry**.
- If you share or export the chat history, [rotate](/connect/tokens#rotate) that token.

## Set it up by hand {#manual}

You can also edit the files yourself. The result is the same.

Put the token in `~/.hermes/.env` (file mode 600).

```bash title="~/.hermes/.env"
ATMARK_AGENT_TOKEN=atk_agent_...
```

Add the server to `~/.hermes/config.yaml`. Don't write the token into this file; config files leak easily through sharing, backups, and screenshots.

```yaml title="~/.hermes/config.yaml"
mcp_servers:
  atmark:
    url: "https://api.atmark.ai/mcp"
    headers:
      Authorization: "Bearer ${env:ATMARK_AGENT_TOKEN}"
    timeout: 60
    connect_timeout: 30
    tools:
      include:
        - send_email
        - reply_email
        - forward_email
        - list_inbox
        - read_email
        - get_thread
        - read_attachment
        - get_attachment_url
        - get_approval_status
        - get_my_policy
        - get_verification_code
        - list_scheduled
        - cancel_scheduled
      resources: false
      prompts: false
```

Run `/reload-mcp` inside Hermes, then check the connection from a terminal.

```bash
hermes mcp test atmark
```

You should see thirteen tools. With a read-only token, the send and cancel tools are left out.

## Troubleshooting

- **401**: Check that `~/.hermes/.env` has a line with that name. If the variable isn't defined, `${env:…}` goes to the server as literal text and you get a 401. Also check you're not on a different profile.
- **Tools don't show up**: Ask Hermes to run `/reload-mcp` again.
- **`recipient_not_allowlisted`**: Add the recipient to the outbound allowlist on the console's **Email** screen, or approve the agent's [change request](/email/allow-block-lists#requests) there.

The agent sees tool names like `mcp__atmark__send_email`.
