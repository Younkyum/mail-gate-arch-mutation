---
title: 웹훅 받기
nav_title: 웹훅 API
description: 메일 도착, 발송, 승인 결과를 내 서버로 받습니다. 웹훅은 콘솔이나 API로 관리하고, 모든 요청에 서명이 붙습니다.
keywords: [콜백, 알림, 이벤트 수신]
group: api
order: 13
updated: 2026-10-15
related: [api/approvals, api/inbound, api/overview]
---
웹훅은 에이전트마다 따로 등록합니다. 콘솔의 에이전트 화면에 있는 **웹훅** 탭이나 아래 API로 등록하고 관리합니다. 콘솔에서는 owner와 admin이 바꿀 수 있고, member는 보기만 합니다(member에게는 URL이 가려져 보입니다). MCP 도구로 등록하거나 교체하면 시크릿이 에이전트에게 보이지 않습니다. 시크릿이 필요하면 콘솔에서 교체합니다.

## 권한 {#scopes}

| 할 일 | 필요한 권한 |
|---|---|
| 등록, 삭제, 시크릿 교체, 재전송 | **웹훅 관리**(`webhooks:manage`) |
| 엔드포인트 목록, 전달 기록 | **읽기**(`messages:read`) |

웹훅을 등록하면 이벤트가 바깥 URL로 나가기 시작합니다. 그래서 읽기 권한만 가진 토큰으로는 등록할 수 없습니다. **웹훅 관리** 권한은 새 토큰에 기본으로 들어 있지 않으니, 에이전트가 웹훅을 직접 다뤄야 할 때 토큰을 만들며 골라 줍니다. [토큰 권한](/connect/tokens#scopes)

:::note 기존 토큰
이 권한이 생기기 **전에 발급한** 토큰은 **2026년 12월 31일(UTC)까지** **보내기**(`messages:send`) 권한으로도 삭제와 재전송을 할 수 있고, **읽기** 권한도 있으면 등록도 할 수 있습니다. 시크릿 교체는 **웹훅 관리** 권한이 있어야 합니다. 그 뒤로는 모든 작업에 **웹훅 관리** 권한이 필요합니다. 콘솔에서 토큰을 교체하면 새 토큰이 되므로 이 예외가 이어지지 않습니다. 그 전에 **웹훅 관리** 권한이 있는 토큰을 새로 발급해 두세요.
:::

## 엔드포인트 등록 {#register}

```http
POST /v1/agents/me/webhook-endpoints
```

**웹훅 관리** 권한이 필요합니다.

```json
{ "url": "https://example.com/atmark-webhook", "event_types": ["message.received", "message.bounced"] }
```

- `url`은 `https` 주소여야 합니다. 내부망 주소는 거부합니다(`400 invalid_webhook_url`).
- `event_types`를 생략하면 기본 네 가지(`approval.resolved`, `approval.expired`, `message.sent`, `message.received`)만 받습니다.
- 구독은 등록한 뒤 바꿀 수 없습니다. 바꾸려면 새로 등록합니다.

응답(`201`)에 **시크릿**(`whsec_…`)이 한 번만 옵니다. 다시 조회할 수 없으니 바로 저장하세요. 잃어버렸다면 [시크릿을 교체](#rotate)합니다.

에이전트당 활성 엔드포인트 수는 요금제가 정합니다(`409 webhook_endpoint_limit`). 하루에 등록할 수 있는 횟수에도 제한이 있습니다(`409 webhook_endpoint_registration_limit`).

### 인증 헤더(선택) {#authorization}

받는 서버가 게이트웨이나 자동화 도구 뒤에 있어 자격 증명이 있는 요청만 받는다면 본문에 `authorization`을 넣습니다. **헤더 값 전체**이고, Atmark는 재시도와 재전송을 포함한 모든 전달에 `Authorization: <값>`으로 싣습니다.

```json
{ "url": "https://example.com/atmark-webhook", "authorization": "Bearer <게이트웨이-토큰>" }
```

- 받는 쪽이 요구하는 값을 그대로 넣습니다(`Bearer <토큰>`, `Basic <base64>` 등). 헤더 이름은 늘 `Authorization`입니다.
- 인쇄 가능한 ASCII만, 2048자까지 넣을 수 있습니다. 줄바꿈·탭 같은 제어 문자와 `Authorization:` 접두어는 안 됩니다(`400 invalid_authorization`).
- 값은 암호화해 저장하고 **다시 돌려주지 않습니다**. 응답과 목록에는 `has_authorization`과 `authorization_hint`(알려진 방식 이름과 끝 네 글자, 예: `Bearer …wxyz`. `Basic`이거나 16자 미만이거나 `:`·공백이 든 값은 끝 글자를 숨깁니다)만 있습니다.
- 에이전트 토큰은 등록할 때만 넣을 수 있습니다. 바꾸거나 지우려면 owner나 admin이 콘솔 **웹훅** 탭에서 엔드포인트의 **⋯** 메뉴를 씁니다. 엔드포인트를 삭제하면 값도 함께 지웁니다.
- 등록한 그 URL로만 보냅니다. 리다이렉트를 따라가지 않으니 헤더가 다른 곳으로 가지 않습니다.

:::note 서명을 대신하지 않습니다
이 헤더는 게이트웨이를 지나기 위한 것입니다. [서명 확인](#signature)은 계속하세요. 요청이 Atmark에서 왔고 바뀌거나 재생되지 않았음을 증명하는 것은 서명입니다.
:::

## 목록과 삭제

```http
GET    /v1/agents/me/webhook-endpoints
DELETE /v1/agents/me/webhook-endpoints/{endpointId}
```

목록에는 시크릿이 없습니다. **웹훅 관리** 권한이 없는 토큰으로 보면 `url`이 `https://example.com/…hook`처럼 가려지고(호스트와 경로 끝 네 글자만) `url_masked`가 `true`입니다. 항목마다 `secret_version`(교체할 때마다 1씩 오름), `secret_rotated_at`, `previous_secret_valid_until`(교체 직후 이전 시크릿이 유효한 끝 시각, 없으면 `null`), `has_authorization`, `authorization_hint`가 있습니다(인증 헤더 값 자체는 없습니다).

삭제에는 **웹훅 관리** 권한이 필요하고, 삭제한 엔드포인트로는 더 보내지 않습니다. 되살릴 수 없습니다.

## 시크릿 교체 {#rotate}

```http
POST /v1/agents/me/webhook-endpoints/{endpointId}/rotate-secret
```

**웹훅 관리** 권한이 필요하고 본문은 없습니다. 콘솔의 **웹훅** 탭에서도 할 수 있습니다. 응답(`200`)은 이렇습니다.

```json
{
  "endpoint": { "id": "…", "url": "https://example.com/atmark-webhook", "secret_version": 2, "previous_secret_valid_until": "2026-10-01T09:00:00.000Z", "…": "…" },
  "secret": "whsec_…",
  "previous_valid_until": "2026-10-01T09:00:00.000Z"
}
```

- 새 시크릿은 이 응답에만 한 번 옵니다. 엔드포인트 id와 구독은 그대로입니다.
- 교체한 뒤 **24시간**(`previous_valid_until`까지)은 모든 요청에 새 시크릿과 이전 시크릿의 서명이 **둘 다** 붙습니다. 그동안 받는 쪽 설정을 새 시크릿으로 바꾸면 이벤트를 놓치지 않습니다. [서명 확인](#signature)
- 24시간 안에 다시 교체하면 바로 앞의 시크릿만 유효하고, 그보다 오래된 시크릿은 바로 끝납니다.
- 엔드포인트 하나당 24시간에 10번까지 교체할 수 있습니다(`429 webhook_rotation_rate_limited`).

## 이벤트 {#events}

| 이벤트 | 언제 | `data` |
|---|---|---|
| `message.received` | 메일이 에이전트에게 도착했을 때(보류된 메일은 제외) | `message_id`, `thread_id`, `received_at` |
| `message.sent` | 메일이 나갔을 때 | `message_id`, `sent_at` |
| `approval.resolved` | 승인 요청이 승인되거나 거절됐을 때 | `approval_id`, `decision`, `resolved_at`, `message_ids` |
| `approval.expired` | 승인 기한이 지났을 때 | `approval_id`, `expired_at`, `message_ids` |
| `message.delivered` | 받는 쪽 메일 서버가 받았을 때(구독해야 받음) | `message_id`, `delivered_at`, `recipient_positions` |
| `message.bounced` | 반송됐을 때(구독해야 받음) | `message_id`, `bounced_at`, `recipient_positions`, `bounce_type`(`permanent`·`transient`·`undetermined`) |
| `message.complained` | 받는 사람이 스팸으로 신고했을 때(구독해야 받음) | `message_id`, `complained_at`, `recipient_positions` |

요청 본문은 이런 모양입니다.

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

웹훅에는 보낸 사람, 제목, 본문, 받는 사람 주소가 들어 있지 않습니다. 필요하면 `message_id`로 [받은 메일 API](/api/inbound)를 부릅니다. `recipient_positions`는 그 메일의 받는 사람 목록에서의 위치(0부터)입니다. 목록은 주소를 소문자로 바꾸고 중복을 없앤 뒤 유니코드 코드 포인트 순으로 정렬한 것입니다. 보낸 쪽에서 같은 규칙으로 정렬하면 위치를 주소로 되돌릴 수 있습니다. 값은 오름차순이고 겹치지 않습니다.

## 서명 확인 {#signature}

모든 요청에 세 헤더가 붙습니다(Standard Webhooks 형식).

| 헤더 | 값 |
|---|---|
| `webhook-id` | 이벤트 ID. 중복 처리에 씁니다. |
| `webhook-timestamp` | 보낸 시각(유닉스 초) |
| `webhook-signature` | `v1,<base64 서명>`. 여럿이면 공백으로 나뉩니다. 시크릿을 교체한 뒤 24시간은 `v1,<새 시크릿 서명> v1,<이전 시크릿 서명>` 두 개가 붙습니다. |

서명은 `<webhook-id>.<webhook-timestamp>.<본문>`을 시크릿으로 HMAC-SHA256한 값입니다. 시크릿의 `whsec_` 뒤는 base64입니다.

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

본문은 파싱하기 전의 원문 그대로 씁니다. 시각은 5분 이내만 받아 재생 공격을 막습니다. 서명 중 **하나라도** 내 시크릿과 맞으면 받습니다. 위 코드는 그렇게 확인하므로 시크릿을 교체하는 동안에도 그대로 씁니다.

## 전달 규칙 {#delivery-contract}

- 10초 안에 `2xx`로 답해야 성공입니다. 무거운 처리는 받은 뒤 따로 합니다.
- `2xx`가 아니거나, 시간이 넘었거나, 연결이 안 되면 실패입니다. 리다이렉트(`3xx`)는 따라가지 않고 실패로 칩니다.
- 실패하면 30초, 2분, 10분, 30분, 1시간, 2시간, 4시간, 8시간, 16시간 뒤에 다시 보냅니다. 첫 시도까지 모두 10번, 약 31시간 40분 동안입니다.
- 다시 보낼 때도 이벤트 ID와 본문은 같고 서명 시각만 새로 붙습니다. `webhook-id`로 중복을 거릅니다.
- 보낼 때 목적지가 거부되면(내부망 주소로 풀리는 도메인, 잘못된 URL, 삭제된 엔드포인트) 다시 시도하지 않고 바로 `dead`가 됩니다.
- 끝내 실패한 전달도 `dead`가 됩니다.

## 전달 기록과 재전송 {#deliveries}

```http
GET  /v1/agents/me/webhook-deliveries?status=dead
POST /v1/agents/me/webhook-deliveries/{deliveryId}/redeliver
```

목록(**읽기** 권한)은 `status`(`pending`·`delivered`·`dead`), `limit`(1~100), `cursor`를 받습니다. 항목마다 `id`, `event_id`, `event_type`, `endpoint_id`, `status`, `attempt_count`, `last_error`, `last_http_status`, `redelivery_of`, `created_at`, `next_attempt_at`(`pending`일 때만), `delivered_at`, `dead_at`이 있습니다. 본문과 URL은 목록에 없습니다.

재전송(**웹훅 관리** 권한)은 `dead`인 전달만 되고, 같은 이벤트 ID와 본문으로 새 전달을 만듭니다(`201`). 한 전달은 3번까지, 에이전트당 시간당 100건까지 다시 보낼 수 있습니다.

## 오류 {#errors}

| 상태 | `error` | 뜻 |
|---|---|---|
| `400` | `invalid_webhook_url` | 등록할 수 없는 URL입니다. |
| `403` | `forbidden` | 토큰에 필요한 권한이 없습니다(`capability_not_granted`). [권한](#scopes) |
| `404` | `not_found` | 엔드포인트나 전달이 없습니다(삭제, 교체, 재전송). |
| `409` | `webhook_endpoint_limit` | 에이전트당 활성 엔드포인트 한도에 닿았습니다. |
| `409` | `webhook_endpoint_registration_limit` | 하루 등록 횟수 한도에 닿았습니다. |
| `409` | `delivery_not_dead` | `dead`인 전달만 다시 보낼 수 있습니다. |
| `409` | `webhook_endpoint_deleted` | 삭제된 엔드포인트로 가는 전달은 다시 보낼 수 없습니다. |
| `409` | `redelivery_destination_rejected` | 목적지가 거부돼 죽은 전달입니다. URL을 고쳐 새 엔드포인트를 등록합니다. |
| `409` | `delivery_already_delivered` | 이 전달(또는 그 재전송)은 이미 받았습니다. |
| `409` | `redelivery_limit` | 한 전달의 재전송 횟수를 다 썼습니다. |
| `429` | `redelivery_rate_limited` | 시간당 재전송 한도에 닿았습니다. 나중에 다시 합니다. |
| `429` | `webhook_rotation_rate_limited` | 24시간 시크릿 교체 한도에 닿았습니다. 나중에 다시 합니다. |
