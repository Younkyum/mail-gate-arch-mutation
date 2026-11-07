---
title: Verification code API
nav_title: Verification codes API
description: GET /v1/messages/verification-code finds sign-up and login codes in recently received mail. It only reads.
group: api
order: 11
updated: 2026-09-27
related: [email/verification-codes, api/inbound]
---
```http
GET /v1/messages/verification-code?sender_domain=github.com
```

Needs the **Read** (`messages:read`) scope. For the flow, see [Let your agent read verification codes](/email/verification-codes).

| Query | Description |
|---|---|
| `agent_id` | Optional. Defaults to the token's agent. If given, it must be the token's agent ID. |
| `sender_domain` | The domain of the site that sent the code. Strongly recommended. |
| `include_subdomains` | With `true`, also looks at mail from subdomains. Only with `sender_domain`. |
| `since` | Only mail received after this time. Defaults to the last 15 minutes with `sender_domain`, or the last 24 hours without it. No earlier than 24 hours ago. |

## Verified result (with `sender_domain`)

You get `verified: true` with `code`, `links` (confirmation links), `from_address`, `from_domain`, `received_at`, and `inbound_message_id`.

## Candidate result (without `sender_domain`)

You get `verified: false`, a `warning`, and an `unverified_candidates` array. Each candidate has `from_domain`, `from_address`, `dmarc` (`pass` or `fail`), and `unverified_code_candidates`, with no links. Pick the site from the candidates, then call again with `sender_domain`.

## Errors

| Response | What to do |
|---|---|
| `404 no_verification_found` | Wait about a minute and call again. Ask the site to resend only once. |
| `409 ambiguous` | Several different codes arrived. Read the most recent message in `candidate_message_ids`. |
| `400` | A query value is invalid, for example a public domain suffix anyone can register under. |
