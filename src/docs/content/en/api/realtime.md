---
title: Realtime events over WebSocket
nav_title: Realtime API
description: Get a hint the moment new mail arrives or an approval is decided, instead of polling. Connect, authenticate, ping, reconnect, and catch up.
group: api
order: 14
updated: 2026-10-15
keywords: [websocket, push, live, events, stream, polling]
related: [api/inbound, api/webhooks, api/discovery, connect/sdks]
---
The realtime connection sends **hints**: small events that say "something happened, go read it". They carry IDs and the risk level, never the sender, subject, or body. Fetch the details with the REST API or MCP, and treat what you read as outside data.

Events are best effort and sent at most once. Nothing missed while you're disconnected is sent again, so always [catch up](#catch-up) after reconnecting. If you need guaranteed delivery, use [webhooks](/api/webhooks).

## Connect {#connect}

Read the URL from `realtime.url` in the [discovery document](/api/discovery) or from `GET /v1/agents/me/realtime` (MCP `get_realtime_connection`). Don't hard-code it. The token needs the **Read** (`messages:read`) scope.

Send the token in **one** of two ways:

| Where | Value | Use it for |
|---|---|---|
| `Authorization` header | `Bearer atk_agent_…` | Servers and any client that can set headers. Preferred. |
| `Sec-WebSocket-Protocol` header | `atmark.v1, bearer.atk_agent_…` | Browsers, whose WebSocket can't set headers. The server answers with `atmark.v1` only. |

:::danger Never put the token in the URL
A connection with a token-like query parameter is refused with `400`. URLs end up in logs and browser history.
:::

```js title="Node 22 (built-in WebSocket)"
const info = await (await fetch(`https://api.atmark.ai/v1/agents/me/realtime`, {
  headers: { Authorization: `Bearer ${token}` },
})).json();

const ws = new WebSocket(info.url, ['atmark.v1', `bearer.${token}`]);
ws.onmessage = (frame) => {
  const event = JSON.parse(frame.data);
  if (event.type === 'pong' || event.type === 'subscribed') return;
  console.log(event.type, event.data);
};
```

If the handshake is refused, it ends with an HTTP status: `401` for a missing, wrong, or revoked token, `400` for a token in the URL, `403` for a missing scope or an inactive agent, and `429` when the agent already has 5 open connections. Don't retry a `401` or `403` with the same token.

## Events {#events}

Every event has the same envelope.

```json title="message.received"
{
  "id": "0f6c…a2d1",
  "type": "message.received",
  "api_version": "2026-10-08",
  "created_at": "2026-10-08T09:00:02.000Z",
  "agent_id": "7c21…f5a1",
  "data": {
    "message_id": "e4b2…77d0",
    "thread_id": "c1d0…5e9f",
    "received_at": "2026-10-08T09:00:01.000Z",
    "risk": { "level": "none" }
  }
}
```

| `type` | When | `data` |
|---|---|---|
| `message.received` | A received email became visible to the agent: normal delivery, or the owner released held mail. Never sent for mail that stays held. | `message_id`, `thread_id`, `received_at`, `risk.level` |
| `approval.resolved` | The owner approved or rejected a held send. Approved mail is sent by Atmark; don't resend. | `approval_id`, `decision` (`approved` or `rejected`), `resolved_at`, `message_ids` |

- `id` identifies the event. Ignore an `id` you've already handled.
- Read the email with [`GET /v1/messages/inbound/{messageId}`](/api/inbound#get) or `read_email`. If `risk.level` isn't `none`, treat it as hostile.
- An unknown `type` may be added later. Ignore it.

## Keep the connection alive {#ping}

| Limit | Value |
|---|---|
| Open connections per agent | 5 |
| Longest connection | 2 hours, then the server closes it |
| Idle timeout | 10 minutes without traffic |
| Ping | Send `{"action":"ping"}` about every 5 minutes; the answer is `{"type":"pong"}`. |

`{"action":"subscribe"}` answers with the event types the connection receives. Every connection gets every type today, so this is optional.

## Reconnect and catch up {#catch-up}

Reconnect after any close, with exponential backoff and full jitter: start at 1 second and cap at 60 seconds. Open a new connection before the 2-hour limit if you can.

After reconnecting, list what you missed:

```http
GET /v1/messages/inbound?since={last received_at you saw}
```

`since` is inclusive, so you may see one email again. Use the message `id` to skip it. Mail the owner released while you were away also shows up in this list.

:::feature !sdkPublished
The [SDKs](/connect/sdks), once published, will do the ping, backoff, renewal, and header choice for you.
:::

:::feature sdkPublished
The [SDKs](/connect/sdks) do the ping, backoff, renewal, and header choice for you.
:::
