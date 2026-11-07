-- 202609230500_inbound_rejection_unstorable.sql
-- P3 결함 수정(검증 V2) — 수신 소비자가 **DB 가 입력 때문에 거부한 메일**을 결말로 기록한다.
--
-- 왜: 소비자의 규율 ②는 "입력 때문에는 던지지 않는다" 다(`workers/inbound-consumer.ts` 머리말). 그런데 CHECK·
--   데이터 예외(길이 초과, JS `toLowerCase` 와 DB `lower()` 의 로캘 차이 — V2 의 U+038D)는 INSERT 를 던지게 했고,
--   그 예외는 `failed`(재전달)로 올라가 같은 결과를 반복하다 DLQ 로 사라졌다 — 인증 없이 누구나 일으키는
--   poison pill 이다. 이제 소비자는 SQLSTATE `22xxx`·`23514`·`23502` 를 입력 거부로 읽고 이 사유로 남긴다.
--   `detail` 에는 제약 이름과 SQLSTATE 만 들어간다(메일 내용 없음 — 기존 200자 CHECK 그대로).
--
-- 사유 목록을 넓히는 것만 한다. 기존 행의 의미는 바뀌지 않는다.
ALTER TABLE inbound_rejections DROP CONSTRAINT inbound_rejections_reason_check;
ALTER TABLE inbound_rejections ADD CONSTRAINT inbound_rejections_reason_check
  CHECK (reason IN ('unknown_recipient', 'virus', 'mime_rejected', 'raw_too_large', 'unstorable'));
