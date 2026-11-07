-- 202609291120_agent_address_domain_guards.sql
-- 고객 도메인 주소의 DB 가드(ADR-0014 · 계획 §3.2 · 단계 0, 보안·critic 리뷰 반영판).
--
--   ① `agent_addresses_verified_domain_guard`(BEFORE INSERT) — 주소의 도메인(**`split_part(NEW.address, '@', 2)` 에서 뽑는다** — `domain` 칸을
--      믿지 않는다, 보안 L1 · 둘의 일치는 CHECK `agent_addresses_domain_matches_address` 가 한 번 더)이 `atmark.ai` 가 아니면:
--        · **별칭만**(진윤겸 2026-09-29 — v1 고객 도메인 주소는 대표 주소가 될 수 없다): `is_primary` 면 P0A06.
--        · **에이전트와 같은 조직**의 `custom_domains` 행이 `verified` 이고 도메인이 **정확히** 같아야 한다 — 아니면 P0A05. 그 행을
--          `FOR NO KEY UPDATE` 로 잡는다(보안 L7 · critic minor 1): 정지·대체·제거 전이(행 UPDATE)와 발급이 줄을 서고, 같은 조직·도메인의
--          동시 발급끼리도 줄을 서서 천장을 정확히 센다.
--        · 그 조직이 그 도메인에 가진 **살아 있는 주소** 수 < `atmark_custom_domain_address_ceiling(domain)` — 아니면 P0A04. 천장은 **도메인 길이의
--          함수**다(critic 4): 로컬파트 64자 · 발송 역할 ARN 128자라는 최악의 경우에도 identity policy 20개(각 4,000바이트)에 들어가는 수, 1,000 이하
--          (TS `customDomainAddressCeiling` 과 같은 식 — 통합 테스트가 길이 1~100 에서 대조).
--      **이름이 보류 트리거(`…_reissue_hold` — 주소 잠금) 뒤에 오도록 골랐다**: 앱의 발급 경로는 INSERT 전에 조직 잠금 → 주소 잠금을 잡으므로
--      트리거 안의 순서도 주소 잠금 → 도메인 행 잠금 → claim 잠금이어야 교착이 없다. 전이 쪽(도메인 행 → 폐기 가드의 주소 잠금)은 **활성**
--      주소만 폐기하는데, 발급 중인 주소는 아직 활성 행이 아니고 폐기된 주소를 다시 받는 발급은 도메인 행을 기다리는 쪽이다.
--   ② `agent_addresses_custom_domain_policy_sync`(AFTER INSERT · AFTER UPDATE OF retired_at, 고객 도메인만) — 그 조직의 **verified** 도메인 행에
--      I2+ 정책 동기화 요청을 적는다(이미 적혀 있으면 그대로). 정지·제거된 도메인은 정책이 이미 지워지므로 건드리지 않는다 — 그래서 소유권 상실
--      전이(202609291100 `custom_domains_retire_on_loss`)가 폐기하는 동안 같은 도메인 행을 다시 고치지 않는다.
--   ③ 주소 천장 함수 `atmark_custom_domain_address_ceiling(domain)`.
--   ④ 예약 로컬파트 CHECK 재작성(M3 · J11): `atmark_reserved_local_parts_for(domain)` — atmark.ai 는 기존 목록 전부(`atmark_reserved_local_parts()`
--      를 부른다), 고객 도메인은 전역 목록(TS `GLOBAL_RESERVED_LOCAL_PARTS`). 같은 이름으로 `NOT VALID` 로 다시 세우고 검증은 202609291121.
--   ⑤ 수신 거부 사유 CHECK(L3): 적용 시점의 현재 목록(202609241500) + `domain_not_active`. `NOT VALID` — 검증은 202609291121.
--   ⑥ `agent_addresses_identity_immutable`(BEFORE UPDATE) — 주소 · 도메인 · 대표 여부 · 에이전트 · 만든 시각은 바뀌지 않는다(`retired_at` 만,
--      재리뷰 L8). 지금 앱이 보내는 주소 UPDATE 는 폐기(`retired_at`) 하나뿐이다.
--   색인 둘(L7 · L10)은 비트랜잭션 파일 202609291122 · 1123.
--
-- **순서(재리뷰 M2b)**: 함수 → CHECK 교체 둘(ACCESS EXCLUSIVE — 가장 센 잠금을 먼저) → 트리거(SHARE ROW EXCLUSIVE). 센 잠금을 뒤에 잡으면 앞에서
-- 쥔 약한 잠금 위에서 쓰기가 줄을 서는 동안 업그레이드를 기다린다.
--
-- **운영 무변화(단계 0).** 모든 기존 주소는 atmark.ai 라 ① ② 는 돌지 않고, ④ 의 atmark.ai 분기는 예전 목록 그대로다.
-- 잠금: CHECK 둘 교체(NOT VALID — 짧은 ACCESS EXCLUSIVE, 표를 훑지 않는다) · 트리거 넷 · 함수. 5초 안에 못 잡으면 실패한다.

