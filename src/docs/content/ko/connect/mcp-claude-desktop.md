---
title: Claude Desktop 연결하기
nav_title: Claude Desktop
description: Atmark MCP 서버는 요청 헤더의 토큰으로 인증합니다. Claude Desktop에서는 헤더를 붙일 수 있는 브리지를 거쳐 연결합니다.
keywords: [클로드 데스크톱, 클로드 앱]
group: connect
order: 5
updated: 2026-09-27
related: [connect/mcp-other-clients, connect/tokens, help/troubleshooting-connection]
---
Atmark MCP 서버는 `Authorization: Bearer <토큰>` 헤더로만 인증합니다. 로그인 창을 여는 방식의 커넥터 인증은 지원하지 않습니다. 그래서 Claude Desktop에서는 요청 헤더를 붙일 수 있는 로컬 브리지를 거쳐 연결합니다.

## 시작하기 전에

- Claude Desktop
- 원격 MCP 서버에 요청 헤더를 붙여 전달하는 브리지(로컬에서 도는 MCP 서버)
- 이 에이전트의 토큰(`atk_agent_…`)

:::steps
### 브리지 설정하기
Claude Desktop 설정 파일(`claude_desktop_config.json`)의 `mcpServers`에 브리지를 추가합니다. 브리지에 넘길 값은 셋입니다.

- 주소: `https://api.atmark.ai/mcp`
- 전송: Streamable HTTP
- 헤더: `Authorization: Bearer <토큰>`

토큰은 설정 파일에 직접 쓰지 말고, 브리지가 지원하면 환경 변수로 넘깁니다.

### 다시 시작하기
Claude Desktop을 완전히 종료했다가 다시 엽니다.

### 확인하기
대화에서 Atmark의 `get_my_policy`를 불러 달라고 합니다. `from_address`가 에이전트 주소면 됩니다.
:::

## 문제 해결

- **401**: 브리지가 헤더를 실제로 붙이는지 봅니다. [연결 문제 해결](/help/troubleshooting-connection)
- **403 `Origin not allowed`**: 브라우저처럼 `Origin` 헤더를 붙여 보내고 있습니다. 서버 대 서버로 보내는 브리지를 씁니다.
- 서버 조건은 [그 밖의 MCP 클라이언트](/connect/mcp-other-clients)에 정리했습니다.
