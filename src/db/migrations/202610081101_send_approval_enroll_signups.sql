-- 202610081101_send_approval_enroll_signups.sql
-- 감시 탭 묶음 D(진윤겸 2026-10-08 — 계획 docs/internal/plans/watch-and-dev-surface.md · ADR-0016 2026-10-08 개정 "발신 승인" · "자가 등록 · 바깥 가입 감지").
--
--   ① 발신 승인(`send_approval`) — 죽어 있던 `agent_policies.require_approval` 를 살린다. 판정은 관문(Stage 7 `rules/send-approval.ts`)이 정책 버전 스냅샷
--      `require_approval` 과 행을 함께 읽는다(하나라도 참이면 always — 좁은 쪽). 바꾸는 길은 정책 새 버전(`admin/ops/policy.ts`)뿐이라 admin 롤에 그 한 칸의
--      UPDATE 를 준다(다른 정책 칸과 같은 모양 — 감사 · 이력은 policy_versions).
--   ② 조직 감시 설정에 네 칸(`org_watch_settings`): 자가 등록 켬(기본 꺼짐) · 하루 상한(기본 5 · 1~20) · 자가 등록 알림(기본 켬) · 가입 감지 알림(기본 켬).
--      쓰기는 정의자 `atmark_watch_set_org` 하나(admin 롤 — 소유자만, 라우트 표).
--   ③ 자가 등록 기록(`agent_enrollments`, append-only — **이것이 감사 행이다**: 부른 에이전트 · 쓴 토큰 · 만든 에이전트 · 시각). 슬롯을 **먼저** 잡는다
--      (pending — 키 보관 전에 하루 상한 · 설정 · 부른 에이전트 상태를 DB 가 본다) → 프로비저닝 → created | taken. 하루 상한은 조직 잠금 아래 지난 24시간의
--      모든 시도(pending · created · taken)를 센다 — 쓸 수 없는 주소 시도도 센다(주소 탐침 상한).
--      created 로 바뀌는 순간 `notify_on_enroll` 이면 알림 창(`quarantine_notices` kind `enroll`)에 넣는다.
--      **연쇄 금지:** 자가 등록으로 태어난 에이전트에는 `agents:enroll` 토큰을 붙일 수 없다(`agent_api_keys_no_enroll_chain` — 모든 롤).
--   ④ 바깥 가입 감지(`agent_signups`) — 에이전트 · 서비스 도메인(등록 가능 도메인)마다 한 행(종류 · 처음/마지막 · 수). 제목 · 본문은 싣지 않는다.
--      쓰기는 정의자 `atmark_record_agent_signup` 하나(앱 롤 — 수신 소비자): 그 메일이 그 에이전트의 것 · DMARC 인증 · 보임 · From 도메인이 서비스 도메인
--      (또는 그 하위)인지 다시 본다. 처음 본 서비스이고 `notify_on_signup` 이면 알림 창(kind `signup`)에 넣는다. 에이전트마다 서비스 1000 개까지.
--   ⑤ 알림 창 종류 둘(`signup` · `enroll`)과 항목 사유 하나(`signup`) — 격리 알림 기계(창 · 2분 · 15분 · 소유자 수신자 · at-most-once)를 그대로 쓴다.
--      조직 하루 상한은 알림기가 종류 묶음(차단 · 위험 / 가입 · 자가 등록)마다 따로 센다 — 정보 알림이 차단 알림을 밀어내지 않는다.
--
-- 잠금: `agent_policies` GRANT 만 · `org_watch_settings`(작은 표) 칸 넷 + CHECK NOT VALID · `quarantine_notices` · `quarantine_notice_items` CHECK 교체 NOT VALID ·
-- `agent_api_keys` 트리거 하나. 새 표 둘. 5초. VALIDATE 는 1102.
-- **순서:** 터널 migrate(1100~1102) → `deploy-compute migrate=false`. expand-only — 옛 코드는 새 칸 · 표를 쓰지 않는다(기본값 = 오늘 동작: 발신 승인 auto ·
-- 자가 등록 꺼짐 · 가입 감지는 새 코드부터).

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
-- ① 발신 승인
-- ---------------------------------------------------------------------------

COMMENT ON COLUMN agent_policies.require_approval IS
  '소유자 발신 승인(send_approval) — false = auto(엔진 판정 그대로) · true = always(허용됐을 발송도 owner_requires_approval 로 승인 대기). 정책 버전 스냅샷 require_approval 과 함께 바뀐다(ADR-0016 2026-10-08).';

