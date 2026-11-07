---
title: 조직 API 키로 에이전트 만들기
nav_title: 조직 API 키
description: 조직 API 키는 CI나 스크립트가 에이전트를 만들고 읽을 때 쓰는 조직 단위 키입니다. 에이전트 토큰과 다릅니다.
group: team
order: 3
updated: 2026-10-15
related: [agents/create, connect/tokens, team/members-and-roles]
---
조직 API 키는 **에이전트 토큰과 다른 것**입니다. 조직 API 키(`atk_org_…`)는 에이전트를 만들고 읽기만 하고, 메일을 보내거나 읽지 못합니다. 에이전트 토큰(`atk_agent_…`)은 조직 API로 쓸 수 없습니다.

## 시작하기 전에

- 역할이 소유자여야 합니다. 조직 API 키는 소유자만 보고 관리합니다.

## 키 발급하기

:::steps
### 새 키 열기
**설정 › 조직 API 키**에서 **키 발급**을 누릅니다.

### 이름·권한·만료 고르기
**이름**(60자까지), **권한**(**에이전트 읽기** `agents:read`, **에이전트 만들기** `agents:create` 중 하나 이상), **만료**를 고릅니다.

### 저장하고 닫기
**발급**을 누르면 키가 한 번만 보입니다. CI의 비밀 저장소에 바로 넣고 창을 닫습니다. 창을 닫으면 키를 다시 볼 수 없습니다.
:::

![설정의 조직 API 키 화면](shot:settings-keys)

조직당 활성 키 수는 요금제가 정합니다(최대 5개).

## API 쓰기

기본 URL은 콘솔 주소입니다.

```text
https://console.atmark.ai/org-api/v1
```

| 메서드 | 경로 | 권한 | 하는 일 |
|---|---|---|---|
| `GET` | `/agents` | `agents:read` | 에이전트 목록. 응답은 `{items, nextCursor}`. `limit`, `cursor`, `q`(검색어)를 받습니다. |
| `GET` | `/agents/{agentId}` | `agents:read` | 에이전트 하나 |
| `POST` | `/agents` | `agents:create` | 에이전트 만들기. 본문 `{"name": "…", "localPart": "…"}` |

```bash
curl -sS https://console.atmark.ai/org-api/v1/agents \
  -H "Authorization: Bearer $ORG_KEY" \
  -H "Content-Type: application/json" \
  -d '{"name": "Help desk agent", "localPart": "desk"}'
```

:::feature customDomains
권한 `domains:manage`가 있는 키는 고객 도메인도 관리합니다(`/domains`). 만들기 본문에 `"domain": "agents.example.com"`을 더하면 그 도메인 주소가 대표 주소가 됩니다. [내 도메인으로 메일 주고받기](/email/custom-domains#org-api)
:::

만들기 응답(`201`)은 `{agent, token}`입니다. 새 에이전트의 **첫 토큰은 이 응답에 한 번만** 옵니다. 바로 비밀 저장소에 넣으세요. 만들기는 콘솔과 같은 규칙을 따릅니다. 주소 규칙, 에이전트 수 한도와 (예전 가입으로 아직 검토 중인 조직의) 검토 중 상한이 똑같이 걸립니다.

- 브라우저에서 부르면 `403 origin_forbidden`입니다. 서버나 CI에서 부릅니다.
- 요청이 너무 잦으면 `429 rate_limited`입니다.
- 키가 없거나 틀리면 `401 unauthenticated`입니다.

## 교체와 폐기

키 행의 동작 메뉴에서 고릅니다.

- **교체**: 같은 이름·권한의 새 키를 발급하고 지금 키는 바로 폐기합니다. CI의 비밀 값을 새 키로 바꿔야 합니다.
- **폐기**: 이 키를 쓰는 CI는 바로 `401`을 받습니다. 이 키로 만든 에이전트는 그대로입니다. 되돌릴 수 없습니다.
