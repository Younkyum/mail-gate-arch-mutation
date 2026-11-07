-- 202609290500_ops_identity.sql
-- 호스팅 운영자 콘솔 ops.atmark.ai 의 **신원 층**(`.omc/plans/ops-console.md` §3.2~3.6 · 계약 `docs/contracts/ops-sql.md`, ADR-0015 초안).
--
--   ① 표 — 운영자(`ops_operators` · 사건 원장) · 로그인 도전(코드 메일 outbox · 다이제스트) · 요청자 원장 · 주소 실패 · 세션 · step-up 허가 ·
--      행위 원장(`ops_actions` · `ops_action_effects`, 티켓은 202609290510) · 설정 한 행(`console_enabled` · `hard_locked` 기본 **false**).
--   ② 인증 정의 함수(SECURITY DEFINER · 소유자 소유 · search_path 고정 · PUBLIC 0) — `atmark_ops` 가 EXECUTE 하는 것은 계약의 인증 함수뿐이다.
--      정의 함수는 **`ops_*` 표에만** 쓴다(도메인 표 쓰기는 202609290510 의 `ops_*_core` 만 — 단위 테스트가 본문을 검사한다).
--   ③ 코드 검증(결정 C2) — 코드는 login-mailer 만 로그인 키로 파생한다. 다이제스트(`ops_code_digest` = sha256(문맥 ‖ 도전 id ‖ 코드))는
--      메일러가 `ops_mailer_set_digest` 로 **한 번** 적고(같은 값이면 멱등 · 다른 값이면 그 도전은 dead — 키 회전), DB 가 검증한다.
--      login-mailer 는 `code_digest` 칸의 SELECT·UPDATE 가 0 이다. 쓰였거나 5번 틀렸거나 무효가 되면 다이제스트는 NULL(가드가 비운다, H11).
--   ④ 열거 동형 — `ops_request_code` 는 목적(로그인/접근 요청)·조용한 상한과 무관하게 같은 모양으로 끝난다(void). 검증 실패는 이유와 무관하게
--      `invalid` 하나다(λ 는 401 code_invalid).
--   ⑤ 권한 — `atmark_ops`: 읽기(칸 단위 — 토큰 해시·UA 해시·요청자 키·다이제스트·주소 솔트 0)와 인증 함수 EXECUTE. **쓰기 GRANT 0**.
--      `atmark_login_mailer`: 도전 outbox 칸 · 운영자(id, email, status) SELECT · `ops_mailer_set_digest`. 앱 롤: 보존·만료·census 함수 셋.
--      허용 목록 `RESTRICTED_ROLE_GRANTS`(atmark_ops · login-mailer · 앱) · 가드 목록 `REQUIRED_GUARDS` 를 같은 변경에서 늘렸다.
--
-- 새 표만 만든다(기존 표를 잠그지 않는다). 롤백 호환: 옛 코드는 `ops_*` 를 모른다.

SET LOCAL lock_timeout = '5s';

DO $$
DECLARE
  missing text;
BEGIN
  SELECT string_agg(name, ', ') INTO missing
    FROM unnest(ARRAY['atmark_ops', 'atmark_login_mailer', 'atmark_app']) AS name
   WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = name);
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION 'role % does not exist — migrate 핸들러의 bootstrap-roles 를 먼저 돌려라(로컬: docs/runbooks/admin.md §8)', missing;
  END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- ① 표
-- ---------------------------------------------------------------------------

