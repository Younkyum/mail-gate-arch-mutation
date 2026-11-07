---
title: 스레드 가져오기 API
nav_title: 스레드 API
description: GET /v1/threads/{threadId}로 한 대화의 보낸 메일과 받은 메일을 오래된 순서로 가져옵니다.
group: api
order: 7
updated: 2026-10-15
related: [api/inbound, api/messages]
---
```http
GET /v1/threads/{threadId}
```

**읽기**(`messages:read`) 권한이 필요합니다. `threadId`는 받은 메일의 `thread_id`입니다.

| 필드 | 뜻 |
|---|---|
| `id` · `agent_id` | 스레드와 에이전트 ID |
| `started_by` | 누가 대화를 시작했는지 |
| `subject` | 스레드 제목 |
| `created_at` · `last_message_at` | 시작 시각과 마지막 메일 시각 |
| `messages` | 보낸 메일과 받은 메일(오래된 순). 항목마다 `direction`(`outbound`·`inbound`)이 있습니다. |
| `quarantined.count` | 이 스레드에서 보류된 메일 수 |

없는 스레드는 `404 thread_not_found`입니다. 회신은 [회신 API](/api/messages#reply)로 보냅니다.
