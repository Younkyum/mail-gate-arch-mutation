---
title: 파일 첨부해 보내기
nav_title: 첨부 보내기
description: 에이전트가 PDF·PNG·JPEG·텍스트 파일을 올린 뒤 새 메일과 회신에 붙여 보냅니다. 올린 파일은 악성코드 검사를 통과해야 나갑니다.
keywords: [첨부파일, 파일 보내기, attachment]
group: email
order: 6
feature: attachments
updated: 2026-09-28
related: [api/attachments, email/sending, plans/plans-and-limits]
---
에이전트는 파일을 먼저 올리고, 받은 첨부 id를 메일에 적어 보냅니다. 올린 파일은 **악성코드 검사**를 통과해야 메일에 붙습니다.

## 보낼 수 있는 파일 {#types}

| 종류 | `mime_type` | 파일 이름 끝 |
|---|---|---|
| PDF | `application/pdf` | `.pdf` |
| PNG 이미지 | `image/png` | `.png` |
| JPEG 이미지 | `image/jpeg` | `.jpg` · `.jpeg` |
| 텍스트 | `text/plain` | `.txt` (1 MB까지, UTF-8) |

- 파일 내용이 적은 종류와 맞아야 합니다. 이름만 `.pdf`인 다른 파일은 거부합니다.
- 메일 한 통에 10개까지 붙입니다. 메일 한 통의 첨부 용량은 요금제가 정합니다. [요금제와 한도](/plans/plans-and-limits)
- 새 메일과 회신에만 붙습니다. 전달과 예약 발송에는 붙일 수 없습니다.

## 보내는 순서 {#flow}

:::steps
### 파일 올릴 자리 받기
에이전트가 `POST /v1/attachments`에 파일 이름·종류·크기·SHA-256을 보냅니다. 응답으로 첨부 id와 올릴 주소가 옵니다.

### 파일 올리기
받은 주소에 파일 바이트를 그대로 올립니다. 올릴 주소는 15분 동안 한 번만 쓸 수 있습니다.

### 검사 기다리기
올린 파일은 곧바로 악성코드 검사를 받습니다. 보통 몇 초면 끝납니다.

### 메일에 붙여 보내기
새 메일(`send_email`)이나 회신(`reply_email`)에 첨부 id를 넣어 보냅니다. 검사가 아직이면 결과가 `attachment_scan_pending`입니다. 같은 호출을 잠시 뒤 다시 합니다.
:::

요청과 응답의 모든 칸은 [첨부 API](/api/attachments)에 있습니다.

## MCP로 연결한 에이전트 {#mcp}

MCP 도구 `send_email`과 `reply_email`은 `attachment_ids`를 받습니다. 파일 올리기는 MCP 도구가 아니라 HTTP API로 합니다. 같은 에이전트 토큰을 쓰고, 토큰에 **보내기** 권한이 있어야 합니다.

## 막히는 경우 {#rejections}

| 결과 | 뜻 | 할 일 |
|---|---|---|
| `attachment_scan_pending` | 검사가 아직 끝나지 않았습니다. | 같은 요청을 잠시 뒤 다시 보냅니다. |
| `attachment_malicious` | 악성코드가 나왔습니다. | 그 파일은 보낼 수 없습니다. |
| `attachment_expired` | 올린 지 2일이 지났습니다. | 다시 올립니다. |
| `attachment_bytes_exceeded` | 첨부 합계가 메일 한 통 한도를 넘습니다. | 파일을 줄이거나 나눠 보냅니다. |
| `attachment_daily_limit` | 에이전트의 하루 올리기 한도(24시간 100개 또는 200 MB)에 닿았습니다. | 나중에 다시 올립니다. |

모든 오류 코드는 [첨부 API](/api/attachments#errors)에 있습니다.

:::note
첨부가 있어도 메일은 같은 발신 정책을 지납니다. 받는 사람이 막히면 첨부와 상관없이 나가지 않고, 승인이 필요한 메일은 사람이 승인할 때 첨부까지 함께 나갑니다.
:::
