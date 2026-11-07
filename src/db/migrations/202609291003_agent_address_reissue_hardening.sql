-- 202609291003_agent_address_reissue_hardening.sql
-- 별칭 재발급 보안 리뷰(2026-09-29) L5 · L6 — 202609291002 는 로컬 DB 에 이미 적용돼 체크섬이 걸려 있어 고치지 않고 이 파일로 더한다.
--
--   L5 새 주소 색인 둘의 **정의 전체**를 대조한다. 1002 의 검사는 "유효 · UNIQUE · 부분" 까지만 봤다 — 같은 이름으로 다른 칼럼·다른 술어의
--      색인이 서 있어도 통과했다. 여기서는 `pg_get_indexdef` 가 정확히 `(address) WHERE (retired_at IS NULL)` 인 UNIQUE 와 `(address)` 보통
--      색인인지 본다. 다르면 실패한다(이 파일이 적용되지 않으면 migrate status 의 대기 파일로 남아 빨갛다). 운영 순서상 1002 가 옛 전역
--      UNIQUE 를 지운 **뒤**의 검사지만, 1000 은 이 저장소의 정확한 문장이고 이름 충돌은 러너의 "그 표의 유효한 색인인가" 확인이 막는다 —
--      이 대조는 사후 확인이다. 상시 확인은 migrate status 의 `index:` 가드(`REQUIRED_GUARDS`)가 한다.
--   L6 트리거 함수 둘(`agent_addresses_reissue_hold` · 1002 가 다시 정의한 `agent_addresses_retire_guard`)에 `search_path` 를 고정한다
--      (`pg_catalog, public`). 정의자 함수는 아니지만, 호출하는 롤의 검색 경로가 `now()`·`hashtextextended`·`pg_advisory_xact_lock` 을
--      가로채지 못하게 한다(표는 이미 `public.` 으로 적었다).
--
-- 잠금: 카탈로그 읽기 · ALTER FUNCTION 둘. 5초 안에 못 잡으면 실패한다.

SET LOCAL lock_timeout = '5s';

DO $$
DECLARE
  active_def text;
  lookup_def text;
  active_ok boolean;
  lookup_ok boolean;
BEGIN
  SELECT pg_get_indexdef(i.indexrelid), i.indisvalid AND i.indisready AND i.indisunique AND i.indrelid = 'public.agent_addresses'::regclass
    INTO active_def, active_ok
    FROM pg_index i WHERE i.indexrelid = to_regclass('public.agent_addresses_active_address_key');
  SELECT pg_get_indexdef(i.indexrelid), i.indisvalid AND i.indisready AND NOT i.indisunique AND i.indrelid = 'public.agent_addresses'::regclass
    INTO lookup_def, lookup_ok
    FROM pg_index i WHERE i.indexrelid = to_regclass('public.agent_addresses_address_idx');
  IF active_ok IS NOT TRUE
     OR active_def IS DISTINCT FROM 'CREATE UNIQUE INDEX agent_addresses_active_address_key ON public.agent_addresses USING btree (address) WHERE (retired_at IS NULL)' THEN
    RAISE EXCEPTION 'agent_addresses_active_address_key 의 정의가 다르다: %', coalesce(active_def, '(없음)') USING ERRCODE = '55000';
  END IF;
  IF lookup_ok IS NOT TRUE
     OR lookup_def IS DISTINCT FROM 'CREATE INDEX agent_addresses_address_idx ON public.agent_addresses USING btree (address)' THEN
    RAISE EXCEPTION 'agent_addresses_address_idx 의 정의가 다르다: %', coalesce(lookup_def, '(없음)') USING ERRCODE = '55000';
  END IF;
  IF to_regclass('public.agent_addresses_address_key') IS NOT NULL THEN
    RAISE EXCEPTION 'agent_addresses_address_key(옛 전역 UNIQUE)가 아직 있다 — 202609291002 가 적용되지 않았다' USING ERRCODE = '55000';
  END IF;
END;
$$;

ALTER FUNCTION agent_addresses_reissue_hold() SET search_path = pg_catalog, public;
ALTER FUNCTION agent_addresses_retire_guard() SET search_path = pg_catalog, public;
