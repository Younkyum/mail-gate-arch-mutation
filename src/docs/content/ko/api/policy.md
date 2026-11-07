---
title: 자기 정책 읽기 API
nav_title: 정책 API
description: GET /v1/agents/me/policy로 에이전트가 자기 발신·수신 모드와 목록, 한도를 읽습니다. 소유자에게 변경을 요청할 수는 있지만 직접 바꾸지는 못합니다.
group: api
order: 9
updated: 2026-10-13
related: [email/sending, email/receiving, email/limits-and-deliverability]
---
```http
GET /v1/agents/me/policy
```

**자기 정보**(`agent:read_self`) 권한이 필요합니다. MCP의 `get_my_policy`와 같은 내용이고, MCP 쪽에는 기본 발신 주소(`from_address`)가 더해집니다.

| 필드 | 뜻 |
|---|---|
| `policy_version` | 지금 정책 버전. 소유자가 바꿀 때마다 올라갑니다. |
| `outbound.mode` | 발신 모드: `all`, `allowlist`, `blocklist`, `none`. 예전 모드면 `legacy` |
| `outbound.allow` | 발신 허용 목록 |
| `outbound.block_count` | 발신 차단 목록 개수(내용은 보이지 않습니다) |
| `inbound.mode` · `inbound.allow` · `inbound.block_count` | 수신 쪽 같은 값 |
| `limits` | 실제로 걸리는 한도: `per_minute`, `per_hour`, `per_day`, `recipients_per_message`, `org_daily_recipients` |
| `plan` | 조직의 요금제 |
| `how_to_change` | 정책을 바꾸는 방법 안내(소유자가 콘솔에서) |

정책이 바뀌는 중이면 `409 policy_changing`입니다. 잠시 뒤 다시 읽습니다.

정책은 에이전트가 바꿀 수 없습니다. 보내야 할 상대가 막혀 있으면 메시지로, 또는 아래의 변경 요청으로 소유자에게 부탁합니다.

## 변경 요청하기 {#requests}

```http
POST /v1/agents/me/policy/requests
```

**정책 변경 요청**(`policy:request`) 권한이 필요합니다. 에이전트가 변경 **하나**를 이유와 함께 소유자에게 요청합니다. 소유자가 콘솔에서 승인하기 전에는 아무것도 바뀌지 않습니다. MCP: `request_policy_change`.

| 칸 | 필수 | 뜻 |
|---|---|---|
| `action` | 예 | `add_rule`, `remove_rule`, `set_mode` |
| `direction` | 예 | `outbound` 또는 `inbound` |
| `list` | 목록 항목일 때 | `allow` 또는 `block` |
| `value` | 목록 항목일 때 | 주소(`name@example.com`)나 도메인(`example.com`, `*.example.com`) |
| `mode` | `set_mode`일 때 | `all`, `allowlist`, `blocklist`, `none` |
| `reason` | 예 | 소유자가 읽을 한 줄, 500자까지 |

다른 칸은 `400 invalid_request`로 거부됩니다. 긴급 정지, 위험 처리, 발신 승인, 신뢰 발신자, 토큰, 권한, 웹훅, 한도는 요청할 수 없습니다.

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

- 응답은 `202`입니다. 기다리는 동안 같은 변경을 다시 요청하면 이유가 달라도 같은 요청이 `replayed: true`로 돌아옵니다.
- 정책이 이미 그 상태면(에이전트가 볼 수 있는 모드와 허용 목록) `409 no_change`입니다. 차단 목록은 에이전트에게 보이지 않으므로 견주지 않습니다.
- 소유자가 24시간 안에 같은 변경을 거절했다면 `409 policy_request_recently_rejected`입니다. 소유자가 시키지 않았다면 다시 요청하지 않습니다.
- 기다리는 요청이 5건이면 `429 policy_request_pending_limit`, 24시간에 20건을 넘으면 `429 policy_request_daily_limit`입니다. 요청은 7일 뒤 만료됩니다.

```http
GET /v1/agents/me/policy/requests/{request_id}
```

**자기 정보** 권한이 필요합니다. `status`는 `pending_approval`, `approved`(적용됨 — `applied_policy_version`이 새 버전), `rejected`, `stale`(소유자가 볼 때 더는 맞지 않음, `stale_reason` 포함), `expired` 중 하나입니다. 차단 목록 요청은 `approved`(요청한 상태가 지금 사실)나 `rejected`로만 보이고 `stale_reason`과 `applied_policy_version`이 없습니다. 결과로 차단 목록이 드러나지 않습니다. MCP: `get_policy_request`. [에이전트의 변경 요청](/email/allow-block-lists#requests)
