-- 202610021205_agent_primary_anchor_restore.sql
-- **앵커로 되돌리기는 언제나**(계획 `custom-domains-stage2-4.md` "대표 주소 설계" · #15 보안 리뷰 L4). `agent_primary_changes_guard`(202610021100)의 속도
-- 상한(원인 `owner` — 에이전트 24시간 5 · 조직 50 → P0A09)이 앵커 복구까지 막았다: 상한을 다 쓴 뒤 고객 도메인을 잃으면 에이전트가 24시간 "주소 없음" 으로
-- 남는다. 대상이 앵커이고 지금 유효 대표가 NULL 일 때만 상한을 건너뛴다 — 그 밖(앵커 ⇄ 고객 별칭을 오가는 변경)은 그대로 센다. 나머지 판정 · 잠금 순서 ·
-- 원인별 롤 · P0A08 · P0A05 · 42501 은 한 글자도 바꾸지 않는다(함수 본문을 그대로 옮기고 그 조건 하나만 더했다). 트리거는 그대로 이 함수를 부른다.
--
-- **운영 무변화.** 선택 행이 0 이면(기능 허용 목록 비어 있음) 이 가드는 돌지 않는다.
-- 잠금: 함수 교체 하나(표 잠금 없음).

SET LOCAL lock_timeout = '5s';

CREATE OR REPLACE FUNCTION agent_primary_changes_guard() RETURNS trigger
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

  -- 속도 상한의 예외(202610021205 · #15 보안 리뷰 L4): 대상이 **앵커**이고 지금 유효 대표가 NULL(고객 도메인을 잃어 "주소 없음")이면 세지 않는다 —
  -- "앵커로 되돌리기는 언제나"(계획). 상한을 다 쓴 뒤 도메인을 잃은 에이전트가 24시간 주소 없이 남지 않게. 이 선택 행도 뒤의 상한 계산에는 센다.
  IF NEW.cause = 'owner' AND NOT (target_primary AND public.atmark_agent_primary_address(NEW.agent_id) IS NULL) THEN
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
