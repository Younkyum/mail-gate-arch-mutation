-- 202609270110_agent_address_aliases.sql
-- 메일 기본기 2차 A6 — 에이전트 **별칭 주소**의 추가·폐기(`.omc/plans/mail-basics.md` §4 A6 · §5, 진윤겸 결정 D5 비공개 · D6 요금제별 · D7 추가+폐기).
--
-- 별칭 = `agent_addresses` 의 `is_primary = false` 행이다(표를 새로 만들지 않는다 — Stage 1·수신 라우팅·전역 UNIQUE 가 이미 이 표를 본다).
--
--   ① 칸 `retired_at` — 폐기 시각. **쓰기 1회**(NULL → 값, 되돌리기·고쳐 쓰기 없음). 값은 DB 가 적는다(`now()` — 꾸민 시각으로 잎 창 밖에
--      숨지 못한다). 폐기한 주소는 전역 UNIQUE 로 **다시 발급할 수 없다**(되살림 없음). 수신·Stage 1·발신 주소 목록·공개 조회에서 빠진다(앱).
--   ② CHECK `agent_addresses_primary_not_retired` — 대표 주소는 폐기할 수 없다(대표 변경은 범위 밖). `NOT VALID`, 검증은 202609270111.
--   ③ 가드 트리거 `agent_addresses_retire_guard`(`BEFORE UPDATE OF retired_at`) — `retired_at` 을 건드리는 문장은 그 칸만, 한 번만 바꾼다.
--      다른 칸을 바꾸는 소유자 롤의 문장(운영 복구·테스트 조작)은 이 트리거를 타지 않는다 — admin 롤은 `UPDATE (retired_at)` 칸 권한뿐이라
--      다른 칸을 바꿀 길이 없다.
--   ④ 천장 트리거 `agent_addresses_alias_ceiling`(`BEFORE INSERT`, 별칭만) — 요금제 한도(앱이 같은 잠금 아래에서 먼저 센다)가 빠져도 넘지 못하는
--      바닥: 에이전트당 **활성 별칭 20**(= `ENTITLEMENT_CEILINGS.aliasesPerAgentMax`) · 에이전트당 **누적 발급 20**(폐기 포함 — 폐기·재발급으로
--      주소를 무한히 태우지 못한다) · 조직당 **하루(24시간) 발급 20**. 잠금 키는 앱(`src/admin/ops/addresses.ts`)과 같다 — 조직 잠금 하나
--      (`agent_addresses_org:<조직>`)가 세 수를 모두 묶는다(같은 세션은 다시 잡아도 된다).
--   ⑤ 권한 — admin 롤에 `UPDATE (retired_at)`(콘솔 별칭 폐기). INSERT 는 이미 있다(202609230720). 앱 롤은 여전히 읽기만.
--      결제 운영자 롤(`pnpm admin:plan`)에 `SELECT (agent_id, is_primary, retired_at)` — 요금제 화면의 별칭 초과 수(주소 원문 없음).
--
-- 투명성: 추가는 기존 잎 `identity.address_assigned`(INSERT 트리거 그대로), 폐기는 새 잎 `identity.address_retired` — 그 outbox 트리거·잎 종류
-- CHECK 는 202609270115(tlog v4) 한 파일에 있다(이 파일은 투명성 표를 건드리지 않는다).
--
-- 잠금: `agent_addresses` 에 칸 추가(기본값 없음 — 재작성 없음) · CHECK NOT VALID(훑지 않음) · 트리거 둘. 5초 안에 못 잡으면 실패한다.
-- 롤백 호환: 옛 코드는 `retired_at` 을 읽지 않는다 — 폐기한 별칭이 옛 코드에서는 다시 받는 주소가 된다. 그래서 **폐기 ≥1 이후에는
-- forward-fix 만 한다**(계획 §6 · 런북 deploy §23).

SET LOCAL lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- ① 칸 · ② CHECK
-- ---------------------------------------------------------------------------

ALTER TABLE agent_addresses ADD COLUMN retired_at timestamptz;

ALTER TABLE agent_addresses
  ADD CONSTRAINT agent_addresses_primary_not_retired CHECK (NOT (is_primary AND retired_at IS NOT NULL)) NOT VALID;

