-- 202610131201_policy_change_requests.sql
-- 에이전트의 정책 변경 요청 · 소유자 승인(진윤겸 2026-10-13 결정 A — ADR-0007 2026-10-13 개정).
--
--   에이전트(토큰 권한 `policy:request`, 202610131200)가 **자기** 정책의 좁은 변경 하나를 이유와 함께 요청한다 — 목록 항목 더하기 · 빼기(발신 · 수신 ×
--   허용 · 차단)와 모드 바꾸기(발신 · 수신 × 전체 · 허용 목록 · 차단 목록 · 전부 X). 요청은 **아무것도 바꾸지 않는다** — 소유자가 콘솔에서 승인하면
--   소유자 행위(관리 연산 `admin/ops/rules.ts` · `policy.ts` 와 같은 길 · 감사 1행 `agent.policy_request.approve` · 새 정책 버전)로서 바뀐다.
--   요청할 수 없는 것(긴급 정지 · 위험 보류 · 발신 승인 · 신뢰 발신자 · 토큰 · 권한 · 웹훅 · 자가 등록 · 한도)은 이 표에 칸이 없다.
--
--   ① 표 `policy_change_requests` — append-only(지우기 · 비우기 금지) · 결정 칸만 한 번(pending → approved | rejected | stale | expired).
--   ② 만들기는 정의자 `atmark_policy_request_create` 하나(앱 롤 — 표 INSERT 0). DB 가 다시 본다: 토큰이 그 에이전트의 살아 있는 `policy:request` 토큰 ·
--      에이전트 active · 같은 변경의 pending 이 있으면 재생(replayed) · 에이전트당 24시간 20건 · pending 5건 · 이미 그런 상태인 변경(보이는 목록 · 모드만 —
--      차단 목록 내용은 에이전트에게 감춘다, ADR-0007 "에이전트 표면") · 발신 허용에 자기 주소. 오염 맥락(ADR-0016 — 위험 표시 메일을 4시간 안에 읽었다)을
--      요청 행에 **고정**한다(`tainted` · `last_risk_exposure_at` — 예약의 `risk_tainted` 와 같은 결: 요청자가 주장하지 않고 DB 가 적는다).
--   ③ 알림 — 감시 알림 기계(`quarantine_notices`, 2분 · 15분 창 · 조직 소유자 · at-most-once)에 종류 `policy_request` 를 더한다. 본문에 에이전트가 쓴
--      글자(이유 · 값)는 싣지 않는다(ADR-0016 "에이전트가 만든 문자열을 경고 문구에 넣지 않는다") — 수와 콘솔 링크만.
--   ④ 만료 7일 — 만들기 함수가 그 에이전트의 지난 pending 을 expired 로 닫고, 콘솔 · 조회는 지난 pending 을 expired 로 읽는다(스위퍼 없음).
--
-- 잠금: 새 표 하나 · `quarantine_notices` CHECK 교체 NOT VALID · 함수 교체(`atmark_watch_notice_slot`). 5초. VALIDATE 는 1202.
-- **순서:** 터널 migrate(1200~1202) → `deploy-compute migrate=false`. expand-only — 옛 코드는 새 표 · 종류를 쓰지 않는다.

SET LOCAL lock_timeout = '5s';

DO $$
DECLARE
  missing text;
BEGIN
  SELECT string_agg(name, ', ') INTO missing
    FROM unnest(ARRAY['atmark_admin', 'atmark_app']) AS name
   WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = name);
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION 'role % does not exist — migrate 핸들러의 bootstrap-roles 를 먼저 돌려라', missing;
  END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- ③(먼저) 알림 창 종류 하나 + 창 잡기 함수가 그 종류를 받는다
-- ---------------------------------------------------------------------------

ALTER TABLE quarantine_notices
  DROP CONSTRAINT quarantine_notices_kind_check,
  ADD CONSTRAINT quarantine_notices_kind_check CHECK (kind IN ('block', 'risk', 'signup', 'enroll', 'policy_request')) NOT VALID;

