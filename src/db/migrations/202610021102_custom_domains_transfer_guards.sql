-- 202610021102_custom_domains_transfer_guards.sql
-- 고객 도메인 소유 변경의 DB 가드 둘(ADR-0014 D-H · 단계 4 · #12 보안 리뷰 — 양도 채택).
--
--   ① **D-H** `custom_domains_retire_foreign_on_verifying`(AFTER UPDATE, 정의자) — 행이 pending → verifying 으로 들어서는 순간, **다른 조직**이
--      그 도메인에 남겨 둔 활성 별칭을 같은 트랜잭션에서 폐기한다. 자발적 제거(`removal_requested_at`)는 주소를 남기므로, 이것이 없으면 새 주인이
--      그 로컬파트를 영영 받지 못한다(ADR-0014 :128). 폐기 시각부터 30일 보류(202609291002)는 그대로다 — 옛 상대가 주인이 바뀐 것을 알아차릴 시간.
--      양도 경로(옛 행 `superseded_by`)에서는 `retire_on_loss` 가 이미 폐기했으므로 남은 것이 없다(같은 문장이 0행). 교차 조직 점유 가드(P0A02)가
--      "다른 조직이 그 도메인을 지금 쥐고 있지 않다" 를 보장하므로 남은 별칭은 모두 제거된 행의 잔여물이다. 대표(앵커)는 atmark.ai 라 걸리지 않는다.
--      잠금 순서는 `retire_on_loss` 와 같다(도메인 행 → 폐기 가드의 주소 잠금).
--   ② **양도 채택 불변식** `custom_domains_supersede_guard`(BEFORE UPDATE) — domain-control 은 틱이 넘긴 `supersededRowId` 를 그대로 믿고 그 행의
--      identity 를 채택한다(태그를 바꾼다). 그래서 `superseded_by` 는 DB 가 지킨다:
--        · 쓰기 1회(이미 있으면 바꾸지 못한다).
--        · 옛 행은 `suspended(ownership_lost)` 에서 **removed 로 나가는 바로 그 UPDATE** 에서만 적힌다(양도 조건 — 계획 §3.3 ⑨).
--        · 가리키는 새 행은 **같은 도메인 · 다른 조직**이고 pending · verifying 이며 **TXT present 를 통과했다**(`txt_verified_at` NOT NULL —
--          틱은 양도 트랜잭션에서 새 행에 먼저 적고, 옛 행을 removed 로, 새 행을 verifying 으로).
--      틱(`src/domains/store.ts` `supersededRowFor`)은 같은 술어를 조회 한 번으로 다시 본 뒤에만 `supersededRowId` 를 보낸다.
--
-- **운영 무변화.** 고객 도메인 행이 0 이다(기능 허용 목록 비어 있음).
-- 잠금: custom_domains 에 트리거 둘(SHARE ROW EXCLUSIVE 잠깐) · 함수. 5초 안에 못 잡으면 실패한다.

SET LOCAL lock_timeout = '5s';

-- ① D-H
CREATE FUNCTION custom_domains_retire_foreign_aliases() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  UPDATE public.agent_addresses x
     SET retired_at = pg_catalog.now()
    FROM public.agents a
   WHERE a.id = x.agent_id
     AND a.organization_id <> NEW.organization_id
     AND x.domain = NEW.domain
     AND x.retired_at IS NULL
     AND NOT x.is_primary;
  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION custom_domains_retire_foreign_aliases() FROM PUBLIC;

CREATE TRIGGER custom_domains_retire_foreign_on_verifying AFTER UPDATE ON custom_domains
  FOR EACH ROW WHEN (OLD.status = 'pending' AND NEW.status = 'verifying')
  EXECUTE FUNCTION custom_domains_retire_foreign_aliases();

-- ② 양도 채택 불변식
CREATE FUNCTION custom_domains_supersede_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF NEW.superseded_by IS NOT DISTINCT FROM OLD.superseded_by THEN
    RETURN NEW;
  END IF;
  IF OLD.superseded_by IS NOT NULL THEN
    RAISE EXCEPTION 'custom_domains: superseded_by 는 한 번만 적는다(id=%)', OLD.id USING ERRCODE = '23514';
  END IF;
  IF NOT (OLD.status = 'suspended' AND OLD.suspended_reason = 'ownership_lost' AND NEW.status = 'removed') THEN
    RAISE EXCEPTION 'custom_domains: 양도는 ownership_lost 정지 행을 removed 로 바꾸는 UPDATE 에서만(id=%)', OLD.id USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.custom_domains s
     WHERE s.id = NEW.superseded_by
       AND s.domain = OLD.domain
       AND s.organization_id <> OLD.organization_id
       AND s.status IN ('pending', 'verifying')
       AND s.txt_verified_at IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'custom_domains: 대체 행은 같은 도메인 · 다른 조직 · TXT 를 통과한 pending/verifying 이어야 한다(id=%)', OLD.id USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER custom_domains_supersede_guard BEFORE UPDATE ON custom_domains
  FOR EACH ROW EXECUTE FUNCTION custom_domains_supersede_guard();
