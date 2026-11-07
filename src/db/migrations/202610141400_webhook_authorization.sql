-- 202610141400_webhook_authorization.sql
-- 웹훅 인증 헤더(선택, 진윤겸 2026-10-14 — "웹훅 등록할 때, optional로 Authorization token을 넣을 수 있도록"). 규칙·봉인은 `src/webhooks/authorization.ts`.
--
--   ① 표 `webhook_endpoint_authorizations` — 엔드포인트당 한 행. **평문이 없다**: `(key_kid, sealed, hint)` 뿐이다. `sealed` 는 웹훅 시크릿 마스터 키
--      묶음(api λ · 디스패처만 가진다)에서 파생한 키로 AES-256-GCM 봉인한 값이고, AAD 가 (에이전트, 엔드포인트 id, URL) 에 묶는다 — 행을 옮기거나 URL 을 바꾸면
--      열리지 않는다. `hint` 는 방식 + 끝 4글자(16자 이상일 때만)다. 지우기 = 세 칸을 NULL 로(`cleared_at`) — 행은 남는다(DELETE 0).
--   ② 정의자 함수 — 이 표 쓰기의 **유일한 경로**(앱·admin 롤은 표 INSERT·UPDATE 0). 그리고 등록의 id 받는 판 `register_webhook_endpoint(id, …)`
--      (보안 리뷰 L2 — 봉인 AAD 가 엔드포인트 id 를 담도록 앱이 id 를 먼저 만든다):
--        `set_webhook_endpoint_authorization(agent, endpoint, kid, sealed, hint, generation, via)` → set · not_found · not_allowed · stale
--          (`generation` 은 지금 세대 + 1 이어야 한다 — 재검증 L2).
--          **앱 롤(에이전트 API · MCP)은 등록과 같은 트랜잭션에서만** 적는다(엔드포인트의 `created_at = now()` · `created_via = 'api'` · 아직 행 없음) —
--          에이전트 토큰은 기존 엔드포인트의 인증 값을 바꾸지 못한다. admin 롤(콘솔)은 켜진 엔드포인트 어디에나(설정 · 교체).
--        `clear_webhook_endpoint_authorization(agent, endpoint, via)` → cleared · none · not_found. admin 롤만 EXECUTE.
--      경로(`via`)는 호출 롤과 맞아야 한다(`webhook_surface_matches_caller`, 202609301410).
--   ③ 가드 — 봉인 칸 셋은 함께 있거나 함께 없다(지운 행만 없다) · admin 롤 직접 쓰기 거부(`reject_admin_role_direct_write`) · DELETE·TRUNCATE 거부 ·
--      엔드포인트를 지우면(`disabled_at`) 봉인값도 지운다(`webhook_endpoints_clear_authorization_on_disable` — 다시 쓰이지 않을 자격을 남기지 않는다).
--   ④ 권한 — 앱 롤: 표 SELECT(디스패처가 봉인값을 읽는다 · 목록이 힌트를 읽는다) · set EXECUTE. admin 롤: 칸 SELECT(`endpoint_id`·`hint`·`set_at` —
--      **봉인값은 읽지 못한다**) · set · clear EXECUTE. 허용 목록은 `src/runtime/role-bootstrap.ts` `RESTRICTED_ROLE_GRANTS`, 가드는 `REQUIRED_GUARDS`.
--
-- 잠금: 새 표(빈 표 — 제약은 바로 VALID) · `webhook_endpoints` 에 트리거 하나(SHARE ROW EXCLUSIVE, 훑기 없음). 5초 안에 못 잡으면 실패하고 바뀌는 것 없음.
-- 배포 순서: **migrate → Compute**(런북 deploy §56 — 터널 `pnpm db:migrate` 뒤 `deploy-compute migrate=false`). 옛 코드는 새 표·함수를 모르고 그대로 돈다.
--   새 코드는 엔드포인트 목록·디스패처가 이 표를 읽으므로 **옛 스키마에서 돌지 않는다** — compute-first 금지. IAM 변경 없음(디스패처·api λ 는 이미 웹훅 키 묶음을 읽는다).

SET LOCAL lock_timeout = '5s';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'atmark_app') THEN
    RAISE EXCEPTION 'role atmark_app does not exist; provision the app role before running this migration' USING ERRCODE = '42704';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'atmark_admin') THEN
    RAISE EXCEPTION 'role atmark_admin does not exist; run bootstrap-roles before this migration' USING ERRCODE = '42704';
  END IF;
