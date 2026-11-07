-- 202609291002_agent_address_reissue.sql
-- 별칭 재발급(진윤겸 결정 2026-09-29, ADR-0013 2026-09-29 개정). 202609270110 은 폐기한 별칭을 전역 UNIQUE 로 **누구도** 다시 쓰지 못하게 했다.
-- 그러면 누구나 좋은 이름(`sales@` …)을 만들고 지워 영원히 태울 수 있다(선점 남용). 새 규칙:
--   - 폐기한 별칭은 **폐기한 조직**이 곧바로 다시 발급할 수 있다(그 조직의 어느 에이전트에게든).
--   - **다른 조직**은 `retired_at` 뒤 **30일**이 지나야 발급할 수 있다(예전 주인에게 가던 메일을 남이 곧바로 가로채지 못하게 — 탈취 방지).
--   - 보류 중에는 지금처럼 메일이 거부되고(모르는 수신자) 모든 조회에서 빠진다(읽기 SQL 의 `retired_at IS NULL`).
--   - 대표 주소는 이 흐름으로 폐기되지 않는다(`agent_addresses_primary_not_retired`) — 그대로다.
--   - 안전장치는 그대로: 에이전트당 활성 한도(요금제) · 에이전트당 누적 발급 20(폐기 포함 — 교체 남용 상한) · 조직 하루 20.
--
--   ① 옛 전역 UNIQUE `agent_addresses_address_key` 를 지운다. 대신 부분 UNIQUE `agent_addresses_active_address_key`(202609291000, 활성 행만)가
--      AC-1 을 지키고, 보통 색인 `agent_addresses_address_idx`(202609291001)가 폐기 행까지 주소로 찾는다. **지우기 전에 두 색인이 유효한지
--      확인한다** — 비트랜잭션 빌드가 INVALID 로 남았는데 이 파일이 돌면 활성 주소의 유일성이 한순간 비기 때문이다. 옛 색인은 지금까지 활성 유일성을
--      지켰고 새 부분 색인이 이미 서 있으므로, 지우는 순간에도 틈이 없다.
--   ② 보류 트리거 `agent_addresses_reissue_hold`(`BEFORE INSERT`, 대표·별칭 모두) — 주소 잠금(`agent_addresses_address:<주소>`) 아래에서
--      같은 주소의 행을 본다. **활성 행이 있거나**, **다른 조직의 행이 30일 안에 폐기됐으면** 거부한다(23505 — 앱은 `address_taken`, 에이전트
--      만들기는 409 `conflict`. 보류인지 사용 중인지 가르지 않는다). 대표 주소도 보는 이유: 새 에이전트의 대표 주소로 남의 막 지운 별칭을
--      가져가는 것도 같은 탈취다. 새 행은 **활성으로만** 태어난다(`retired_at` 을 채운 INSERT 는 23514 — admin 롤은 INSERT 칸 제한이 없어,
--      먼 미래의 `retired_at` 으로 주소를 영원히 보류시키는 길을 막는다).
--   ③ 폐기 가드 `agent_addresses_retire_guard` 재정의 — 202609270110 정의에 **주소 잠금 한 줄**만 더한다. 폐기와 다른 조직의 발급이 겹칠 때
--      (폐기 트랜잭션이 커밋 전) 발급 쪽이 "아직 활성" 을 보고 통과한 뒤 폐기 커밋과 함께 부분 UNIQUE 를 지나는 경합을 닫는다 — 둘이 같은 잠금을
--      잡으므로 발급 쪽은 폐기 커밋을 기다린 뒤 새 스냅샷(READ COMMITTED 의 문장별 스냅샷)으로 폐기 행을 보고 보류로 거부한다.
--
-- 잠금 순서: 별칭 추가 = 조직 잠금(앱 · `agent_addresses_alias_ceiling`) → 주소 잠금(앱 · ②). 폐기 = 행 잠금(FOR UPDATE) → 주소 잠금(③).
-- 대표 주소 INSERT = 주소 잠금만. 어느 경로도 주소 잠금 뒤에 조직 잠금·행 잠금을 잡지 않는다 — 교착이 없다.
--
-- 투명성: 재발급은 새 행이다(새 id) — 기존 `identity.address_assigned` 잎이 하나 더 생긴다. 잎·검증기는 원천 행 id 로 대조하고 주소 커밋은 잎마다
-- 솔트가 달라, "한 주소는 한 번만 연결된다" 는 가정이 없다(검증기 판 그대로).
--
-- 잠금: 옛 색인 DROP(짧은 ACCESS EXCLUSIVE) · 함수 둘 · 트리거 하나. 5초 안에 못 잡으면 실패한다.
-- 롤백 호환: 옛 코드는 재발급 규칙을 모른다 — 별칭 추가 전 "이미 있나" 를 폐기 행까지 보므로 **더 좁게** 막을 뿐이다(재발급을 409 로 거부).
-- 옛 코드가 DB 가 허용하지 않는 것을 하게 되는 길은 없다.

