-- 202610041005_injection_signals_subject_part_validate.sql
-- 202610041004 가 `NOT VALID` 로 바꾼 `agent_exposures_part_check` 의 기존 행 검증(SHARE UPDATE EXCLUSIVE — 쓰기를 막지 않는다). 옛 행은 더 좁은
-- 옛 규칙을 지났으므로 통과한다.

SET LOCAL lock_timeout = '5s';

ALTER TABLE agent_exposures VALIDATE CONSTRAINT agent_exposures_part_check;