SET LOCAL lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- ③ 주소 천장 — 도메인 길이의 함수(TS `customDomainAddressCeiling` 과 같은 식)
-- ---------------------------------------------------------------------------

-- frame = 빈 정책 문서 258 + ARN 예산 128 + 계정 12 + 도메인 길이 · 주소 하나의 최악 = 64 + 1 + 도메인 길이 + 3(따옴표 둘 · 쉼표).
CREATE FUNCTION atmark_custom_domain_address_ceiling(p_domain text) RETURNS integer
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT greatest(0, least(1000, 20 * ((4000 - (258 + 128 + 12 + length(p_domain))) / (64 + 1 + length(p_domain) + 3))))
$$;

COMMENT ON FUNCTION atmark_custom_domain_address_ceiling(text) IS
  '고객 도메인의 살아 있는 발급 주소 천장(ADR-0014 · S1 — 정책 4,000바이트 × 20, 로컬파트 64 · ARN 128 최악). 18자 → 820 · 100자 → 400.';

-- ---------------------------------------------------------------------------
-- ④ 도메인별 예약 로컬파트
-- ---------------------------------------------------------------------------

CREATE FUNCTION atmark_reserved_local_parts_for(p_domain text) RETURNS text[]
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT CASE
           WHEN p_domain = 'atmark.ai' THEN atmark_reserved_local_parts()
           ELSE ARRAY[
             'postmaster', 'abuse', 'hostmaster', 'webmaster', 'noc', 'security',
             'admin', 'administrator', 'root', 'ssladmin', 'ssl-admin', 'sslwebmaster',
             'mailer-daemon'
           ]::text[]
         END
$$;

COMMENT ON FUNCTION atmark_reserved_local_parts_for(text) IS
  '도메인별 예약 로컬파트(ADR-0014 결정 8 · J11). atmark.ai = atmark_reserved_local_parts() 전부, 고객 도메인 = 전역 목록(TS GLOBAL_RESERVED_LOCAL_PARTS).';

ALTER TABLE agent_addresses DROP CONSTRAINT agent_addresses_not_reserved_local_part;
ALTER TABLE agent_addresses ADD CONSTRAINT agent_addresses_not_reserved_local_part
  CHECK (NOT (split_part(address, '@', 1) = ANY (atmark_reserved_local_parts_for(split_part(address, '@', 2))))) NOT VALID;


-- ---------------------------------------------------------------------------
-- ⑤ 수신 거부 사유 — 현재 목록(202609241500) + domain_not_active
-- ---------------------------------------------------------------------------

ALTER TABLE inbound_rejections DROP CONSTRAINT inbound_rejections_reason_check;
ALTER TABLE inbound_rejections ADD CONSTRAINT inbound_rejections_reason_check
  CHECK (reason IN ('unknown_recipient', 'virus', 'mime_rejected', 'raw_too_large', 'unstorable', 'org_not_active', 'contact_not_forwarded',
                    'domain_not_active')) NOT VALID;

-- ---------------------------------------------------------------------------
-- ① 고객 도메인 주소 = 별칭 · 같은 조직의 verified 도메인 · 천장
-- ---------------------------------------------------------------------------

CREATE FUNCTION agent_addresses_verified_domain_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  address_domain text := split_part(NEW.address, '@', 2);
  org uuid;
  domain_id uuid;
  live integer;
