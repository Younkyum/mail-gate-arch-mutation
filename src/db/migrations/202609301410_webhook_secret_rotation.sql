-- 202609301410_webhook_secret_rotation.sql
-- 웹훅 시크릿 회전 · 콘솔 웹훅 관리 · 권한 정리(진윤겸 2026-09-30 승인 — ADR-0013 2026-09-30 개정, `src/webhooks/management.ts`).
-- 보안 리뷰(2026-09-30, M1·M2·M3·L2)와 재검토 강화(L-1 콘솔 시크릿 발급 1회 · L-3 admin 의 전달 본문 읽기 0)를 반영했다 — 운영 전이라 이 파일을
-- 고쳐 썼다.
--
--   ① 토큰의 전환 경로 자격 — `agent_api_keys.webhooks_legacy_eligible`. **이 파일이 돌기 전에 있던 토큰만 true** 다: 칸을 기본값 true 로 더하면
--      기존 행은 표를 다시 쓰지 않고 true 로 읽히고(빠른 기본값), 곧바로 기본값을 false 로 바꿔 그 뒤 발급되는 토큰(콘솔 교체 포함)은 false 다.
--      불변 핵심 트리거(`agent_api_keys_immutable_core`)의 예외 목록 밖이라 누구도 바꿀 수 없다. 앱은 이 칸이 true 이고 `messages:send` 가 있을
--      때만(등록은 `messages:read` 도) `webhooks:manage` 없이 웹훅을 관리하게 한다 — 2027-01-01 까지, 회전은 전환 경로 없음(보안 M3).
--   ② 회전 칸 넷 — `webhook_endpoints.secret_rotated_at` · `previous_secret_kid` · `previous_secret_version` · `previous_secret_valid_until`.
--      시크릿은 여전히 **저장하지 않는다**(마스터 키에서 `(id, kid, version)` 으로 파생 — `src/webhooks/signing.ts`). 회전은 `secret_version` 을
--      하나 올리고(kid 는 그때의 활성 kid), 직전 `(kid, version)` 을 `previous_*` 에 옮겨 **24시간 유예**를 둔다. 유예 동안 디스패처는 새·옛
--      시크릿 **둘 다로** 서명한다(`webhook-signature: v1,<새> v1,<옛>`). 유예 안에 다시 회전하면 그 직전 버전만 남는다.
--      `created_via`(`api`·`console`) — 어느 표면이 등록했는가(콘솔 시크릿 발급 확인 ⑦ 의 입력). 모양 CHECK 둘은 `NOT VALID` — 검증은 202609301411.
--   ③ 회전 원장 `webhook_secret_rotations` — 회전 한 번 = 한 행(append-only). **엔드포인트당 24시간 10회** 상한의 분자 · 감사 기록 · 콘솔 시크릿
--      발급 확인(⑦)의 입력. 앱·admin 롤은 이 표 권한이 0 이다.
--   ④ 정의자 함수 넷 — 웹훅 쓰기의 **유일한 경로**(admin 롤은 두 표 INSERT·UPDATE 가 0 — 보안 M2):
--        `register_webhook_endpoint(agent, url, kid, event_types, via)` → 새 id. 상한은 앱이 같은 잠금 아래에서 먼저 본다(요금제 계산이 앱에 있다).
--        `rotate_webhook_endpoint_secret(agent, endpoint, kid, via)` → rotated · not_found · rate_limited.
--        `redeliver_webhook_delivery(agent, delivery, next_attempt_at)` → 재전송 규칙 전부(앱이 하던 것과 같다) + INSERT … SELECT(루트 복사).
--          admin 롤이 **임의의 본문**을 outbox 에 넣으면 디스패처가 그것에 서명해 보낸다 — 새 행은 루트에서만 복사된다.
--        `console_webhook_secret_ref(agent, endpoint)` → (kid, version) — 콘솔이 **방금**(60초 안) 등록·회전한 행에만, 그 버전당 **한 번만**
--          답한다(⑦ — 발급 원장 `webhook_console_secret_issues` 에 (엔드포인트, 버전)을 선점한다).
--      경로(`via`)는 호출 롤과 맞아야 한다: `atmark_admin` 은 console 만, `atmark_app` 은 api 만(원장·`created_via` 를 다른 표면 이름으로 꾸미지
--      못한다). 소유자 롤(운영·테스트)은 무엇이든.
--   ⑤ 가드 — 버전은 내려가지 않는다 · 지운 엔드포인트는 회전하지 않는다(`webhook_endpoints_secret_guard`) · admin 롤의 **직접** INSERT 는 두 표 모두
--      거부(`…_admin_write_guard` — GRANT 가 실수로 되살아나도, 보안 M2 심층 방어; 정의자 함수 안은 current_user 가 소유자라 지난다).
--      불변 핵심 트리거 둘은 예외 목록에 새 칸을 더해 다시 세운다(같은 이름 — `REQUIRED_GUARDS` 그대로).
--   ⑥ `webhook_deliveries.last_attempt_at` — 콘솔 전달 목록의 "마지막 시도". 디스패처가 집을 때(`claimDue`) 적는다. 옛 행은 NULL.
--   ⑦ 콘솔 시크릿 발급(보안 M1) — admin λ 는 웹훅 키링을 **갖지 않는다**. 콘솔은 등록·회전을 커밋한 뒤 api λ 를 내부 이벤트로 불러 시크릿을
--      받는다. api λ 는 `console_webhook_secret_ref` 로 "이 엔드포인트가 60초 안에 콘솔에서 등록(버전 1)됐거나 콘솔 회전으로 지금 버전이 됐다" 를
--      DB 에서 다시 확인한 뒤에만 파생한다. 앱 롤은 원장을 직접 읽지 못한다 — 이 함수 EXECUTE 하나.
--      **발급은 (엔드포인트, 버전)당 한 번이다**(재검토 L-1). 확인을 지나면 `webhook_console_secret_issues` 에 `INSERT … ON CONFLICT DO NOTHING`
--      으로 그 버전을 선점하고, 선점한 호출만 (kid, 버전)을 받는다. 두 번째 호출은 0행(→ `not_eligible`)이다 — 60초 창 안이라도 다른 환경·
--      재시도가 같은 시크릿을 다시 읽지 못한다. 선점 뒤 응답이 사라지면(시간 초과) 그 버전의 시크릿은 다시 받을 수 없다 — 콘솔은 503
--      `webhook_secret_unavailable` 이고 사용자는 교체로 새 버전을 받는다. 발급 원장은 append-only · 앱·admin 롤 권한 0(정의자 함수만 쓴다).
--   ⑧ 콘솔 감사 상세 `webhook_owner_action_details`(보안 L2) — owner_actions 한 행 옆에 엔드포인트 id · URL 호스트 · 전달 id(재전송은 새 전달 id).
--      append-only · admin 롤 INSERT(칸 단위)만. 투명성 잎은 owner_actions `agent.webhook.*` 가 남긴다.
--   ⑨ 권한 — 앱 롤: 정의자 함수 넷 EXECUTE · `last_attempt_at` UPDATE. admin 롤: 엔드포인트 SELECT · 전달은 **`body` 를 뺀 칸만** SELECT
--      (재검토 L-3 — 본문은 이벤트 원문이고 콘솔 목록은 싣지 않는다; 재전송 정의자 함수는 소유자로 본문을 복사한다) · 정의자 함수 넷 중
--      셋(등록·회전·재전송)과 삭제 EXECUTE · 감사 상세 INSERT. 허용 목록은 `src/runtime/role-bootstrap.ts` `RESTRICTED_ROLE_GRANTS`, 가드 목록은 `REQUIRED_GUARDS`(W4 표지).
--
-- 잠금: `agent_api_keys`(인증 경로 — 칸 추가 · 기본값 바꾸기, 훑기 없음) → `webhook_endpoints`(작다) → `webhook_deliveries`(outbox) ACCESS EXCLUSIVE.
--   **어느 표도 훑지 않는다** — 칸 추가(상수 기본값 = 빠른 기본값)·트리거·함수·`NOT VALID` 제약뿐이다. 5초 안에 잠금을 못 잡으면 실패하고 아무것도
--   바뀌지 않는다. 운영에서는 디스패처 스케줄을 잠깐 멈추고 돌린다(런북 deploy §28 — outbox 잠금 경합을 줄인다).
-- 배포 순서: migrate → Compute. 옛 코드는 새 칸·함수를 모른다(회전 경로가 없다).

