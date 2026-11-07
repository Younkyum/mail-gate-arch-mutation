-- 202609291004_agent_addresses_created_at_stamp.sql
-- 별칭 재발급 보안 재검토(2026-09-29) LOW-3 — `agent_addresses.created_at` 을 **DB 가 찍는다**.
--
-- 재발급 뒤 신뢰 근거의 컷오프(`src/db/repositories/hosted-evidence.ts`)와 조직 24시간 별칭 천장은 이 칸을 믿는다. `atmark_admin` 은 표 전체
-- INSERT 권한이 있어, INSERT 가 과거 시각을 넣으면 새 주인이 예전 근거를 물려받고 천장도 비껴간다. 앱 코드는 이 칸을 넣지 않지만(기본값
-- now()), `retired_at` 을 DB 가 찍는 것과 같은 규율로 INSERT 때 늘 now() 로 덮는다. 이름이 `agent_addresses_reissue_hold` 보다 앞이라
-- 먼저 돈다(순서는 결과에 상관없다 — 다른 트리거는 기존 행의 created_at 만 본다).
--
-- 잠금: 함수 하나 · 트리거 하나(짧은 SHARE ROW EXCLUSIVE). 5초 안에 못 잡으면 실패한다.

SET LOCAL lock_timeout = '5s';

CREATE OR REPLACE FUNCTION public.agent_addresses_created_at_stamp() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public
AS $$
BEGIN
  NEW.created_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS agent_addresses_created_at_stamp ON public.agent_addresses;
CREATE TRIGGER agent_addresses_created_at_stamp
  BEFORE INSERT ON public.agent_addresses
  FOR EACH ROW EXECUTE FUNCTION public.agent_addresses_created_at_stamp();
