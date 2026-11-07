-- 202610021100_agent_primary_changes.sql
-- 대표 주소 **포인터 모델**(ADR-0014 2026-10 개정 — 진윤겸 결정 2 · 계획 `custom-domains-stage2-4.md` "대표 주소 설계").
--
-- `agent_addresses.is_primary` 는 @atmark.ai **앵커**로 뜻을 고정한다(단계 0 가드 그대로 — P0A06 · 대표 폐기 금지 · 식별 칸 불변 · `retire_on_loss`).
-- "대표 주소" = 이 표의 **마지막 선택**이고, 읽을 때 `atmark_agent_primary_address(agent)` 가 판정한다:
--   · 선택이 없거나 마지막 선택이 앵커 → 앵커.
--   · 마지막 선택이 살아 있는 주소이고 (atmark.ai 이거나 같은 조직의 그 도메인이 verified · suspended) → 그 주소.
--   · 그 밖(마지막 선택이 고객 도메인 주소인데 폐기됐다 · 도메인을 잃었다) → **NULL**(에이전트는 "주소 없음" — 자동으로 앵커로 옮기지 않는다).
--   마지막 선택이 고객 도메인 주소면 앵커는 **잠든다**(보이지 않고 받지 않고 보내지 않는다 — 정책 소스 `usable` · 수신 조회가 같은 술어를 쓴다).
--
--   ① `agent_primary_changes` — append-only(UPDATE · DELETE · TRUNCATE 거부). 색인 (agent_id, created_at DESC, id DESC) — 마지막 선택 조회.
--   ② `agent_primary_changes_guard`(BEFORE INSERT, 정의자 **아님** — current_user 가 INSERT 한 롤이어야 원인 판정이 된다):
--        · 원인 `owner` 는 누구나(admin = 콘솔·조직 API) · `provision` · `operator` 는 소유자 롤만(프로비저닝 정의자 함수 · 운영자 CLI) — 아니면 42501.
--        · **잠금 순서: 조직(`agent_addresses_org:` — 발급·폐기와 같은 키) → 도메인 행(FOR NO KEY UPDATE) → 대상 주소 행(FOR SHARE).** 발급의
--          "조직 → 주소 잠금 → 도메인 행" 과 달리 도메인 행이 주소보다 먼저다 — 대상은 **이미 활성인** 주소라서, 소유권 상실 전이(도메인 행 →
--          `retire_on_loss` → 주소 행)와 같은 순서여야 교착이 없다(발급은 아직 없는 주소라 그 전이와 만나지 않는다).
--        · 대상 = 이 에이전트의 앵커(언제나) 또는 **같은 조직이 verified 로 가진 고객 도메인의 활성 별칭**. atmark.ai 별칭 · 폐기된 주소 ·
--          남의 주소 → P0A08. 고객 도메인이 verified 가 아니면 P0A05(주소 가드와 같은 코드).
--        · 운영자 예약 앵커(support@ 등 — `atmark_operator_assignable_addresses()`)의 에이전트는 원인 `owner` 로 바꿀 수 없다(42501).
--        · 속도 상한(원인 `owner` 만): 에이전트 24시간 5 · 조직 24시간 50 → P0A09(→ 429). 조직 잠금 아래에서 세어 정확하다.
--        · `address` 는 트리거가 대상 행에서 적는다(호출자 값을 믿지 않는다) · `created_at` = clock_timestamp()(한 트랜잭션의 두 선택도 순서가 선다).
--   ③ `atmark_agent_primary_address(agent)` — 위 판정(INVOKER · STABLE). TS 거울 `effectivePrimaryOf`(`src/domains/contract.ts`) — 통합 테스트가 표로 대조.
--   ④ 여권 재서명 요청(ADR-0014 개정 — 여권 주소 = 유효 대표): ⓐ 선택 INSERT ⓑ 마지막 선택 주소의 폐기 ⓒ 그 도메인의 상태·정지 사유 변화 →
--      `passport_publish_requests` 에 `resign`(`system:primary_address`) — 게시된(published · suspended) 여권이 있을 때만, 이미 대기 중이면 그대로.
--
-- **운영 무변화.** 이 표에 행을 넣는 코드 경로는 M3b(연산 · 라우트)와 고객 도메인 대표 프로비저닝(202610021101)뿐이고 기능 허용 목록이 비어 있다.
-- 행이 0 이면 판정 함수는 언제나 앵커(= 지금의 대표 주소)를 돌려주고, ⓑ ⓒ 는 아무것도 하지 않는다.
-- 잠금: 새 표 · 함수 · 트리거(agent_addresses · custom_domains 에 SHARE ROW EXCLUSIVE 잠깐) · GRANT. 5초 안에 못 잡으면 실패한다.

