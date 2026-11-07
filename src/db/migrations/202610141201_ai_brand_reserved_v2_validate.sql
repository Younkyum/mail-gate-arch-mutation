-- 202610141201_ai_brand_reserved_v2_validate.sql
-- 202610141200 이 `NOT VALID` 로 다시 세운 `agent_addresses_not_reserved_local_part` 의 기존 행 검증. 202609301201 · 202609301501 과 같은 판정:
-- 위반 행이 없으면 VALIDATE, 있으면 NOT VALID 로 남기고 경고한다(새 행은 계속 검사된다 — "검증됨" 표시가 거짓이 되지 않게).
-- 새 이름 · 구분자 변형을 이미 쥔 행과 `claude@atmark.ai` 는 1200 ② 의 (id, 주소) 쌍으로 통과한다 — 남는 위반은 1200 이전부터 있던 목록 밖 예약 주소뿐이다.
-- 판정식은 1200 ⑤ 의 CHECK 와 같다. migrate `status` 의 `reservedLocalPartCheckValidated` 가 결과를 보고한다(docs/runbooks/deploy.md §55 — 운영에서는 true).
--
-- 잠금: SHARE UPDATE EXCLUSIVE(쓰기를 막지 않는다 — 표를 한 번 훑는다). 5초 안에 못 잡으면 실패한다.

SET LOCAL lock_timeout = '5s';

DO $$
DECLARE
  offenders integer;
BEGIN
  SELECT count(*) INTO offenders FROM agent_addresses
   WHERE NOT (address = ANY (atmark_operator_assignable_addresses()))
     AND NOT ((id::text || ' ' || address) = ANY (atmark_reserved_grandfathered_address_keys()))
     AND (split_part(address, '@', 1) = ANY (atmark_reserved_local_parts_for(split_part(address, '@', 2)))
          OR (split_part(address, '@', 2) = 'atmark.ai'
              AND regexp_replace(split_part(address, '@', 1), '[._-]', '', 'g') = ANY (atmark_brand_reserved_keys())));
  IF offenders = 0 THEN
    ALTER TABLE agent_addresses VALIDATE CONSTRAINT agent_addresses_not_reserved_local_part;
  ELSE
    RAISE WARNING 'agent_addresses 에 예약 로컬파트 주소가 % 개 있다(운영자 목록 · 예약 이전 행 밖) — CHECK 는 NOT VALID 로 남는다(새 행은 검사된다). docs/runbooks/deploy.md §55 참고', offenders;
  END IF;
END
$$;