BEGIN
  IF address_domain = 'atmark.ai' THEN
    RETURN NEW;
  END IF;
  IF NEW.is_primary THEN
    RAISE EXCEPTION 'agent_addresses: 고객 도메인 주소는 별칭으로만 만든다(v1)' USING ERRCODE = 'P0A06';
  END IF;
  SELECT a.organization_id INTO org FROM public.agents a WHERE a.id = NEW.agent_id;
  IF org IS NULL THEN
    RETURN NEW; -- FK 가 거부한다.
  END IF;
  SELECT d.id INTO domain_id
    FROM public.custom_domains d
   WHERE d.organization_id = org AND d.domain = address_domain AND d.status = 'verified'
     FOR NO KEY UPDATE;
  IF domain_id IS NULL THEN
    RAISE EXCEPTION 'agent_addresses: 조직이 확인(verified)한 고객 도메인이 아니다' USING ERRCODE = 'P0A05';
  END IF;
  SELECT count(*) INTO live
    FROM public.agent_addresses x JOIN public.agents a ON a.id = x.agent_id
   WHERE x.domain = address_domain AND a.organization_id = org AND x.retired_at IS NULL;
  IF live >= public.atmark_custom_domain_address_ceiling(address_domain) THEN
    RAISE EXCEPTION 'agent_addresses: 고객 도메인의 주소가 천장(%)에 닿았다', public.atmark_custom_domain_address_ceiling(address_domain)
      USING ERRCODE = 'P0A04';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION agent_addresses_verified_domain_guard() FROM PUBLIC;

CREATE TRIGGER agent_addresses_verified_domain_guard BEFORE INSERT ON agent_addresses
  FOR EACH ROW EXECUTE FUNCTION agent_addresses_verified_domain_guard();

-- ---------------------------------------------------------------------------
-- ② 주소가 늘거나 줄면 정책 동기화 요청(verified 도메인만)
-- ---------------------------------------------------------------------------

CREATE FUNCTION agent_addresses_custom_domain_policy_sync() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  -- 도메인 행을 `FOR NO KEY UPDATE SKIP LOCKED` 로만 잡는다(재리뷰 L4). 기다리지 않는 이유 — 자발적 별칭 폐기(주소 잠금 → 이 트리거 → 도메인 행)와
  -- 소유권 상실 전이(도메인 행 → `custom_domains_retire_on_loss` → 폐기 가드의 주소 잠금)가 반대 순서로 잠가 교착한다. 행을 잡고 있는 쪽은
  -- ⓐ 전이(정지·제거 — 그 전이가 정책 동기화를 스스로 요청하거나 정책을 지운다) ⓑ 같은 도메인의 발급(그 발급이 이 표시를 적는다) ⓒ 동기화를
  -- 끝낸 틱(표시를 비우는 중)이다. ⓒ 에서 이번 변화가 빠지면 그 정책은 다음 재확인의 정책 감사(`audit_policy` — 기대 주소와 대조, drift 면 덮어쓰기)
  -- 가 바로잡고, 그 사이 폐기된 별칭은 관문(Stage 1 — 폐기 주소는 바인딩 주소가 아니다)이 이미 막는다.
  UPDATE public.custom_domains d
     SET policy_sync_requested_at = pg_catalog.now()
   WHERE d.id IN (SELECT c.id
                    FROM public.custom_domains c JOIN public.agents a ON a.organization_id = c.organization_id
                   WHERE a.id = NEW.agent_id
                     AND c.domain = split_part(NEW.address, '@', 2)
                     AND c.status = 'verified'
                     AND c.policy_sync_requested_at IS NULL
                     FOR NO KEY UPDATE OF c SKIP LOCKED);
  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION agent_addresses_custom_domain_policy_sync() FROM PUBLIC;

CREATE TRIGGER agent_addresses_custom_domain_policy_sync AFTER INSERT ON agent_addresses
  FOR EACH ROW WHEN (split_part(NEW.address, '@', 2) <> 'atmark.ai')
  EXECUTE FUNCTION agent_addresses_custom_domain_policy_sync();
CREATE TRIGGER agent_addresses_custom_domain_policy_sync_retire AFTER UPDATE OF retired_at ON agent_addresses
  FOR EACH ROW WHEN (split_part(NEW.address, '@', 2) <> 'atmark.ai' AND OLD.retired_at IS NULL AND NEW.retired_at IS NOT NULL)
  EXECUTE FUNCTION agent_addresses_custom_domain_policy_sync();

-- ---------------------------------------------------------------------------
-- ⑥ 주소 행의 식별 칸 불변(재리뷰 L8) — 바뀔 수 있는 칸은 `retired_at` 뿐이다(별칭 폐기 · 소유권 상실 폐기 모두 그 칸만 적는다)
-- ---------------------------------------------------------------------------

CREATE TRIGGER agent_addresses_identity_immutable BEFORE UPDATE ON agent_addresses
  FOR EACH ROW EXECUTE FUNCTION reject_column_update_except('retired_at');