-- 설정 한 행. 소유자 롤만 바꾼다(아무 롤에도 쓰기 GRANT 가 없다). 닫힌 채 배포한다(console_enabled = false).
CREATE TABLE ops_settings (
  id               boolean PRIMARY KEY DEFAULT true CHECK (id),
  console_enabled  boolean NOT NULL DEFAULT false,
  hard_locked      boolean NOT NULL DEFAULT false,
  failure_salt     text NOT NULL CHECK (failure_salt ~ '^[0-9a-f]{64}$'),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
INSERT INTO ops_settings (failure_salt)
VALUES (encode(sha256(convert_to(gen_random_uuid()::text || gen_random_uuid()::text || clock_timestamp()::text, 'UTF8')), 'hex'));

CREATE TRIGGER ops_settings_salt_immutable BEFORE UPDATE ON ops_settings
  FOR EACH ROW EXECUTE FUNCTION reject_column_update('failure_salt');
CREATE TRIGGER ops_settings_set_updated_at BEFORE UPDATE ON ops_settings
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER ops_settings_no_delete BEFORE DELETE ON ops_settings
  FOR EACH ROW EXECUTE FUNCTION reject_row_delete();
CREATE TRIGGER ops_settings_no_truncate AFTER TRUNCATE ON ops_settings
  FOR EACH STATEMENT EXECUTE FUNCTION reject_truncate();

COMMENT ON TABLE ops_settings IS
  '호스팅 운영자 콘솔 설정 한 행 — console_enabled(소프트 킬 스위치) · hard_locked(하드 킬 스위치 영속, bootstrap-roles 가 NOLOGIN 을 유지) · 주소 실패 HMAC 솔트. 소유자 롤만 바꾼다.';

CREATE TABLE ops_operators (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         text NOT NULL,
  status        text NOT NULL CHECK (status IN ('requested', 'active', 'denied', 'revoked', 'expired')),
  origin        text NOT NULL CHECK (origin IN ('cli', 'console')),
  requested_at  timestamptz,
  decided_at    timestamptz,
  decided_by    uuid REFERENCES ops_operators (id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ops_operators_email_shape
    CHECK (email = lower(btrim(email)) AND length(email) BETWEEN 3 AND 254 AND email ~ '^[^@[:space:]]+@[^@[:space:]]+$'),
  -- 자기 결정 금지(승인·거절). 폐기는 자기 자신도 된다(§3.5).
  CONSTRAINT ops_operators_not_self_decided CHECK (decided_by IS DISTINCT FROM id OR status = 'revoked'),
  CONSTRAINT ops_operators_requested_shape CHECK (status <> 'requested' OR (requested_at IS NOT NULL AND origin = 'console'))
);
CREATE UNIQUE INDEX ops_operators_email_key ON ops_operators (email);
CREATE INDEX ops_operators_status_idx ON ops_operators (status);

COMMENT ON TABLE ops_operators IS
  '운영자 — 주소 하나에 한 행. 상태 기계(requested → active|denied|expired · active → revoked · 끝난 행 → requested(쿨다운 7일)). origin=cli 행은 소유자 롤 세션(session_user)만 바꾼다(H1). 대기 요청 최대 5. DELETE 거부.';

-- 사건 원장(append-only). ops_operators 의 AFTER 트리거가 적는다 — 행위자는 트랜잭션 설정 atmark.ops_actor.
CREATE TABLE ops_operator_events (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  operator_id  uuid NOT NULL REFERENCES ops_operators (id),
  from_status  text,
  to_status    text NOT NULL,
  actor        text NOT NULL CHECK (length(actor) BETWEEN 1 AND 200),
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ops_operator_events_operator_idx ON ops_operator_events (operator_id, created_at);
CREATE TRIGGER ops_operator_events_no_update BEFORE UPDATE ON ops_operator_events
  FOR EACH ROW EXECUTE FUNCTION reject_row_update();
CREATE TRIGGER ops_operator_events_no_delete BEFORE DELETE ON ops_operator_events
  FOR EACH ROW EXECUTE FUNCTION reject_row_delete();
CREATE TRIGGER ops_operator_events_no_truncate AFTER TRUNCATE ON ops_operator_events
  FOR EACH STATEMENT EXECUTE FUNCTION reject_truncate();

CREATE TABLE ops_sessions (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  operator_id    uuid NOT NULL REFERENCES ops_operators (id),
  token_hash     text NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  ua_hash        text NOT NULL CHECK (ua_hash ~ '^[0-9a-f]{64}$'),
  client_key     text NOT NULL CHECK (client_key ~ '^[0-9a-f]{64}$'),
  created_at     timestamptz NOT NULL DEFAULT now(),
  expires_at     timestamptz NOT NULL,
  last_seen_at   timestamptz NOT NULL DEFAULT now(),
  -- 이 세션에서 틀린 step-up 코드 수(+1 씩만). 10 이 되면 그 자리에서 세션을 폐기한다(`step_up_failures` — 보안 검토 L2).
  step_up_failures smallint NOT NULL DEFAULT 0 CHECK (step_up_failures BETWEEN 0 AND 10),
  revoked_at     timestamptz,
  revoke_reason  text CHECK (revoke_reason IN ('logout', 'logout_all', 'ua_changed', 'operator_revoked', 'step_up_failures')),
  CONSTRAINT ops_sessions_lifetime CHECK (expires_at > created_at AND expires_at <= created_at + interval '8 hours'),
  CONSTRAINT ops_sessions_revoked_shape CHECK ((revoked_at IS NULL) = (revoke_reason IS NULL))
);
CREATE INDEX ops_sessions_operator_idx ON ops_sessions (operator_id) WHERE revoked_at IS NULL;

COMMENT ON TABLE ops_sessions IS
  '운영자 세션 — 토큰 해시만(평문 없음). 절대 8시간 · 유휴 30분 · last_seen_at 앞으로만 · 폐기 1회. UA 가 바뀌면 폐기, IP 가 바뀌면 기록만. 틀린 step-up 코드 10 이면 폐기.';

CREATE TABLE ops_login_challenges (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  purpose             text NOT NULL CHECK (purpose IN ('login', 'access_request', 'step_up')),
  email               text NOT NULL CHECK (email = lower(btrim(email)) AND length(email) BETWEEN 3 AND 254),
  operator_id         uuid REFERENCES ops_operators (id),
  session_id          uuid REFERENCES ops_sessions (id),
  action              text CHECK (action IN ('org.activate', 'org.reject', 'org.freeze_on', 'agent.suspend',
                                             'operator.approve', 'operator.deny', 'operator.revoke')),
  organization_id     uuid,
  target_operator_id  uuid REFERENCES ops_operators (id),
  target_ref          text CHECK (target_ref ~ '^[0-9A-Z]{4}$'),
  binding             text CHECK (binding ~ '^[0-9a-f]{64}$'),
  client_key          text NOT NULL CHECK (client_key ~ '^[0-9a-f]{64}$'),
  lang                text NOT NULL DEFAULT 'ko' CHECK (lang IN ('ko', 'en')),
  created_at          timestamptz NOT NULL DEFAULT now(),
  expires_at          timestamptz NOT NULL,
  used_at             timestamptz,
  invalidated_at      timestamptz,
  code_failures       smallint NOT NULL DEFAULT 0 CHECK (code_failures BETWEEN 0 AND 5),
  code_digest         text CHECK (code_digest ~ '^[0-9a-f]{64}$'),
  -- outbox(login-mailer) — owner_login_links 와 같은 칸.
  status              text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'dead', 'undeliverable', 'obsolete')),
  attempt_count       integer NOT NULL DEFAULT 0 CHECK (attempt_count BETWEEN 0 AND 10),
  next_attempt_at     timestamptz NOT NULL DEFAULT now(),
  claimed_at          timestamptz,
  last_error          text CHECK (length(last_error) <= 200),
  ses_message_id      text CHECK (length(ses_message_id) <= 200),
  sent_at             timestamptz,
  settled_at          timestamptz,
  CONSTRAINT ops_login_challenges_ttl CHECK (expires_at > created_at AND expires_at <= created_at + interval '10 minutes'),
  CONSTRAINT ops_login_challenges_purpose_shape CHECK (
    CASE purpose
      WHEN 'login' THEN operator_id IS NOT NULL AND binding IS NOT NULL AND session_id IS NULL AND action IS NULL
                        AND organization_id IS NULL AND target_operator_id IS NULL AND target_ref IS NULL
      WHEN 'access_request' THEN operator_id IS NULL AND binding IS NOT NULL AND session_id IS NULL AND action IS NULL
                        AND organization_id IS NULL AND target_operator_id IS NULL AND target_ref IS NULL
      ELSE operator_id IS NOT NULL AND binding IS NULL AND session_id IS NOT NULL AND action IS NOT NULL AND target_ref IS NOT NULL
           AND ((organization_id IS NOT NULL) <> (target_operator_id IS NOT NULL))
    END),
  CONSTRAINT ops_login_challenges_sent_shape CHECK (status <> 'sent' OR sent_at IS NOT NULL)
);
CREATE INDEX ops_login_challenges_binding_idx ON ops_login_challenges (binding, created_at) WHERE binding IS NOT NULL;
CREATE INDEX ops_login_challenges_session_idx ON ops_login_challenges (session_id, created_at) WHERE session_id IS NOT NULL;
CREATE INDEX ops_login_challenges_email_idx ON ops_login_challenges (email, created_at);
CREATE INDEX ops_login_challenges_due_idx ON ops_login_challenges (next_attempt_at) WHERE status = 'pending';
CREATE INDEX ops_login_challenges_created_idx ON ops_login_challenges (created_at);
CREATE INDEX ops_login_challenges_access_idx ON ops_login_challenges (created_at) WHERE purpose = 'access_request';

COMMENT ON TABLE ops_login_challenges IS
  '운영자 코드 메일 도전(로그인 · 접근 요청 · step-up) + login-mailer outbox. 코드는 저장하지 않는다 — 다이제스트만(ops_mailer_set_digest 로 한 번, 쓰면 NULL). 수명 ≤ 10분 · 틀린 코드 5회. 하루 뒤 purge_ops_login_records 가 지운다.';

-- 요청자(client_key = HMAC(ops 키, ip)) 원장 — 요청·검증 상한의 분자, (주소, 요청자) 하루 실패의 분자. 하루 뒤 지운다.
CREATE TABLE ops_login_attempts (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  client_key    text NOT NULL CHECK (client_key ~ '^[0-9a-f]{64}$'),
  kind          text NOT NULL CHECK (kind IN ('request', 'verify', 'stepup_request', 'stepup_verify', 'verify_failure')),
  address_hash  text CHECK (address_hash ~ '^[0-9a-f]{64}$'),
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ops_login_attempts_failure_shape CHECK ((kind = 'verify_failure') = (address_hash IS NOT NULL))
);
CREATE INDEX ops_login_attempts_client_idx ON ops_login_attempts (client_key, kind, created_at);
CREATE INDEX ops_login_attempts_created_idx ON ops_login_attempts (created_at);
CREATE TRIGGER ops_login_attempts_no_update BEFORE UPDATE ON ops_login_attempts
  FOR EACH ROW EXECUTE FUNCTION reject_row_update();
CREATE TRIGGER ops_login_attempts_no_truncate AFTER TRUNCATE ON ops_login_attempts
  FOR EACH STATEMENT EXECUTE FUNCTION reject_truncate();

-- 주소별 하루 실패(주소 평문 없음 — sha256(솔트 ‖ 주소)). 50 이면 24시간 코드 발급 중지(CLI --unlock 으로 푼다). 30일 뒤 지운다.
CREATE TABLE ops_address_failures (
  address_hash  text NOT NULL CHECK (address_hash ~ '^[0-9a-f]{64}$'),
  day           date NOT NULL,
  failures      integer NOT NULL DEFAULT 0 CHECK (failures >= 0),
  locked_until  timestamptz,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (address_hash, day)
);
CREATE INDEX ops_address_failures_locked_idx ON ops_address_failures (locked_until) WHERE locked_until IS NOT NULL;
CREATE TRIGGER ops_address_failures_set_updated_at BEFORE UPDATE ON ops_address_failures
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE ops_step_up_grants (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id          uuid NOT NULL REFERENCES ops_sessions (id),
  action              text NOT NULL CHECK (action IN ('org.activate', 'org.reject', 'operator.approve', 'operator.deny', 'operator.revoke')),
  organization_id     uuid,
  target_operator_id  uuid REFERENCES ops_operators (id),
  target_ref          text NOT NULL CHECK (target_ref ~ '^[0-9A-Z]{4}$'),
  mode                text NOT NULL CHECK (mode IN ('once', 'window')),
  created_at          timestamptz NOT NULL DEFAULT now(),
  expires_at          timestamptz NOT NULL,
  used_at             timestamptz,
  CONSTRAINT ops_step_up_grants_ttl CHECK (expires_at > created_at AND expires_at <= created_at + interval '10 minutes'),
  -- `OPS_STEP_UP`(src/ops/contract.ts)와 같은 표 — 활성화만 window.
  CONSTRAINT ops_step_up_grants_mode CHECK ((mode = 'window') = (action = 'org.activate')),
  CONSTRAINT ops_step_up_grants_target CHECK (
    CASE WHEN action LIKE 'org.%' THEN organization_id IS NOT NULL AND target_operator_id IS NULL
         ELSE organization_id IS NULL AND target_operator_id IS NOT NULL END),
  CONSTRAINT ops_step_up_grants_window_unused CHECK (mode = 'once' OR used_at IS NULL)
);
CREATE INDEX ops_step_up_grants_session_idx ON ops_step_up_grants (session_id, action, created_at);

-- 행위 원장 — 티켓(202609290510 ops_authorize) · 실패 · 세션 사건 · 운영자 사건. append-only.
CREATE TABLE ops_actions (
  id                  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  kind                text NOT NULL CHECK (kind IN ('ticket', 'failure', 'session_event', 'operator_event')),
  result              text NOT NULL CHECK (result ~ '^[a-z_]{1,40}$'),
  operator_id         uuid REFERENCES ops_operators (id),
  session_id          uuid REFERENCES ops_sessions (id),
  client_key          text CHECK (client_key ~ '^[0-9a-f]{64}$'),
  action              text CHECK (action IN ('org.activate', 'org.reject', 'org.freeze_on', 'agent.suspend',
                                             'operator.approve', 'operator.deny', 'operator.revoke')),
  organization_id     uuid,
  agent_id            text CHECK (agent_id ~ '^[0-9a-f]{32}$'),
  target_operator_id  uuid REFERENCES ops_operators (id),
  -- 실패 코드(§3.2 표의 DETAIL · 'unknown') — kind='failure' 에서만.
  code                text CHECK (code ~ '^[a-z_]{1,40}$'),
  xact_id             xid8 UNIQUE,
  created_at          timestamptz NOT NULL DEFAULT now(),
  -- H2 — 티켓 ⇔ xact_id · 티켓은 언제나 ok. 조회 조건은 늘 kind='ticket' AND result='ok' AND xact_id = pg_current_xact_id().
  CONSTRAINT ops_actions_ticket_xact CHECK ((kind = 'ticket') = (xact_id IS NOT NULL)),
  CONSTRAINT ops_actions_ticket_ok CHECK (kind <> 'ticket' OR result = 'ok'),
  CONSTRAINT ops_actions_code_shape CHECK ((kind = 'failure') = (code IS NOT NULL)),
  CONSTRAINT ops_actions_ticket_shape CHECK (
    kind <> 'ticket' OR (operator_id IS NOT NULL AND session_id IS NOT NULL AND action IS NOT NULL AND organization_id IS NOT NULL))
);
CREATE INDEX ops_actions_session_idx ON ops_actions (session_id, kind, created_at);
CREATE INDEX ops_actions_kind_action_idx ON ops_actions (kind, action, created_at);
CREATE INDEX ops_actions_client_idx ON ops_actions (client_key, kind, created_at) WHERE client_key IS NOT NULL;
CREATE INDEX ops_actions_org_idx ON ops_actions (organization_id, created_at) WHERE organization_id IS NOT NULL;
CREATE INDEX ops_actions_created_idx ON ops_actions (created_at);
CREATE TRIGGER ops_actions_no_update BEFORE UPDATE ON ops_actions
  FOR EACH ROW EXECUTE FUNCTION reject_row_update();
CREATE TRIGGER ops_actions_no_delete BEFORE DELETE ON ops_actions
  FOR EACH ROW EXECUTE FUNCTION reject_row_delete();
CREATE TRIGGER ops_actions_no_truncate AFTER TRUNCATE ON ops_actions
  FOR EACH STATEMENT EXECUTE FUNCTION reject_truncate();

-- 티켓이 만든 도메인 표 변경(202609290510 의 zz_ops_record_effect 가 적는다). 트리거 안에서만 INSERT(H3). append-only.
CREATE TABLE ops_action_effects (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  action_id   bigint NOT NULL REFERENCES ops_actions (id),
  table_name  text NOT NULL CHECK (table_name IN ('organizations', 'agents', 'agent_api_keys', 'org_entitlements', 'billing_audit')),
  row_key     text NOT NULL CHECK (length(row_key) BETWEEN 1 AND 100),
  op          text NOT NULL CHECK (op IN ('INSERT', 'UPDATE')),
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ops_action_effects_action_idx ON ops_action_effects (action_id);

CREATE FUNCTION ops_action_effects_insert_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  -- 트리거(zz_ops_record_effect) 안에서의 INSERT 는 이 BEFORE 트리거에서 깊이 2 다. 직접 INSERT(소유자 포함)는 1 이다.
  IF pg_catalog.pg_trigger_depth() < 2 THEN
    RAISE EXCEPTION 'ops_action_effects rows are written only by the zz_ops_record_effect trigger' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION ops_action_effects_insert_guard() FROM PUBLIC;
CREATE TRIGGER ops_action_effects_insert_guard BEFORE INSERT ON ops_action_effects
  FOR EACH ROW EXECUTE FUNCTION ops_action_effects_insert_guard();
CREATE TRIGGER ops_action_effects_no_update BEFORE UPDATE ON ops_action_effects
  FOR EACH ROW EXECUTE FUNCTION reject_row_update();
CREATE TRIGGER ops_action_effects_no_delete BEFORE DELETE ON ops_action_effects
  FOR EACH ROW EXECUTE FUNCTION reject_row_delete();
CREATE TRIGGER ops_action_effects_no_truncate AFTER TRUNCATE ON ops_action_effects
  FOR EACH STATEMENT EXECUTE FUNCTION reject_truncate();

-- ---------------------------------------------------------------------------
-- 가드
-- ---------------------------------------------------------------------------

-- 운영자 상태 기계 · H1(session_user) · 대기 5 · 핵심 칸 불변.
CREATE FUNCTION ops_operators_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_owner boolean := pg_catalog.pg_has_role(session_user, (SELECT c.relowner FROM pg_catalog.pg_class c WHERE c.oid = TG_RELID), 'MEMBER');
  v_pending integer;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.id IS DISTINCT FROM OLD.id OR NEW.email IS DISTINCT FROM OLD.email OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
      RAISE EXCEPTION 'ops_operators: id·email·created_at are immutable' USING ERRCODE = '23514';
    END IF;
    -- H1 — CLI 출신 운영자 행은 소유자 롤 세션만 바꾼다(정의 함수 안에서도 session_user 는 호출한 롤이다).
    IF OLD.origin = 'cli' AND NOT v_owner THEN
      RAISE EXCEPTION 'ops_operators: cli operator % can only be changed by the owner role', OLD.id USING ERRCODE = '42501';
    END IF;
    IF NEW.origin IS DISTINCT FROM OLD.origin AND NOT v_owner THEN
      RAISE EXCEPTION 'ops_operators: origin is immutable' USING ERRCODE = '42501';
    END IF;
    IF NOT v_owner AND NEW.status IS DISTINCT FROM OLD.status AND NOT (
         (OLD.status = 'requested' AND NEW.status IN ('active', 'denied', 'expired'))
      OR (OLD.status = 'active' AND NEW.status = 'revoked')
      OR (OLD.status IN ('denied', 'revoked', 'expired') AND NEW.status = 'requested')) THEN
      RAISE EXCEPTION 'ops_operators: % → % is not a console transition', OLD.status, NEW.status USING ERRCODE = '23514';
    END IF;
  ELSE
    IF NEW.origin = 'cli' AND NOT v_owner THEN
      RAISE EXCEPTION 'ops_operators: only the owner role adds cli operators' USING ERRCODE = '42501';
    END IF;
    IF NOT v_owner AND NEW.status <> 'requested' THEN
      RAISE EXCEPTION 'ops_operators: the console only records requests' USING ERRCODE = '42501';
    END IF;
  END IF;
  IF NEW.status = 'requested' AND (TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM 'requested') THEN
    PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('ops_access_request', 0));
    SELECT count(*) INTO v_pending FROM public.ops_operators o WHERE o.status = 'requested' AND o.id <> NEW.id;
    IF v_pending >= 5 THEN
      RAISE EXCEPTION 'ops_operators: pending request cap' USING ERRCODE = 'AT429', DETAIL = 'rate_limited';
    END IF;
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION ops_operators_guard() FROM PUBLIC;
CREATE TRIGGER ops_operators_guard BEFORE INSERT OR UPDATE ON ops_operators
  FOR EACH ROW EXECUTE FUNCTION ops_operators_guard();
CREATE TRIGGER ops_operators_no_delete BEFORE DELETE ON ops_operators
  FOR EACH ROW EXECUTE FUNCTION reject_row_delete();
CREATE TRIGGER ops_operators_no_truncate AFTER TRUNCATE ON ops_operators
  FOR EACH STATEMENT EXECUTE FUNCTION reject_truncate();

CREATE FUNCTION ops_operators_record_event() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF TG_OP = 'INSERT' OR NEW.status IS DISTINCT FROM OLD.status THEN
    INSERT INTO public.ops_operator_events (operator_id, from_status, to_status, actor)
    VALUES (NEW.id, CASE WHEN TG_OP = 'UPDATE' THEN OLD.status END, NEW.status,
            left(coalesce(nullif(current_setting('atmark.ops_actor', true), ''), 'db:' || session_user), 200));
  END IF;
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION ops_operators_record_event() FROM PUBLIC;
CREATE TRIGGER ops_operators_record_event AFTER INSERT OR UPDATE ON ops_operators
  FOR EACH ROW EXECUTE FUNCTION ops_operators_record_event();

-- 세션 — 핵심 칸 불변 · last_seen_at 앞으로만 · 폐기 1회.
CREATE FUNCTION ops_sessions_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF NEW.last_seen_at < OLD.last_seen_at THEN
    RAISE EXCEPTION 'ops_sessions: last_seen_at only moves forward' USING ERRCODE = '23514';
  END IF;
  IF OLD.revoked_at IS NOT NULL AND (NEW.revoked_at IS DISTINCT FROM OLD.revoked_at OR NEW.revoke_reason IS DISTINCT FROM OLD.revoke_reason) THEN
    RAISE EXCEPTION 'ops_sessions: session % is already revoked', OLD.id USING ERRCODE = '23514';
  END IF;
  IF NEW.step_up_failures < OLD.step_up_failures OR NEW.step_up_failures > OLD.step_up_failures + 1 THEN
    RAISE EXCEPTION 'ops_sessions: step_up_failures only moves forward by one' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION ops_sessions_guard() FROM PUBLIC;
CREATE TRIGGER ops_sessions_immutable_core BEFORE UPDATE ON ops_sessions
  FOR EACH ROW EXECUTE FUNCTION reject_column_update_except('last_seen_at', 'client_key', 'revoked_at', 'revoke_reason', 'step_up_failures');
CREATE TRIGGER ops_sessions_guard BEFORE UPDATE ON ops_sessions
  FOR EACH ROW EXECUTE FUNCTION ops_sessions_guard();
CREATE TRIGGER ops_sessions_no_delete BEFORE DELETE ON ops_sessions
  FOR EACH ROW EXECUTE FUNCTION reject_row_delete();
CREATE TRIGGER ops_sessions_no_truncate AFTER TRUNCATE ON ops_sessions
  FOR EACH STATEMENT EXECUTE FUNCTION reject_truncate();

-- 도전 — 틀린 수 +1 씩만 · 사용·무효 1회 · 다이제스트는 한 번 쓰고 NULL 로만(쓰였거나 무효거나 5번 틀리면 비운다, H11) ·
--   다이제스트 없이는 'sent' 가 되지 않는다(적은 뒤에만 발송) · outbox 종단 불변.
CREATE FUNCTION ops_login_challenges_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF NEW.code_failures < OLD.code_failures OR NEW.code_failures > OLD.code_failures + 1 THEN
    RAISE EXCEPTION 'ops_login_challenges: code_failures only moves forward by one' USING ERRCODE = '23514';
  END IF;
  IF OLD.used_at IS NOT NULL AND NEW.used_at IS DISTINCT FROM OLD.used_at THEN
    RAISE EXCEPTION 'ops_login_challenges: challenge % is already used', OLD.id USING ERRCODE = '23514';
  END IF;
  IF OLD.invalidated_at IS NOT NULL AND NEW.invalidated_at IS DISTINCT FROM OLD.invalidated_at THEN
    RAISE EXCEPTION 'ops_login_challenges: challenge % is already invalidated', OLD.id USING ERRCODE = '23514';
  END IF;
  IF OLD.used_at IS NULL AND NEW.used_at IS NOT NULL
     AND (OLD.code_failures >= 5 OR OLD.invalidated_at IS NOT NULL OR OLD.code_digest IS NULL) THEN
    RAISE EXCEPTION 'ops_login_challenges: challenge % cannot be used', OLD.id USING ERRCODE = '23514';
  END IF;
  IF NEW.code_digest IS NOT NULL AND NEW.code_digest IS DISTINCT FROM OLD.code_digest THEN
    IF OLD.code_digest IS NOT NULL OR OLD.used_at IS NOT NULL OR OLD.invalidated_at IS NOT NULL OR OLD.code_failures >= 5
       OR OLD.status <> 'pending' THEN
      RAISE EXCEPTION 'ops_login_challenges: code_digest is written once' USING ERRCODE = '23514';
    END IF;
  END IF;
  IF NEW.used_at IS NOT NULL OR NEW.invalidated_at IS NOT NULL OR NEW.code_failures >= 5 THEN
    NEW.code_digest := NULL;
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF OLD.status <> 'pending' THEN
      RAISE EXCEPTION 'ops_login_challenges: outbox status % is terminal', OLD.status USING ERRCODE = '23514';
    END IF;
    IF NEW.status = 'sent' AND OLD.code_digest IS NULL AND NEW.code_digest IS NULL THEN
      RAISE EXCEPTION 'ops_login_challenges: a challenge is sent only after its digest is written' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION ops_login_challenges_guard() FROM PUBLIC;
CREATE TRIGGER ops_login_challenges_immutable_core BEFORE UPDATE ON ops_login_challenges
  FOR EACH ROW EXECUTE FUNCTION reject_column_update_except(
    'used_at', 'invalidated_at', 'code_failures', 'code_digest',
    'status', 'attempt_count', 'next_attempt_at', 'claimed_at', 'last_error', 'ses_message_id', 'sent_at', 'settled_at');
CREATE TRIGGER ops_login_challenges_guard BEFORE UPDATE ON ops_login_challenges
  FOR EACH ROW EXECUTE FUNCTION ops_login_challenges_guard();
CREATE TRIGGER ops_login_challenges_no_truncate AFTER TRUNCATE ON ops_login_challenges
  FOR EACH STATEMENT EXECUTE FUNCTION reject_truncate();

-- step-up 허가 — 핵심 불변 · 사용 1회(once 만).
CREATE FUNCTION ops_step_up_grants_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF OLD.used_at IS NOT NULL AND NEW.used_at IS DISTINCT FROM OLD.used_at THEN
    RAISE EXCEPTION 'ops_step_up_grants: grant % is already used', OLD.id USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION ops_step_up_grants_guard() FROM PUBLIC;
CREATE TRIGGER ops_step_up_grants_immutable_core BEFORE UPDATE ON ops_step_up_grants
  FOR EACH ROW EXECUTE FUNCTION reject_column_update_except('used_at');
CREATE TRIGGER ops_step_up_grants_guard BEFORE UPDATE ON ops_step_up_grants
  FOR EACH ROW EXECUTE FUNCTION ops_step_up_grants_guard();
CREATE TRIGGER ops_step_up_grants_no_truncate AFTER TRUNCATE ON ops_step_up_grants
  FOR EACH STATEMENT EXECUTE FUNCTION reject_truncate();

-- ---------------------------------------------------------------------------
-- ② 내부 함수(소유자만 EXECUTE — 정의 함수 안에서만 부른다)
-- ---------------------------------------------------------------------------

-- 콘솔이 열려 있다(console_enabled AND NOT hard_locked). 아니면 AT503.
CREATE FUNCTION ops_require_console_open() RETURNS void
LANGUAGE plpgsql STABLE SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.ops_settings s WHERE s.console_enabled AND NOT s.hard_locked) THEN
    RAISE EXCEPTION 'ops console is disabled' USING ERRCODE = 'AT503', DETAIL = 'ops_disabled';
  END IF;
