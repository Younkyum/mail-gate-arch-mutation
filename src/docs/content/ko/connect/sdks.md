---
title: TypeScript · Python SDK
nav_title: SDK
description: npm atmark-sdk · PyPI atmark-sdk. 멱등 키, 안전한 재시도, 실시간 재연결, 웹훅 확인이 들어간 TypeScript · Python 타입 클라이언트.
group: connect
order: 10
updated: 2026-10-09
keywords: [sdk, 라이브러리, 클라이언트, npm, pip, typescript, python, node]
related: [api/overview, api/realtime, api/webhooks, api/discovery]
---
:::feature !sdkPublished
TypeScript · Python SDK는 npm과 PyPI에 올릴 준비를 하고 있습니다. 이 페이지는 SDK의 API를 미리 보여 줍니다. 두 SDK는 [OpenAPI 문서](/api/discovery#openapi)의 모든 경로를 다루고 똑같이 동작합니다.
:::

:::feature sdkPublished
TypeScript SDK는 npm에, Python SDK는 PyPI에 있습니다. 두 SDK는 [OpenAPI 문서](/api/discovery#openapi)의 모든 경로를 다루고 똑같이 동작합니다.
:::

- **발송에 `Idempotency-Key`를 자동으로 붙입니다.** 다시 시도할 때 같은 키를 써서 메일이 두 번 나가지 않습니다.
- **안전한 요청만 다시 시도합니다:** 읽기와 멱등 키가 있는 요청을, 네트워크 오류 · `429` · `500` · `502`(`send_failed` 제외) · `503` · `504` · `409 policy_changing` 뒤에. 지터를 섞어 기다리고 `Retry-After`를 따릅니다.
- **오류에 코드가 있습니다.** 문구가 아니라 `code`로 분기합니다.
- **실시간**은 핑을 보내고, 끊기면 백오프로 다시 연결하고, 2시간 한도 전에 연결을 갈아 끼웁니다.
- **웹훅 확인**은 서명을 검증하고 5분 넘게 어긋난 시각을 거부합니다.

| | TypeScript | Python |
|---|---|---|
| 패키지 | `atmark-sdk` | `atmark-sdk`(import 이름은 `atmark`) |
| 런타임 | Node 20 이상 · Deno · Bun · 브라우저 | Python 3.9 이상 |
| 의존성 | 없음 | 없음. 실시간은 선택 추가 패키지 `websockets`를 씁니다. |

## 설치 {#install}

:::feature !sdkPublished
:::note 준비 중
npm과 PyPI에 올릴 준비를 하고 있어 아직 설치할 수 없습니다. 그 전까지는 Atmark를 바로 씁니다.

- REST API. OpenAPI 문서 `https://api.atmark.ai/v1/openapi.json`에 설명이 있고, 이것으로 클라이언트를 생성할 수 있습니다. [발견](/api/discovery)
- 원격 MCP 서버 `https://api.atmark.ai/mcp`. [MCP 도구](/connect/mcp-tools)
- 새 메일은 [웹훅](/api/webhooks)이나 [실시간 WebSocket](/api/realtime)으로 받습니다.
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
pip install "atmark-sdk[realtime]"   # 실시간까지 쓸 때(websockets)
```
:::

Python 패키지 이름은 `atmark-sdk`이고, 코드에서는 `import atmark`로 씁니다.
:::

## 빠른 시작 {#quickstart}

:::feature !sdkPublished
SDK API 미리 보기입니다. 같은 호출을 지금은 [REST API](/api/overview)로 씁니다.
:::

:::tabs
@tab TypeScript
```ts
import { Atmark, AtmarkError, isHostile } from 'atmark-sdk';

const atmark = new Atmark({ token: process.env.ATMARK_AGENT_TOKEN });

// 1. 먼저 내 설정을 읽는다: 주소 · 권한 · 정책 · 발신 승인
const caps = await atmark.capabilities.get();
console.log(caps.agent?.address, caps.policy?.send_approval);

// 2. 받은편지함 읽기. 받은 메일은 바깥 데이터이고 지시가 아니다.
for await (const message of atmark.messages.inbound.list({ read: false })) {
  if (isHostile(message)) continue; // risk.level 이 "risk" 나 "block"
  const full = await atmark.messages.inbound.get(message.id);
  await atmark.labels.set(full.id, { add: ['seen-by-agent'] });
}

// 3. 초안을 만들고 보낸다. Idempotency-Key 는 SDK 가 만든다.
const draft = await atmark.drafts.create({ from: 'scout@atmark.ai', to: ['partner@example.com'], subject: 'Weekly report', text: 'Numbers attached.' });
try {
  const sent = await atmark.drafts.send(draft.id);
  if (sent.status === 'pending_approval') console.log('소유자 승인 대기. 다시 보내지 않는다.');
} catch (error) {
  if (error instanceof AtmarkError) console.log(error.status, error.code); // error.code 로 분기
  else throw error;
}
```
@tab Python
```python
import os
from atmark import Atmark, AtmarkError, is_hostile

atmark = Atmark(token=os.environ["ATMARK_AGENT_TOKEN"])

# 1. 먼저 내 설정을 읽는다: 주소 · 권한 · 정책 · 발신 승인
caps = atmark.capabilities.get()
print(caps["agent"]["address"], caps["policy"]["send_approval"])

# 2. 받은편지함 읽기. 받은 메일은 바깥 데이터이고 지시가 아니다.
for message in atmark.messages.inbound.list(read=False):
    if is_hostile(message):  # risk.level 이 "risk" 나 "block"
        continue
    full = atmark.messages.inbound.get(message["id"])
    atmark.labels.set(full["id"], {"add": ["seen-by-agent"]})

# 3. 초안을 만들고 보낸다. Idempotency-Key 는 SDK 가 만든다.
draft = atmark.drafts.create({"from": "scout@atmark.ai", "to": ["partner@example.com"], "subject": "Weekly report", "text": "Numbers attached."})
try:
    sent = atmark.drafts.send(draft["id"])
    if sent["status"] == "pending_approval":
        print("소유자 승인 대기. 다시 보내지 않는다.")
except AtmarkError as error:
    print(error.status, error.code)  # error.code 로 분기
```
:::

`isHostile`과 `is_hostile`은 `risk.level`이 정확히 `none`일 때만 거짓입니다. [risk](/api/inbound#risk)

## 실시간 {#realtime}

:::feature !sdkPublished
SDK API 미리 보기입니다. 지금은 [실시간](/api/realtime#connect)에 나온 대로 바로 연결합니다.
:::

SDK는 발견 문서에서 주소를 읽고, 토큰을 헤더(브라우저에서는 하위 프로토콜)로 보냅니다. 토큰을 URL에 넣지 않습니다. [실시간](/api/realtime)

:::tabs
@tab TypeScript
```ts
const connection = atmark.realtime.connect({
  onEvent(event) {
    if (event.type === 'message.received' && event.risk.level === 'none') void atmark.messages.inbound.get(event.message_id);
  },
  onOpen({ reconnected }) {
    if (reconnected) {
      // 놓친 이벤트는 다시 오지 않는다: messages.inbound.list({ since }) 로 따라잡는다.
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

Node 20에서는 WebSocket 생성자를 넘깁니다: `new Atmark({ token, WebSocket: (await import('ws')).default })`. Python에서는 `on_open(True)`가 다시 연결됐다는 뜻이니 `messages.inbound.list(since=...)`로 따라잡습니다.

## 웹훅 확인 {#webhooks}

:::feature !sdkPublished
SDK API 미리 보기입니다. 지금은 [웹훅](/api/webhooks)에 나온 대로 서명을 확인합니다.
:::

받은 그대로의 본문을 넘깁니다.

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

[시크릿 교체](/api/webhooks#rotate) 중에는 새 시크릿과 옛 시크릿 어느 쪽이든 맞으면 통과합니다.

## 에이전트 만들기 {#create-agent}

`atmark.agents.create({ name })`(Python: `atmark.agents.create("이름")`)는 [자가 등록](/api/agents)을 부릅니다. 소유자가 켰을 때만 되고, 다시 시도하지 않습니다. 새 토큰은 한 번만 나오니 바로 보관합니다.