SET LOCAL lock_timeout = '5s';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'atmark_app') THEN
    RAISE EXCEPTION
      'role atmark_app does not exist; provision the app role before running this migration'
      USING ERRCODE = '42704';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'atmark_admin') THEN
    RAISE EXCEPTION
      'role atmark_admin does not exist; run bootstrap-roles before this migration'
      USING ERRCODE = '42704';
  END IF;
END;
$$;

-- ---------------------------------------------------------------------------
-- ① 토큰의 전환 경로 자격(이 파일 전의 토큰만)
-- ---------------------------------------------------------------------------

ALTER TABLE agent_api_keys ADD COLUMN webhooks_legacy_eligible boolean NOT NULL DEFAULT true;
ALTER TABLE agent_api_keys ALTER COLUMN webhooks_legacy_eligible SET DEFAULT false;

COMMENT ON COLUMN agent_api_keys.webhooks_legacy_eligible IS
  'webhooks:manage 전(202609301410 전)에 발급된 토큰이면 true — 2027-01-01 까지 messages:send 로 웹훅 등록·삭제·재전송 가능(회전 제외). 불변.';

-- ---------------------------------------------------------------------------
-- ② 회전 칸 · 등록 표면
-- ---------------------------------------------------------------------------

ALTER TABLE webhook_endpoints
  ADD COLUMN secret_rotated_at timestamptz,
  ADD COLUMN previous_secret_kid text,
  ADD COLUMN previous_secret_version integer,
  ADD COLUMN previous_secret_valid_until timestamptz,
  ADD COLUMN created_via text NOT NULL DEFAULT 'api';

