-- 202610021105_ses_events_bounce_type_validate.sql
-- 202610021104 의 `ses_events_bounce_type_shape` 검증 — 기존 행은 모두 NULL 이라 통과한다. VALIDATE 는 SHARE UPDATE EXCLUSIVE — 소비자의 INSERT 를
-- 막지 않는다.
--
-- 잠금: SHARE UPDATE EXCLUSIVE 하나. 5초 안에 못 잡으면 실패한다.

SET LOCAL lock_timeout = '5s';

ALTER TABLE ses_events VALIDATE CONSTRAINT ses_events_bounce_type_shape;