GRANT UPDATE (require_approval) ON agent_policies TO atmark_admin;

-- ---------------------------------------------------------------------------
-- ② 조직 감시 설정 — 자가 등록 · 가입 감지
-- ---------------------------------------------------------------------------

ALTER TABLE org_watch_settings
  ADD COLUMN agent_self_enroll boolean NOT NULL DEFAULT false,
  ADD COLUMN enroll_daily_cap integer NOT NULL DEFAULT 5,
  ADD COLUMN notify_on_enroll boolean NOT NULL DEFAULT true,
  ADD COLUMN notify_on_signup boolean NOT NULL DEFAULT true;

ALTER TABLE org_watch_settings
  ADD CONSTRAINT org_watch_settings_enroll_daily_cap_check CHECK (enroll_daily_cap BETWEEN 1 AND 20) NOT VALID;

COMMENT ON COLUMN org_watch_settings.agent_self_enroll IS
  '자가 등록 — 켜면 agents:enroll 토큰을 받은 에이전트가 같은 조직에 안전 기본값의 형제 에이전트를 만든다(하루 enroll_daily_cap · 요금제 한도). 기본 꺼짐.';

-- 조직 설정 바꾸기 — NULL 인자는 지금 값 그대로. 결과: unchanged | changed (+ 바뀐 뒤 값). 상한 범위는 표의 CHECK 가 본다(23514).
CREATE FUNCTION atmark_watch_set_org(p_organization_id uuid, p_self_enroll boolean, p_enroll_daily_cap integer, p_notify_on_enroll boolean,
                                     p_notify_on_signup boolean, p_user_id uuid)
