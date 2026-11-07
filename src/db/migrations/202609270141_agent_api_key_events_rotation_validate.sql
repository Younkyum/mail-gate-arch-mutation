-- 202609270141_agent_api_key_events_rotation_validate.sql
-- 토큰 한 개 교체 — 202609270140 이 `NOT VALID` 로 더한 FK·CHECK 의 기존 행 검증(SHARE UPDATE EXCLUSIVE — 쓰기를 막지 않는다).
-- 기존 행은 `new_key_id` 가 전부 NULL 이라 걸릴 행이 없다.

SET LOCAL lock_timeout = '5s';

ALTER TABLE agent_api_key_events VALIDATE CONSTRAINT agent_api_key_events_new_key_fkey;
ALTER TABLE agent_api_key_events VALIDATE CONSTRAINT agent_api_key_events_new_key_check;
