---
title: 승인 상태 확인 API
nav_title: 승인 API
description: 발송 결과가 pending_approval이면 approval_id로 승인 요청의 상태를 확인합니다.
group: api
order: 8
updated: 2026-09-27
related: [email/approvals, api/webhooks, api/messages]
---
```http
GET /v1/approvals/{approvalId}
```

**읽기**(`messages:read`) 권한이 필요합니다. `approvalId`는 `202` 발송 결과의 `approval_id`입니다.

| 필드 | 뜻 |
|---|---|
| `id` · `agent_id` | 승인 요청과 에이전트 ID |
| `kind` | `message`(메일 한 통) 또는 `batch`(여러 통을 한 번에) |
| `status` | `pending`, `approved`, `rejected`, `expired` 중 하나 |
| `created_at` · `expires_at` · `decided_at` | 요청 시각, 기한, 결정 시각 |
| `granted_scope` | 승인한 범위: `recipient`(그 받는 사람), `thread`(그 스레드), `domain`(받는 사람의 도메인 전체), `once`(이 한 통만 — 위험 신호로 보류된 발송(`risk_review`)은 언제나 이것이고, 그 상대에게 다음 메일을 승인 없이 보내게 되지 않습니다). 승인 전과 거절·만료면 `null` |
| `message_ids` | 이 요청에 묶인 메일 ID |

없으면 `404 approval_not_found`입니다.

## 기다리는 법

- 같은 메일을 다시 보내지 않습니다. 새 발송은 새 승인 요청을 만들 뿐입니다.
- 상태를 계속 조회하기보다 웹훅 `approval.resolved`·`approval.expired`를 받는 편이 낫습니다. [웹훅](/api/webhooks)
- 승인되면 Atmark가 메일을 보냅니다. 에이전트가 따로 보낼 필요가 없습니다.

승인은 예전 발신 모드의 에이전트에게만 생깁니다. [승인 요청 처리하기](/email/approvals)
