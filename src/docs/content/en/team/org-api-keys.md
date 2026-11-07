---
title: Create agents with an organization API key
nav_title: Organization API keys
description: Organization API keys let CI and scripts create and read agents. They're not agent tokens.
group: team
order: 3
updated: 2026-10-15
related: [agents/create, connect/tokens, team/members-and-roles]
---
Organization API keys are **not agent tokens**. An organization API key (`atk_org_…`) only creates and reads agents; it can't send or read mail. Agent tokens (`atk_agent_…`) don't work with the organization API.

## Before you start

- You need the owner role. Only owners can see and manage organization API keys.

## Issue a key

:::steps
### Open New key
In **Settings › Organization API keys**, choose **Issue key**.

### Pick a name, scopes, and expiry
Choose a **Name** (up to 60 characters), at least one **Scope** (**Read agents** `agents:read`, **Create agent** `agents:create`), and **Expires**.

### Store it and close
Choose **Issue**. The key is shown only once. Put it straight into your CI's secret store and close the window. Once it's closed, you can't see the key again.
:::

![Organization API keys in Settings](shot:settings-keys)

Your plan sets how many active keys an organization can have (up to 5).

## Use the API

The base URL is on the console host.

```text
https://console.atmark.ai/org-api/v1
```

| Method | Path | Scope | What it does |
|---|---|---|---|
| `GET` | `/agents` | `agents:read` | Lists agents. The response is `{items, nextCursor}`. Takes `limit`, `cursor`, and `q` (search). |
| `GET` | `/agents/{agentId}` | `agents:read` | One agent |
| `POST` | `/agents` | `agents:create` | Creates an agent. Body: `{"name": "…", "localPart": "…"}` |

```bash
curl -sS https://console.atmark.ai/org-api/v1/agents \
  -H "Authorization: Bearer $ORG_KEY" \
  -H "Content-Type: application/json" \
  -d '{"name": "Help desk agent", "localPart": "desk"}'
```

:::feature customDomains
A key with the `domains:manage` permission also manages custom domains (`/domains`). Add `"domain": "agents.example.com"` to the create body to make an address on that domain the primary. [Send and receive mail on your own domain](/email/custom-domains#org-api)
:::

The create response (`201`) is `{agent, token}`. The new agent's **first token comes in this response only once**. Put it in your secret store right away. Creating follows the same rules as the console: address rules, agent limits, and the under-review cap (for older organizations still under review) all apply.

- Calls from a browser get `403 origin_forbidden`. Call it from a server or CI.
- Too many requests get `429 rate_limited`.
- A missing or wrong key gets `401 unauthenticated`.

## Rotate and revoke

Pick these from the key row's action menu.

- **Rotate**: Issues a new key with the same name and scopes, and revokes the current one right away. Update the secret in your CI.
- **Revoke**: Any CI using this key gets `401` right away. Agents created with it stay. This can't be undone.