-- 202610081101 의 정의 그대로 + 종류 `policy_request`. 에이전트 잠금을 **기다리지 않는다** — 못 잡으면 NULL(이번 한 건은 세지 않는다).
CREATE OR REPLACE FUNCTION atmark_watch_notice_slot(p_agent_id bpchar, p_organization_id uuid, p_kind text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  notice uuid;
  previous timestamptz;
BEGIN
  IF p_kind NOT IN ('signup', 'enroll', 'policy_request') THEN
    RAISE EXCEPTION 'atmark_watch_notice_slot: 정보 알림 종류만(signup | enroll | policy_request)' USING ERRCODE = '22023';
  END IF;
  IF NOT pg_catalog.pg_try_advisory_xact_lock(pg_catalog.hashtextextended('quarantine_notice:' || p_agent_id::text, 0)) THEN
    RETURN NULL;
  END IF;
  SELECT n.id INTO notice FROM public.quarantine_notices n
   WHERE n.agent_id = p_agent_id AND n.kind = p_kind AND n.status = 'pending' AND n.claimed_at IS NULL
   FOR UPDATE;
  IF notice IS NULL THEN
    SELECT max(n.claimed_at) INTO previous FROM public.quarantine_notices n
     WHERE n.agent_id = p_agent_id AND n.kind = p_kind AND n.claimed_at IS NOT NULL;
    INSERT INTO public.quarantine_notices (agent_id, organization_id, kind, next_attempt_at)
    VALUES (p_agent_id, p_organization_id, p_kind,
            GREATEST(pg_catalog.now() + interval '2 minutes', coalesce(previous + interval '15 minutes', '-infinity'::timestamptz)))
    RETURNING id INTO notice;
  END IF;
  UPDATE public.quarantine_notices SET message_count = message_count + 1, last_at = GREATEST(last_at, pg_catalog.now()) WHERE id = notice;
  RETURN notice;
END;
$$;

REVOKE ALL ON FUNCTION atmark_watch_notice_slot(bpchar, uuid, text) FROM PUBLIC;

-- ---------------------------------------------------------------------------
-- ① 요청 표
-- ---------------------------------------------------------------------------

CREATE TABLE policy_change_requests (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id               character(32) NOT NULL REFERENCES agents (id) ON DELETE RESTRICT,
  organization_id        uuid NOT NULL REFERENCES organizations (id) ON DELETE RESTRICT,
  -- 요청을 만든 토큰(`policy:request` — 만들기 함수가 다시 본다).
  token_id               uuid NOT NULL REFERENCES agent_api_keys (id) ON DELETE RESTRICT,
  -- 변경 하나: 목록 항목 더하기 · 빼기 | 모드 바꾸기. 칸 모양은 아래 CHECK 가 묶는다.
  action                 text NOT NULL CHECK (action IN ('add_rule', 'remove_rule', 'set_mode')),
  direction              text NOT NULL CHECK (direction IN ('outbound', 'inbound')),
  list                   text CHECK (list IN ('allow', 'block')),
  -- 목록 값(저장형 — 소문자 · trim · ASCII 출력 문자). 주소 · 도메인 모양은 `policy/contact-rules.ts` 가 보고, 승인 때 관리 연산이 한 번 더 본다.
  value                  text CHECK (value IS NULL OR (length(value) BETWEEN 1 AND 255 AND value = lower(value) AND value ~ '^[!-~]+$')),
  -- 콘솔 이름(`policy/mode-names.ts`) — 레거시 승인 모드는 고를 수 없다.
  mode                   text CHECK (mode IN ('all', 'allowlist', 'blocklist', 'none')),
  -- 에이전트가 쓴 이유(사람이 읽는다 — 콘솔만, 알림 메일에는 싣지 않는다). 제어 문자 없음.
  reason                 text NOT NULL CHECK (char_length(reason) BETWEEN 1 AND 500 AND reason !~ '[[:cntrl:]]'),
  -- 변경의 지문(sha256 hex — 같은 변경의 pending 이 있으면 재생). 이유는 넣지 않는다(다시 쓴 이유로 같은 요청이 둘이 되지 않게).
  request_hash           text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  -- 요청 때 정책 버전 — 콘솔이 "그 뒤 바뀌었다" 를 보인다(승인은 그때의 현재 상태로 다시 판정한다).
  base_version           integer NOT NULL CHECK (base_version >= 1),
  -- 오염 맥락(ADR-0016) — 요청 직전 4시간 안에 T2 노출이 있었나 · 7일 안의 마지막 T2 노출 시각. 만들기 함수가 적는다(요청자가 주장하지 않는다).
  tainted                boolean NOT NULL,
  last_risk_exposure_at  timestamptz,
  status                 text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'stale', 'expired')),
  created_at             timestamptz NOT NULL DEFAULT now(),
  expires_at             timestamptz NOT NULL,
  decided_at             timestamptz,
  -- 결정한 쪽(`admin:session:<id>` · `system:expiry`) · 사람(세션 사용자, 만료면 NULL).
  decided_by             text CHECK (decided_by IS NULL OR length(decided_by) BETWEEN 1 AND 200),
  decided_user_id        uuid REFERENCES users (id) ON DELETE RESTRICT,
  -- 승인이 만든 정책 버전(그 버전의 `created_by` 가 이 요청 id 를 싣는다).
  applied_version        integer CHECK (applied_version IS NULL OR applied_version >= 2),
  -- stale 의 까닭(닫힌 어휘 — 이미 그 상태 · 목록 상한 · 자기 주소 등 관리 연산의 거부 코드).
  stale_reason           text CHECK (stale_reason IS NULL OR stale_reason ~ '^[a-z][a-z0-9_]{0,63}$'),
  notice_id              uuid REFERENCES quarantine_notices (id) ON DELETE RESTRICT,
  CONSTRAINT policy_change_requests_change_shape CHECK (
    (action IN ('add_rule', 'remove_rule') AND list IS NOT NULL AND value IS NOT NULL AND mode IS NULL)
    OR (action = 'set_mode' AND list IS NULL AND value IS NULL AND mode IS NOT NULL)),
  CONSTRAINT policy_change_requests_decided_shape CHECK (
    (status = 'pending' AND decided_at IS NULL AND decided_by IS NULL AND decided_user_id IS NULL)
    OR (status <> 'pending' AND decided_at IS NOT NULL AND decided_by IS NOT NULL)),
  CONSTRAINT policy_change_requests_applied_shape CHECK ((status = 'approved') = (applied_version IS NOT NULL)),
  CONSTRAINT policy_change_requests_stale_shape CHECK (stale_reason IS NULL OR status = 'stale'),
  CONSTRAINT policy_change_requests_expiry CHECK (expires_at > created_at AND expires_at <= created_at + interval '7 days')
);

