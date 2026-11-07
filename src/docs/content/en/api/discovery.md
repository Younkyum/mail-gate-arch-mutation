---
title: Discovery and capabilities
nav_title: Discovery API
description: Two public documents and one per-agent call that let an agent read how Atmark works and set itself up, without a person writing the config.
group: api
order: 15
updated: 2026-10-08
keywords: [openapi, well-known, self-configure, capabilities, schema]
related: [api/overview, api/realtime, connect/sdks, connect/mcp-tools]
---
An agent can learn everything it needs from three sources. The first two are public and need no token.

| What | Where | Token |
|---|---|---|
| Discovery document | `GET https://api.atmark.ai/.well-known/atmark.json` | None |
| OpenAPI 3.1 | `GET https://api.atmark.ai/v1/openapi.json` | None |
| Your capabilities | `GET /v1/agents/me/capabilities` or MCP `get_capabilities` | **Self** (`agent:read_self`) |

The public documents can be cached for 5 minutes and can be read from any origin.

## Discovery document {#well-known}

```bash
curl -sS https://api.atmark.ai/.well-known/atmark.json
```

It's a JSON object. The main keys:

| Key | What it says |
|---|---|
| `api` | `base_url` (`https://api.atmark.ai/v1`) and `openapi_url` |
| `mcp` | The MCP server URL, transport, and the tool to call first (`get_capabilities`) |
| `docs` | This site, plus `llms.txt` and `llms-full.txt` |
| `realtime` | How to connect to the [realtime WebSocket](/api/realtime): URL, auth, events, limits, reconnect |
| `auth` | Bearer token in `Authorization`, the token prefix, every scope, and how tokens are obtained |
| `send_approval` | What `send_approval: "always"` means for sends |
| `self_enroll` | How an agent can [create a sibling agent](/api/agents) |
| `idempotency` | The header, which operations require it and which accept it, and the reuse error |
| `rate_limits` | Requests per second and burst for the whole API |
| `sdks` | The [TypeScript and Python SDKs](/connect/sdks) and whether they're published yet |
| `risk` | The `risk.level` values and the rule for received mail |

Agents can't create tokens for themselves. The owner issues one in the console, and the agent reads the rest from here.

## OpenAPI {#openapi}

```bash
curl -sS https://api.atmark.ai/v1/openapi.json
```

Every public path is in it, with its scope, whether it takes an `Idempotency-Key`, query parameters, and request and response schemas. Generate a client from it, or let an agent read it directly. The realtime events are described under the `x-atmark-realtime` extension.

## Your capabilities {#capabilities}

```http
GET /v1/agents/me/capabilities
Authorization: Bearer atk_agent_...
```

The response is the discovery document plus three keys about the calling agent.

| Key | What it says |
|---|---|
| `agent` | `agent_id`, the primary `address`, every address (`addresses`, with `primary`), and the token's `scopes` |
| `policy` | Policy version, the outbound and inbound mode with list **counts**, limits, plan, `send_approval`, and how to change it |
| `self_enroll` | Whether [self-enrollment](/api/agents) is `available` right now: `scope_granted`, `enabled_by_owner`, `daily_cap`, `used_last_24h` |

The full lists are in [Policy](/api/policy). The MCP tool `get_capabilities` returns the same thing, and its description tells agents to read it first.
