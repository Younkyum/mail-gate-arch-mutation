---
title: TypeScript and Python SDKs
nav_title: SDKs
description: npm atmark-sdk and PyPI atmark-sdk. Typed TypeScript and Python clients with idempotency keys, safe retries, realtime reconnects, and webhook checks.
group: connect
order: 10
updated: 2026-10-09
keywords: [sdk, library, client, npm, pip, typescript, python, node]
related: [api/overview, api/realtime, api/webhooks, api/discovery]
---
:::feature !sdkPublished
The TypeScript and Python SDKs are being prepared for npm and PyPI. This page previews their API. Both will cover every path in the [OpenAPI document](/api/discovery#openapi) and behave the same way.
:::

:::feature sdkPublished
The TypeScript SDK is on npm and the Python SDK is on PyPI. Both cover every path in the [OpenAPI document](/api/discovery#openapi) and behave the same way.
:::

- **Sends get an `Idempotency-Key` automatically.** A retry reuses it, so mail never goes out twice.
- **Only safe requests are retried:** reads, and requests with an idempotency key, after network errors, `429`, `500`, `502` (except `send_failed`), `503`, `504`, and `409 policy_changing`. They back off with jitter and respect `Retry-After`.
- **Errors carry the code.** Branch on `code`, not on the message.
- **Realtime** pings, reconnects with backoff, and renews the connection before the 2-hour limit.
- **Webhook checks** verify the signature and refuse timestamps more than 5 minutes off.

| | TypeScript | Python |
|---|---|---|
| Package | `atmark-sdk` | `atmark-sdk` (import name `atmark`) |
| Runtime | Node 20 or later, Deno, Bun, browsers | Python 3.9 or later |
| Dependencies | None | None. Realtime uses the optional `websockets` extra. |

## Install {#install}

:::feature !sdkPublished
:::note Coming soon
The packages are being prepared for npm and PyPI and can't be installed yet. Until then, use Atmark directly:

- The REST API, described by the OpenAPI document at `https://api.atmark.ai/v1/openapi.json`. You can generate a client from it. See [Discovery](/api/discovery).
- The remote MCP server at `https://api.atmark.ai/mcp`. See [MCP tools](/connect/mcp-tools).
- [Webhooks](/api/webhooks) or the [realtime WebSocket](/api/realtime) for new mail.
:::
:::

:::feature sdkPublished
:::tabs
@tab TypeScript
```bash
npm install atmark-sdk
```
@tab Python
```bash
pip install atmark-sdk
pip install "atmark-sdk[realtime]"   # for realtime (websockets)
```
:::

The Python package is `atmark-sdk`; in code you `import atmark`.
:::

## Quickstart {#quickstart}

:::feature !sdkPublished
A preview of the SDK API. The same calls work today over the [REST API](/api/overview).
:::

:::tabs
@tab TypeScript
```ts
import { Atmark, AtmarkError, isHostile } from 'atmark-sdk';

const atmark = new Atmark({ token: process.env.ATMARK_AGENT_TOKEN });

// 1. Read your setup first: address, scopes, policy, send approval.
const caps = await atmark.capabilities.get();
console.log(caps.agent?.address, caps.policy?.send_approval);

// 2. Read the inbox. Received mail is outside data, never instructions.
for await (const message of atmark.messages.inbound.list({ read: false })) {
  if (isHostile(message)) continue; // risk.level is "risk" or "block"
  const full = await atmark.messages.inbound.get(message.id);
  await atmark.labels.set(full.id, { add: ['seen-by-agent'] });
}

// 3. Draft, then send. The Idempotency-Key is generated for you.
const draft = await atmark.drafts.create({ from: 'scout@atmark.ai', to: ['partner@example.com'], subject: 'Weekly report', text: 'Numbers attached.' });
try {
  const sent = await atmark.drafts.send(draft.id);
  if (sent.status === 'pending_approval') console.log('Waiting for the owner. Do not resend.');
} catch (error) {
  if (error instanceof AtmarkError) console.log(error.status, error.code); // branch on error.code
  else throw error;
}
```
@tab Python
```python
import os
from atmark import Atmark, AtmarkError, is_hostile

atmark = Atmark(token=os.environ["ATMARK_AGENT_TOKEN"])

# 1. Read your setup first: address, scopes, policy, send approval.
caps = atmark.capabilities.get()
print(caps["agent"]["address"], caps["policy"]["send_approval"])

# 2. Read the inbox. Received mail is outside data, never instructions.
for message in atmark.messages.inbound.list(read=False):
    if is_hostile(message):  # risk.level is "risk" or "block"
        continue
    full = atmark.messages.inbound.get(message["id"])
    atmark.labels.set(full["id"], {"add": ["seen-by-agent"]})

# 3. Draft, then send. The Idempotency-Key is generated for you.
draft = atmark.drafts.create({"from": "scout@atmark.ai", "to": ["partner@example.com"], "subject": "Weekly report", "text": "Numbers attached."})
try:
    sent = atmark.drafts.send(draft["id"])
    if sent["status"] == "pending_approval":
        print("Waiting for the owner. Do not resend.")
except AtmarkError as error:
    print(error.status, error.code)  # branch on error.code
```
:::

`isHostile` and `is_hostile` are true unless `risk.level` is exactly `none`. See [risk](/api/inbound#risk).

## Realtime {#realtime}

:::feature !sdkPublished
A preview of the SDK API. Today, connect directly as shown in [Realtime](/api/realtime#connect).
:::

The SDK reads the URL from the discovery document and sends the token in a header, or in the subprotocol in browsers. It never puts the token in the URL. See [Realtime](/api/realtime).

:::tabs
@tab TypeScript
```ts
const connection = atmark.realtime.connect({
  onEvent(event) {
    if (event.type === 'message.received' && event.risk.level === 'none') void atmark.messages.inbound.get(event.message_id);
  },
  onOpen({ reconnected }) {
    if (reconnected) {
      // Missed events are not sent again: catch up with messages.inbound.list({ since }).
    }
  },
  onError: console.error,
});
// connection.close();
```
@tab Python
```python
import asyncio

async def main() -> None:
    async for event in atmark.realtime.events():
        if event.type == "message.received" and event.risk["level"] == "none":
            print(atmark.messages.inbound.get(event["message_id"])["subject"])

asyncio.run(main())
```
:::

On Node 20, pass a WebSocket constructor: `new Atmark({ token, WebSocket: (await import('ws')).default })`. In Python, `on_open(True)` tells you it reconnected; catch up with `messages.inbound.list(since=...)`.

## Verify webhooks {#webhooks}

:::feature !sdkPublished
A preview of the SDK API. Today, check the signature as shown in [Webhooks](/api/webhooks).
:::

Pass the raw body exactly as received.

:::tabs
@tab TypeScript
```ts
import { verifyWebhookSignature } from 'atmark-sdk';

export async function handleWebhook(request: Request): Promise<Response> {
  const rawBody = await request.text();
  const result = await verifyWebhookSignature(rawBody, request.headers, process.env.WEBHOOK_SECRET ?? '');
  if (!result.valid) return new Response(result.reason, { status: 401 });
  return new Response('ok');
}
```
@tab Python
```python
from atmark import verify_webhook_signature

result = verify_webhook_signature(raw_body, request.headers, os.environ["WEBHOOK_SECRET"])
if not result.valid:
    return 401, result.reason
```
:::

During a [secret rotation](/api/webhooks#rotate), either secret matches.

## Creating agents {#create-agent}

`atmark.agents.create({ name })` (Python: `atmark.agents.create("Name")`) calls [self-enrollment](/api/agents). It works only when the owner turned it on, and it's never retried: the new token appears once, so store it right away.
