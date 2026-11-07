-- 202609301201_agent_brand_reserved_local_parts_validate.sql
-- 202609301200 이 `NOT VALID` 로 다시 세운 `agent_addresses_not_reserved_local_part` 의 기존 행 검증. 202609290600 · 202609291121 과 같은 판정:
-- 위반 행이 없으면 VALIDATE, 있으면 NOT VALID 로 남기고 경고한다(새 행은 계속 검사된다 — "검증됨" 표시가 거짓이 되지 않게).
-- migrate `status` 의 `reservedLocalPartCheckValidated` 가 결과를 보고한다(사전 질의가 0 이면 true — docs/runbooks/deploy.md §27).
--
-- 잠금: SHARE UPDATE EXCLUSIVE(쓰기를 막지 않는다 — 표를 한 번 훑는다). 5초 안에 못 잡으면 실패한다.

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
    RAISE WARNING 'agent_addresses 에 예약 로컬파트 주소가 % 개 있다 — CHECK 는 NOT VALID 로 남는다(새 행은 검사된다). docs/runbooks/deploy.md §27 참고', offenders;
  END IF;
END
$$;