END;
$$;

-- 코드 다이제스트 — `src/security/login-code.ts` `opsCodeDigest` 와 같은 식(단위 테스트 벡터).
CREATE FUNCTION ops_code_digest(p_challenge uuid, p_code text) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT encode(sha256(convert_to('atmark.ops-login-code.v1.digest' || chr(10) || p_challenge::text || chr(10) || p_code, 'UTF8')), 'hex')
$$;

-- 대상 참조(비밀 아님) — base32(Crockford) 4자리 = sha256(도전 id ‖ 행위 ‖ 대상)의 앞 20비트. `opsTargetRef` 와 같은 식.
CREATE FUNCTION ops_target_ref(p_challenge uuid, p_action text, p_target text) RETURNS text
LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_hash bytea := sha256(convert_to(p_challenge::text || chr(10) || p_action || chr(10) || p_target, 'UTF8'));
  v_n integer := (get_byte(v_hash, 0) << 12) | (get_byte(v_hash, 1) << 4) | (get_byte(v_hash, 2) >> 4);
  v_alphabet constant text := '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
BEGIN
  RETURN substr(v_alphabet, ((v_n >> 15) & 31) + 1, 1) || substr(v_alphabet, ((v_n >> 10) & 31) + 1, 1)
      || substr(v_alphabet, ((v_n >> 5) & 31) + 1, 1) || substr(v_alphabet, (v_n & 31) + 1, 1);
