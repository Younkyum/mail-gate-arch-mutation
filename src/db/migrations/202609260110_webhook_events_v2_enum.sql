-- 202609260110_webhook_events_v2_enum.sql
-- 메일 기본기 1차 A4 — 웹훅 이벤트 세 종 `message.delivered` · `message.bounced` · `message.complained`
-- (`.omc/plans/mail-basics.md` §4 A4 · §5, `src/webhooks/events.ts` `WEBHOOK_EVENT_TYPES`).
--
-- 원천은 SES 이벤트다 — ses-events 소비자가 `ses_events` 기록과 같은 트랜잭션의 savepoint 안에서 outbox 에 적는다
-- (`db/repositories/ses-event-store.ts`). **엔드포인트별 opt-in** 이라 `event_types` 에 적은 엔드포인트만 받는다(202609260115).
-- 격리 이벤트는 없다(D9 b).
--
-- **파일을 나눈 이유:** 러너는 파일 하나 = 트랜잭션 하나이고, `ADD VALUE` 로 넣은 값은 같은 트랜잭션에서 쓸 수 없다. 이 값들을 쓰는
-- 구독 칸·CHECK 는 다음 파일(202609260115)이다. 열거형 값 추가는 되돌릴 수 없다(append-only) — `IF NOT EXISTS` 라 재실행해도 같다.

SET LOCAL lock_timeout = '5s';

ALTER TYPE webhook_event_type ADD VALUE IF NOT EXISTS 'message.delivered';
ALTER TYPE webhook_event_type ADD VALUE IF NOT EXISTS 'message.bounced';
ALTER TYPE webhook_event_type ADD VALUE IF NOT EXISTS 'message.complained';
