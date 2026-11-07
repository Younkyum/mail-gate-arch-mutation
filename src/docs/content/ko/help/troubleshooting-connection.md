---
title: 연결이 안 될 때
description: 401, 403, 프로토콜 버전 오류, 도구가 안 보이는 문제를 하나씩 확인합니다.
group: help
order: 1
updated: 2026-09-27
related: [connect/tokens, connect/mcp-other-clients, connect/mcp-hermes]
---
먼저 [curl로 확인하기](/connect/mcp-other-clients)로 클라이언트 문제인지 서버 문제인지 가릅니다.

## 401 Unauthorized

토큰이 서버에 제대로 닿지 않았습니다.

- 토큰이 에이전트 환경에 실제로 있는지 봅니다. 변수가 정의되지 않으면 `${…}` 같은 글자가 그대로 서버로 갑니다.
- 콘솔의 **토큰** 화면에서 그 토큰이 폐기되거나 만료되지 않았는지 봅니다. 목록의 끝 네 글자로 어느 토큰인지 맞춰 봅니다.
- `atk_org_`로 시작하는 조직 API 키를 쓰고 있지 않은지 봅니다. 에이전트 연결에는 `atk_agent_` 토큰을 씁니다.
- 값을 잃어버렸다면 그 토큰을 [교체](/connect/tokens#rotate)하고 새 값을 넣습니다.

## 403

| 응답 | 원인과 해결 |
|---|---|
| `Origin not allowed` | 요청에 `Origin` 헤더가 붙었습니다. 브라우저가 아닌 서버에서 부릅니다. |
| `forbidden` | 토큰에 필요한 권한이 없거나, 다른 에이전트의 `agent_id`를 썼습니다. [권한](/connect/tokens#scopes)을 확인합니다. |

## 400, 코드 -32022

클라이언트가 보낸 MCP 프로토콜 버전을 지원하지 않습니다. 지원 버전은 `2025-11-25`, `2025-06-18`, `2025-03-26`입니다. 클라이언트를 업데이트합니다.

## 도구가 안 보임

- 클라이언트에서 MCP 서버를 다시 불러옵니다(Hermes는 `/reload-mcp`, Claude Code는 `/mcp`).
- 읽기 전용 토큰이면 보내기 도구가 보이지 않는 것이 정상입니다.
- Hermes의 `tools.include` 목록에 도구 이름이 빠지지 않았는지 봅니다.

## 405

`GET` 요청입니다. MCP 서버는 `POST`만 받습니다. 정상 동작입니다.
