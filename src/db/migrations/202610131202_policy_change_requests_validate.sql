-- 202610131202_policy_change_requests_validate.sql
-- 202610131201 의 NOT VALID 제약을 검증한다(SHARE UPDATE EXCLUSIVE — 쓰기를 막지 않는다). 옛 행은 모두 통과한다: 알림 종류는 block | risk | signup | enroll.

SET LOCAL lock_timeout = '5s';

ALTER TABLE quarantine_notices VALIDATE CONSTRAINT quarantine_notices_kind_check;