-- 넷은 함께 있거나 함께 없다(회전한 적 없음). 옛 버전은 지금 버전보다 작다 · kid 모양은 `secret_kid` 와 같다.
ALTER TABLE webhook_endpoints ADD CONSTRAINT webhook_endpoints_secret_rotation_shape CHECK (
  (previous_secret_kid IS NULL) = (previous_secret_version IS NULL)
  AND (previous_secret_version IS NULL) = (previous_secret_valid_until IS NULL)
  AND (previous_secret_version IS NULL) = (secret_rotated_at IS NULL)
  AND (previous_secret_kid IS NULL OR previous_secret_kid ~ '^[a-z0-9]{1,16}$')
  AND (previous_secret_version IS NULL OR (previous_secret_version >= 1 AND previous_secret_version < secret_version))
) NOT VALID;

ALTER TABLE webhook_endpoints ADD CONSTRAINT webhook_endpoints_created_via_check CHECK (created_via IN ('api', 'console')) NOT VALID;

COMMENT ON COLUMN webhook_endpoints.previous_secret_valid_until IS
  '직전 시크릿 (previous_secret_kid, previous_secret_version) 의 유예 끝. 이 시각 전에는 디스패처가 새·옛 시크릿 둘 다로 서명한다. 시크릿 자체는 저장하지 않는다.';
COMMENT ON COLUMN webhook_endpoints.created_via IS
  '등록 표면(api | console) — register_webhook_endpoint 가 호출 롤과 맞춰 적는다. 콘솔 시크릿 발급 확인(console_webhook_secret_ref)의 입력. 불변.';

-- ---------------------------------------------------------------------------
-- ③ 회전 원장
-- ---------------------------------------------------------------------------

