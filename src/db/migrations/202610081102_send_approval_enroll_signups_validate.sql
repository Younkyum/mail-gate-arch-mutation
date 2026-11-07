-- 202610081102_send_approval_enroll_signups_validate.sql
-- 202610081101 의 NOT VALID 제약을 검증한다(SHARE UPDATE EXCLUSIVE — 쓰기를 막지 않는다). 옛 행은 모두 통과한다: 조직 설정 하루 상한은 기본 5 ·
-- 알림 종류는 block | risk · 항목 사유는 옛 네 값.

SET LOCAL lock_timeout = '5s';

ALTER TABLE org_watch_settings VALIDATE CONSTRAINT org_watch_settings_enroll_daily_cap_check;
ALTER TABLE quarantine_notices VALIDATE CONSTRAINT quarantine_notices_kind_check;
ALTER TABLE quarantine_notice_items VALIDATE CONSTRAINT quarantine_notice_items_reason_check;