SET LOCAL lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- ① 표
-- ---------------------------------------------------------------------------

CREATE TABLE agent_primary_changes (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id    char(32) NOT NULL REFERENCES agents (id) ON DELETE RESTRICT,
  address_id  uuid NOT NULL REFERENCES agent_addresses (id) ON DELETE RESTRICT,
  -- 그때의 주소(트리거가 대상 행에서 적는다 — 주소 행은 식별 칸이 불변이라 늘 같다). 투명성 잎 `identity.primary_set` 의 커밋 재료.
  address     text NOT NULL,
  cause       text NOT NULL CONSTRAINT agent_primary_changes_cause_check CHECK (cause IN ('provision', 'owner', 'operator')),
  created_at  timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX agent_primary_changes_agent_created_idx ON agent_primary_changes (agent_id, created_at DESC, id DESC);

COMMENT ON TABLE agent_primary_changes IS
  '대표 주소 선택(ADR-0014 2026-10 개정 — 포인터 모델). append-only. 유효 대표 = atmark_agent_primary_address(agent). 잎 identity.primary_set.';

CREATE TRIGGER agent_primary_changes_no_update BEFORE UPDATE ON agent_primary_changes
  FOR EACH ROW EXECUTE FUNCTION reject_row_update();
CREATE TRIGGER agent_primary_changes_no_delete BEFORE DELETE ON agent_primary_changes
  FOR EACH ROW EXECUTE FUNCTION reject_row_delete();
CREATE TRIGGER agent_primary_changes_no_truncate AFTER TRUNCATE ON agent_primary_changes
  FOR EACH STATEMENT EXECUTE FUNCTION reject_truncate();

-- ---------------------------------------------------------------------------
-- ② 가드
-- ---------------------------------------------------------------------------

CREATE FUNCTION agent_primary_changes_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE
  -- 소유자 롤(운영자 CLI · 정의자 함수)인가 — custom_domains_transition_guard 와 같은 판정.
  is_owner boolean := pg_has_role(current_user, (SELECT c.relowner FROM pg_catalog.pg_class c WHERE c.oid = TG_RELID), 'USAGE');
  org uuid;
  anchor_id uuid;
  anchor_address text;
  target_address text;
  target_domain text;
  target_primary boolean;
  target_retired timestamptz;
  domain_id uuid;
  recent integer;
BEGIN
  IF NEW.cause <> 'owner' AND NOT is_owner THEN
    RAISE EXCEPTION 'agent_primary_changes: 원인 %는 운영자·프로비저닝만 쓴다', NEW.cause USING ERRCODE = '42501';
  END IF;
  SELECT a.organization_id INTO org FROM public.agents a WHERE a.id = NEW.agent_id;
  IF org IS NULL THEN
    RETURN NEW; -- FK 가 거부한다.
  END IF;
  -- 잠금 ① 조직 — 발급·폐기·다른 선택과 줄을 선다(속도 상한을 정확히 센다).
  PERFORM pg_advisory_xact_lock(hashtextextended('agent_addresses_org:' || org::text, 0));

  SELECT x.id, x.address INTO anchor_id, anchor_address
    FROM public.agent_addresses x WHERE x.agent_id = NEW.agent_id AND x.is_primary AND x.retired_at IS NULL;
  IF anchor_id IS NULL THEN
    RAISE EXCEPTION 'agent_primary_changes: 앵커(대표 주소 행)가 없는 에이전트다' USING ERRCODE = '23514';
  END IF;
  IF NEW.cause = 'owner' AND anchor_address = ANY (public.atmark_operator_assignable_addresses()) THEN
    RAISE EXCEPTION 'agent_primary_changes: 운영자 예약 주소의 에이전트는 대표 주소를 바꾸지 않는다' USING ERRCODE = '42501';
  END IF;
  IF NEW.cause = 'provision' AND EXISTS (SELECT 1 FROM public.agent_primary_changes p WHERE p.agent_id = NEW.agent_id) THEN
    RAISE EXCEPTION 'agent_primary_changes: provision 선택은 에이전트의 첫 선택이다' USING ERRCODE = '23514';
  END IF;

  SELECT x.address, x.domain, x.is_primary, x.retired_at INTO target_address, target_domain, target_primary, target_retired
    FROM public.agent_addresses x WHERE x.id = NEW.address_id AND x.agent_id = NEW.agent_id;
  -- 남의 주소 · 없는 주소 · 폐기된 주소는 같은 코드(존재를 가리지 않는다 — 어차피 같은 에이전트 범위).
  IF target_address IS NULL OR target_retired IS NOT NULL THEN
    RAISE EXCEPTION 'agent_primary_changes: 이 에이전트의 활성 주소가 아니다' USING ERRCODE = 'P0A08';
  END IF;
  IF NOT target_primary THEN
    IF target_domain = 'atmark.ai' THEN
      RAISE EXCEPTION 'agent_primary_changes: @atmark.ai 별칭은 대표 주소가 될 수 없다(앵커만)' USING ERRCODE = 'P0A08';
    END IF;
    -- 잠금 ② 도메인 행 — 정지·대체·제거 전이와 줄을 선다(전이 쪽도 도메인 행 → 주소 행 순서).
    SELECT d.id INTO domain_id
      FROM public.custom_domains d
     WHERE d.organization_id = org AND d.domain = target_domain AND d.status = 'verified'
       FOR NO KEY UPDATE;
    IF domain_id IS NULL THEN
      RAISE EXCEPTION 'agent_primary_changes: 조직이 확인(verified)한 고객 도메인이 아니다' USING ERRCODE = 'P0A05';
    END IF;
    -- 잠금 ③ 대상 주소 행 — 도메인 행 아래에서 다시 본다(그 사이 폐기됐으면 거부).
    PERFORM 1 FROM public.agent_addresses x WHERE x.id = NEW.address_id AND x.retired_at IS NULL FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'agent_primary_changes: 이 에이전트의 활성 주소가 아니다' USING ERRCODE = 'P0A08';
    END IF;
  END IF;

  IF NEW.cause = 'owner' THEN
    SELECT count(*) INTO recent FROM public.agent_primary_changes p
     WHERE p.agent_id = NEW.agent_id AND p.cause = 'owner' AND p.created_at > pg_catalog.now() - interval '24 hours';
    IF recent >= 5 THEN
      RAISE EXCEPTION 'agent_primary_changes: 에이전트의 대표 주소 변경이 24시간 상한(5)에 닿았다' USING ERRCODE = 'P0A09';
    END IF;
    SELECT count(*) INTO recent FROM public.agent_primary_changes p JOIN public.agents a ON a.id = p.agent_id
     WHERE a.organization_id = org AND p.cause = 'owner' AND p.created_at > pg_catalog.now() - interval '24 hours';
    IF recent >= 50 THEN
      RAISE EXCEPTION 'agent_primary_changes: 조직의 대표 주소 변경이 24시간 상한(50)에 닿았다' USING ERRCODE = 'P0A09';
    END IF;
  END IF;

  NEW.address := target_address;
  NEW.created_at := clock_timestamp();
  RETURN NEW;
END;
$$;

CREATE TRIGGER agent_primary_changes_guard BEFORE INSERT ON agent_primary_changes
  FOR EACH ROW EXECUTE FUNCTION agent_primary_changes_guard();

-- ---------------------------------------------------------------------------
-- ③ 유효 대표 주소 판정(TS `effectivePrimaryOf`)
-- ---------------------------------------------------------------------------

CREATE FUNCTION atmark_agent_primary_address(p_agent_id char(32)) RETURNS text
LANGUAGE sql STABLE SET search_path = pg_catalog, public AS $$
  WITH anchor AS (
    SELECT x.id, x.address FROM public.agent_addresses x WHERE x.agent_id = p_agent_id AND x.is_primary AND x.retired_at IS NULL
  ), last AS (
    SELECT p.address_id FROM public.agent_primary_changes p WHERE p.agent_id = p_agent_id ORDER BY p.created_at DESC, p.id DESC LIMIT 1
  )
  SELECT CASE
           WHEN NOT EXISTS (SELECT 1 FROM last) OR (SELECT l.address_id FROM last l) = (SELECT n.id FROM anchor n) THEN (SELECT n.address FROM anchor n)
           ELSE (SELECT x.address
                   FROM public.agent_addresses x JOIN public.agents a ON a.id = x.agent_id
                  WHERE x.id = (SELECT l.address_id FROM last l) AND x.agent_id = p_agent_id AND x.retired_at IS NULL
                    AND (x.domain = 'atmark.ai'
                         OR EXISTS (SELECT 1 FROM public.custom_domains d
                                     WHERE d.organization_id = a.organization_id AND d.domain = x.domain
                                       AND d.status IN ('verified', 'suspended'))))
         END
$$;

COMMENT ON FUNCTION atmark_agent_primary_address(char) IS
  '유효 대표 주소(ADR-0014 2026-10 개정). 선택 없음·앵커 선택 → 앵커 · 살아 있는 선택(도메인 verified·suspended) → 그 주소 · 무효한 고객 선택 → NULL. TS effectivePrimaryOf 와 같다.';

-- ---------------------------------------------------------------------------
-- ④ 여권 재서명 요청 ⓐ ⓑ ⓒ
-- ---------------------------------------------------------------------------

CREATE FUNCTION atmark_request_primary_resign(p_agent_id char(32)) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  INSERT INTO public.passport_publish_requests (agent_id, kind, requested_by)
  SELECT p.agent_id, 'resign', 'system:primary_address'
    FROM public.passports p
   WHERE p.agent_id = p_agent_id AND p.superseded_at IS NULL AND p.status IN ('published', 'suspended')
   LIMIT 1
  ON CONFLICT (agent_id) WHERE status = 'pending' AND kind IN ('publish', 'resign') DO NOTHING
$$;

REVOKE ALL ON FUNCTION atmark_request_primary_resign(char) FROM PUBLIC;

-- ⓐ 선택 INSERT.
CREATE FUNCTION agent_primary_changes_resign_request() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  PERFORM public.atmark_request_primary_resign(NEW.agent_id);
  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION agent_primary_changes_resign_request() FROM PUBLIC;

CREATE TRIGGER agent_primary_changes_resign_request AFTER INSERT ON agent_primary_changes
  FOR EACH ROW EXECUTE FUNCTION agent_primary_changes_resign_request();

-- ⓑ 마지막 선택 주소의 폐기(자발적 폐기 · 소유권 상실 · D-H).
CREATE FUNCTION agent_addresses_primary_retired_resign() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF (SELECT p.address_id FROM public.agent_primary_changes p WHERE p.agent_id = NEW.agent_id
       ORDER BY p.created_at DESC, p.id DESC LIMIT 1) = NEW.id THEN
    PERFORM public.atmark_request_primary_resign(NEW.agent_id);
  END IF;
  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION agent_addresses_primary_retired_resign() FROM PUBLIC;

CREATE TRIGGER agent_addresses_primary_retired_resign AFTER UPDATE OF retired_at ON agent_addresses
  FOR EACH ROW WHEN (OLD.retired_at IS NULL AND NEW.retired_at IS NOT NULL)
  EXECUTE FUNCTION agent_addresses_primary_retired_resign();

-- ⓒ 도메인 상태·정지 사유 변화 — 그 조직에서 마지막 선택이 이 도메인의 주소인 에이전트.
CREATE FUNCTION custom_domains_primary_resign() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  agent char(32);
BEGIN
  FOR agent IN
    SELECT l.agent_id
      FROM (SELECT DISTINCT ON (p.agent_id) p.agent_id, p.address_id
              FROM public.agent_primary_changes p JOIN public.agents a ON a.id = p.agent_id AND a.organization_id = NEW.organization_id
             ORDER BY p.agent_id, p.created_at DESC, p.id DESC) AS l
      JOIN public.agent_addresses x ON x.id = l.address_id AND x.domain = NEW.domain
     ORDER BY l.agent_id
  LOOP
    PERFORM public.atmark_request_primary_resign(agent);
  END LOOP;
  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION custom_domains_primary_resign() FROM PUBLIC;

CREATE TRIGGER custom_domains_primary_resign AFTER UPDATE ON custom_domains
  FOR EACH ROW WHEN (OLD.status IS DISTINCT FROM NEW.status OR OLD.suspended_reason IS DISTINCT FROM NEW.suspended_reason)
  EXECUTE FUNCTION custom_domains_primary_resign();

-- ---------------------------------------------------------------------------
-- GRANT — `src/runtime/role-bootstrap.ts` `RESTRICTED_ROLE_GRANTS` 와 같다
-- ---------------------------------------------------------------------------

-- admin(콘솔·조직 API — M3b 의 `setAgentPrimary` · 증명 묶음 · 신원 블록): 읽기 · 원인 `owner` 선택(주소·시각은 트리거가 적는다).
GRANT SELECT ON agent_primary_changes TO atmark_admin;
GRANT INSERT (agent_id, address_id, cause) ON agent_primary_changes TO atmark_admin;
-- 앱 롤(정책 소스 `usable` · 수신 조회의 잠든 앵커 술어): 마지막 선택을 고르는 칸만.
GRANT SELECT (id, agent_id, address_id, created_at) ON agent_primary_changes TO atmark_app;
