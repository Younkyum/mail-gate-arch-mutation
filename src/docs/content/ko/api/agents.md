---
title: 에이전트 만들기(자가 등록)
nav_title: 에이전트 만들기 API
description: 소유자가 허락하면 에이전트가 같은 조직에 형제 에이전트를 만듭니다. 새 에이전트는 바꿀 수 없는 안전한 기본값으로 시작합니다.
group: api
order: 16
updated: 2026-10-08
keywords: [자가 등록, enroll, 새 에이전트, 에이전트 생성]
related: [security/watch, api/discovery, connect/tokens]
---
자가 등록은 **기본으로 꺼져 있습니다.** 둘 다 참일 때만 됩니다.

- 소유자가 콘솔에서 **감시 › 자가 등록**을 켰습니다.
- 소유자가 이 에이전트의 토큰에 **자가 등록**(`agents:enroll`) 권한을 줬습니다. 소유자만 토큰마다 줄 수 있고, 새 토큰에는 들어 있지 않습니다.

부르기 전에 확인합니다: [내 기능](/api/discovery#capabilities)의 `self_enroll.available`은 둘 다 참이고 하루 상한이 남았을 때만 `true`입니다.

## 형제 에이전트 만들기 {#create}

```http
POST /v1/agents
Authorization: Bearer atk_agent_...
```

| 필드 | 필수 | 설명 |
|---|---|---|
| `name` | 예 | 표시 이름, 보이는 글자 1~80자 |
| `local_part` | 아니요 | `@` 앞부분. 빼면 무작위로 정합니다. |

```json title="201 응답 예"
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

:::warning 토큰은 한 번만 보입니다
`token`은 이 응답에만 나옵니다. 바로 비밀 저장소에 보관합니다. 메일 · 로그 · 메시지에 넣지 않습니다. 다시 받을 수 없고, 잃어버리면 소유자가 콘솔에서 새로 발급합니다.
:::

## 새 에이전트의 시작값 {#defaults}

이 기본값은 고정입니다. 만든 에이전트는 고르거나 바꿀 수 없고, 소유자만 콘솔에서 바꿉니다.

- **보내기:** 허용 목록만, 목록은 비어 있음. 소유자가 사람을 넣기 전에는 아무에게도 보내지 않습니다.
- **발신 승인:** `always`. 바깥으로 가는 메일은 모두 소유자를 기다립니다.
- **받기:** 누구에게서나, 위험 메일은 보류.
- **토큰:** 보내기 · 읽기 · 자기 정보만. 웹훅 · 감사 · 자가 등록 권한 없음.
- 새 에이전트는 다시 에이전트를 만들 수 없고, 그 토큰에는 `agents:enroll`을 줄 수 없습니다.

새 에이전트가 생기면 소유자에게 메일로 알립니다(소유자가 끄지 않았다면).

## 한도와 재시도 {#limits}

- 조직에는 24시간 동안 시도할 수 있는 횟수 상한이 있습니다(기본 5, 최대 20, 소유자가 정함). 실패한 시도도 셉니다. 이미 쓰인 주소도 셉니다.
- 요금제의 에이전트 한도도 그대로입니다.
- **자동으로 다시 시도하지 않습니다.** `503 enroll_busy` 뒤에는 1분 뒤 한 번만 다시 합니다. `503 enroll_timeout` 뒤에는 이미 만들어졌을 수 있으니 다시 부르기 전에 소유자에게 콘솔 확인을 부탁합니다.

## 오류 {#errors}

| 상태 | `error` | 뜻 |
|---|---|---|
| `400` | `invalid_request` | `name`이나 `local_part`가 틀렸거나 모르는 필드가 있습니다. |
| `401` | `unauthorized` | 토큰이 없거나 틀렸거나 폐기 · 만료됐습니다. |
| `403` | `forbidden` | 토큰에 `agents:enroll` 권한이 없습니다. |
| `403` | `self_enroll_disabled` | 소유자가 자가 등록을 켜지 않았습니다. |
| `403` | `agent_not_active` | 이 에이전트나 조직이 활성이 아닙니다. |
| `403` | `enroll_chain_forbidden` | 이 에이전트 자신이 자가 등록으로 만들어졌습니다. |
| `409` | `address_taken` | 그 주소는 쓸 수 없습니다. 다른 `local_part`를 고릅니다. 시도는 셉니다. |
| `409` | `agent_limit` | 조직이 요금제의 에이전트 한도에 닿았습니다. |
| `429` | `enroll_daily_cap` | 오늘 시도 횟수를 다 썼습니다. 내일 하거나 소유자에게 묻습니다. |
| `503` | `enroll_busy` | 바쁩니다. 1분 뒤 한 번만 다시 합니다. |
| `503` | `enroll_timeout` | 제때 답이 없었습니다. 만들어졌을 수 있으니 바로 다시 부르지 않습니다. |
| `503` | `enroll_unavailable` | 지금은 자가 등록을 쓸 수 없습니다. |

MCP 도구 `create_agent`도 같은 일을 하고 같은 오류를 돌려줍니다.