-- 같은 변경의 pending 은 에이전트당 하나(재생의 근거 — 만들기 함수가 지난 pending 을 먼저 expired 로 닫는다).
CREATE UNIQUE INDEX policy_change_requests_pending_key ON policy_change_requests (agent_id, request_hash) WHERE status = 'pending';
CREATE INDEX policy_change_requests_agent_created_idx ON policy_change_requests (agent_id, created_at DESC);
CREATE INDEX policy_change_requests_notice_idx ON policy_change_requests (notice_id) WHERE notice_id IS NOT NULL;

-- 결정 — pending 에서 한 번만(모든 롤). 시각은 DB 가 적는다.
CREATE FUNCTION policy_change_requests_transition() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF OLD.status <> 'pending' OR NEW.status NOT IN ('approved', 'rejected', 'stale', 'expired') THEN
    RAISE EXCEPTION 'policy_change_requests: pending → approved | rejected | stale | expired 한 번만(id=%)', OLD.id USING ERRCODE = '23514';
  END IF;
  IF NEW.status = 'expired' AND OLD.expires_at > pg_catalog.now() THEN
    RAISE EXCEPTION 'policy_change_requests: 아직 만료되지 않았다(id=%)', OLD.id USING ERRCODE = '23514';
  END IF;
  IF NEW.status IN ('approved', 'rejected', 'stale') AND OLD.expires_at <= pg_catalog.now() THEN
    RAISE EXCEPTION 'policy_change_requests: 만료된 요청은 결정할 수 없다(id=%)', OLD.id USING ERRCODE = 'P0A57';
  END IF;
  NEW.decided_at := pg_catalog.now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER policy_change_requests_immutable BEFORE UPDATE ON policy_change_requests
  FOR EACH ROW EXECUTE FUNCTION reject_column_update_except('status', 'decided_at', 'decided_by', 'decided_user_id', 'applied_version', 'stale_reason');
CREATE TRIGGER policy_change_requests_transition BEFORE UPDATE ON policy_change_requests
  FOR EACH ROW EXECUTE FUNCTION policy_change_requests_transition();
CREATE TRIGGER policy_change_requests_no_delete BEFORE DELETE ON policy_change_requests
  FOR EACH ROW EXECUTE FUNCTION reject_row_delete();