END;
$$;

-- ---------------------------------------------------------------------------
-- ① 표
-- ---------------------------------------------------------------------------

CREATE TABLE webhook_endpoint_authorizations (
  endpoint_id  uuid PRIMARY KEY REFERENCES webhook_endpoints (id) ON DELETE RESTRICT,
  key_kid      text CONSTRAINT webhook_endpoint_authorizations_kid_check CHECK (key_kid ~ '^[a-z0-9]{1,16}$'),
  -- "v1." + b64url(iv 12B = 16자) + "." + b64url(암호문 ‖ 태그 16B). 값 2048자 → 약 2752자(정규식 반복 상한이 255라 길이는 따로 본다).
  sealed       text CONSTRAINT webhook_endpoint_authorizations_sealed_check
                 CHECK (sealed ~ '^v1\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]+$' AND length(sealed) BETWEEN 42 AND 3020),
  hint         text CONSTRAINT webhook_endpoint_authorizations_hint_check CHECK (length(hint) BETWEEN 1 AND 40 AND hint !~ '[[:cntrl:]]'),
  -- 마지막으로 바꾼 표면(api = 등록 때 · console = 콘솔 설정·교체·지우기).
  set_via      text NOT NULL CONSTRAINT webhook_endpoint_authorizations_via_check CHECK (set_via IN ('api', 'console')),
  set_at       timestamptz NOT NULL DEFAULT now(),
  cleared_at   timestamptz,
  -- 세대(재검증 L2) — 설정 · 지우기마다 1씩 오른다(가드 트리거가 내려가지 못하게 · 봉인이 바뀌면 반드시 오르게 한다). 봉인 AAD 에 든다 — 같은
  --   엔드포인트에 옛 봉인값을 다시 넣거나 지운 값을 되살려도 열리지 않는다.
  generation   integer NOT NULL CONSTRAINT webhook_endpoint_authorizations_generation_check CHECK (generation >= 1),
  CONSTRAINT webhook_endpoint_authorizations_shape CHECK (
    (key_kid IS NULL) = (sealed IS NULL)
    AND (sealed IS NULL) = (hint IS NULL)
    AND (sealed IS NULL) = (cleared_at IS NOT NULL)
  )
);

COMMENT ON TABLE webhook_endpoint_authorizations IS
  '웹훅 인증 헤더(선택) — 봉인값(AES-256-GCM, 웹훅 키 묶음 파생 키 · AAD = 에이전트 + 엔드포인트 id + URL)과 힌트만. 평문 없음. 쓰기는 정의자 함수 둘뿐. 지우기 = NULL(행 유지).';
COMMENT ON COLUMN webhook_endpoint_authorizations.hint IS
  '목록에 보이는 힌트 — 방식 + 끝 4글자(자격 16자 이상일 때만). 예: Bearer …wxyz.';

-- 왜(재검증 L2): 세대가 내려가거나, 봉인을 바꾸면서 세대를 그대로 두면 옛 봉인값(그 세대로 열리는)을 다시 넣을 수 있다. 소유자 롤도 막는다.
--   행은 지울 수 없으므로(아래) 지우고 다시 넣어 세대를 1로 되돌리는 길도 없다.
CREATE FUNCTION webhook_endpoint_authorizations_generation_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF NEW.generation < OLD.generation THEN
    RAISE EXCEPTION 'webhook authorization generation cannot go down (% -> %)', OLD.generation, NEW.generation USING ERRCODE = '23514';
  END IF;
  IF (NEW.sealed, NEW.key_kid) IS DISTINCT FROM (OLD.sealed, OLD.key_kid) AND NEW.generation <= OLD.generation THEN
    RAISE EXCEPTION 'webhook authorization changed without a new generation' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER webhook_endpoint_authorizations_generation_guard
  BEFORE UPDATE ON webhook_endpoint_authorizations
  FOR EACH ROW EXECUTE FUNCTION webhook_endpoint_authorizations_generation_guard();

CREATE TRIGGER webhook_endpoint_authorizations_no_delete
  BEFORE DELETE ON webhook_endpoint_authorizations
  FOR EACH ROW EXECUTE FUNCTION reject_row_delete();

CREATE TRIGGER webhook_endpoint_authorizations_no_truncate
  AFTER TRUNCATE ON webhook_endpoint_authorizations
  FOR EACH STATEMENT EXECUTE FUNCTION reject_truncate();

