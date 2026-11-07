-- 202610131613_ses_events_recipients_validate.sql
-- 202610131612 가 NOT VALID 로 더한 CHECK 셋을 검증한다(SHARE UPDATE EXCLUSIVE — SES 이벤트 소비자의 INSERT 를 막지 않는다). 기존 행은
-- recipient_count = 1 · 새 칸 NULL 이라 곧바로 통과한다.

SET LOCAL lock_timeout = '5s';

ALTER TABLE ses_events VALIDATE CONSTRAINT ses_events_recipient_count_range;
ALTER TABLE ses_events VALIDATE CONSTRAINT ses_events_bounce_subtype_shape;
ALTER TABLE ses_events VALIDATE CONSTRAINT ses_events_complaint_hashes_shape;
