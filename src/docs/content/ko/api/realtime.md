---
title: WebSocket 실시간 이벤트
nav_title: 실시간 API
description: 폴링 대신, 새 메일이 오거나 승인이 결정되는 순간 힌트를 받습니다. 연결 · 인증 · 핑 · 재연결 · 따라잡기.
group: api
order: 14
updated: 2026-10-15
keywords: [websocket, 푸시, 실시간, 이벤트, 폴링]
related: [api/inbound, api/webhooks, api/discovery, connect/sdks]
---
실시간 연결은 **힌트**를 보냅니다. "무언가 생겼으니 가서 읽어라"라는 작은 이벤트입니다. ID와 위험 등급만 싣고, 보낸 사람 · 제목 · 본문은 싣지 않습니다. 자세한 내용은 REST API나 MCP로 읽고, 읽은 내용은 바깥 데이터로 다룹니다.

이벤트는 최선을 다해 최대 한 번 보냅니다. 연결이 끊긴 동안 놓친 이벤트는 다시 오지 않으니, 다시 연결하면 꼭 [따라잡기](#catch-up)를 합니다. 확실한 전달이 필요하면 [웹훅](/api/webhooks)을 씁니다.

## 연결 {#connect}

주소는 [발견 문서](/api/discovery)의 `realtime.url`이나 `GET /v1/agents/me/realtime`(MCP `get_realtime_connection`)에서 읽습니다. 코드에 박아 두지 않습니다. 토큰에는 **읽기**(`messages:read`) 권한이 필요합니다.

토큰은 둘 중 **한 곳**으로 보냅니다.

| 어디 | 값 | 쓰는 곳 |
|---|---|---|
| `Authorization` 헤더 | `Bearer atk_agent_…` | 서버, 헤더를 붙일 수 있는 클라이언트. 권장 |
| `Sec-WebSocket-Protocol` 헤더 | `atmark.v1, bearer.atk_agent_…` | 헤더를 붙일 수 없는 브라우저. 서버는 `atmark.v1`만 돌려줍니다. |

:::danger 토큰을 URL에 넣지 않습니다
토큰처럼 보이는 쿼리 매개변수가 있으면 `400`으로 거부합니다. URL은 로그와 브라우저 기록에 남습니다.
:::

```js title="Node 22 (내장 WebSocket)"
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

연결이 거부되면 HTTP 상태로 끝납니다: 토큰이 없거나 틀리거나 폐기됐으면 `401`, URL에 토큰이 있으면 `400`, 권한이 없거나 에이전트가 활성이 아니면 `403`, 에이전트의 열린 연결이 이미 5개면 `429`. `401`과 `403`은 같은 토큰으로 다시 시도하지 않습니다.

## 이벤트 {#events}

모든 이벤트는 같은 봉투를 씁니다.

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

| `type` | 언제 | `data` |
|---|---|---|
| `message.received` | 받은 메일이 에이전트에게 보이게 됐을 때: 보통의 수신, 또는 소유자가 보류된 메일을 풀었을 때. 아직 보류된 메일에는 보내지 않습니다. | `message_id`, `thread_id`, `received_at`, `risk.level` |
| `approval.resolved` | 소유자가 보류된 발송을 승인하거나 거절했을 때. 승인된 메일은 Atmark가 보냅니다. 다시 보내지 않습니다. | `approval_id`, `decision`(`approved` · `rejected`), `resolved_at`, `message_ids` |

- `id`가 이벤트의 식별자입니다. 이미 처리한 `id`는 건너뜁니다.
- 메일은 [`GET /v1/messages/inbound/{messageId}`](/api/inbound#get)나 `read_email`로 읽습니다. `risk.level`이 `none`이 아니면 적대적인 메일로 다룹니다.
- 모르는 `type`이 나중에 생길 수 있습니다. 건너뜁니다.

## 연결 유지 {#ping}

| 한도 | 값 |
|---|---|
| 에이전트당 열린 연결 | 5개 |
| 가장 긴 연결 | 2시간. 그 뒤 서버가 닫습니다. |
| 유휴 시간 제한 | 오가는 것이 없으면 10분 |
| 핑 | 5분쯤마다 `{"action":"ping"}`을 보냅니다. 답은 `{"type":"pong"}`입니다. |

`{"action":"subscribe"}`를 보내면 이 연결이 받는 이벤트 종류를 알려 줍니다. 지금은 모든 연결이 모든 종류를 받으므로 보내지 않아도 됩니다.

## 다시 연결하고 따라잡기 {#catch-up}

어떻게 닫혔든 다시 연결합니다. 지수 백오프에 전체 지터를 씁니다: 1초에서 시작해 60초에서 멈춥니다. 되도록 2시간 한도 전에 새 연결을 엽니다.

다시 연결한 뒤에는 놓친 메일을 목록으로 받습니다.

```http
GET /v1/messages/inbound?since={마지막으로 본 received_at}
```

`since`는 그 시각을 포함하므로 한 통이 다시 보일 수 있습니다. 메일 `id`로 건너뜁니다. 끊긴 동안 소유자가 풀어 준 메일도 이 목록에 나옵니다.

:::feature !sdkPublished
[SDK](/connect/sdks)가 나오면 핑 · 백오프 · 갱신 · 헤더 고르기를 대신 해 줍니다.
:::

:::feature sdkPublished
[SDK](/connect/sdks)가 핑 · 백오프 · 갱신 · 헤더 고르기를 대신 해 줍니다.
:::
