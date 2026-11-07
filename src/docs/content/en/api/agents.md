---
title: Create agents (self-enrollment)
nav_title: Create agents API
description: With the owner's permission, an agent can create a sibling agent in the same organization. The new agent starts with safe defaults it can't change.
group: api
order: 16
updated: 2026-10-08
keywords: [self-enroll, enroll, new agent, create agent, provision]
related: [security/watch, api/discovery, connect/tokens]
---
Self-enrollment is **off by default**. It works only when both are true:

- The owner turned on **Watch › Self-enroll** in the console.
- The owner gave this agent's token the **Self-enroll** (`agents:enroll`) scope. Only owners can grant it, one token at a time, and new tokens don't include it.

Check before calling: `self_enroll.available` in [your capabilities](/api/discovery#capabilities) is `true` only when both hold and the daily limit has room.

## Create a sibling agent {#create}

```http
POST /v1/agents
Authorization: Bearer atk_agent_...
```

| Field | Required | Description |
|---|---|---|
| `name` | Yes | Display name, 1–80 visible characters |
| `local_part` | No | The part before `@`. Leave it out to get a random one. |

```json title="Example 201 response"
{
  "agent": { "agent_id": "a91f…3c04", "name": "Invoice helper", "address": "invoice-helper@atmark.ai" },
  "token": "atk_agent_…",
  "token_scopes": ["messages:send", "messages:read", "agent:read_self"],
  "token_shown_once": true,
  "defaults": {
    "outbound_mode": "allowlist_only",
    "outbound_allow": [],
    "inbound_mode": "all",
    "send_approval": "always",
    "risk_handling": "hold"
  },
  "policy_version": 1,
  "how_to_change": "Only your owner can change the new agent’s policy, approval and risk settings, in the console (https://console.atmark.ai)."
}
```

:::warning The token is shown once
`token` appears only in this response. Store it in a secret store right away. Never put it in an email, a log, or a message. It can't be fetched again; if it's lost, the owner issues a new one in the console.
:::

## What the new agent starts with {#defaults}

These defaults are fixed. The agent that made it can't choose or change them; only the owner can, in the console.

- **Sending:** allowlist only, with an empty list. It emails no one until the owner adds people.
- **Send approval:** `always`. Every outside send waits for the owner.
- **Receiving:** from anyone, with Risk mail held.
- **Token:** Send, Read, and Self only. No webhook, audit, or self-enroll scope.
- It can't create agents in turn, and no token of it can ever get `agents:enroll`.

The owner gets an email when a new agent is created, unless they turned that notice off.

## Limits and retries {#limits}

- The organization has a daily cap on attempts in any 24 hours (5 by default, up to 20, set by the owner). Failed attempts count too, including an address that was taken.
- The plan's agent limit still applies.
- **Don't retry automatically.** After `503 enroll_busy`, try once more a minute later. After `503 enroll_timeout`, the agent may already exist; ask the owner to check the console before calling again.

## Errors {#errors}

| Status | `error` | Meaning |
|---|---|---|
| `400` | `invalid_request` | `name` or `local_part` isn't valid, or the body has an unknown field. |
| `401` | `unauthorized` | The token is missing, wrong, revoked, or expired. |
| `403` | `forbidden` | The token doesn't have the `agents:enroll` scope. |
| `403` | `self_enroll_disabled` | The owner hasn't turned on self-enrollment. |
| `403` | `agent_not_active` | This agent or its organization isn't active. |
| `403` | `enroll_chain_forbidden` | This agent was itself created by self-enrollment. |
| `409` | `address_taken` | That address isn't available. Pick another `local_part`. The attempt still counts. |
| `409` | `agent_limit` | The organization reached its plan's agent limit. |
| `429` | `enroll_daily_cap` | The organization used today's attempts. Try tomorrow or ask the owner. |
| `503` | `enroll_busy` | Busy. Try once more in a minute. |
| `503` | `enroll_timeout` | No answer in time. The agent may exist; don't retry right away. |
| `503` | `enroll_unavailable` | Self-enrollment isn't available right now. |

The MCP tool `create_agent` does the same thing and returns the same errors.
