-- 202610021202_agent_primary_view.sql
-- **유효 대표 주소의 좁은 읽기**(ADR-0014 2026-10 개정 · M3b — 여권 F-7 · 운영자 콘솔). 판정 함수 `atmark_agent_primary_address`(202610021100)는
-- INVOKER 라 부르는 롤이 주소 · 선택 · 도메인 행의 칸을 읽어야 한다. 서명 롤(`atmark_passport_signer`)과 운영자 콘솔 롤(`atmark_ops`)은 그 칸이 없고,
-- 칸을 열면 다른 조직의 도메인 상태까지 읽는다. 그래서 **결과 두 칸만** 주는 정의자 함수 하나를 둔다:
--
--   `atmark_agent_primary_view(agent) → (address, domain_verified)`
--     · `address` = `atmark_agent_primary_address(agent)` — 무효한 고객 선택이면 NULL(에이전트는 "주소 없음"). 잠든 앵커는 여기 나오지 않는다.
--     · `domain_verified` = 그 주소의 도메인을 Atmark 가 지금 확인했는가 — `atmark.ai` 는 참(우리 identity), 고객 도메인은 **같은 조직의 행이 verified
--       이거나 suspended(plan_limit)** 일 때만 참(계약: plan_limit 정지는 여권 true 유지 · 소유 상실 · DKIM 실패 · 평판 · 운영자 정지는 거짓). 주소가
--       없으면 거짓.
--
-- 여권 서명 워커(`src/passport/publisher.ts`)와 운영자 콘솔 읽기(`src/ops/console/reads.ts`)가 부른다. 앱 롤(공개 조회)과 admin 롤(콘솔)은 판정
-- 함수를 직접 부른다(칸 권한이 이미 있다).
-- **운영 무변화.** 선택 행이 0 이면 결과는 지금의 대표 주소 · `atmark.ai` 참 그대로다.
-- 잠금: 함수 하나 · GRANT. 표 잠금 없음.

SET LOCAL lock_timeout = '5s';

CREATE FUNCTION atmark_agent_primary_view(p_agent_id char(32))
RETURNS TABLE (address text, domain_verified boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  WITH p AS (SELECT public.atmark_agent_primary_address(p_agent_id) AS address)
  SELECT p.address,
         CASE
           WHEN p.address IS NULL THEN false
           WHEN split_part(p.address, '@', 2) = 'atmark.ai' THEN true
           ELSE EXISTS (SELECT 1 FROM public.custom_domains d JOIN public.agents a ON a.organization_id = d.organization_id
                         WHERE a.id = p_agent_id AND d.domain = split_part(p.address, '@', 2)
                           AND (d.status = 'verified' OR (d.status = 'suspended' AND d.suspended_reason = 'plan_limit')))
         END
    FROM p
$$;

REVOKE ALL ON FUNCTION atmark_agent_primary_view(char) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION atmark_agent_primary_view(char) TO atmark_passport_signer;
GRANT EXECUTE ON FUNCTION atmark_agent_primary_view(char) TO atmark_ops;

COMMENT ON FUNCTION atmark_agent_primary_view(char) IS
  '유효 대표 주소 + domain_verified(ADR-0014 2026-10 개정 · 여권 F-7). 정의자 — 서명·운영자 콘솔 롤은 두 칸만 받는다.';