RETURNS TABLE (outcome text, r_self_enroll boolean, r_enroll_daily_cap integer, r_notify_on_enroll boolean, r_notify_on_signup boolean, r_updated_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  cur record;
  n_self boolean;
  n_cap integer;
  n_enroll boolean;
  n_signup boolean;
  stamped timestamptz;
BEGIN
  PERFORM 1 FROM public.organizations o WHERE o.id = p_organization_id FOR SHARE OF o;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'atmark_watch_set_org: 조직이 없다' USING ERRCODE = '23503';
  END IF;
  SELECT s.agent_self_enroll, s.enroll_daily_cap, s.notify_on_enroll, s.notify_on_signup, s.updated_at INTO cur
    FROM public.org_watch_settings s WHERE s.organization_id = p_organization_id FOR UPDATE;
  n_self := coalesce(p_self_enroll, cur.agent_self_enroll, false);
  n_cap := coalesce(p_enroll_daily_cap, cur.enroll_daily_cap, 5);
  n_enroll := coalesce(p_notify_on_enroll, cur.notify_on_enroll, true);
  n_signup := coalesce(p_notify_on_signup, cur.notify_on_signup, true);
  IF (n_self, n_cap, n_enroll, n_signup) IS NOT DISTINCT FROM
     (coalesce(cur.agent_self_enroll, false), coalesce(cur.enroll_daily_cap, 5), coalesce(cur.notify_on_enroll, true), coalesce(cur.notify_on_signup, true)) THEN
    RETURN QUERY SELECT 'unchanged'::text, n_self, n_cap, n_enroll, n_signup, cur.updated_at;
    RETURN;
  END IF;
  INSERT INTO public.org_watch_settings AS o (organization_id, agent_self_enroll, enroll_daily_cap, notify_on_enroll, notify_on_signup, updated_at, updated_by)
  VALUES (p_organization_id, n_self, n_cap, n_enroll, n_signup, pg_catalog.now(), p_user_id)
  ON CONFLICT (organization_id) DO UPDATE
    SET agent_self_enroll = EXCLUDED.agent_self_enroll, enroll_daily_cap = EXCLUDED.enroll_daily_cap, notify_on_enroll = EXCLUDED.notify_on_enroll,
        notify_on_signup = EXCLUDED.notify_on_signup, updated_at = EXCLUDED.updated_at, updated_by = EXCLUDED.updated_by
  RETURNING o.updated_at INTO stamped;
  RETURN QUERY SELECT 'changed'::text, n_self, n_cap, n_enroll, n_signup, stamped;
END;
$$;

REVOKE ALL ON FUNCTION atmark_watch_set_org(uuid, boolean, integer, boolean, boolean, uuid) FROM PUBLIC;

-- ---------------------------------------------------------------------------
-- ⑤(먼저) 알림 창 — 종류 둘 · 사유 하나 · 창 하나 잡기(내부 정의자 — 아무에게도 EXECUTE 없음)
-- ---------------------------------------------------------------------------

ALTER TABLE quarantine_notices
  DROP CONSTRAINT quarantine_notices_kind_check,
  ADD CONSTRAINT quarantine_notices_kind_check CHECK (kind IN ('block', 'risk', 'signup', 'enroll')) NOT VALID;

ALTER TABLE quarantine_notice_items
  DROP CONSTRAINT quarantine_notice_items_reason_check,
  ADD CONSTRAINT quarantine_notice_items_reason_check
    CHECK (reason IN ('injection_risk', 'scanner_error', 'risk_hold', 'risk_delivered', 'signup')) NOT VALID;

-- 에이전트 · 종류의 열린 창 하나에 1을 더하고 그 id 를 돌려준다(없으면 연다 — 첫 항목 2분 뒤 · 같은 종류의 직전 집기 15분 뒤). 에이전트 잠금을 **기다리지 않는다**
-- (수신 경로 — `quarantine_notice_record()` 와 같은 규율). 못 잡으면 NULL(이번 한 건은 세지 않는다).
CREATE FUNCTION atmark_watch_notice_slot(p_agent_id bpchar, p_organization_id uuid, p_kind text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  notice uuid;
  previous timestamptz;
BEGIN
  IF p_kind NOT IN ('signup', 'enroll') THEN
    RAISE EXCEPTION 'atmark_watch_notice_slot: 정보 알림 종류만(signup | enroll)' USING ERRCODE = '22023';
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
-- ③ 자가 등록 기록
-- ---------------------------------------------------------------------------

CREATE TABLE agent_enrollments (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid NOT NULL REFERENCES organizations (id) ON DELETE RESTRICT,
  -- 부른 에이전트 · 쓴 토큰(`agents:enroll` — 트리거가 다시 본다).
  parent_agent_id  character(32) NOT NULL REFERENCES agents (id) ON DELETE RESTRICT,
  parent_token_id  uuid NOT NULL REFERENCES agent_api_keys (id) ON DELETE RESTRICT,
  child_agent_id   character(32) UNIQUE REFERENCES agents (id) ON DELETE RESTRICT,
  outcome          text NOT NULL DEFAULT 'pending' CHECK (outcome IN ('pending', 'created', 'taken')),
  notice_id        uuid REFERENCES quarantine_notices (id) ON DELETE RESTRICT,
  created_at       timestamptz NOT NULL DEFAULT now(),
  completed_at     timestamptz,
  CONSTRAINT agent_enrollments_shape CHECK (
    (outcome = 'pending' AND child_agent_id IS NULL AND completed_at IS NULL)
    OR (outcome = 'created' AND child_agent_id IS NOT NULL AND completed_at IS NOT NULL)
    OR (outcome = 'taken' AND child_agent_id IS NULL AND completed_at IS NOT NULL)),
  CONSTRAINT agent_enrollments_not_self CHECK (child_agent_id IS DISTINCT FROM parent_agent_id)
);

CREATE INDEX agent_enrollments_org_created_idx ON agent_enrollments (organization_id, created_at DESC);
CREATE INDEX agent_enrollments_notice_idx ON agent_enrollments (notice_id) WHERE notice_id IS NOT NULL;

-- INSERT — 슬롯 잡기. 모든 판정은 DB 가 다시 본다(라우트 · 호출자를 믿지 않는다): pending 으로만 · 토큰이 그 에이전트의 살아 있는 `agents:enroll` 토큰 ·
-- 부른 에이전트 active · 조직 = 에이전트의 조직 · 조직 active(검토 끝 · 정지 · 동결 없음) · 설정 켜짐 · 지난 24시간 시도 < 하루 상한(조직 잠금 아래).
CREATE FUNCTION agent_enrollments_admit() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  cap integer;
  enabled boolean;
  used integer;
BEGIN
  IF NEW.outcome <> 'pending' OR NEW.child_agent_id IS NOT NULL OR NEW.completed_at IS NOT NULL OR NEW.notice_id IS NOT NULL THEN
    RAISE EXCEPTION 'agent_enrollments: 새 행은 pending 이다' USING ERRCODE = '23514';
  END IF;
  NEW.created_at := pg_catalog.now();
  PERFORM 1 FROM public.agent_api_keys k
   WHERE k.id = NEW.parent_token_id AND k.agent_id = NEW.parent_agent_id AND k.revoked_at IS NULL
     AND (k.expires_at IS NULL OR k.expires_at > pg_catalog.now())
     AND 'agents:enroll'::public.agent_token_capability = ANY (k.capabilities);
  IF NOT FOUND THEN
    RAISE EXCEPTION 'agent_enrollments: 토큰에 agents:enroll 이 없다' USING ERRCODE = 'P0A31';
  END IF;
  PERFORM 1 FROM public.agents a JOIN public.organizations o ON o.id = a.organization_id
   WHERE a.id = NEW.parent_agent_id AND a.organization_id = NEW.organization_id AND a.status = 'active'
     AND o.review_status = 'active' AND NOT o.owner_paused AND NOT o.abuse_freeze;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'agent_enrollments: 부른 에이전트 · 조직이 활성이 아니다' USING ERRCODE = 'P0A32';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('agent_enrollments:' || NEW.organization_id::text, 0));
  SELECT s.agent_self_enroll, s.enroll_daily_cap INTO enabled, cap FROM public.org_watch_settings s WHERE s.organization_id = NEW.organization_id;
  IF NOT coalesce(enabled, false) THEN
    RAISE EXCEPTION 'agent_enrollments: 조직의 자가 등록이 꺼져 있다' USING ERRCODE = 'P0A33';
  END IF;
  SELECT count(*)::integer INTO used FROM public.agent_enrollments e
   WHERE e.organization_id = NEW.organization_id AND e.created_at > pg_catalog.now() - interval '24 hours';
  IF used >= coalesce(cap, 5) THEN
    RAISE EXCEPTION 'agent_enrollments: 조직의 하루 자가 등록 상한(%)', coalesce(cap, 5) USING ERRCODE = 'P0A34';
  END IF;
  RETURN NEW;
END;
$$;

-- UPDATE — pending → created(같은 조직의 새 에이전트) | taken, 한 번. created 면 알림 창(조직 설정 notify_on_enroll — 행이 없으면 켬)에 넣는다(실패는 삼킨다).
CREATE FUNCTION agent_enrollments_complete() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF OLD.outcome <> 'pending' OR NEW.outcome NOT IN ('created', 'taken') OR NEW.notice_id IS DISTINCT FROM OLD.notice_id THEN
    RAISE EXCEPTION 'agent_enrollments: pending → created | taken 한 번만(id=%)', OLD.id USING ERRCODE = '23514';
  END IF;
  IF NEW.outcome = 'created' THEN
    PERFORM 1 FROM public.agents a WHERE a.id = NEW.child_agent_id AND a.organization_id = OLD.organization_id AND a.created_at >= OLD.created_at;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'agent_enrollments: 만든 에이전트가 같은 조직이 아니다' USING ERRCODE = '23514';
    END IF;
  END IF;
  NEW.completed_at := pg_catalog.now();
  IF NEW.outcome = 'created'
     AND coalesce((SELECT s.notify_on_enroll FROM public.org_watch_settings s WHERE s.organization_id = OLD.organization_id), true) THEN
    BEGIN
      NEW.notice_id := public.atmark_watch_notice_slot(OLD.parent_agent_id, OLD.organization_id, 'enroll');
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'agent_enrollments_complete: 알림 계수를 건너뛴다(sqlstate=%)', SQLSTATE;
      NEW.notice_id := NULL;
    END;
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION agent_enrollments_admit() FROM PUBLIC;
REVOKE ALL ON FUNCTION agent_enrollments_complete() FROM PUBLIC;

CREATE TRIGGER agent_enrollments_admit BEFORE INSERT ON agent_enrollments
  FOR EACH ROW EXECUTE FUNCTION agent_enrollments_admit();
CREATE TRIGGER agent_enrollments_immutable BEFORE UPDATE ON agent_enrollments
  FOR EACH ROW EXECUTE FUNCTION reject_column_update_except('outcome', 'child_agent_id', 'completed_at', 'notice_id');
CREATE TRIGGER agent_enrollments_complete BEFORE UPDATE ON agent_enrollments
  FOR EACH ROW EXECUTE FUNCTION agent_enrollments_complete();
CREATE TRIGGER agent_enrollments_no_delete BEFORE DELETE ON agent_enrollments
  FOR EACH ROW EXECUTE FUNCTION reject_row_delete();
CREATE TRIGGER agent_enrollments_no_truncate AFTER TRUNCATE ON agent_enrollments
  FOR EACH STATEMENT EXECUTE FUNCTION reject_truncate();

COMMENT ON TABLE agent_enrollments IS
  '자가 등록 감사(append-only, ADR-0016 2026-10-08) — 부른 에이전트 · 토큰 · 만든 에이전트 · 시각. 슬롯(pending)을 키 보관 전에 잡고 하루 상한 · 설정 · 상태를 DB 가 본다.';

-- 연쇄 금지 — 자가 등록으로 태어난 에이전트는 agents:enroll 토큰을 가질 수 없다(소유자도 붙이지 못한다 — 형제가 형제를 낳는 사슬을 끊는다).
CREATE FUNCTION agent_api_keys_no_enroll_chain() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF 'agents:enroll'::public.agent_token_capability = ANY (NEW.capabilities)
     AND EXISTS (SELECT 1 FROM public.agent_enrollments e WHERE e.child_agent_id = NEW.agent_id) THEN
    RAISE EXCEPTION 'agent_api_keys: 자가 등록으로 만든 에이전트에는 agents:enroll 을 줄 수 없다' USING ERRCODE = 'P0A35';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION agent_api_keys_no_enroll_chain() FROM PUBLIC;

CREATE TRIGGER agent_api_keys_no_enroll_chain BEFORE INSERT ON agent_api_keys
  FOR EACH ROW EXECUTE FUNCTION agent_api_keys_no_enroll_chain();

-- ---------------------------------------------------------------------------
-- ④ 바깥 가입 감지
-- ---------------------------------------------------------------------------

CREATE TABLE agent_signups (
  agent_id         character(32) NOT NULL REFERENCES agents (id) ON DELETE RESTRICT,
  organization_id  uuid NOT NULL REFERENCES organizations (id) ON DELETE RESTRICT,
  -- 등록 가능 도메인(eTLD+1, 수신 소비자가 PSL 로 접었다) — 소문자 LDH · 라벨 2개 이상 · 253자(알림 도메인과 같은 모양).
  service_domain   text NOT NULL CHECK (length(service_domain) <= 253
                     AND service_domain ~ '^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+([a-z]{2,63}|xn--[a-z0-9-]{1,59})$'),
  -- 마지막으로 본 종류(인증 · 환영 · 계정 생성).
  kind             text NOT NULL CHECK (kind IN ('verification', 'welcome', 'account_created')),
  first_seen_at    timestamptz NOT NULL DEFAULT now(),
  last_seen_at     timestamptz NOT NULL DEFAULT now(),
  message_count    integer NOT NULL DEFAULT 1 CHECK (message_count >= 1),
  PRIMARY KEY (agent_id, service_domain),
  CONSTRAINT agent_signups_window CHECK (last_seen_at >= first_seen_at)
);

CREATE INDEX agent_signups_org_last_idx ON agent_signups (organization_id, last_seen_at DESC, agent_id, service_domain);

CREATE TRIGGER agent_signups_immutable BEFORE UPDATE ON agent_signups
  FOR EACH ROW EXECUTE FUNCTION reject_column_update_except('kind', 'last_seen_at', 'message_count');
CREATE TRIGGER agent_signups_no_delete BEFORE DELETE ON agent_signups
  FOR EACH ROW EXECUTE FUNCTION reject_row_delete();
CREATE TRIGGER agent_signups_no_truncate AFTER TRUNCATE ON agent_signups
  FOR EACH STATEMENT EXECUTE FUNCTION reject_truncate();

COMMENT ON TABLE agent_signups IS
  '바깥 가입 감지(ADR-0016 2026-10-08) — 에이전트가 가입한 것 같은 서비스(DMARC 인증된 가입 확인 · 환영 · 계정 생성 메일). 도메인 · 종류 · 시각 · 수만 — 제목 · 본문 없음. 정보용(격리와 무관).';

-- 기록 — 수신 소비자(앱 롤)가 메일을 적은 뒤 부른다. 결과: new | seen | ignored(조건 불성립 · 서비스 1000 개 초과).
CREATE FUNCTION atmark_record_agent_signup(p_agent_id text, p_inbound_message_id uuid, p_service_domain text, p_kind text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  msg record;
  org uuid;
  inserted integer := 0;
  notice uuid;
  dom text := pg_catalog.lower(p_service_domain);
BEGIN
  IF p_kind IS NULL OR p_kind NOT IN ('verification', 'welcome', 'account_created') THEN
    RAISE EXCEPTION 'atmark_record_agent_signup: 종류' USING ERRCODE = '22023';
  END IF;
  SELECT m.from_domain, m.from_authenticated, m.quarantined, a.organization_id INTO msg
    FROM public.inbound_messages m JOIN public.agents a ON a.id = m.agent_id
   WHERE m.id = p_inbound_message_id AND m.agent_id = p_agent_id::bpchar;
  IF NOT FOUND OR NOT msg.from_authenticated OR msg.quarantined OR msg.from_domain IS NULL
     OR NOT (pg_catalog.lower(msg.from_domain) = dom OR pg_catalog.right(pg_catalog.lower(msg.from_domain), pg_catalog.length(dom) + 1) = '.' || dom) THEN
    RETURN 'ignored';
  END IF;
  org := msg.organization_id;
  UPDATE public.agent_signups s
     SET kind = p_kind, last_seen_at = GREATEST(s.last_seen_at, pg_catalog.now()), message_count = s.message_count + 1
   WHERE s.agent_id = p_agent_id::bpchar AND s.service_domain = dom;
  IF FOUND THEN
    RETURN 'seen';
  END IF;
  IF (SELECT count(*) FROM public.agent_signups s WHERE s.agent_id = p_agent_id::bpchar) >= 1000 THEN
    RETURN 'ignored';
  END IF;
  INSERT INTO public.agent_signups (agent_id, organization_id, service_domain, kind)
  VALUES (p_agent_id::bpchar, org, dom, p_kind)
  ON CONFLICT (agent_id, service_domain) DO NOTHING;
  GET DIAGNOSTICS inserted = ROW_COUNT;
  IF inserted = 0 THEN
    RETURN 'seen';
  END IF;
  -- 처음 본 서비스 — 알림(조직 설정 notify_on_signup, 행이 없으면 켬). 같은 메일이 다른 창의 항목이면(위험 전달 등) 건너뛴다. 실패는 삼킨다(기록이 먼저다).
  IF coalesce((SELECT s.notify_on_signup FROM public.org_watch_settings s WHERE s.organization_id = org), true)
     AND NOT EXISTS (SELECT 1 FROM public.quarantine_notice_items i WHERE i.inbound_message_id = p_inbound_message_id) THEN
    BEGIN
      notice := public.atmark_watch_notice_slot(p_agent_id::bpchar, org, 'signup');
      IF notice IS NOT NULL THEN
        INSERT INTO public.quarantine_notice_items (inbound_message_id, notice_id, sender_domain, sender_authenticated, reason)
        VALUES (p_inbound_message_id, notice, dom, true, 'signup');
      END IF;
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'atmark_record_agent_signup: 알림 계수를 건너뛴다(sqlstate=%)', SQLSTATE;
    END;
  END IF;
  RETURN 'new';
END;
$$;

REVOKE ALL ON FUNCTION atmark_record_agent_signup(text, uuid, text, text) FROM PUBLIC;

-- ---------------------------------------------------------------------------
-- GRANT — `src/runtime/role-bootstrap.ts` `RESTRICTED_ROLE_GRANTS` 와 같다(migrate status 가 대조)
-- ---------------------------------------------------------------------------

-- 앱 롤: 가입 기록(정의자) · 알림기가 자가 등록 창을 그릴 때 읽는 두 칸. 표 쓰기 0.
GRANT EXECUTE ON FUNCTION atmark_record_agent_signup(text, uuid, text, text) TO atmark_app;
GRANT SELECT (notice_id, child_agent_id, organization_id, created_at) ON agent_enrollments TO atmark_app;
-- 발견(`get_capabilities` · `/v1/agents/{id}/capabilities`)이 자가 등록을 쓸 수 있는지 말한다 — 조직 설정 두 칸 읽기(쓰기 0).
GRANT SELECT (organization_id, agent_self_enroll, enroll_daily_cap) ON org_watch_settings TO atmark_app;
-- admin 롤(콘솔 · 자가 등록 실행): 읽기 + 슬롯 INSERT(칸 셋) · 끝내기 UPDATE(칸 둘 — 나머지는 트리거) + 조직 설정 정의자.
GRANT SELECT ON agent_enrollments, agent_signups TO atmark_admin;
GRANT INSERT (organization_id, parent_agent_id, parent_token_id) ON agent_enrollments TO atmark_admin;
GRANT UPDATE (outcome, child_agent_id) ON agent_enrollments TO atmark_admin;
GRANT EXECUTE ON FUNCTION atmark_watch_set_org(uuid, boolean, integer, boolean, boolean, uuid) TO atmark_admin;
