---
title: Receive webhooks
nav_title: Webhooks API
description: Get incoming mail, sends, and approval results pushed to your server. Manage webhooks in the console or through the API; every request is signed.
keywords: [callback, notification, events]
group: api
order: 13
updated: 2026-10-15
related: [api/approvals, api/inbound, api/overview]
---
Register webhooks per agent, either in the **Webhooks** tab of an agent in the console or with the API below. In the console, owners and admins can make changes; members can only view, with URLs masked. Registering or rotating through the MCP tools never shows the secret to the agent; rotate in the console when you need one.

## Scopes {#scopes}

| Action | Scope needed |
|---|---|
| Register, delete, rotate the secret, redeliver | **Manage webhooks** (`webhooks:manage`) |
| List endpoints, delivery records | **Read** (`messages:read`) |

Registering a webhook starts sending events to an outside URL, so a token with only the Read scope can't register one. New tokens don't include **Manage webhooks** by default; choose it when you create a token for an agent that needs to manage its own webhooks. See [Token scopes](/connect/tokens#scopes).

:::note Existing tokens
Tokens **issued before** this scope existed can still delete and redeliver with the **Send** (`messages:send`) scope **until December 31, 2026 (UTC)**, and can register if they also have the **Read** scope. Rotating a secret always needs **Manage webhooks**. After that date every action needs **Manage webhooks**. Rotating a token in the console issues a new token, so the exception doesn't carry over. Issue tokens with **Manage webhooks** before then.
:::

## Register an endpoint {#register}

```http
POST /v1/agents/me/webhook-endpoints
```

Needs the **Manage webhooks** scope.

```json
{ "url": "https://example.com/atmark-webhook", "event_types": ["message.received", "message.bounced"] }
```

- `url` must be an `https` address. Private network addresses are refused (`400 invalid_webhook_url`).
- Without `event_types`, you get the default four (`approval.resolved`, `approval.expired`, `message.sent`, `message.received`).
- The subscription can't be changed after registration. To change it, register a new endpoint.

The `201` response includes the **secret** (`whsec_…`) exactly once. It can't be fetched again, so store it right away. If you lose it, [rotate the secret](#rotate).

Your plan sets how many active endpoints an agent can have (`409 webhook_endpoint_limit`). The number of registrations per day is limited too (`409 webhook_endpoint_registration_limit`).

### Authorization header (optional) {#authorization}

If your receiver sits behind a gateway or an automation tool that only accepts requests with credentials, add `authorization` to the body. It's the **full header value**, and Atmark sends it as `Authorization: <value>` with every delivery, including retries and redeliveries.

```json
{ "url": "https://example.com/atmark-webhook", "authorization": "Bearer <your-gateway-token>" }
```

- Use the exact value your receiver expects, such as `Bearer <token>` or `Basic <base64>`. The header name is always `Authorization`.
- Printable ASCII only, up to 2,048 characters: no line breaks, tabs, or other control characters, and no `Authorization:` prefix (`400 invalid_authorization`).
- The value is stored encrypted and is **never returned again**. Responses and the list only show `has_authorization` and `authorization_hint` (a known scheme such as `Bearer` and the last four characters, like `Bearer …wxyz`; the last characters are hidden for `Basic`, for values under 16 characters, and for values with `:` or spaces).
- An agent token can set it only when registering. To replace or remove it, an owner or admin uses the endpoint's **⋯** menu in the console's **Webhooks** tab. Deleting the endpoint deletes the value too.
- It's sent only to the URL it was registered with. Redirects aren't followed, so the header never goes anywhere else.

:::note It doesn't replace the signature
The header is for getting past your gateway. Keep [verifying the signature](#signature): it's what proves a request came from Atmark and wasn't changed or replayed.
:::

## List and delete

```http
GET    /v1/agents/me/webhook-endpoints
DELETE /v1/agents/me/webhook-endpoints/{endpointId}
```

The list never includes secrets. With a token that lacks **Manage webhooks**, `url` is masked like `https://example.com/…hook` (host and the last four characters of the path) and `url_masked` is `true`. Each item has `secret_version` (goes up by one on every rotation), `secret_rotated_at`, and `previous_secret_valid_until` (until when the previous secret stays valid right after a rotation, otherwise `null`), plus `has_authorization` and `authorization_hint` (never the header value itself).

Deleting needs the **Manage webhooks** scope; nothing more is sent to a deleted endpoint, and it can't be restored.

## Rotate the secret {#rotate}

```http
POST /v1/agents/me/webhook-endpoints/{endpointId}/rotate-secret
```

Needs the **Manage webhooks** scope and takes no body. You can also do it from the **Webhooks** tab in the console. The response (`200`):

```json
{
  "endpoint": { "id": "…", "url": "https://example.com/atmark-webhook", "secret_version": 2, "previous_secret_valid_until": "2026-10-01T09:00:00.000Z", "…": "…" },
  "secret": "whsec_…",
  "previous_valid_until": "2026-10-01T09:00:00.000Z"
}
```

- The new secret appears only in this response. The endpoint ID and subscription stay the same.
- For **24 hours** after a rotation (until `previous_valid_until`), every request carries signatures from **both** the new and the previous secret. Switch your receiver to the new secret in that window and you won't miss events. See [Verify the signature](#signature).
- Rotating again within 24 hours keeps only the secret right before it valid; anything older ends immediately.
- Each endpoint can be rotated up to 10 times per 24 hours (`429 webhook_rotation_rate_limited`).

## Events {#events}

| Event | When | `data` |
|---|---|---|
| `message.received` | Mail reached the agent (held mail excluded) | `message_id`, `thread_id`, `received_at` |
| `message.sent` | Mail went out | `message_id`, `sent_at` |
| `approval.resolved` | An approval request was approved or rejected | `approval_id`, `decision`, `resolved_at`, `message_ids` |
| `approval.expired` | An approval deadline passed | `approval_id`, `expired_at`, `message_ids` |
| `message.delivered` | The recipient's mail server accepted it (subscribe to receive) | `message_id`, `delivered_at`, `recipient_positions` |
| `message.bounced` | It bounced (subscribe to receive) | `message_id`, `bounced_at`, `recipient_positions`, `bounce_type` (`permanent`, `transient`, `undetermined`) |
| `message.complained` | A recipient reported it as spam (subscribe to receive) | `message_id`, `complained_at`, `recipient_positions` |

The request body looks like this.

```json
{
  "id": "…",
  "type": "message.received",
  "api_version": "2026-09-23",
  "created_at": "2026-09-27T09:00:00.000Z",
  "agent_id": "7c21…f5a1",
  "data": { "message_id": "…", "thread_id": "…", "received_at": "2026-09-27T09:00:00.000Z" }
}
```

Webhooks never include the sender, subject, body, or recipient addresses. If you need them, call the [received mail API](/api/inbound) with `message_id`. `recipient_positions` are positions (from 0) in that email's recipient list, after lowercasing the addresses, removing duplicates, and sorting by Unicode code point. Sort your own recipient list the same way to map positions back to addresses. Values are ascending and unique.

## Verify the signature {#signature}

Every request carries three headers (Standard Webhooks format).

| Header | Value |
|---|---|
| `webhook-id` | The event ID. Use it to drop duplicates. |
| `webhook-timestamp` | When it was sent (Unix seconds) |
| `webhook-signature` | `v1,<base64 signature>`. Several are separated by spaces. For 24 hours after a secret rotation there are two: `v1,<new secret signature> v1,<previous secret signature>`. |

The signature is an HMAC-SHA256 of `<webhook-id>.<webhook-timestamp>.<body>` with your secret. The part of the secret after `whsec_` is base64.

```js title="verify-webhook.mjs"
import { createHmac, timingSafeEqual } from 'node:crypto';

export function verifyWebhook(secret, headers, rawBody) {
  const id = headers['webhook-id'];
  const timestamp = headers['webhook-timestamp'];
  const signatures = headers['webhook-signature'];
  if (!id || !timestamp || !signatures) return false;
  const ts = Number(timestamp);
  if (!Number.isInteger(ts) || Math.abs(Date.now() / 1000 - ts) > 300) return false;

  const key = Buffer.from(secret.replace(/^whsec_/, ''), 'base64');
  const expected = createHmac('sha256', key).update(`${id}.${timestamp}.${rawBody}`).digest();

  return signatures.split(' ').some((entry) => {
    const [version, value] = entry.split(',');
    if (version !== 'v1' || !value) return false;
    const given = Buffer.from(value, 'base64');
    return given.length === expected.length && timingSafeEqual(given, expected);
  });
}
```

Use the raw body exactly as received, before parsing. Accepting only timestamps within 5 minutes blocks replays. Accept the request if **any** signature matches your secret. The code above does exactly that, so it keeps working while you rotate the secret.

## Delivery contract {#delivery-contract}

- Respond with `2xx` within 10 seconds. Do heavy work after acknowledging.
- Anything other than `2xx`, a timeout, or a connection failure is a failure. Redirects (`3xx`) aren't followed and count as failures.
- Failed deliveries are retried after 30 seconds, 2 minutes, 10 minutes, 30 minutes, 1 hour, 2 hours, 4 hours, 8 hours, and 16 hours: 10 attempts in total, over about 31 hours 40 minutes.
- Retries keep the same event ID and body with a fresh signature time. Drop duplicates by `webhook-id`.
- If the destination is rejected at delivery time (a domain that resolves to a private address, an invalid URL, or a deleted endpoint), there are no retries and the delivery goes straight to `dead`.
- A delivery that never succeeds also ends as `dead`.

## Delivery records and redelivery {#deliveries}

```http
GET  /v1/agents/me/webhook-deliveries?status=dead
POST /v1/agents/me/webhook-deliveries/{deliveryId}/redeliver
```

The list (**Read** scope) takes `status` (`pending`, `delivered`, `dead`), `limit` (1–100), and `cursor`. Each item has `id`, `event_id`, `event_type`, `endpoint_id`, `status`, `attempt_count`, `last_error`, `last_http_status`, `redelivery_of`, `created_at`, `next_attempt_at` (only while `pending`), `delivered_at`, and `dead_at`. Bodies and URLs aren't in the list.

Redelivery (**Manage webhooks** scope) only works for `dead` deliveries and creates a new delivery with the same event ID and body (`201`). One delivery can be redelivered up to 3 times, and an agent can make up to 100 redeliveries per hour.

## Errors {#errors}

| Status | `error` | Meaning |
|---|---|---|
| `400` | `invalid_webhook_url` | The URL can't be registered. |
| `403` | `forbidden` | The token lacks the needed scope (`capability_not_granted`). See [Scopes](#scopes). |
| `404` | `not_found` | The endpoint or delivery doesn't exist (delete, rotation, redelivery). |
| `409` | `webhook_endpoint_limit` | The agent's active endpoint limit was reached. |
| `409` | `webhook_endpoint_registration_limit` | The daily registration limit was reached. |
| `409` | `delivery_not_dead` | Only `dead` deliveries can be redelivered. |
| `409` | `webhook_endpoint_deleted` | Deliveries to a deleted endpoint can't be redelivered. |
| `409` | `redelivery_destination_rejected` | It died because the destination was rejected. Register a new endpoint with a corrected URL. |
| `409` | `delivery_already_delivered` | This delivery (or a redelivery of it) was already received. |
| `409` | `redelivery_limit` | This delivery's redeliveries are used up. |
| `429` | `redelivery_rate_limited` | The hourly redelivery limit was reached. Try again later. |
| `429` | `webhook_rotation_rate_limited` | The 24-hour secret rotation limit was reached. Try again later. |