SET LOCAL lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- ① 옛 전역 UNIQUE → 부분 UNIQUE(활성 행) + 보통 색인. 두 새 색인이 유효할 때만.
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  active_ok boolean;
  lookup_ok boolean;
BEGIN
  SELECT i.indisvalid AND i.indisready AND i.indisunique AND i.indpred IS NOT NULL AND i.indrelid = 'agent_addresses'::regclass INTO active_ok
    FROM pg_index i WHERE i.indexrelid = to_regclass('agent_addresses_active_address_key');
  SELECT i.indisvalid AND i.indisready AND i.indrelid = 'agent_addresses'::regclass INTO lookup_ok
    FROM pg_index i WHERE i.indexrelid = to_regclass('agent_addresses_address_idx');
  IF active_ok IS NOT TRUE OR lookup_ok IS NOT TRUE THEN
    RAISE EXCEPTION 'agent_addresses: 새 주소 색인(agent_addresses_active_address_key · agent_addresses_address_idx)이 유효하지 않다 — 202609291000·1001 을 다시 돌려라'
      USING ERRCODE = '55000';
  END IF;
END;
$$;

DROP INDEX agent_addresses_address_key;

COMMENT ON INDEX agent_addresses_active_address_key IS
  'AC-1 — 한 주소의 활성 행(retired_at IS NULL)은 하나다. 폐기 행은 들지 않는다(재발급 규칙은 트리거 agent_addresses_reissue_hold, ADR-0013 2026-09-29 개정).';

COMMENT ON COLUMN agent_addresses.retired_at IS
  '별칭 폐기 시각(쓰기 1회, DB 가 적는다). 폐기 주소는 수신·발신·공개 조회에서 빠진다. 같은 조직은 곧바로, 다른 조직은 30일 뒤 다시 발급할 수 있다(ADR-0013 2026-09-29 개정).';

-- ---------------------------------------------------------------------------
-- ② 재발급 보류 — 활성 행이 있거나 다른 조직이 30일 안에 폐기했으면 거부
-- ---------------------------------------------------------------------------

CREATE FUNCTION agent_addresses_reissue_hold() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  org uuid;
BEGIN
  IF NEW.retired_at IS NOT NULL THEN
    RAISE EXCEPTION 'agent_addresses: 주소는 활성으로만 만든다 — retired_at 은 폐기 문장이 적는다' USING ERRCODE = '23514';
  END IF;
  SELECT a.organization_id INTO org FROM public.agents a WHERE a.id = NEW.agent_id;
  IF org IS NULL THEN
    RETURN NEW; -- FK 가 거부한다.
  END IF;
  -- 같은 주소를 발급·폐기하는 트랜잭션을 줄 세운다(③ 과 같은 키). 잠금을 얻은 뒤의 조회는 그 사이 커밋된 폐기·발급을 본다.
  PERFORM pg_advisory_xact_lock(hashtextextended('agent_addresses_address:' || NEW.address, 0));
  IF EXISTS (
    SELECT 1
      FROM public.agent_addresses d JOIN public.agents a ON a.id = d.agent_id
     WHERE d.address = NEW.address
       AND (d.retired_at IS NULL OR (a.organization_id <> org AND d.retired_at > now() - interval '30 days'))
  ) THEN
    -- 사용 중인지 보류 중인지 가르지 않는다(값도 싣지 않는다) — 다른 조직이 막 지운 주소인지 드러내지 않는다.
    RAISE EXCEPTION 'agent_addresses: address is not available' USING ERRCODE = '23505';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER agent_addresses_reissue_hold BEFORE INSERT ON agent_addresses
  FOR EACH ROW EXECUTE FUNCTION agent_addresses_reissue_hold();

-- ---------------------------------------------------------------------------
-- ③ 폐기 가드 — 202609270110 정의 그대로 + 주소 잠금(② 와 같은 키)
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION agent_addresses_retire_guard() RETURNS trigger
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
  PERFORM pg_advisory_xact_lock(hashtextextended('agent_addresses_address:' || OLD.address, 0));
  NEW.retired_at := now();
  RETURN NEW;
END;
$$;
