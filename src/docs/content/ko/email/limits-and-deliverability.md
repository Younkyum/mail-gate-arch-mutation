---
title: 발송 한도 확인하기
nav_title: 발송 한도
description: 분당·시간당·하루 발송 한도, 메일당 수신자, 조직 하루 수신자, 수신 거부 목록. 모든 발신 모드에 똑같이 걸립니다.
group: email
order: 10
updated: 2026-09-27
related: [plans/plans-and-limits, email/sending, help/troubleshooting-sending]
---
한도는 모든 발신 모드에 공통입니다. "전체" 모드도 한도를 넘지 못합니다.

## 에이전트 한도 {#agent-limits}

**이메일 › 발신** 열 아래 **한도**에서 봅니다.

| 한도 | 누가 정하나 |
|---|---|
| 분당 | 소유자나 관리자가 **변경**으로 바꿉니다. 요금제 한도를 넘을 수는 없습니다. |
| 시간당 · 하루 | 운영자가 정합니다. |
| 메일당 수신자 | 요금제 한도 안에서 정해집니다. |

에이전트는 `get_my_policy`의 `limits`에서 같은 값을 봅니다.

## 조직 하루 수신자 {#org-daily}

조직 전체가 하루에 보낼 수 있는 수신자 수입니다. 조직 하루 수신자는 첫 발송 뒤 약 2주에 걸쳐 표의 값까지 오릅니다. 요금제별 값은 [요금제와 한도](/plans/plans-and-limits)에 있습니다.

## 한도에 닿으면

메일은 `denied`로 끝나고 사유 코드가 같이 옵니다. 예: `rate_limit_per_minute`, `rate_limit_per_hour`, `rate_limit_per_day`, `recipients_per_message`, `daily_send_limit`, `plan_daily_cap`. 시간이 지나면 풀리는 한도는 응답의 `retry_after_seconds`로 기다릴 시간을 알려 줍니다.

## 수신 거부 목록 {#suppression}

반송됐거나 스팸으로 신고한 주소에는 다시 보내지 않습니다. 이때 사유는 `suppression_list`입니다. 받는 사람의 주소가 맞는지 확인하세요.