COMMENT ON COLUMN agent_addresses.retired_at IS
  '별칭 폐기 시각(쓰기 1회, DB 가 적는다). 폐기 주소는 수신·발신·공개 조회에서 빠지고 전역 UNIQUE 로 재발급되지 않는다(ADR-0013 A6).';

-- ---------------------------------------------------------------------------
-- ③ 폐기 가드 — retired_at 은 NULL → now() 한 번, 그 문장은 다른 칸을 바꾸지 않는다
-- ---------------------------------------------------------------------------

CREATE FUNCTION agent_addresses_retire_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.retired_at IS NOT NULL THEN
    RAISE EXCEPTION 'agent_addresses: 이미 폐기한 주소다 — retired_at 은 한 번만 적는다(id=%)', OLD.id USING ERRCODE = '23514';
  END IF;
  IF NEW.retired_at IS NULL THEN
    RETURN NEW;
  END IF;
  IF OLD.is_primary OR NEW.is_primary THEN
    RAISE EXCEPTION 'agent_addresses: 대표 주소는 폐기할 수 없다(id=%)', OLD.id USING ERRCODE = '23514';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.agent_id IS DISTINCT FROM OLD.agent_id OR NEW.address IS DISTINCT FROM OLD.address
     OR NEW.domain IS DISTINCT FROM OLD.domain OR NEW.is_primary IS DISTINCT FROM OLD.is_primary OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'agent_addresses: 폐기 문장은 retired_at 만 바꾼다(id=%)', OLD.id USING ERRCODE = '23514';
  END IF;
  NEW.retired_at := now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER agent_addresses_retire_guard BEFORE UPDATE OF retired_at ON agent_addresses
  FOR EACH ROW EXECUTE FUNCTION agent_addresses_retire_guard();

-- ---------------------------------------------------------------------------
-- ④ 별칭 천장 — 활성 20 · 누적 20 / 에이전트 · 하루 20 / 조직 (별칭만, 대표 주소는 세지 않는다)
-- ---------------------------------------------------------------------------

CREATE FUNCTION agent_addresses_alias_ceiling() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  org uuid;
  active integer;
  issued integer;
  today integer;
BEGIN
  IF NEW.is_primary THEN
    RETURN NEW;
  END IF;
  SELECT a.organization_id INTO org FROM public.agents a WHERE a.id = NEW.agent_id;
  IF org IS NULL THEN
    RETURN NEW; -- FK 가 거부한다.
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('agent_addresses_org:' || org::text, 0));
  SELECT count(*) FILTER (WHERE d.retired_at IS NULL), count(*) INTO active, issued
    FROM public.agent_addresses d
   WHERE d.agent_id = NEW.agent_id AND NOT d.is_primary;
  IF active >= 20 THEN
    RAISE EXCEPTION 'agent_addresses: agent % already has % active aliases (max 20)', NEW.agent_id, active USING ERRCODE = '23514';
  END IF;
  IF issued >= 20 THEN
    RAISE EXCEPTION 'agent_addresses: agent % already issued % aliases (max 20, retired included)', NEW.agent_id, issued USING ERRCODE = '23514';
  END IF;
  SELECT count(*) INTO today
    FROM public.agent_addresses d JOIN public.agents a ON a.id = d.agent_id
   WHERE a.organization_id = org AND NOT d.is_primary AND d.created_at > now() - interval '24 hours';
  IF today >= 20 THEN
    RAISE EXCEPTION 'agent_addresses: organization % already issued % aliases in 24 hours (max 20)', org, today USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER agent_addresses_alias_ceiling BEFORE INSERT ON agent_addresses
  FOR EACH ROW EXECUTE FUNCTION agent_addresses_alias_ceiling();

-- ---------------------------------------------------------------------------
-- ⑤ 권한 — admin 롤: 별칭 폐기(칸 하나). 허용 목록 `RESTRICTED_ROLE_GRANTS`.
-- ---------------------------------------------------------------------------

GRANT UPDATE (retired_at) ON agent_addresses TO atmark_admin;
-- 결제 운영자 롤(`pnpm admin:plan` — `planUsageOp` 의 칸): 강등 뒤 별칭 초과 에이전트 수를 센다(에이전트 · 대표 여부 · 폐기 시각). 주소 원문은 0.
GRANT SELECT (agent_id, is_primary, retired_at) ON agent_addresses TO atmark_billing_operator;