END;
$$;

-- 주소 해시(주소 실패 원장 · 하루 실패 원장의 키). 솔트는 설정 행 — 평문 주소를 적지 않는다.
CREATE FUNCTION ops_address_hash(p_email text) RETURNS text
LANGUAGE sql STABLE SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT encode(sha256(convert_to(s.failure_salt || ':' || p_email, 'UTF8')), 'hex') FROM public.ops_settings s
$$;

-- 세션 판정 — 해시 일치 · 폐기 안 됨 · 절대 8h · 유휴 30m · 운영자 active. 아니면 p_raise 면 AT401, 아니면 NULL 행. 건드리지 않는다.
CREATE FUNCTION ops_session_resolve(p_session_hash text, p_raise boolean) RETURNS public.ops_sessions
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_session public.ops_sessions%ROWTYPE;
BEGIN
  IF p_session_hash IS NOT NULL AND p_session_hash ~ '^[0-9a-f]{64}$' THEN
    SELECT s.* INTO v_session
      FROM public.ops_sessions s JOIN public.ops_operators o ON o.id = s.operator_id
     WHERE s.token_hash = p_session_hash AND s.revoked_at IS NULL AND s.expires_at > now()
       AND s.last_seen_at > now() - interval '30 minutes' AND o.status = 'active';
    IF FOUND THEN RETURN v_session; END IF;
  END IF;
  IF p_raise THEN
    RAISE EXCEPTION 'ops session is not valid' USING ERRCODE = 'AT401', DETAIL = 'session_invalid';
  END IF;
  RETURN NULL;
END;
$$;

-- 요청자 상한(15분 창) — 넘으면 AT429 rate_limited, 아니면 한 행 적는다. 요청자 잠금 아래에서 센다.
CREATE FUNCTION ops_client_attempt(p_client_key text, p_kinds text[], p_kind text, p_limit integer) RETURNS void
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_n integer;
BEGIN
  IF p_client_key IS NULL OR p_client_key !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'ops: client_key must be 64 hex' USING ERRCODE = '22023';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('ops_client:' || p_client_key, 0));
  SELECT count(*) INTO v_n FROM public.ops_login_attempts a
   WHERE a.client_key = p_client_key AND a.kind = ANY (p_kinds) AND a.created_at > now() - interval '15 minutes';
  IF v_n >= p_limit THEN
    RAISE EXCEPTION 'ops: requester rate limit' USING ERRCODE = 'AT429', DETAIL = 'rate_limited';
  END IF;
  INSERT INTO public.ops_login_attempts (client_key, kind) VALUES (p_client_key, p_kind);
END;
$$;

-- 접근 요청 기록(코드 검증 뒤에만). 결과: requested · pending · cooldown · pending_cap · already_operator.
CREATE FUNCTION ops_upsert_access_request(p_email text) RETURNS text
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_operator public.ops_operators%ROWTYPE;
  v_exists boolean;
  v_pending integer;