-- 보안 M2(202609301410)와 같은 심층 방어 — admin 롤의 직접 쓰기는 GRANT 가 실수로 생겨도 여기서 죽는다(정의자 함수 안은 소유자라 지난다).
CREATE TRIGGER webhook_endpoint_authorizations_admin_write_guard
  BEFORE INSERT OR UPDATE ON webhook_endpoint_authorizations
  FOR EACH ROW EXECUTE FUNCTION reject_admin_role_direct_write();

-- ---------------------------------------------------------------------------
-- ② 정의자 함수
-- ---------------------------------------------------------------------------

-- 등록의 id 받는 판(보안 리뷰 L2) — 앱이 INSERT **전에** id 를 만들어 봉인 AAD 에 넣는다(봉인값을 다른 · 다시 만든 엔드포인트로 옮기면 열리지 않게).
--   규칙은 옛 판과 같다(경로 = 호출 롤). id 가 이미 있으면 PK 위반(23505) — 남의 행을 고를 수 없다. 옛 판은 배포 동안 옛 코드가 쓰므로 남긴다.
CREATE FUNCTION register_webhook_endpoint(p_id uuid, p_agent_id text, p_url text, p_kid text, p_event_types webhook_event_type[], p_via text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  created uuid;
BEGIN
  IF NOT public.webhook_surface_matches_caller(p_via) THEN
    RAISE EXCEPTION 'webhook surface % does not match the calling role', p_via USING ERRCODE = '42501';
  END IF;
  IF p_id IS NULL THEN
    RAISE EXCEPTION 'endpoint id is required' USING ERRCODE = '22004';
  END IF;
  INSERT INTO public.webhook_endpoints (id, agent_id, url, secret_kid, event_types, created_via)
  VALUES (p_id, p_agent_id::bpchar, p_url, p_kid, p_event_types, p_via)
  RETURNING id INTO created;
  RETURN created;
END;
$$;

COMMENT ON FUNCTION register_webhook_endpoint(uuid, text, text, text, webhook_event_type[], text) IS
  '웹훅 엔드포인트 등록(앱이 만든 id) — 인증 헤더 봉인의 AAD 에 id 를 넣기 위해서다(202610141400). 규칙은 id 없는 판과 같다.';
REVOKE ALL ON FUNCTION register_webhook_endpoint(uuid, text, text, text, webhook_event_type[], text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION register_webhook_endpoint(uuid, text, text, text, webhook_event_type[], text) TO atmark_app, atmark_admin;

CREATE FUNCTION set_webhook_endpoint_authorization(
  p_agent_id text, p_endpoint_id uuid, p_kid text, p_sealed text, p_hint text, p_generation integer, p_via text
) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  target public.webhook_endpoints%ROWTYPE;
  current_generation integer;
BEGIN
  IF NOT public.webhook_surface_matches_caller(p_via) THEN
    RAISE EXCEPTION 'webhook surface % does not match the calling role', p_via USING ERRCODE = '42501';
  END IF;
  SELECT * INTO target FROM public.webhook_endpoints e
   WHERE e.id = p_endpoint_id AND e.agent_id = p_agent_id::bpchar AND e.disabled_at IS NULL
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN 'not_found';
  END IF;
  -- 에이전트 API(앱 롤)는 **등록과 같은 트랜잭션**에서 처음 한 번만 — 기존 엔드포인트의 인증 값을 토큰이 바꾸지 못한다.
  IF session_user = 'atmark_app' AND (
       target.created_via <> 'api'
       OR target.created_at <> now()
       OR EXISTS (SELECT 1 FROM public.webhook_endpoint_authorizations a WHERE a.endpoint_id = p_endpoint_id)
     ) THEN
    RETURN 'not_allowed';
  END IF;
  -- 세대(재검증 L2) — 봉인은 **지금 세대 + 1**(행이 없으면 1)로 해 와야 한다. 엔드포인트 행 잠금(위 FOR UPDATE) 아래라 동시 설정 둘 중 하나만 맞는다.
  SELECT a.generation INTO current_generation FROM public.webhook_endpoint_authorizations a WHERE a.endpoint_id = p_endpoint_id;
  IF p_generation IS DISTINCT FROM COALESCE(current_generation, 0) + 1 THEN
    RETURN 'stale';
  END IF;
  INSERT INTO public.webhook_endpoint_authorizations (endpoint_id, key_kid, sealed, hint, set_via, set_at, cleared_at, generation)
  VALUES (p_endpoint_id, p_kid, p_sealed, p_hint, p_via, now(), NULL, p_generation)
  ON CONFLICT (endpoint_id) DO UPDATE
     SET key_kid = EXCLUDED.key_kid, sealed = EXCLUDED.sealed, hint = EXCLUDED.hint,
         set_via = EXCLUDED.set_via, set_at = EXCLUDED.set_at, cleared_at = NULL, generation = EXCLUDED.generation;
  RETURN 'set';
END;
$$;

CREATE FUNCTION clear_webhook_endpoint_authorization(p_agent_id text, p_endpoint_id uuid, p_via text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  changed integer;
BEGIN
  IF NOT public.webhook_surface_matches_caller(p_via) THEN
    RAISE EXCEPTION 'webhook surface % does not match the calling role', p_via USING ERRCODE = '42501';
  END IF;
  PERFORM 1 FROM public.webhook_endpoints e
   WHERE e.id = p_endpoint_id AND e.agent_id = p_agent_id::bpchar AND e.disabled_at IS NULL
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN 'not_found';
  END IF;
  UPDATE public.webhook_endpoint_authorizations a
     SET key_kid = NULL, sealed = NULL, hint = NULL, set_via = p_via, set_at = now(), cleared_at = now(), generation = a.generation + 1
   WHERE a.endpoint_id = p_endpoint_id AND a.sealed IS NOT NULL;
  GET DIAGNOSTICS changed = ROW_COUNT;
  RETURN CASE WHEN changed = 0 THEN 'none' ELSE 'cleared' END;
END;
$$;

COMMENT ON FUNCTION set_webhook_endpoint_authorization(text, uuid, text, text, text, integer, text) IS
  '웹훅 인증 헤더 봉인값 적기 — (에이전트, 엔드포인트) 짝이 맞는 켜진 행만. 앱 롤은 등록과 같은 트랜잭션에서 처음 한 번만(not_allowed). 인가는 라우트.';
COMMENT ON FUNCTION clear_webhook_endpoint_authorization(text, uuid, text) IS
  '웹훅 인증 헤더 지우기(봉인 칸 셋을 NULL 로) — 켜진 행만. 콘솔(admin 롤)만 EXECUTE.';

REVOKE ALL ON FUNCTION set_webhook_endpoint_authorization(text, uuid, text, text, text, integer, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION clear_webhook_endpoint_authorization(text, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION set_webhook_endpoint_authorization(text, uuid, text, text, text, integer, text) TO atmark_app, atmark_admin;
GRANT EXECUTE ON FUNCTION clear_webhook_endpoint_authorization(text, uuid, text) TO atmark_admin;

-- ---------------------------------------------------------------------------
-- ③ 엔드포인트를 지우면 봉인값도 지운다
-- ---------------------------------------------------------------------------

-- 지운 엔드포인트는 다시 켜지지 않는다(쓰기 1회 트리거) — 그 자격 증명은 다시 쓰이지 않으므로 남기지 않는다. `disabled_at` 은 정의자 함수
--   `disable_webhook_endpoint`(소유자)만 쓰므로 이 트리거도 소유자로 돈다.
CREATE FUNCTION webhook_endpoints_clear_authorization_on_disable() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF OLD.disabled_at IS NULL AND NEW.disabled_at IS NOT NULL THEN
    UPDATE public.webhook_endpoint_authorizations a
       SET key_kid = NULL, sealed = NULL, hint = NULL, cleared_at = now(), generation = a.generation + 1
     WHERE a.endpoint_id = NEW.id AND a.sealed IS NOT NULL;
  END IF;
  RETURN NULL;
END;
$$;

CREATE TRIGGER webhook_endpoints_clear_authorization_on_disable
  AFTER UPDATE OF disabled_at ON webhook_endpoints
  FOR EACH ROW EXECUTE FUNCTION webhook_endpoints_clear_authorization_on_disable();

-- ---------------------------------------------------------------------------
-- ④ 권한
-- ---------------------------------------------------------------------------

GRANT SELECT ON webhook_endpoint_authorizations TO atmark_app;
GRANT SELECT (endpoint_id, hint, set_at) ON webhook_endpoint_authorizations TO atmark_admin;