CREATE TRIGGER policy_change_requests_no_truncate AFTER TRUNCATE ON policy_change_requests
  FOR EACH STATEMENT EXECUTE FUNCTION reject_truncate();

COMMENT ON TABLE policy_change_requests IS
  '에이전트의 정책 변경 요청(append-only, ADR-0007 2026-10-13) — 목록 항목 더하기·빼기 · 모드 바꾸기 하나 + 이유. 바꾸지 않는다 — 소유자가 콘솔에서 승인하면 관리 연산이 새 정책 버전을 쓴다(applied_version). 만들기는 atmark_policy_request_create 하나.';

-- ---------------------------------------------------------------------------
-- ② 만들기 — 정의자(앱 롤의 유일한 쓰기 길)
-- ---------------------------------------------------------------------------
--
-- 결과: created | replayed (+ 요청 행의 칸). 거부는 SQLSTATE(라우트가 코드로 옮긴다 — `db/repositories/policy-request-store.ts`):
-- 토큰은 해시로 받는다(`agent_api_keys.token_hash` — 평문은 DB 에 오지 않는다).
--   P0A51 토큰이 그 에이전트의 살아 있는 policy:request 토큰이 아니다 · P0A52 에이전트가 active 가 아니다 · P0A53 24시간 20건 ·
--   P0A54 pending 5건 · P0A55 이미 그 상태(보이는 목록 · 모드) · P0A56 발신 허용에 자기 주소 · 22023 칸 모양.
CREATE FUNCTION atmark_policy_request_create(
  p_agent_id text, p_token_hash text, p_action text, p_direction text, p_list text, p_value text, p_mode text, p_reason text, p_request_hash text)
