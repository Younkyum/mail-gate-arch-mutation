---
title: Hermes 연결하기
nav_title: Hermes
description: 토큰은 Hermes 환경 파일에 직접 넣고, 콘솔 연결 화면의 설정 메시지를 붙여 넣으면 Hermes가 스스로 MCP 서버를 연결하고 확인합니다.
group: connect
order: 2
updated: 2026-10-13
related: [connect/tokens, connect/mcp-tools, help/troubleshooting-connection]
---
Hermes는 Nous Research의 오픈소스 AI 에이전트입니다. 토큰은 직접 Hermes 환경 파일에 넣고, 콘솔의 설정 메시지(토큰 없음)를 Hermes에게 보내면 Hermes가 나머지를 스스로 설정합니다.

## 시작하기 전에

- Hermes가 설치된 환경
- 이 에이전트의 토큰. 토큰은 발급하거나 교체한 직후에만 보입니다. 없으면 [새 토큰](/connect/tokens)을 발급합니다.

:::steps
### 토큰을 환경 파일에 넣기
`~/.hermes/.env`에 이미 `ATMARK_AGENT_TOKEN` 줄이 있다면 아래 명령 대신 편집기로 그 줄의 값만 바꿉니다.

없다면 터미널에서 실행하고, 토큰을 붙여 넣은 뒤 Enter를 누릅니다. 토큰을 쓰기 전에 파일을 나만 읽을 수 있게(600) 만들고, 토큰은 화면과 셸 기록에 남지 않습니다.

```bash
(umask 077 && mkdir -p ~/.hermes && touch ~/.hermes/.env) && chmod 600 ~/.hermes/.env && read -rs ATMARK_AGENT_TOKEN && printf 'ATMARK_AGENT_TOKEN=%s\n' "$ATMARK_AGENT_TOKEN" >> ~/.hermes/.env; unset ATMARK_AGENT_TOKEN
```

### 연결 화면의 메시지 복사하기
에이전트 화면의 **연결**에서 메시지 언어(**EN**·**KO**)를 고르고 **메시지 복사**를 누릅니다. 이 메시지에는 토큰이 없습니다. 대신 토큰이 이미 `~/.hermes/.env`에 있으니 그 파일은 열거나 출력하거나 고치지 말라고 Hermes에게 알려 줍니다.

### Hermes에게 붙여 넣기
Hermes와의 대화에 메시지를 그대로 붙여 넣습니다. 덧붙일 말은 없습니다. Hermes가 `~/.hermes/config.yaml`을 고치고 `/reload-mcp`를 실행한 뒤 `get_my_policy`로 확인합니다.

### 답 확인하기
Hermes가 "Atmark 연결됨"과 `get_my_policy` 결과로 답하면 끝입니다. `from_address`가 에이전트 주소인지 봅니다.
:::

![에이전트 연결 화면](shot:agent-connect)

## 토큰이 든 설정 메시지 쓰기 {#token-message}

토큰을 발급한 직후의 토큰 창에는 토큰이 들어간 설정 메시지도 있습니다. 붙여 넣기만 하면 되어 편하지만 대가가 있습니다.

- 토큰이 Hermes 대화 기록과 모델 제공자 쪽 기록에 남습니다.
- 그래서 이 방법을 쓸 때는 이 용도로만 쓰는 토큰을 따로 발급하고 **만료**를 정합니다.
- 대화 기록을 다른 사람과 나누거나 내보냈다면 그 토큰을 [교체](/connect/tokens#rotate)합니다.

## 직접 설정하기 {#manual}

메시지 대신 직접 고쳐도 됩니다. 결과는 같습니다.

`~/.hermes/.env`(파일 권한 600)에 토큰을 넣습니다.

```bash title="~/.hermes/.env"
ATMARK_AGENT_TOKEN=atk_agent_...
```

`~/.hermes/config.yaml`에 서버를 추가합니다. 토큰을 이 파일에 직접 쓰지 마세요. 설정 파일은 공유·백업·스크린샷으로 새기 쉽습니다.

```yaml title="~/.hermes/config.yaml"
mcp_servers:
  atmark:
    url: "https://api.atmark.ai/mcp"
    headers:
      Authorization: "Bearer ${env:ATMARK_AGENT_TOKEN}"
    timeout: 60
    connect_timeout: 30
    tools:
      include:
        - send_email
        - reply_email
        - forward_email
        - list_inbox
        - read_email
        - get_thread
        - read_attachment
        - get_attachment_url
        - get_approval_status
        - get_my_policy
        - get_verification_code
        - list_scheduled
        - cancel_scheduled
      resources: false
      prompts: false
```

Hermes 안에서 `/reload-mcp`를 실행하고, 터미널에서 연결을 확인합니다.

```bash
hermes mcp test atmark
```

도구 열세 개가 보이면 됩니다. 읽기 전용 토큰이면 보내기·취소 도구가 빠집니다.

## 문제 해결

- **401**: `~/.hermes/.env`에 그 이름의 줄이 있는지 봅니다. 변수가 정의되지 않으면 `${env:…}`가 글자 그대로 서버로 가서 401이 납니다. 다른 프로필을 쓰고 있지 않은지도 확인합니다.
- **도구가 안 보임**: Hermes에게 `/reload-mcp`를 다시 부탁합니다.
- **`recipient_not_allowlisted`**: 콘솔의 **이메일** 화면에서 발신 허용 목록에 상대를 넣거나, 그 화면의 에이전트 [변경 요청](/email/allow-block-lists#requests)을 승인합니다.

에이전트가 보는 도구 이름은 `mcp__atmark__send_email` 꼴입니다.
