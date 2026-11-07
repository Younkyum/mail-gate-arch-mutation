-- 202609291121_agent_address_domain_guards_validate.sql
-- 202609291120 이 `NOT VALID` 로 다시 세운 CHECK 둘의 기존 행 검증(ADR-0014). 트랜잭션 파일이지만 VALIDATE 는 SHARE UPDATE EXCLUSIVE 라 쓰기를
-- 막지 않는다.
--
--   · `agent_addresses_not_reserved_local_part` — 202609290600 과 같은 판정: 위반 행이 없으면 VALIDATE, 있으면 NOT VALID 로 남기고 경고(새 행은
--     계속 검사된다 — "검증됨" 표시가 거짓이 되지 않게). 기존 행은 전부 atmark.ai 라 판정은 0600 과 같다. migrate `status` 의
--     `reservedLocalPartCheckValidated` 가 결과를 보고한다.
--   · `inbound_rejections_reason_check` — 옛 목록의 상위 집합이라 기존 행은 모두 통과한다.
--
-- 잠금: SHARE UPDATE EXCLUSIVE 둘. 5초 안에 못 잡으면 실패한다.

SET LOCAL lock_timeout = '5s';

DO $$
DECLARE
  offenders integer;
BEGIN
  SELECT count(*) INTO offenders FROM agent_addresses
   WHERE split_part(address, '@', 1) = ANY (atmark_reserved_local_parts_for(split_part(address, '@', 2)));
  IF offenders = 0 THEN
    ALTER TABLE agent_addresses VALIDATE CONSTRAINT agent_addresses_not_reserved_local_part;
  ELSE
    RAISE WARNING 'agent_addresses 에 예약 로컬파트 주소가 % 개 있다 — CHECK 는 NOT VALID 로 남는다(새 행은 검사된다). docs/runbooks/deploy.md §12 참고', offenders;
  END IF;
END
$$;

ALTER TABLE inbound_rejections VALIDATE CONSTRAINT inbound_rejections_reason_check;
