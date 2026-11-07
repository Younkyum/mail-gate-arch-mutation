-- 202610081001_watch_levels_validate.sql
-- 202610081000 의 NOT VALID 제약을 검증한다(SHARE UPDATE EXCLUSIVE — 쓰기를 막지 않는다). 옛 행은 새 칸이 NULL/false 라 모두 통과한다:
-- watch_level NULL · trusted_bypass false · 풀린 칸 NULL · 알림 kind 기본 'block' · 알림 항목 사유는 옛 두 값.

SET LOCAL lock_timeout = '5s';

ALTER TABLE inbound_messages VALIDATE CONSTRAINT inbound_messages_quarantine_reason_check;
ALTER TABLE inbound_messages VALIDATE CONSTRAINT inbound_messages_high_is_quarantined;
ALTER TABLE inbound_messages VALIDATE CONSTRAINT inbound_messages_watch_level_check;
ALTER TABLE inbound_messages VALIDATE CONSTRAINT inbound_messages_released_from_check;
ALTER TABLE inbound_messages VALIDATE CONSTRAINT inbound_messages_release_shape;
ALTER TABLE inbound_messages VALIDATE CONSTRAINT inbound_messages_trusted_bypass_shape;
ALTER TABLE inbound_messages VALIDATE CONSTRAINT inbound_messages_watch_level_shape;
ALTER TABLE quarantine_notices VALIDATE CONSTRAINT quarantine_notices_kind_check;
ALTER TABLE quarantine_notice_items VALIDATE CONSTRAINT quarantine_notice_items_reason_check;