BEGIN
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('ops_access_request', 0));
  SELECT o.* INTO v_operator FROM public.ops_operators o WHERE o.email = p_email FOR UPDATE;
  v_exists := FOUND;
  IF v_exists THEN
    IF v_operator.status = 'active' THEN RETURN 'already_operator'; END IF;
    IF v_operator.status = 'requested' THEN RETURN 'pending'; END IF;
    -- H1 — CLI 출신 행은 콘솔이 바꾸지 못한다. 끝난 지 7일 안이면 쿨다운.
    IF v_operator.origin = 'cli' OR v_operator.updated_at > now() - interval '7 days' THEN RETURN 'cooldown'; END IF;
  END IF;
  SELECT count(*) INTO v_pending FROM public.ops_operators o WHERE o.status = 'requested';
  IF v_pending >= 5 THEN RETURN 'pending_cap'; END IF;
  PERFORM set_config('atmark.ops_actor', 'console:access_request', true);
  IF v_exists THEN
    UPDATE public.ops_operators SET status = 'requested', requested_at = now(), decided_at = NULL, decided_by = NULL
     WHERE id = v_operator.id;
  ELSE
    INSERT INTO public.ops_operators (email, status, origin, requested_at) VALUES (p_email, 'requested', 'console', now());
  END IF;
  RETURN 'requested';
END;
$$;

-- once step-up 소모 — 세션·행위·대상에 묶인 살아 있는 허가 하나. 없으면 AT403 step_up_required.
CREATE FUNCTION ops_consume_once_grant(p_session uuid, p_action text, p_org uuid, p_target_operator uuid) RETURNS void
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_grant uuid;
BEGIN
  SELECT g.id INTO v_grant FROM public.ops_step_up_grants g
   WHERE g.session_id = p_session AND g.action = p_action AND g.mode = 'once' AND g.used_at IS NULL AND g.expires_at > now()
     AND g.organization_id IS NOT DISTINCT FROM p_org AND g.target_operator_id IS NOT DISTINCT FROM p_target_operator
   ORDER BY g.created_at DESC, g.id LIMIT 1 FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ops: step-up required' USING ERRCODE = 'AT403', DETAIL = 'step_up_required';
  END IF;
  UPDATE public.ops_step_up_grants SET used_at = now() WHERE id = v_grant;
END;
$$;

