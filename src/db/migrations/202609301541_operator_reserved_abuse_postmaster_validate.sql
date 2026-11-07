-- 202609301541_operator_reserved_abuse_postmaster_validate.sql
-- 202609301540 이 `NOT VALID` 로 더한 `agent_addresses_role_address_not_primary`(abuse@ · postmaster@ 는 대표 주소가 될 수 없다)의 기존 행 검증.
-- `VALIDATE CONSTRAINT` 는 SHARE UPDATE EXCLUSIVE 라 주소 발급 · 수신 조회(읽기·쓰기)를 막지 않는다. 1540 의 닫힌 채로 실패 검사가 두 주소를 쥔
-- 행이 0 임을 확인했으므로 통과한다. 실패하면 이 트랜잭션만 되돌아가고 제약은 NOT VALID 로 남는다(새 행·UPDATE 에는 여전히 선다 — migrate status 의
-- `unvalidatedGuards` 가 이름으로 알린다).

SET LOCAL lock_timeout = '5s';

ALTER TABLE agent_addresses VALIDATE CONSTRAINT agent_addresses_role_address_not_primary;
