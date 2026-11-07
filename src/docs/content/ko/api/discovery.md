---
title: 발견 문서와 기능 조회
nav_title: 발견 API
description: 공개 문서 둘과 에이전트별 조회 하나로, 사람이 설정을 써 주지 않아도 에이전트가 Atmark 쓰는 법을 읽고 스스로 설정합니다.
group: api
order: 15
updated: 2026-10-08
keywords: [openapi, well-known, 자동 설정, capabilities, 스키마]
related: [api/overview, api/realtime, connect/sdks, connect/mcp-tools]
---
에이전트는 세 곳에서 필요한 것을 모두 읽을 수 있습니다. 앞의 둘은 공개이고 토큰이 필요 없습니다.

| 무엇 | 어디 | 토큰 |
|---|---|---|
| 발견 문서 | `GET https://api.atmark.ai/.well-known/atmark.json` | 없음 |
| OpenAPI 3.1 | `GET https://api.atmark.ai/v1/openapi.json` | 없음 |
| 내 기능 | `GET /v1/agents/me/capabilities` 또는 MCP `get_capabilities` | **자기 정보**(`agent:read_self`) |

공개 문서는 5분 동안 캐시할 수 있고 어느 출처에서든 읽을 수 있습니다.

## 발견 문서 {#well-known}

```bash
curl -sS https://api.atmark.ai/.well-known/atmark.json
```

JSON 객체입니다. 주요 키는 이렇습니다.

| 키 | 내용 |
|---|---|
| `api` | `base_url`(`https://api.atmark.ai/v1`)과 `openapi_url` |
| `mcp` | MCP 서버 주소, 전송 방식, 먼저 부를 도구(`get_capabilities`) |
| `docs` | 이 문서 사이트와 `llms.txt` · `llms-full.txt` |
| `realtime` | [실시간 WebSocket](/api/realtime)에 붙는 법: 주소 · 인증 · 이벤트 · 한도 · 재연결 |
| `auth` | `Authorization`의 Bearer 토큰, 토큰 접두사, 모든 권한, 토큰을 받는 법 |
| `send_approval` | `send_approval: "always"`가 발송에 뜻하는 것 |
| `self_enroll` | 에이전트가 [형제 에이전트를 만드는 법](/api/agents) |
| `idempotency` | 헤더 이름, 필수인 동작과 받는 동작, 재사용 오류 |
| `rate_limits` | API 전체의 초당 요청 수와 버스트 |
| `sdks` | [TypeScript · Python SDK](/connect/sdks)와 게시 여부 |
| `risk` | `risk.level` 값과 받은 메일 규칙 |

에이전트는 자기 토큰을 만들 수 없습니다. 소유자가 콘솔에서 발급하고, 나머지는 에이전트가 여기서 읽습니다.

## OpenAPI {#openapi}

```bash
curl -sS https://api.atmark.ai/v1/openapi.json
```

모든 공개 경로가 들어 있습니다: 권한, `Idempotency-Key`를 받는지, 쿼리 매개변수, 요청 · 응답 스키마. 클라이언트를 생성하거나 에이전트가 바로 읽게 합니다. 실시간 이벤트는 `x-atmark-realtime` 확장에 있습니다.

## 내 기능 {#capabilities}

```http
GET /v1/agents/me/capabilities
Authorization: Bearer atk_agent_...
```

응답은 발견 문서에 부른 에이전트에 대한 키 셋을 더한 것입니다.

| 키 | 내용 |
|---|---|
| `agent` | `agent_id`, 대표 `address`, 모든 주소(`addresses`, `primary` 표시), 토큰의 `scopes` |
| `policy` | 정책 버전, 발신 · 수신 모드와 목록 **개수**, 한도, 요금제, `send_approval`, 바꾸는 법 |
| `self_enroll` | [자가 등록](/api/agents)을 지금 쓸 수 있는지(`available`): `scope_granted` · `enabled_by_owner` · `daily_cap` · `used_last_24h` |

목록 전체는 [정책 API](/api/policy)에 있습니다. MCP 도구 `get_capabilities`도 같은 값을 돌려주고, 도구 설명이 에이전트에게 먼저 읽으라고 말합니다.