REVOKE ALL ON FUNCTION ops_require_console_open() FROM PUBLIC;
REVOKE ALL ON FUNCTION ops_code_digest(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION ops_target_ref(uuid, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION ops_address_hash(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION ops_session_resolve(text, boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION ops_client_attempt(text, text[], text, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION ops_upsert_access_request(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION ops_consume_once_grant(uuid, text, uuid, uuid) FROM PUBLIC;

-- ---------------------------------------------------------------------------
-- ③ 인증 정의 함수(atmark_ops) · 메일러 정의 함수(atmark_login_mailer)
-- ---------------------------------------------------------------------------

-- 코드 요청 — 언제나 같은 모양으로 끝난다(void). 요청자 15분 10회를 넘으면 AT429. 나머지 상한은 조용하다(적지 않고 같은 결과).
CREATE FUNCTION ops_request_code(p_email text, p_binding text, p_client_key text, p_lang text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_email text := lower(btrim(coalesce(p_email, '')));
  v_now timestamptz := now();
  v_operator public.ops_operators%ROWTYPE;
  v_exists boolean;
  v_purpose text;
  v_n integer;
BEGIN
  PERFORM public.ops_require_console_open();
  IF p_binding IS NULL OR p_binding !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'ops_request_code: binding must be 64 hex' USING ERRCODE = '22023';
  END IF;
  PERFORM public.ops_client_attempt(p_client_key, ARRAY['request'], 'request', 10);
  IF p_lang IS NULL OR p_lang NOT IN ('ko', 'en') OR length(v_email) > 254 OR v_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' THEN
    RETURN;
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('ops_address:' || v_email, 0));
  -- (주소, 요청자) 시간당 3 · 주소 하루 30 · 주소 잠금 · 억제 목록.
  SELECT count(*) INTO v_n FROM public.ops_login_challenges c
   WHERE c.email = v_email AND c.client_key = p_client_key AND c.purpose <> 'step_up' AND c.created_at > v_now - interval '1 hour';
  IF v_n >= 3 THEN RETURN; END IF;
  SELECT count(*) INTO v_n FROM public.ops_login_challenges c
   WHERE c.email = v_email AND c.purpose <> 'step_up' AND c.created_at > v_now - interval '1 day';
  IF v_n >= 30 THEN RETURN; END IF;
  IF EXISTS (SELECT 1 FROM public.ops_address_failures f
              WHERE f.address_hash = public.ops_address_hash(v_email) AND f.locked_until > v_now) THEN
    RETURN;
  END IF;
  IF public.signup_email_suppressed(v_email) THEN RETURN; END IF;

  SELECT o.* INTO v_operator FROM public.ops_operators o WHERE o.email = v_email;
  v_exists := FOUND;
  IF v_exists AND v_operator.status = 'active' THEN
    v_purpose := 'login';
  ELSE
    v_purpose := 'access_request';
    -- 접근 요청 전역 시간당 5(로그인은 세지 않는다) · 대기 5 가 찼으면 새 주소는 받지 않는다(검증 뒤에도 pending_cap 이다).
    PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('ops_access_request_mail', 0));
    SELECT count(*) INTO v_n FROM public.ops_login_challenges c
     WHERE c.purpose = 'access_request' AND c.created_at > v_now - interval '1 hour';
    IF v_n >= 5 THEN RETURN; END IF;
    IF NOT v_exists AND (SELECT count(*) FROM public.ops_operators o WHERE o.status = 'requested') >= 5 THEN RETURN; END IF;
  END IF;

  INSERT INTO public.ops_login_challenges (purpose, email, operator_id, binding, client_key, lang, created_at, expires_at, next_attempt_at)
  VALUES (v_purpose, v_email, CASE WHEN v_purpose = 'login' THEN v_operator.id END, p_binding, p_client_key, p_lang,
          v_now, v_now + interval '10 minutes', v_now);
END;
$$;

-- 코드 검증 — 성공: 로그인이면 세션(outcome 'session'), 접근 요청이면 기록 결과. 실패는 이유와 무관하게 'invalid'(후보 전부 +1 · 시험한 후보마다 그 주소 +1).
--   요청자 15분 30회를 넘으면 AT429(적은 것이 없다). 실패는 RAISE 가 아니라 결과다 — 틀린 수가 커밋돼야 한다.
CREATE FUNCTION ops_login_verify(p_binding text, p_client_key text, p_code text, p_session_hash text, p_ua_hash text)
RETURNS TABLE(outcome text, operator_id uuid, session_id uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_now timestamptz := now();
  v_day date := (now() AT TIME ZONE 'UTC')::date;
  v_candidate record;
  v_ids uuid[] := ARRAY[]::uuid[];
  v_hashes text[] := ARRAY[]::text[];
  v_match record;
  v_found boolean := false;
  v_operator public.ops_operators%ROWTYPE;
  v_session uuid;
  v_hash text;
BEGIN
  PERFORM public.ops_require_console_open();
  IF p_binding IS NULL OR p_binding !~ '^[0-9a-f]{64}$' OR p_session_hash IS NULL OR p_session_hash !~ '^[0-9a-f]{64}$'
     OR p_ua_hash IS NULL OR p_ua_hash !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'ops_login_verify: binding·session·ua must be 64 hex' USING ERRCODE = '22023';
  END IF;
  PERFORM public.ops_client_attempt(p_client_key, ARRAY['verify', 'stepup_verify'], 'verify', 30);
  IF p_code IS NULL OR p_code !~ '^[0-9]{6}$' THEN
    RETURN QUERY SELECT 'invalid'::text, NULL::uuid, NULL::uuid;
    RETURN;
  END IF;

  FOR v_candidate IN
    SELECT c.id, c.purpose, c.email, c.operator_id, c.code_digest, public.ops_address_hash(c.email) AS address_hash
      FROM public.ops_login_challenges c
     WHERE c.binding = p_binding AND c.purpose IN ('login', 'access_request')
       AND c.used_at IS NULL AND c.invalidated_at IS NULL AND c.expires_at > v_now AND c.status = 'sent'
       AND c.code_failures < 5 AND c.code_digest IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM public.ops_address_failures f
                        WHERE f.address_hash = public.ops_address_hash(c.email) AND f.locked_until > v_now)
       AND (SELECT count(*) FROM public.ops_login_attempts a
             WHERE a.kind = 'verify_failure' AND a.client_key = p_client_key
               AND a.address_hash = public.ops_address_hash(c.email) AND a.created_at > v_now - interval '1 day') < 20
     ORDER BY c.created_at DESC, c.id
     LIMIT 10
     FOR UPDATE OF c
  LOOP
    v_ids := v_ids || v_candidate.id;
    -- 시험한 후보마다 그 주소에 실패 하나(중복 제거 없음 — 한 결속에 같은 주소의 도전 10개를 쌓아도 한 번에 10 이 든다, 보안 검토 L3).
    v_hashes := v_hashes || v_candidate.address_hash;
    IF NOT v_found AND v_candidate.code_digest = public.ops_code_digest(v_candidate.id, p_code) THEN
      v_found := true;
      v_match := v_candidate;
    END IF;
  END LOOP;

  IF v_found THEN
    UPDATE public.ops_login_challenges SET used_at = v_now WHERE id = v_match.id;
    IF v_match.purpose = 'login' THEN
      SELECT o.* INTO v_operator FROM public.ops_operators o WHERE o.id = v_match.operator_id FOR SHARE;
      IF NOT FOUND OR v_operator.status <> 'active' THEN
        RETURN QUERY SELECT 'invalid'::text, NULL::uuid, NULL::uuid;
        RETURN;
      END IF;
      INSERT INTO public.ops_sessions (operator_id, token_hash, ua_hash, client_key, created_at, expires_at, last_seen_at)
      VALUES (v_operator.id, p_session_hash, p_ua_hash, p_client_key, v_now, v_now + interval '8 hours', v_now)
      RETURNING id INTO v_session;
      INSERT INTO public.ops_actions (kind, result, operator_id, session_id)
      VALUES ('session_event', 'login', v_operator.id, v_session);
      RETURN QUERY SELECT 'session'::text, v_operator.id, v_session;
      RETURN;
    END IF;
    RETURN QUERY SELECT public.ops_upsert_access_request(v_match.email), NULL::uuid, NULL::uuid;
    RETURN;
  END IF;

  IF array_length(v_ids, 1) IS NOT NULL THEN
    UPDATE public.ops_login_challenges SET code_failures = code_failures + 1 WHERE id = ANY (v_ids);
    FOREACH v_hash IN ARRAY v_hashes LOOP
      INSERT INTO public.ops_login_attempts (client_key, kind, address_hash) VALUES (p_client_key, 'verify_failure', v_hash);
      INSERT INTO public.ops_address_failures AS f (address_hash, day, failures, locked_until)
      VALUES (v_hash, v_day, 1, NULL)
      ON CONFLICT (address_hash, day) DO UPDATE
         SET failures = f.failures + 1,
             locked_until = CASE WHEN f.failures + 1 >= 50 AND (f.locked_until IS NULL OR f.locked_until <= v_now)
                                 THEN v_now + interval '24 hours' ELSE f.locked_until END;
    END LOOP;
  END IF;
  RETURN QUERY SELECT 'invalid'::text, NULL::uuid, NULL::uuid;
END;
$$;

-- 세션 확인 — 모든 인증 요청의 첫 문장. 살아 있으면 한 행(운영자 · 세션 · 주소 · 만료)을 돌려주고 last_seen_at 을 민다.
--   무효(없음·폐기·만료·유휴·운영자 비활성)면 **빈 결과**다(λ 는 401). UA 가 바뀌면 그 자리에서 폐기하고 빈 결과. IP 가 바뀌면 기록만.
CREATE FUNCTION ops_session_touch(p_session_hash text, p_ua_hash text, p_client_key text)
RETURNS TABLE(operator_id uuid, session_id uuid, email text, expires_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_session public.ops_sessions%ROWTYPE;
  v_email text;
BEGIN
  PERFORM public.ops_require_console_open();
  IF p_ua_hash IS NULL OR p_ua_hash !~ '^[0-9a-f]{64}$' OR p_client_key IS NULL OR p_client_key !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'ops_session_touch: ua·client must be 64 hex' USING ERRCODE = '22023';
  END IF;
  v_session := public.ops_session_resolve(p_session_hash, false);
  IF v_session.id IS NULL THEN RETURN; END IF;
  SELECT s.* INTO v_session FROM public.ops_sessions s WHERE s.id = v_session.id FOR UPDATE;
  IF v_session.ua_hash <> p_ua_hash THEN
    UPDATE public.ops_sessions SET revoked_at = now(), revoke_reason = 'ua_changed' WHERE id = v_session.id;
    INSERT INTO public.ops_actions (kind, result, operator_id, session_id, client_key)
    VALUES ('session_event', 'ua_changed', v_session.operator_id, v_session.id, p_client_key);
    RETURN;
  END IF;
  IF v_session.client_key <> p_client_key THEN
    INSERT INTO public.ops_actions (kind, result, operator_id, session_id, client_key)
    VALUES ('session_event', 'ip_changed', v_session.operator_id, v_session.id, p_client_key);
  END IF;
  UPDATE public.ops_sessions SET last_seen_at = greatest(last_seen_at, now()), client_key = p_client_key WHERE id = v_session.id;
  SELECT o.email INTO v_email FROM public.ops_operators o WHERE o.id = v_session.operator_id;
  RETURN QUERY SELECT v_session.operator_id, v_session.id, v_email, v_session.expires_at;
END;
$$;

-- 로그아웃 — 이 세션(또는 p_all 이면 그 운영자의 모든 세션, 이 세션이 살아 있을 때만). 폐기한 수.
CREATE FUNCTION ops_session_revoke(p_session_hash text, p_all boolean) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_session public.ops_sessions%ROWTYPE;
  v_n integer;
BEGIN
  IF p_session_hash IS NULL OR p_session_hash !~ '^[0-9a-f]{64}$' THEN RETURN 0; END IF;
  IF coalesce(p_all, false) THEN
    v_session := public.ops_session_resolve(p_session_hash, false);
    IF v_session.id IS NULL THEN RETURN 0; END IF;
    UPDATE public.ops_sessions SET revoked_at = now(), revoke_reason = 'logout_all'
     WHERE operator_id = v_session.operator_id AND revoked_at IS NULL;
  ELSE
    SELECT s.* INTO v_session FROM public.ops_sessions s WHERE s.token_hash = p_session_hash;
    IF NOT FOUND THEN RETURN 0; END IF;
    UPDATE public.ops_sessions SET revoked_at = now(), revoke_reason = 'logout' WHERE id = v_session.id AND revoked_at IS NULL;
  END IF;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n > 0 THEN
    INSERT INTO public.ops_actions (kind, result, operator_id, session_id)
    VALUES ('session_event', CASE WHEN coalesce(p_all, false) THEN 'logout_all' ELSE 'logout' END, v_session.operator_id, v_session.id);
  END IF;
  RETURN v_n;
END;
$$;

-- step-up 코드 요청 — 행위와 대상에 묶인 도전 하나(메일은 login-mailer). 대상 참조를 돌려준다(화면과 메일에 같은 값).
CREATE FUNCTION ops_request_stepup(p_session_hash text, p_client_key text, p_action text, p_org uuid, p_target_operator uuid)
RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_session public.ops_sessions%ROWTYPE;
  v_email text;
  v_id uuid := gen_random_uuid();
  v_ref text;
  v_n integer;
  v_now timestamptz := now();
BEGIN
  PERFORM public.ops_require_console_open();
  v_session := public.ops_session_resolve(p_session_hash, true);
  IF p_action IN ('org.activate', 'org.reject') THEN
    IF p_org IS NULL OR p_target_operator IS NOT NULL THEN
      RAISE EXCEPTION 'ops_request_stepup: organization actions take an organization' USING ERRCODE = 'AT403', DETAIL = 'forbidden';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.organizations o WHERE o.id = p_org) THEN
      RAISE EXCEPTION 'organization not found' USING ERRCODE = 'AT404', DETAIL = 'organization_not_found';
    END IF;
  ELSIF p_action IN ('operator.approve', 'operator.deny', 'operator.revoke') THEN
    IF p_target_operator IS NULL OR p_org IS NOT NULL THEN
      RAISE EXCEPTION 'ops_request_stepup: operator actions take an operator' USING ERRCODE = 'AT403', DETAIL = 'forbidden';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.ops_operators o WHERE o.id = p_target_operator) THEN
      RAISE EXCEPTION 'operator not found' USING ERRCODE = 'AT404', DETAIL = 'operator_not_found';
    END IF;
  ELSE
    -- step-up 이 없는 행위(P2 안전 방향)이거나 모르는 행위.
    RAISE EXCEPTION 'ops_request_stepup: no step-up for this action' USING ERRCODE = 'AT403', DETAIL = 'forbidden';
  END IF;
  PERFORM public.ops_client_attempt(p_client_key, ARRAY['stepup_request'], 'stepup_request', 10);
  SELECT count(*) INTO v_n FROM public.ops_login_challenges c
   WHERE c.session_id = v_session.id AND c.created_at > v_now - interval '15 minutes';
  IF v_n >= 10 THEN
    RAISE EXCEPTION 'ops: step-up request rate limit' USING ERRCODE = 'AT429', DETAIL = 'rate_limited';
  END IF;
  SELECT o.email INTO v_email FROM public.ops_operators o WHERE o.id = v_session.operator_id;
  v_ref := public.ops_target_ref(v_id, p_action, coalesce(p_org::text, p_target_operator::text));
  INSERT INTO public.ops_login_challenges (id, purpose, email, operator_id, session_id, action, organization_id, target_operator_id,
                                           target_ref, client_key, created_at, expires_at, next_attempt_at)
  VALUES (v_id, 'step_up', v_email, v_session.operator_id, v_session.id, p_action, p_org, p_target_operator,
          v_ref, p_client_key, v_now, v_now + interval '10 minutes', v_now);
  RETURN v_ref;
END;
$$;

-- step-up 코드 검증 — 이 세션의 **가장 최근** 살아 있는 step-up 도전 하나만 대조한다(여러 도전으로 한 번에 여러 코드를 시험하지 못한다 — 보안 검토 L2).
--   성공하면 허가(once: 대상에 묶인 1회용 · window: (행위, 조직) 10분)를 만든다. 틀리면 그 도전 +1 · 세션 `step_up_failures` +1 — 10 이 되면
--   그 자리에서 세션을 폐기한다(`revoke_reason = 'step_up_failures'`, 결과는 'invalid' · 다음 호출부터 AT401). 후보가 없으면 세지 않는다(시험한 것이 없다).
CREATE FUNCTION ops_stepup_verify(p_session_hash text, p_client_key text, p_code text)
RETURNS TABLE(outcome text, action text, target_ref text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_session public.ops_sessions%ROWTYPE;
  v_candidate record;
  v_now timestamptz := now();
BEGIN
  PERFORM public.ops_require_console_open();
  v_session := public.ops_session_resolve(p_session_hash, true);
  PERFORM public.ops_client_attempt(p_client_key, ARRAY['verify', 'stepup_verify'], 'stepup_verify', 30);
  IF p_code IS NULL OR p_code !~ '^[0-9]{6}$' THEN
    RETURN QUERY SELECT 'invalid'::text, NULL::text, NULL::text;
    RETURN;
  END IF;
  -- 세션 행을 잠근 뒤 다시 본다 — 동시 호출이 방금 폐기했으면(10번째 실패 · 로그아웃) 더 시험하지 않는다.
  SELECT s.* INTO v_session FROM public.ops_sessions s WHERE s.id = v_session.id FOR UPDATE;
  IF v_session.revoked_at IS NOT NULL THEN
    RAISE EXCEPTION 'ops session is not valid' USING ERRCODE = 'AT401', DETAIL = 'session_invalid';
  END IF;
  SELECT c.id, c.action, c.organization_id, c.target_operator_id, c.target_ref, c.code_digest INTO v_candidate
    FROM public.ops_login_challenges c
   WHERE c.session_id = v_session.id AND c.purpose = 'step_up'
     AND c.used_at IS NULL AND c.invalidated_at IS NULL AND c.expires_at > v_now AND c.status = 'sent'
     AND c.code_failures < 5 AND c.code_digest IS NOT NULL
   ORDER BY c.created_at DESC, c.id DESC
   LIMIT 1
   FOR UPDATE OF c;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'invalid'::text, NULL::text, NULL::text;
    RETURN;
  END IF;
  IF v_candidate.code_digest = public.ops_code_digest(v_candidate.id, p_code) THEN
    UPDATE public.ops_login_challenges SET used_at = v_now WHERE id = v_candidate.id;
    INSERT INTO public.ops_step_up_grants (session_id, action, organization_id, target_operator_id, target_ref, mode, created_at, expires_at)
    VALUES (v_session.id, v_candidate.action, v_candidate.organization_id, v_candidate.target_operator_id, v_candidate.target_ref,
            CASE WHEN v_candidate.action = 'org.activate' THEN 'window' ELSE 'once' END, v_now, v_now + interval '10 minutes');
    RETURN QUERY SELECT 'ok'::text, v_candidate.action::text, v_candidate.target_ref::text;
    RETURN;
  END IF;
  UPDATE public.ops_login_challenges SET code_failures = code_failures + 1 WHERE id = v_candidate.id;
  IF v_session.step_up_failures + 1 >= 10 THEN
    UPDATE public.ops_sessions
       SET step_up_failures = v_session.step_up_failures + 1, revoked_at = v_now, revoke_reason = 'step_up_failures'
     WHERE id = v_session.id;
    UPDATE public.ops_login_challenges SET invalidated_at = v_now
     WHERE session_id = v_session.id AND used_at IS NULL AND invalidated_at IS NULL;
    INSERT INTO public.ops_actions (kind, result, operator_id, session_id, client_key)
    VALUES ('session_event', 'step_up_failures', v_session.operator_id, v_session.id, p_client_key);
  ELSE
    UPDATE public.ops_sessions SET step_up_failures = v_session.step_up_failures + 1 WHERE id = v_session.id;
  END IF;
  RETURN QUERY SELECT 'invalid'::text, NULL::text, NULL::text;
END;
$$;

-- 접근 요청 승인·거절 — 호출자 active · 대상에 묶인 once step-up 소모 · 대상 requested · 자기 결정 금지. 결과 'ok'(거부는 AT4xx + DETAIL).
CREATE FUNCTION ops_decide_request(p_session_hash text, p_operator_id uuid, p_decision text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_session public.ops_sessions%ROWTYPE;
  v_target public.ops_operators%ROWTYPE;
BEGIN
  PERFORM public.ops_require_console_open();
  v_session := public.ops_session_resolve(p_session_hash, true);
  IF p_decision IS NULL OR p_decision NOT IN ('approve', 'deny') THEN
    RAISE EXCEPTION 'ops_decide_request: decision is approve | deny' USING ERRCODE = 'AT409', DETAIL = 'invalid_transition';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('ops_operator_roster', 0));
  SELECT o.* INTO v_target FROM public.ops_operators o WHERE o.id = p_operator_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'operator not found' USING ERRCODE = 'AT404', DETAIL = 'operator_not_found';
  END IF;
  IF v_target.id = v_session.operator_id THEN
    RAISE EXCEPTION 'ops: an operator cannot decide on itself' USING ERRCODE = 'AT403', DETAIL = 'self_decision';
  END IF;
  -- H1 — CLI 출신 행은 콘솔이 결정하지 못한다(폐기와 같은 앞 검사 · 가드의 42501 보다 먼저 계약 코드로).
  IF v_target.origin = 'cli' THEN
    RAISE EXCEPTION 'ops: cli operators are decided only with the CLI' USING ERRCODE = 'AT403', DETAIL = 'cli_operator';
  END IF;
  IF v_target.status <> 'requested' THEN
    RAISE EXCEPTION 'ops: operator is not requested' USING ERRCODE = 'AT409', DETAIL = 'not_requested';
  END IF;
  PERFORM public.ops_consume_once_grant(v_session.id, 'operator.' || p_decision, NULL, v_target.id);
  PERFORM set_config('atmark.ops_actor', 'ops:' || v_session.operator_id::text, true);
  UPDATE public.ops_operators
     SET status = CASE WHEN p_decision = 'approve' THEN 'active' ELSE 'denied' END, decided_by = v_session.operator_id, decided_at = now()
   WHERE id = v_target.id;
  INSERT INTO public.ops_actions (kind, result, operator_id, session_id, action, target_operator_id)
  VALUES ('operator_event', 'ok', v_session.operator_id, v_session.id, 'operator.' || p_decision, v_target.id);
  RETURN 'ok';
END;
$$;

-- 운영자 폐기 — once step-up · 대상 origin=console(H1) · 마지막 active 운영자 불가 · 자기 자신 가능. 같은 트랜잭션에서 대상의 세션·도전 무효.
CREATE FUNCTION ops_revoke_operator(p_session_hash text, p_operator_id uuid) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_session public.ops_sessions%ROWTYPE;
  v_target public.ops_operators%ROWTYPE;
BEGIN
  PERFORM public.ops_require_console_open();
  v_session := public.ops_session_resolve(p_session_hash, true);
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('ops_operator_roster', 0));
  SELECT o.* INTO v_target FROM public.ops_operators o WHERE o.id = p_operator_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'operator not found' USING ERRCODE = 'AT404', DETAIL = 'operator_not_found';
  END IF;
  IF v_target.origin = 'cli' THEN
    RAISE EXCEPTION 'ops: cli operators are revoked only with the CLI' USING ERRCODE = 'AT403', DETAIL = 'cli_operator';
  END IF;
  IF v_target.status <> 'active' THEN
    RAISE EXCEPTION 'ops: operator is not active' USING ERRCODE = 'AT409', DETAIL = 'invalid_transition';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.ops_operators o WHERE o.status = 'active' AND o.id <> v_target.id) THEN
    RAISE EXCEPTION 'ops: the last operator cannot be revoked' USING ERRCODE = 'AT403', DETAIL = 'last_operator';
  END IF;
  PERFORM public.ops_consume_once_grant(v_session.id, 'operator.revoke', NULL, v_target.id);
  PERFORM set_config('atmark.ops_actor', 'ops:' || v_session.operator_id::text, true);
  UPDATE public.ops_operators SET status = 'revoked', decided_by = v_session.operator_id, decided_at = now() WHERE id = v_target.id;
  UPDATE public.ops_sessions SET revoked_at = now(), revoke_reason = 'operator_revoked'
   WHERE operator_id = v_target.id AND revoked_at IS NULL;
  UPDATE public.ops_login_challenges SET invalidated_at = now()
   WHERE (operator_id = v_target.id OR email = v_target.email) AND used_at IS NULL AND invalidated_at IS NULL;
  INSERT INTO public.ops_actions (kind, result, operator_id, session_id, action, target_operator_id)
  VALUES ('operator_event', 'ok', v_session.operator_id, v_session.id, 'operator.revoke', v_target.id);
  RETURN 'ok';
END;
$$;

-- 메일러 — 다이제스트를 한 번 적는다. 같은 값이면 'ok'(재시도 · 같은 키) · 다른 값이면 그 도전을 dead 로 닫고 'dead'(키 회전 — 예외 없음) ·
--   이미 쓰였거나 무효·종단이면 'dead'. 메일러는 'ok' 일 때만 보낸다.
CREATE FUNCTION ops_mailer_set_digest(p_challenge uuid, p_digest text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_challenge public.ops_login_challenges%ROWTYPE;
BEGIN
  IF p_digest IS NULL OR p_digest !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'ops_mailer_set_digest: digest must be 64 hex' USING ERRCODE = '22023';
  END IF;
  SELECT c.* INTO v_challenge FROM public.ops_login_challenges c WHERE c.id = p_challenge FOR UPDATE;
  IF NOT FOUND OR v_challenge.status <> 'pending' THEN RETURN 'dead'; END IF;
  IF v_challenge.used_at IS NOT NULL OR v_challenge.invalidated_at IS NOT NULL OR v_challenge.code_failures >= 5
     OR v_challenge.expires_at <= now() THEN
    UPDATE public.ops_login_challenges SET status = 'obsolete', settled_at = now(), last_error = 'challenge_closed' WHERE id = p_challenge;
    RETURN 'dead';
  END IF;
  IF v_challenge.code_digest IS NULL THEN
    UPDATE public.ops_login_challenges SET code_digest = p_digest WHERE id = p_challenge;
    RETURN 'ok';
  END IF;
  IF v_challenge.code_digest = p_digest THEN RETURN 'ok'; END IF;
  UPDATE public.ops_login_challenges SET status = 'dead', settled_at = now(), last_error = 'key_rotated', code_digest = NULL
   WHERE id = p_challenge;
  RETURN 'dead';
END;
$$;

-- ---------------------------------------------------------------------------
-- 앱 롤(TTL 스위퍼 approval-expiry) — 보존 · 만료 · census. 인자 없음.
-- ---------------------------------------------------------------------------

CREATE FUNCTION purge_ops_login_records() RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_total integer := 0;
  v_n integer;
BEGIN
  DELETE FROM public.ops_step_up_grants g
   WHERE g.id IN (SELECT o.id FROM public.ops_step_up_grants o WHERE o.created_at < now() - interval '1 day' ORDER BY o.created_at LIMIT 10000);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_total := v_total + v_n;
  DELETE FROM public.ops_login_challenges c
   WHERE c.id IN (SELECT o.id FROM public.ops_login_challenges o WHERE o.created_at < now() - interval '1 day' ORDER BY o.created_at LIMIT 10000);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_total := v_total + v_n;
  DELETE FROM public.ops_login_attempts a
   WHERE a.id IN (SELECT o.id FROM public.ops_login_attempts o WHERE o.created_at < now() - interval '1 day' ORDER BY o.created_at LIMIT 10000);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_total := v_total + v_n;
  DELETE FROM public.ops_address_failures f
   WHERE f.day < (now() AT TIME ZONE 'UTC')::date - 30 AND (f.locked_until IS NULL OR f.locked_until <= now());
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_total + v_n;
END;
$$;

CREATE FUNCTION expire_ops_requests() RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_n integer;
BEGIN
  PERFORM set_config('atmark.ops_actor', 'system:expiry', true);
  UPDATE public.ops_operators SET status = 'expired'
   WHERE status = 'requested' AND requested_at < now() - interval '7 days';
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END;
$$;

CREATE FUNCTION ops_operator_census() RETURNS TABLE(active int, pending int, addresses_failing_today int, addresses_locked int)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT (SELECT count(*)::int FROM public.ops_operators o WHERE o.status = 'active'),
         (SELECT count(*)::int FROM public.ops_operators o WHERE o.status = 'requested'),
         (SELECT count(DISTINCT f.address_hash)::int FROM public.ops_address_failures f
           WHERE f.day = (now() AT TIME ZONE 'UTC')::date AND f.failures > 0),
         (SELECT count(DISTINCT f.address_hash)::int FROM public.ops_address_failures f WHERE f.locked_until > now())
$$;

-- ---------------------------------------------------------------------------
-- ⑤ 권한
-- ---------------------------------------------------------------------------

REVOKE ALL ON ops_settings, ops_operators, ops_operator_events, ops_sessions, ops_login_challenges, ops_login_attempts,
              ops_address_failures, ops_step_up_grants, ops_actions, ops_action_effects FROM PUBLIC;

REVOKE ALL ON FUNCTION ops_request_code(text, text, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION ops_login_verify(text, text, text, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION ops_session_touch(text, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION ops_session_revoke(text, boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION ops_request_stepup(text, text, text, uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION ops_stepup_verify(text, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION ops_decide_request(text, uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION ops_revoke_operator(text, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION ops_mailer_set_digest(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION purge_ops_login_records() FROM PUBLIC;
REVOKE ALL ON FUNCTION expire_ops_requests() FROM PUBLIC;
REVOKE ALL ON FUNCTION ops_operator_census() FROM PUBLIC;

GRANT USAGE ON SCHEMA public TO atmark_ops;
GRANT EXECUTE ON FUNCTION ops_request_code(text, text, text, text) TO atmark_ops;
GRANT EXECUTE ON FUNCTION ops_login_verify(text, text, text, text, text) TO atmark_ops;
GRANT EXECUTE ON FUNCTION ops_session_touch(text, text, text) TO atmark_ops;
GRANT EXECUTE ON FUNCTION ops_session_revoke(text, boolean) TO atmark_ops;
GRANT EXECUTE ON FUNCTION ops_request_stepup(text, text, text, uuid, uuid) TO atmark_ops;
GRANT EXECUTE ON FUNCTION ops_stepup_verify(text, text, text) TO atmark_ops;
GRANT EXECUTE ON FUNCTION ops_decide_request(text, uuid, text) TO atmark_ops;
GRANT EXECUTE ON FUNCTION ops_revoke_operator(text, uuid) TO atmark_ops;

-- 읽기 — ops 표. 호스팅 읽기(`src/ops/console/reads.ts` 감사 · `src/ops/hosted/backend.ts` 운영자 탭)가 보내는 칸만 — 세션·설정·사건 원장 ·
--   토큰 해시 · UA 해시 · 요청자 키 · 다이제스트 · 결속 · 솔트는 0. 세션 확인은 정의 함수(ops_session_touch)로만.
GRANT SELECT (id, email, status, origin, requested_at, decided_at, created_at) ON ops_operators TO atmark_ops;
GRANT SELECT (id, kind, result, operator_id, action, organization_id, agent_id, target_operator_id, code, created_at) ON ops_actions TO atmark_ops;
GRANT SELECT (action_id, table_name, op) ON ops_action_effects TO atmark_ops;

-- 읽기 — 도메인 표(공유 코어 `src/ops/console/api.ts` · `src/ops/core/review.ts` · `src/admin/ops/{agents,plan}.ts` 가 보내는 SELECT 의 칸).
--   토큰 해시(에이전트·조직 키·세션) · 키쌍 비공개 부분 · 메시지 본문 · 수신 원문은 0. 쓰기 GRANT 0.
GRANT SELECT (id, name, owner_email, review_status, signup_source, reviewed_at, abuse_freeze, owner_paused, billing_status,
              sending_started_at, created_at, updated_at) ON organizations TO atmark_ops;
GRANT SELECT (id, organization_id, name, status, suspended_by, created_at, updated_at) ON agents TO atmark_ops;
GRANT SELECT (agent_id, address, is_primary, retired_at) ON agent_addresses TO atmark_ops;
GRANT SELECT (agent_id, revoked_at, expires_at, last_used_at) ON agent_api_keys TO atmark_ops;
GRANT SELECT (agent_id, status, superseded_at) ON passports TO atmark_ops;
GRANT SELECT (agent_id, public_key) ON agent_keypairs TO atmark_ops;
GRANT SELECT (agent_id, current_version) ON agent_policies TO atmark_ops;
GRANT SELECT (agent_id, version, outbound_mode, inbound_mode) ON policy_versions TO atmark_ops;
-- 요금제 행 — `ORG_ENTITLEMENTS_COLUMNS` 가 to_jsonb(행)을 읽는다(표 단위 SELECT 필요). 금액·고객 id 는 이 표에 없다.
GRANT SELECT ON org_entitlements TO atmark_ops;
GRANT SELECT (id, organization_id, label, revoked_at, expires_at) ON org_api_keys TO atmark_ops;
GRANT SELECT (id, organization_id, user_id, role, joined_via, created_at, removed_at) ON memberships TO atmark_ops;
GRANT SELECT (id, email) ON users TO atmark_ops;
GRANT SELECT (organization_id, environment, status, plan_code, current_period_end, scheduled_change_action, scheduled_change_at,
              past_due_since, synced_at) ON billing_subscriptions TO atmark_ops;
GRANT SELECT (id, organization_id, from_plan, to_plan, cause, actor, note, entitlement_version, created_at) ON billing_audit TO atmark_ops;
GRANT SELECT (id, organization_id, session_id, org_api_key_id, action, target_id, created_at) ON owner_actions TO atmark_ops;
GRANT SELECT (id, user_id) ON owner_sessions TO atmark_ops;
GRANT SELECT (agent_id, created_at, direction, status, recipient_count, sent_at) ON messages TO atmark_ops;

-- login-mailer — 도전 outbox 칸 · 수신자는 보내는 순간 운영자 표에서(로그인·step-up) 또는 도전의 주소(접근 요청). 결속·요청자 키·다이제스트 0.
GRANT SELECT (id, purpose, email, operator_id, action, organization_id, target_operator_id, target_ref, lang, created_at, expires_at,
              used_at, invalidated_at, status, attempt_count, next_attempt_at, claimed_at) ON ops_login_challenges TO atmark_login_mailer;
GRANT UPDATE (status, attempt_count, next_attempt_at, claimed_at, last_error, ses_message_id, sent_at, settled_at)
  ON ops_login_challenges TO atmark_login_mailer;
GRANT SELECT (id, email, status) ON ops_operators TO atmark_login_mailer;
GRANT EXECUTE ON FUNCTION ops_mailer_set_digest(uuid, text) TO atmark_login_mailer;

-- 앱 롤 — 함수 셋만(I-6). 표 권한 0.
GRANT EXECUTE ON FUNCTION purge_ops_login_records() TO atmark_app;
GRANT EXECUTE ON FUNCTION expire_ops_requests() TO atmark_app;
GRANT EXECUTE ON FUNCTION ops_operator_census() TO atmark_app;
