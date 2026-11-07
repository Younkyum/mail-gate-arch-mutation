-- 202610041003_injection_signals_review_validate.sql
-- 202610041002 가 `NOT VALID` 로 더한 제약 다섯의 기존 행 검증(SHARE UPDATE EXCLUSIVE — 쓰기를 막지 않는다). 옛 행은 기본값이거나 더 좁은 옛 규칙을
-- 지났으므로 통과한다. 실패하면 이 트랜잭션만 되돌아가고 제약은 NOT VALID 로 남는다(새 행·UPDATE 에는 선다).

SET LOCAL lock_timeout = '5s';

ALTER TABLE scheduled_sends VALIDATE CONSTRAINT scheduled_sends_risk_dlp_check;
ALTER TABLE agent_exposures VALIDATE CONSTRAINT agent_exposures_sender_check;
ALTER TABLE inbound_fingerprints VALIDATE CONSTRAINT inbound_fingerprints_sender_check;
ALTER TABLE agent_exposures VALIDATE CONSTRAINT agent_exposures_reply_to_check;
ALTER TABLE agent_exposures VALIDATE CONSTRAINT agent_exposures_surface_check;