RETURNS TABLE (outcome text, r_id uuid, r_status text, r_created_at timestamptz, r_expires_at timestamptz, r_base_version integer, r_tainted boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_token_id uuid;
  agent_row record;
  existing record;
  used integer;
  pending integer;
  cur_version integer;
  cur_out text;
  cur_in text;
  cur_mode text;
  want_mode text;
  taint boolean;
  last_risk timestamptz;
  notice uuid;
  inserted record;
BEGIN
  IF p_action IS NULL OR p_action NOT IN ('add_rule', 'remove_rule', 'set_mode')
     OR p_direction IS NULL OR p_direction NOT IN ('outbound', 'inbound')
     OR (p_action = 'set_mode' AND (p_mode IS NULL OR p_list IS NOT NULL OR p_value IS NOT NULL))
     OR (p_action <> 'set_mode' AND (p_list IS NULL OR p_value IS NULL OR p_mode IS NOT NULL)) THEN
    RAISE EXCEPTION 'atmark_policy_request_create: 변경 모양' USING ERRCODE = '22023';
  END IF;

  SELECT k.id INTO v_token_id FROM public.agent_api_keys k
   WHERE k.token_hash = p_token_hash AND k.agent_id = p_agent_id::bpchar AND k.revoked_at IS NULL
     AND (k.expires_at IS NULL OR k.expires_at > pg_catalog.now())
     AND 'policy:request'::public.agent_token_capability = ANY (k.capabilities);
  IF v_token_id IS NULL THEN
    RAISE EXCEPTION 'atmark_policy_request_create: 토큰에 policy:request 가 없다' USING ERRCODE = 'P0A51';
  END IF;
  SELECT a.id, a.organization_id, a.status INTO agent_row FROM public.agents a WHERE a.id = p_agent_id::bpchar;
  IF NOT FOUND OR agent_row.status <> 'active' THEN
    RAISE EXCEPTION 'atmark_policy_request_create: 에이전트가 active 가 아니다' USING ERRCODE = 'P0A52';
  END IF;

  -- 에이전트마다 줄 세운다(계수 · 재생 · pending 상한이 한 시점을 본다).
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('policy_change_requests:' || p_agent_id, 0));

  -- 만료 — 지난 pending 을 닫는다(같은 변경의 새 요청을 막지 않게 · pending 상한에 세지 않게).
  UPDATE public.policy_change_requests r
     SET status = 'expired', decided_by = 'system:expiry'
   WHERE r.agent_id = p_agent_id::bpchar AND r.status = 'pending' AND r.expires_at <= pg_catalog.now();

  -- 재생 — 같은 변경의 pending 이 있으면 그것(계수하지 않는다).
  SELECT r.id, r.status, r.created_at, r.expires_at, r.base_version, r.tainted INTO existing
    FROM public.policy_change_requests r
   WHERE r.agent_id = p_agent_id::bpchar AND r.request_hash = p_request_hash AND r.status = 'pending';
  IF FOUND THEN
    RETURN QUERY SELECT 'replayed'::text, existing.id, existing.status, existing.created_at, existing.expires_at, existing.base_version, existing.tainted;
    RETURN;
  END IF;

  SELECT count(*)::integer INTO used FROM public.policy_change_requests r
   WHERE r.agent_id = p_agent_id::bpchar AND r.created_at > pg_catalog.now() - interval '24 hours';
  IF used >= 20 THEN
    RAISE EXCEPTION 'atmark_policy_request_create: 24시간 요청 상한(20)' USING ERRCODE = 'P0A53';
  END IF;
  SELECT count(*)::integer INTO pending FROM public.policy_change_requests r
   WHERE r.agent_id = p_agent_id::bpchar AND r.status = 'pending';
  IF pending >= 5 THEN
    RAISE EXCEPTION 'atmark_policy_request_create: 결정을 기다리는 요청 상한(5)' USING ERRCODE = 'P0A54';
  END IF;

  -- 지금 상태 — 관문과 같은 진실(현재 버전의 모드 · 살아 있는 목록 = 그 버전의 스냅샷, 202609241040 트리거가 커밋마다 맞춘다).
  SELECT p.current_version INTO cur_version FROM public.agent_policies p WHERE p.agent_id = p_agent_id::bpchar;
  SELECT v.outbound_mode::text, v.inbound_mode::text INTO cur_out, cur_in
    FROM public.policy_versions v WHERE v.agent_id = p_agent_id::bpchar AND v.version = cur_version;
  IF cur_version IS NULL OR cur_out IS NULL THEN
    RAISE EXCEPTION 'atmark_policy_request_create: 정책이 없다' USING ERRCODE = 'P0A52';
  END IF;
  IF p_action = 'set_mode' THEN
    cur_mode := CASE WHEN p_direction = 'outbound' THEN cur_out ELSE cur_in END;
    want_mode := CASE p_mode
                   WHEN 'all' THEN CASE WHEN p_direction = 'outbound' THEN 'unrestricted' ELSE 'all' END
                   WHEN 'allowlist' THEN 'allowlist_only'
                   WHEN 'blocklist' THEN 'blocklist_only'
                   WHEN 'none' THEN 'disabled'
                 END;
    IF want_mode IS NULL THEN
      RAISE EXCEPTION 'atmark_policy_request_create: 모드' USING ERRCODE = '22023';
    END IF;
    IF cur_mode = want_mode THEN
      RAISE EXCEPTION 'atmark_policy_request_create: 이미 그 모드다' USING ERRCODE = 'P0A55';
    END IF;
  ELSIF p_list = 'allow' THEN
    -- 허용 목록은 에이전트가 이미 본다(get_my_policy) — 이미 그런 상태면 거부. 차단 목록은 내용을 감추므로 보지 않는다(승인 때 stale 이 된다).
    PERFORM 1 FROM public.agent_contact_rules c
     WHERE c.agent_id = p_agent_id::bpchar AND c.direction = p_direction AND c.list = 'allow' AND c.value = p_value AND c.removed_at IS NULL;
    IF (p_action = 'add_rule') = FOUND THEN
      RAISE EXCEPTION 'atmark_policy_request_create: 이미 그 상태다' USING ERRCODE = 'P0A55';
    END IF;
    IF p_action = 'add_rule' AND p_direction = 'outbound' THEN
      PERFORM 1 FROM public.agent_addresses ad
       WHERE ad.agent_id = p_agent_id::bpchar AND ad.retired_at IS NULL
         AND pg_catalog.lower(pg_catalog.regexp_replace(ad.address, '\+[^@]*@', '@')) = pg_catalog.regexp_replace(p_value, '\+[^@]*@', '@');
      IF FOUND THEN
        RAISE EXCEPTION 'atmark_policy_request_create: 발신 허용에 자기 주소' USING ERRCODE = 'P0A56';
      END IF;
    END IF;
  END IF;

  -- 오염 맥락(ADR-0016) — 에이전트 4시간 창의 T2 노출 · 7일 안의 마지막 T2 노출.
  SELECT max(e.last_at) INTO last_risk FROM public.agent_exposures e
   WHERE e.agent_id = p_agent_id::bpchar AND e.level >= 2 AND e.last_at > pg_catalog.now() - interval '7 days';
  taint := last_risk IS NOT NULL AND last_risk > pg_catalog.now() - interval '4 hours';

  -- 알림 창(소유자 — 실패는 삼킨다: 요청 기록이 먼저다. 콘솔에는 그대로 보인다).
  BEGIN
    notice := public.atmark_watch_notice_slot(p_agent_id::bpchar, agent_row.organization_id, 'policy_request');
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'atmark_policy_request_create: 알림 계수를 건너뛴다(sqlstate=%)', SQLSTATE;
    notice := NULL;
  END;

  INSERT INTO public.policy_change_requests AS r
    (agent_id, organization_id, token_id, action, direction, list, value, mode, reason, request_hash, base_version, tainted,
     last_risk_exposure_at, created_at, expires_at, notice_id)
  VALUES (p_agent_id::bpchar, agent_row.organization_id, v_token_id, p_action, p_direction, p_list, p_value, p_mode, p_reason, p_request_hash,
          cur_version, taint, last_risk, pg_catalog.now(), pg_catalog.now() + interval '7 days', notice)
  RETURNING r.id, r.status, r.created_at, r.expires_at, r.base_version, r.tainted INTO inserted;
  RETURN QUERY SELECT 'created'::text, inserted.id, inserted.status, inserted.created_at, inserted.expires_at, inserted.base_version, inserted.tainted;
