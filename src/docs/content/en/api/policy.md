---
title: Read your own policy API
nav_title: Policy API
description: With GET /v1/agents/me/policy, an agent reads its own modes, lists, and limits. It can ask its owner for a change, but can't make one.
group: api
order: 9
updated: 2026-10-13
related: [email/sending, email/receiving, email/limits-and-deliverability]
---
```http
GET /v1/agents/me/policy
```

Needs the **Self** (`agent:read_self`) scope. It returns the same content as MCP `get_my_policy`; the MCP version also adds the default sending address (`from_address`).

| Field | Meaning |
|---|---|
| `policy_version` | The current policy version. It goes up each time the owner changes something. |
| `outbound.mode` | Outbound mode: `all`, `allowlist`, `blocklist`, or `none`. `legacy` for an old mode. |
| `outbound.allow` | The outbound allowlist |
| `outbound.block_count` | How many entries are on the outbound blocklist (not the entries themselves) |
| `inbound.mode` · `inbound.allow` · `inbound.block_count` | The same for inbound |
| `limits` | The limits that actually apply: `per_minute`, `per_hour`, `per_day`, `recipients_per_message`, `org_daily_recipients` |
| `plan` | The organization's plan |
| `how_to_change` | How to change the policy (the owner, in the console) |

If the policy is being changed at that moment, you get `409 policy_changing`. Read it again shortly.

The agent can't change its policy. If it needs to email someone who's blocked, it asks the owner, in a message or with a change request below.

## Ask for a change {#requests}

```http
POST /v1/agents/me/policy/requests
```

Needs the **Request policy changes** (`policy:request`) scope. The agent asks its owner for **one** change, with a reason. Nothing changes until the owner approves it in the console. MCP: `request_policy_change`.

| Field | Required | Meaning |
|---|---|---|
| `action` | Yes | `add_rule`, `remove_rule`, or `set_mode` |
| `direction` | Yes | `outbound` or `inbound` |
| `list` | For rules | `allow` or `block` |
| `value` | For rules | An address (`name@example.com`) or a domain (`example.com`, `*.example.com`) |
| `mode` | For `set_mode` | `all`, `allowlist`, `blocklist`, or `none` |
| `reason` | Yes | One line for the owner, up to 500 characters |

Any other field is refused with `400 invalid_request`: an agent can't request the emergency stop, risk handling, send approval, trusted senders, tokens, scopes, webhooks, or limits.

```json
{
  "request_id": "6f1c…",
  "status": "pending_approval",
  "replayed": false,
  "change": { "action": "add_rule", "direction": "outbound", "list": "allow", "value": "partner@example.com" },
  "base_policy_version": 3,
  "expires_at": "2026-10-20T09:00:00.000Z",
  "next_step": "Nothing has changed yet. …"
}
```

- The answer is `202`. The same change while it's still waiting returns the same request with `replayed: true`, even with a different reason.
- `409 no_change` if the policy already looks like that (the modes and allowlists the agent can see). Blocklist requests aren't compared, because the agent doesn't see the blocklist.
- `409 policy_request_recently_rejected` if the owner rejected the same change in the last 24 hours. Don't ask again unless the owner tells you to.
- `429 policy_request_pending_limit` with 5 requests waiting, `429 policy_request_daily_limit` after 20 in 24 hours. Requests expire after 7 days.

```http
GET /v1/agents/me/policy/requests/{request_id}
```

Needs the **Self** scope. `status` is `pending_approval`, `approved` (in effect; `applied_policy_version` is the new version), `rejected`, `stale` (no longer applied when the owner reviewed it, with `stale_reason`), or `expired`. Blocklist requests only report `approved` (the requested state is in effect) or `rejected`, with no `stale_reason` or `applied_policy_version`, so the result never reveals the blocklist. MCP: `get_policy_request`. See [Let your agent ask for changes](/email/allow-block-lists#requests).