CREATE TABLE webhook_secret_rotations (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  endpoint_id   uuid NOT NULL REFERENCES webhook_endpoints (id) ON DELETE RESTRICT,
  agent_id      char(32) NOT NULL REFERENCES agents (id) ON DELETE RESTRICT,
  from_version  integer NOT NULL CHECK (from_version >= 1),
  to_version    integer NOT NULL,
  -- 어느 표면이 회전했는가 — 에이전트 API(MCP 포함)·콘솔. 함수가 호출 롤과 맞춰 본다.
  via           text NOT NULL CHECK (via IN ('api', 'console')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT webhook_secret_rotations_version_step CHECK (to_version = from_version + 1)
);

CREATE INDEX webhook_secret_rotations_endpoint_created_idx ON webhook_secret_rotations (endpoint_id, created_at DESC);

CREATE TRIGGER webhook_secret_rotations_no_update
  BEFORE UPDATE ON webhook_secret_rotations
  FOR EACH ROW EXECUTE FUNCTION reject_row_update();

CREATE TRIGGER webhook_secret_rotations_no_delete
  BEFORE DELETE ON webhook_secret_rotations
  FOR EACH ROW EXECUTE FUNCTION reject_row_delete();

CREATE TRIGGER webhook_secret_rotations_no_truncate
  AFTER TRUNCATE ON webhook_secret_rotations
  FOR EACH STATEMENT EXECUTE FUNCTION reject_truncate();

COMMENT ON TABLE webhook_secret_rotations IS
  '웹훅 시크릿 회전 원장(append-only) — 엔드포인트당 24시간 10회 상한의 분자 · 감사 기록 · 콘솔 시크릿 발급 확인의 입력. 적는 것은 rotate_webhook_endpoint_secret 뿐. 시크릿 없음.';

-- 콘솔 시크릿 발급 원장(⑦ · 재검토 L-1) — (엔드포인트, 버전)당 한 행. 행이 있으면 그 버전의 시크릿은 이미 콘솔에 한 번 나갔다.
--   적는 것은 console_webhook_secret_ref(정의자 — 소유자로 돈다)뿐이다. 앱·admin 롤 권한 0. 시크릿 없음.
CREATE TABLE webhook_console_secret_issues (
  endpoint_id  uuid NOT NULL REFERENCES webhook_endpoints (id) ON DELETE RESTRICT,
  version      integer NOT NULL CHECK (version >= 1),
  issued_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (endpoint_id, version)
);

CREATE TRIGGER webhook_console_secret_issues_no_update
  BEFORE UPDATE ON webhook_console_secret_issues
  FOR EACH ROW EXECUTE FUNCTION reject_row_update();

CREATE TRIGGER webhook_console_secret_issues_no_delete
  BEFORE DELETE ON webhook_console_secret_issues
  FOR EACH ROW EXECUTE FUNCTION reject_row_delete();

CREATE TRIGGER webhook_console_secret_issues_no_truncate
  AFTER TRUNCATE ON webhook_console_secret_issues
  FOR EACH STATEMENT EXECUTE FUNCTION reject_truncate();

COMMENT ON TABLE webhook_console_secret_issues IS
  '콘솔 웹훅 시크릿 발급 원장(append-only) — (엔드포인트, 버전)당 한 번. console_webhook_secret_ref 가 선점한다. 지우면 같은 버전을 다시 발급할 수 있게 되므로 지우지 않는다. 시크릿 없음.';

-- ---------------------------------------------------------------------------
-- ④ 정의자 함수 — 웹훅 쓰기의 유일한 경로
-- ---------------------------------------------------------------------------

-- 경로 이름은 호출 롤과 맞아야 한다 — 콘솔 λ(atmark_admin)는 console, api λ(atmark_app)는 api. 다른 롤(소유자 — 운영·테스트)은 넘긴 값 그대로.
CREATE FUNCTION webhook_surface_matches_caller(p_via text) RETURNS boolean
LANGUAGE sql STABLE SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT p_via IN ('api', 'console')
     AND CASE session_user
           WHEN 'atmark_admin' THEN p_via = 'console'
           WHEN 'atmark_app' THEN p_via = 'api'
           ELSE true
         END
$$;

-- 등록 — INSERT 하나. 상한(min(천장, 요금제) · 24시간 10회)은 앱이 같은 advisory 잠금 아래에서 먼저 보고, 천장 10·바닥 20 은 기존 트리거가 다시 본다.
--   URL 은 앱의 정적 검사를 지난 값이다(여기서는 https CHECK 가 바닥).
CREATE FUNCTION register_webhook_endpoint(p_agent_id text, p_url text, p_kid text, p_event_types webhook_event_type[], p_via text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  created uuid;
BEGIN
  IF NOT public.webhook_surface_matches_caller(p_via) THEN
    RAISE EXCEPTION 'webhook surface % does not match the calling role', p_via USING ERRCODE = '42501';
  END IF;
  INSERT INTO public.webhook_endpoints (agent_id, url, secret_kid, event_types, created_via)
  VALUES (p_agent_id::bpchar, p_url, p_kid, p_event_types, p_via)
  RETURNING id INTO created;
  RETURN created;
END;
$$;

CREATE FUNCTION rotate_webhook_endpoint_secret(p_agent_id text, p_endpoint_id uuid, p_kid text, p_via text)
RETURNS TABLE (r_outcome text, r_secret_kid text, r_secret_version integer, r_rotated_at timestamptz, r_previous_valid_until timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  target public.webhook_endpoints%ROWTYPE;
  recent integer;
BEGIN
  IF NOT public.webhook_surface_matches_caller(p_via) THEN
    RAISE EXCEPTION 'webhook surface % does not match the calling role', p_via USING ERRCODE = '42501';
  END IF;
  -- 행 잠금 — 같은 엔드포인트의 동시 회전 둘이 둘 다 "아직 9회" 를 보거나 같은 새 버전을 만들지 않게.
  SELECT * INTO target FROM public.webhook_endpoints e
   WHERE e.id = p_endpoint_id AND e.agent_id = p_agent_id::bpchar AND e.disabled_at IS NULL
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'not_found'::text, NULL::text, NULL::integer, NULL::timestamptz, NULL::timestamptz;
    RETURN;
  END IF;
  SELECT count(*) INTO recent FROM public.webhook_secret_rotations r
   WHERE r.endpoint_id = p_endpoint_id AND r.created_at > now() - interval '24 hours';
  IF recent >= 10 THEN
    RETURN QUERY SELECT 'rate_limited'::text, NULL::text, NULL::integer, NULL::timestamptz, NULL::timestamptz;
    RETURN;
  END IF;
  UPDATE public.webhook_endpoints e
     SET previous_secret_kid = e.secret_kid,
         previous_secret_version = e.secret_version,
         previous_secret_valid_until = now() + interval '24 hours',
         secret_kid = p_kid,
         secret_version = e.secret_version + 1,
         secret_rotated_at = now()
   WHERE e.id = p_endpoint_id;
  INSERT INTO public.webhook_secret_rotations (endpoint_id, agent_id, from_version, to_version, via)
  VALUES (p_endpoint_id, target.agent_id, target.secret_version, target.secret_version + 1, p_via);
  RETURN QUERY
    SELECT 'rotated'::text, e.secret_kid, e.secret_version, e.secret_rotated_at, e.previous_secret_valid_until
      FROM public.webhook_endpoints e WHERE e.id = p_endpoint_id;
END;
$$;

-- 재전송 — 앱(`redeliverWebhookDelivery`)이 하던 규칙 그대로, 이유를 가려 돌려준다. 새 행은 **루트에서만 복사**한다(본문·이벤트·엔드포인트).
--   잠금 순서는 루트 → 에이전트(교착 없음). 가드 트리거(`webhook_deliveries_redelivery_guard`)가 같은 루트 잠금 아래에서 한 번 더 본다.
CREATE FUNCTION redeliver_webhook_delivery(p_agent_id text, p_delivery_id uuid, p_next_attempt_at timestamptz)
RETURNS TABLE (r_outcome text, r_delivery_id uuid, r_redelivery_of uuid, r_event_id uuid, r_ordinal integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  target_redelivery_of uuid;
  target_status public.webhook_delivery_status;
  target_disabled boolean;
  root_id uuid;
  family_rejected boolean;
  family_delivered boolean;
  used integer;
  recent integer;
  inserted_id uuid;
  inserted_event uuid;
BEGIN
  SELECT d.redelivery_of, d.status, (e.disabled_at IS NOT NULL)
    INTO target_redelivery_of, target_status, target_disabled
    FROM public.webhook_deliveries d JOIN public.webhook_endpoints e ON e.id = d.endpoint_id
   WHERE d.id = p_delivery_id AND e.agent_id = p_agent_id::bpchar;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'not_found'::text, NULL::uuid, NULL::uuid, NULL::uuid, NULL::integer;
    RETURN;
  END IF;
  IF target_status <> 'dead' THEN
    RETURN QUERY SELECT 'not_dead'::text, NULL::uuid, NULL::uuid, NULL::uuid, NULL::integer;
    RETURN;
  END IF;
  root_id := COALESCE(target_redelivery_of, p_delivery_id);
  PERFORM pg_advisory_xact_lock(hashtextextended('webhook_redelivery:' || root_id::text, 0));
  IF target_disabled THEN
    RETURN QUERY SELECT 'endpoint_disabled'::text, NULL::uuid, NULL::uuid, NULL::uuid, NULL::integer;
    RETURN;
  END IF;
  SELECT COALESCE(bool_or(d.status = 'dead' AND d.last_error IN ('blocked_destination', 'invalid_url', 'endpoint_disabled')), false),
         COALESCE(bool_or(d.status = 'delivered'), false),
         (count(*) FILTER (WHERE d.redelivery_of = root_id))::integer
    INTO family_rejected, family_delivered, used
    FROM public.webhook_deliveries d
   WHERE d.id = root_id OR d.redelivery_of = root_id;
  IF family_rejected THEN
    RETURN QUERY SELECT 'destination_rejected'::text, NULL::uuid, NULL::uuid, NULL::uuid, NULL::integer;
    RETURN;
  END IF;
  IF family_delivered THEN
    RETURN QUERY SELECT 'already_delivered'::text, NULL::uuid, NULL::uuid, NULL::uuid, NULL::integer;
    RETURN;
  END IF;
  IF used >= 3 THEN
    RETURN QUERY SELECT 'limit_reached'::text, NULL::uuid, NULL::uuid, NULL::uuid, NULL::integer;
    RETURN;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('webhook_redelivery_agent:' || p_agent_id, 0));
  SELECT count(*)::integer INTO recent
    FROM public.webhook_endpoints e JOIN public.webhook_deliveries d ON d.endpoint_id = e.id
   WHERE e.agent_id = p_agent_id::bpchar AND d.redelivery_of IS NOT NULL AND d.created_at > now() - interval '1 hour';
  IF recent >= 100 THEN
    RETURN QUERY SELECT 'agent_rate_limited'::text, NULL::uuid, NULL::uuid, NULL::uuid, NULL::integer;
    RETURN;
  END IF;
  INSERT INTO public.webhook_deliveries (event_id, endpoint_id, event_type, dedupe_key, body, next_attempt_at, redelivery_of)
  SELECT r.event_id, r.endpoint_id, r.event_type, 'redelivery:' || r.id::text || ':' || (used + 1)::text, r.body, p_next_attempt_at, r.id
    FROM public.webhook_deliveries r
   WHERE r.id = root_id
  RETURNING id, event_id INTO inserted_id, inserted_event;
  RETURN QUERY SELECT 'redelivered'::text, inserted_id, root_id, inserted_event, used + 1;
END;
$$;

-- 콘솔 시크릿 발급(⑦) — 콘솔이 **60초 안에** 등록(버전 1, 회전 전)했거나 콘솔 회전으로 지금 버전이 된 켜진 행이고, 그 (엔드포인트, 버전)을
--   **처음** 선점한 호출에만 (kid, 버전)을 답한다(재검토 L-1). 그 밖은 0행.
--   행 잠금(FOR SHARE) — 확인과 선점 사이에 회전이 끼어 "선점한 버전 ≠ 답한 버전" 이 되지 않게(회전은 FOR UPDATE 로 기다린다).
CREATE FUNCTION console_webhook_secret_ref(p_agent_id text, p_endpoint_id uuid)
RETURNS TABLE (r_secret_kid text, r_secret_version integer)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  eligible_kid text;
  eligible_version integer;
  claimed integer;
BEGIN
  SELECT e.secret_kid, e.secret_version INTO eligible_kid, eligible_version
    FROM public.webhook_endpoints e
   WHERE e.id = p_endpoint_id AND e.agent_id = p_agent_id::bpchar AND e.disabled_at IS NULL
     AND (
       (e.created_via = 'console' AND e.secret_version = 1 AND e.secret_rotated_at IS NULL AND e.created_at > now() - interval '60 seconds')
       OR EXISTS (
         SELECT 1 FROM public.webhook_secret_rotations r
          WHERE r.endpoint_id = e.id AND r.via = 'console' AND r.to_version = e.secret_version
            AND r.created_at > now() - interval '60 seconds')
     )
   FOR SHARE OF e;
  IF NOT FOUND THEN
    RETURN;
  END IF;
  INSERT INTO public.webhook_console_secret_issues (endpoint_id, version)
  VALUES (p_endpoint_id, eligible_version)
  ON CONFLICT DO NOTHING
  RETURNING version INTO claimed;
  IF claimed IS NULL THEN
    RETURN;
  END IF;
  RETURN QUERY SELECT eligible_kid, eligible_version;
END;
$$;

COMMENT ON FUNCTION register_webhook_endpoint(text, text, text, webhook_event_type[], text) IS
  '웹훅 엔드포인트 등록 INSERT 하나(경로는 호출 롤과 맞아야 한다). 상한은 앱이 같은 잠금 아래에서 먼저 본다.';
COMMENT ON FUNCTION rotate_webhook_endpoint_secret(text, uuid, text, text) IS
  '웹훅 시크릿 회전 — (에이전트, 엔드포인트) 짝이 맞는 켜진 행만. 엔드포인트당 24시간 10회. 버전 +1 · 직전 (kid, 버전) 24시간 유예. 인가는 라우트.';
COMMENT ON FUNCTION redeliver_webhook_delivery(text, uuid, timestamptz) IS
  '웹훅 재전송 — dead 루트에서만 복사(본문·이벤트·엔드포인트). 루트당 3회 · 에이전트 시간당 100 · 목적지 거부류·delivered 가족 거부. 인가는 라우트.';
COMMENT ON FUNCTION console_webhook_secret_ref(text, uuid) IS
  '콘솔 시크릿 발급 — 60초 안에 콘솔이 등록(버전 1)·회전한 켜진 행의 (kid, 버전)을 (엔드포인트, 버전)당 한 번만(webhook_console_secret_issues 선점). 그 밖·두 번째는 0행. api λ(앱 롤)만 EXECUTE.';

REVOKE ALL ON FUNCTION webhook_surface_matches_caller(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION register_webhook_endpoint(text, text, text, webhook_event_type[], text) FROM PUBLIC;
REVOKE ALL ON FUNCTION rotate_webhook_endpoint_secret(text, uuid, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION redeliver_webhook_delivery(text, uuid, timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION console_webhook_secret_ref(text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION register_webhook_endpoint(text, text, text, webhook_event_type[], text) TO atmark_app, atmark_admin;
GRANT EXECUTE ON FUNCTION rotate_webhook_endpoint_secret(text, uuid, text, text) TO atmark_app, atmark_admin;
GRANT EXECUTE ON FUNCTION redeliver_webhook_delivery(text, uuid, timestamptz) TO atmark_app, atmark_admin;
GRANT EXECUTE ON FUNCTION console_webhook_secret_ref(text, uuid) TO atmark_app;

-- ---------------------------------------------------------------------------
-- ⑤ 가드 · 불변 핵심 다시 세우기
-- ---------------------------------------------------------------------------

-- 왜: 버전이 내려가면 이미 버린(샜을 수 있는) 옛 시크릿이 다시 유효해진다. 지운 엔드포인트의 시크릿을 바꾸는 것은 뜻이 없다. 소유자 롤도 막는다.
CREATE FUNCTION webhook_endpoints_secret_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.secret_version < OLD.secret_version THEN
    RAISE EXCEPTION 'webhook endpoint % secret_version cannot go down (% -> %)', OLD.id, OLD.secret_version, NEW.secret_version
      USING ERRCODE = '23514';
  END IF;
  IF OLD.disabled_at IS NOT NULL
     AND (NEW.secret_version, NEW.secret_kid) IS DISTINCT FROM (OLD.secret_version, OLD.secret_kid) THEN
    RAISE EXCEPTION 'webhook endpoint % is deleted — its secret cannot be rotated', OLD.id
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER webhook_endpoints_secret_guard
  BEFORE UPDATE OF secret_version, secret_kid ON webhook_endpoints
  FOR EACH ROW EXECUTE FUNCTION webhook_endpoints_secret_guard();

-- 왜(보안 M2 심층 방어): admin 롤이 outbox 에 직접 쓰면 디스패처가 그 본문에 서명해 보낸다. GRANT 는 이미 0 이지만, 권한이 실수로 되살아나도
--   직접 INSERT 는 여기서 죽는다. 정의자 함수 안의 INSERT 는 current_user 가 소유자라 지난다.
CREATE FUNCTION reject_admin_role_direct_write() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF current_user = 'atmark_admin' THEN
    RAISE EXCEPTION '% is written only through its definer functions (atmark_admin direct write)', TG_TABLE_NAME
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER webhook_endpoints_admin_write_guard
  BEFORE INSERT OR UPDATE ON webhook_endpoints
  FOR EACH ROW EXECUTE FUNCTION reject_admin_role_direct_write();

CREATE TRIGGER webhook_deliveries_admin_write_guard
  BEFORE INSERT OR UPDATE ON webhook_deliveries
  FOR EACH ROW EXECUTE FUNCTION reject_admin_role_direct_write();

DROP TRIGGER webhook_endpoints_immutable_core ON webhook_endpoints;
CREATE TRIGGER webhook_endpoints_immutable_core
  BEFORE UPDATE ON webhook_endpoints
  FOR EACH ROW EXECUTE FUNCTION reject_column_update_except(
    'url', 'secret_kid', 'secret_version', 'disabled_at',
    'secret_rotated_at', 'previous_secret_kid', 'previous_secret_version', 'previous_secret_valid_until');

-- ---------------------------------------------------------------------------
-- ⑥ 전달의 마지막 시도 시각
-- ---------------------------------------------------------------------------

ALTER TABLE webhook_deliveries ADD COLUMN last_attempt_at timestamptz;

COMMENT ON COLUMN webhook_deliveries.last_attempt_at IS
  '마지막 시도를 집은 시각(디스패처 claimDue). 이 칸 전의 행은 NULL — 화면은 delivered_at · dead_at 으로 대신한다.';

DROP TRIGGER webhook_deliveries_immutable_core ON webhook_deliveries;
CREATE TRIGGER webhook_deliveries_immutable_core
  BEFORE UPDATE ON webhook_deliveries
  FOR EACH ROW EXECUTE FUNCTION reject_column_update_except(
    'status', 'attempt_count', 'next_attempt_at', 'last_error', 'last_http_status', 'delivered_at', 'dead_at', 'last_attempt_at');

-- ---------------------------------------------------------------------------
-- ⑧ 콘솔 감사 상세
-- ---------------------------------------------------------------------------

CREATE TABLE webhook_owner_action_details (
  owner_action_id  uuid PRIMARY KEY REFERENCES owner_actions (id) ON DELETE RESTRICT,
  endpoint_id      uuid NOT NULL REFERENCES webhook_endpoints (id) ON DELETE RESTRICT,
  -- URL 의 호스트(포트 포함)만 — 경로·쿼리(토큰이 들어 있을 수 있다)는 싣지 않는다.
  url_host         text NOT NULL CONSTRAINT webhook_owner_action_details_url_host_check
                     CHECK (length(url_host) BETWEEN 1 AND 300 AND url_host ~ '^[a-z0-9.:\[\]-]+$'),
  -- 재전송: 다시 보낸 전달(루트든 재전송 행이든 콘솔이 고른 것)과 새로 만든 전달.
  delivery_id      uuid REFERENCES webhook_deliveries (id) ON DELETE RESTRICT,
  new_delivery_id  uuid REFERENCES webhook_deliveries (id) ON DELETE RESTRICT,
  CONSTRAINT webhook_owner_action_details_delivery_pair CHECK ((delivery_id IS NULL) = (new_delivery_id IS NULL))
);

CREATE INDEX webhook_owner_action_details_endpoint_idx ON webhook_owner_action_details (endpoint_id);

CREATE TRIGGER webhook_owner_action_details_no_update
  BEFORE UPDATE ON webhook_owner_action_details
  FOR EACH ROW EXECUTE FUNCTION reject_row_update();
CREATE TRIGGER webhook_owner_action_details_no_delete
  BEFORE DELETE ON webhook_owner_action_details
  FOR EACH ROW EXECUTE FUNCTION reject_row_delete();
CREATE TRIGGER webhook_owner_action_details_no_truncate
  AFTER TRUNCATE ON webhook_owner_action_details
  FOR EACH STATEMENT EXECUTE FUNCTION reject_truncate();

COMMENT ON TABLE webhook_owner_action_details IS
  '콘솔 웹훅 감사(owner_actions agent.webhook.*)의 부속 상세 — 엔드포인트 id · URL 호스트 · 재전송의 전달 id 둘. append-only. 앱 롤 권한 0.';

-- ---------------------------------------------------------------------------
-- ⑨ 권한
-- ---------------------------------------------------------------------------

GRANT UPDATE (last_attempt_at) ON webhook_deliveries TO atmark_app;

-- 콘솔 웹훅 화면(admin 롤) — 읽기 둘 · 삭제 함수 · 감사 상세 INSERT. 쓰기는 위 정의자 함수로만(표 INSERT·UPDATE·DELETE 0).
--   전달은 `body` 를 뺀 칸만(재검토 L-3) — 콘솔은 본문을 싣지 않고, 재전송 함수는 소유자로 본문을 복사한다. 칸이 늘면 여기와
--   `RESTRICTED_ROLE_GRANTS` 를 함께 고친다(허용 목록 밖의 칸 권한은 migrate status 가 잡는다).
GRANT SELECT ON webhook_endpoints TO atmark_admin;
GRANT SELECT (id, event_id, endpoint_id, event_type, dedupe_key, status, attempt_count, next_attempt_at, last_error, last_http_status,
              delivered_at, dead_at, created_at, redelivery_of, last_attempt_at) ON webhook_deliveries TO atmark_admin;
GRANT EXECUTE ON FUNCTION disable_webhook_endpoint(text, uuid) TO atmark_admin;
GRANT INSERT (owner_action_id, endpoint_id, url_host, delivery_id, new_delivery_id) ON webhook_owner_action_details TO atmark_admin;