END;
$$;

REVOKE ALL ON FUNCTION atmark_policy_request_create(text, text, text, text, text, text, text, text, text) FROM PUBLIC;

-- ---------------------------------------------------------------------------
-- 콘솔의 위험 경고 — 요청 뒤의 노출도 본다(적대 검증 G07 · G08)
-- ---------------------------------------------------------------------------
--
-- 요청 행의 `tainted` 는 만들 때 고정한 사실이다. 그 뒤 에이전트가 위험 표시 메일을 읽으면(같은 요청의 재생 포함) 소유자가 승인하는 순간의 에이전트는 오염돼
-- 있다 — 콘솔이 목록 · 승인 때 `p_since`(요청 시각 − 4시간) 이후의 마지막 T2 노출 시각을 다시 읽는다. admin 롤은 노출 표 권한이 없다(정의자 · 시각 하나만).
-- 조직 범위는 콘솔 라우트가 먼저 본다(`requireAgentInOrganization`).
CREATE FUNCTION atmark_agent_last_risk_exposure(p_agent_id bpchar, p_since timestamptz) RETURNS timestamptz
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT max(e.last_at) FROM public.agent_exposures e WHERE e.agent_id = p_agent_id AND e.level >= 2 AND e.last_at >= p_since
$$;

REVOKE ALL ON FUNCTION atmark_agent_last_risk_exposure(bpchar, timestamptz) FROM PUBLIC;

-- ---------------------------------------------------------------------------
-- GRANT — `src/runtime/role-bootstrap.ts` `RESTRICTED_ROLE_GRANTS` 와 같다(migrate status 가 대조)
-- ---------------------------------------------------------------------------

-- 앱 롤: 만들기(정의자) · 자기 요청 조회(라우트가 에이전트로 거른다) · 알림기가 창을 그릴 때 읽는 칸. 표 쓰기 0.
GRANT EXECUTE ON FUNCTION atmark_policy_request_create(text, text, text, text, text, text, text, text, text) TO atmark_app;
GRANT SELECT (id, agent_id, organization_id, action, direction, list, value, mode, status, created_at, expires_at, decided_at, applied_version,
              stale_reason, notice_id)
  ON policy_change_requests TO atmark_app;
-- admin 롤(콘솔): 읽기 · 결정 칸 UPDATE(전이는 트리거가 본다). INSERT · DELETE 0.
GRANT SELECT ON policy_change_requests TO atmark_admin;
GRANT UPDATE (status, decided_by, decided_user_id, applied_version, stale_reason) ON policy_change_requests TO atmark_admin;
GRANT EXECUTE ON FUNCTION atmark_agent_last_risk_exposure(bpchar, timestamptz) TO atmark_admin;
