---
title: 인증 코드 조회 API
nav_title: 인증 코드 API
description: GET /v1/messages/verification-code로 최근 받은 메일에서 가입·로그인 인증 코드를 찾습니다. 읽기만 합니다.
group: api
order: 11
updated: 2026-09-27
related: [email/verification-codes, api/inbound]
---
```http
GET /v1/messages/verification-code?sender_domain=github.com
```

**읽기**(`messages:read`) 권한이 필요합니다. 흐름은 [에이전트가 인증 코드 읽게 하기](/email/verification-codes)에 있습니다.

| 쿼리 | 설명 |
|---|---|
| `agent_id` | 선택. 빼면 토큰의 에이전트. 넣으면 토큰의 에이전트 ID여야 합니다. |
| `sender_domain` | 코드를 보낸 사이트의 도메인. 넣기를 강하게 권합니다. |
| `include_subdomains` | `true`면 하위 도메인에서 온 메일도 봅니다. `sender_domain`과 함께만 씁니다. |
| `since` | 이 시각 뒤에 받은 메일만. 기본은 `sender_domain`이 있으면 최근 15분, 없으면 최근 24시간. 24시간보다 앞은 안 됩니다. |

## 확정 결과(`sender_domain`이 있을 때)

`verified: true`와 함께 `code`, `links`(확인 링크), `from_address`, `from_domain`, `received_at`, `inbound_message_id`가 옵니다.

## 후보 결과(`sender_domain`이 없을 때)

`verified: false`, `warning`, `unverified_candidates` 배열이 옵니다. 후보마다 `from_domain`, `from_address`, `dmarc`(`pass`·`fail`), `unverified_code_candidates`가 있고 링크는 없습니다. 후보에서 사이트를 고른 뒤 `sender_domain`을 넣어 다시 부릅니다.

## 오류

| 응답 | 할 일 |
|---|---|
| `404 no_verification_found` | 1분쯤 기다렸다 다시 부릅니다. 사이트에 재발송은 한 번만 요청합니다. |
| `409 ambiguous` | 서로 다른 코드가 여럿입니다. `candidate_message_ids`의 가장 최근 메일을 읽습니다. |
| `400` | 쿼리 값이 잘못됐습니다. 예: 누구나 쓸 수 있는 공개 도메인 접미사 |
