-- 202610041007_injection_secret_link_validate.sql
-- 202610041006 이 `NOT VALID` 로 바꾼 CHECK 둘의 기존 행 검증(SHARE UPDATE EXCLUSIVE — 쓰기를 막지 않는다). 옛 행은 더 좁은 옛 규칙을 지났다.

SET LOCAL lock_timeout = '5s';

ALTER TABLE messages VALIDATE CONSTRAINT messages_outbound_dlp_check;
ALTER TABLE scheduled_sends VALIDATE CONSTRAINT scheduled_sends_risk_dlp_check;
