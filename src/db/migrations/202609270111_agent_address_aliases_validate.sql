-- 202609270111_agent_address_aliases_validate.sql
-- 메일 기본기 2차 A6 — 202609270110 이 `NOT VALID` 로 더한 `agent_addresses_primary_not_retired` 의 기존 행 검증.
--
-- `VALIDATE CONSTRAINT` 는 SHARE UPDATE EXCLUSIVE 만 잡는다 — 프로비저닝의 주소 INSERT·수신 라우팅의 읽기가 그대로 돈다. 기존 행은
-- `retired_at` 이 모두 NULL 이라 통과한다. 이 파일이 끝나야 `REQUIRED_GUARDS` 의 `convalidated` 검사가 초록이다.

SET LOCAL lock_timeout = '5s';

ALTER TABLE agent_addresses VALIDATE CONSTRAINT agent_addresses_primary_not_retired;
