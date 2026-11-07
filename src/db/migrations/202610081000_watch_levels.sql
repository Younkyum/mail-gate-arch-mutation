-- 202610081000_watch_levels.sql
-- 받은 메일의 두 등급 · 위험 보류 · 풀어 주기 · 신뢰 발신자 우회(ADR-0016 2026-10-08 개정 — 진윤겸 결정, 계획 docs/internal/plans/watch-and-dev-surface.md 묶음 A).
-- 등급의 정의는 `src/security/levels.ts`(`classifyInboundLevel`) 하나다 — 이 파일은 그 결과를 행에 남기고, 바꿀 수 있는 길을 정의자 함수로만 연다.
--
--   ① 설정 저장소(감시 탭) — D 묶음(발신 승인 · 자가 등록)이 칸을 더할 자리:
--      `agent_watch_settings`(에이전트마다 · 행이 없으면 기본값 = 위험 `deliver` · 알림 켬) · `org_watch_settings`(조직마다 — 지금은 바뀐 시각만) ·
--      `org_trusted_senders`(조직의 신뢰 발신자 — 정확한 주소 또는 도메인, 살아 있는 행 최대 200, 지우기는 표시 한 번).
--      **앱 롤은 읽기만**(수신 소비자) · admin 롤은 읽기 + 정의자 함수 셋(쓰기는 그 함수로만).
--   ② `inbound_messages` 칸 다섯:
--      `watch_level`(수신 시점 등급 none|risk|block — 옛 행 NULL) · `trusted_bypass`(신뢰 발신자 우회가 적용됐다 — DMARC 인증된 From 만, CHECK) ·
--      `released_at`·`released_by`·`released_from`(소유자가 풀어 준 시각 · 사용자 · 무엇에서 풀었나 injection_risk|risk_hold).
--      격리 사유에 `risk_hold`(위험 등급 + 에이전트 설정 `hold`) — 에이전트에게는 격리와 똑같이 숨는다(`visibleToAgent` 술어 그대로).
--      `high ⇒ 격리` CHECK 는 신뢰 발신자 우회 · 풀린 행을 예외로 다시 세운다(같은 이름). 판정 없음(scanner_error)은 여전히 격리이고 풀 수 없다(fail closed).
--      풀기는 **격리 → 보임 한 방향 한 번**(트리거 `inbound_messages_release_guard`) — INSERT 는 풀린 칸을 채울 수 없다.
--   ③ 정의자 함수 셋(admin 롤 EXECUTE): 에이전트 설정 · 신뢰 발신자 목록 바꾸기 · 풀어 주기(+ `message.received` 웹훅을 같은 트랜잭션에).
--   ④ 격리 알림에 종류(`quarantine_notices.kind` block|risk) — 위험 알림은 같은 기계(창 · 15분 · 조직 상한 · 인증된 도메인만)를 쓴다. 트리거 함수 교체와
--      열린 창 색인 교체는 1002(비트랜잭션 색인) · 1003 에서 한다. 이 파일은 칸과 CHECK(NOT VALID)만.
--
-- 잠금: `inbound_messages` ALTER(칸 다섯 — 상수 기본값이라 다시 쓰지 않는다 · CHECK NOT VALID · 트리거 교체) — 짧은 ACCESS EXCLUSIVE.
-- `quarantine_notices` · `quarantine_notice_items` ALTER(칸 하나 · CHECK 교체 NOT VALID). 새 표 셋. 5초 안에 못 잡으면 아무것도 바뀌지 않는다.
-- **순서:** 터널 migrate(1000~1003) → `deploy-compute migrate=false`. expand-only — 옛 코드는 새 칸을 쓰지 않는다(기본값으로 오늘 동작 그대로:
-- watch_level NULL · trusted_bypass false · 보류 없음). 옛 알림기는 kind 를 모르고 위험 창도 격리 문구로 보낸다 — 1003 의 위험 창은 Compute 배포 전
-- 몇 분 동안만 생긴다(런북 deploy 기록).

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
-- ① 설정 저장소
-- ---------------------------------------------------------------------------

CREATE TABLE agent_watch_settings (
  agent_id       character(32) PRIMARY KEY REFERENCES agents (id) ON DELETE RESTRICT,
  -- 위험 등급 메일: deliver = 에이전트에게 보인다(읽으면 오염 T2 — 발송은 소유자 승인) · hold = 격리처럼 숨기고 소유자가 풀 때까지.
  risk_handling  text NOT NULL DEFAULT 'deliver' CHECK (risk_handling IN ('deliver', 'hold')),
  -- 위험 등급 메일이 오면 소유자에게 알림(기본 켬). 차단 등급은 이 값과 무관하게 **항상** 알린다.
  risk_notify    boolean NOT NULL DEFAULT true,
  updated_at     timestamptz NOT NULL DEFAULT now(),
  updated_by     uuid
);

COMMENT ON TABLE agent_watch_settings IS
  '감시 탭 — 에이전트별 받기 설정(ADR-0016 2026-10-08). 행이 없으면 기본값(risk_handling=deliver · risk_notify=true). 쓰기는 atmark_watch_set_agent 만.';

CREATE TABLE org_watch_settings (
  organization_id  uuid PRIMARY KEY REFERENCES organizations (id) ON DELETE RESTRICT,
  updated_at       timestamptz NOT NULL DEFAULT now(),
  updated_by       uuid
);

COMMENT ON TABLE org_watch_settings IS
  '감시 탭 — 조직 설정(ADR-0016 2026-10-08). 지금은 신뢰 발신자 목록이 마지막으로 바뀐 시각만. 칸은 다음 묶음이 더한다. 쓰기는 정의자 함수만.';

CREATE TABLE org_trusted_senders (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid NOT NULL REFERENCES organizations (id) ON DELETE RESTRICT,
  kind             text NOT NULL CHECK (kind IN ('address', 'domain')),
  value            text NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  created_by       uuid,
  removed_at       timestamptz,
  removed_by       uuid,
  -- 값 모양 = 종류. 소문자만(수신 From 은 소비자가 소문자로 접는다). 도메인은 LDH 라벨 2개 이상 · 글자 TLD 또는 xn--(격리 알림 도메인과 같은 규칙).
  CONSTRAINT org_trusted_senders_value_kind CHECK (
    value = lower(value) AND (
      (kind = 'domain' AND length(value) <= 253
        AND value ~ '^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+([a-z]{2,63}|xn--[a-z0-9-]{1,59})$')
      OR (kind = 'address' AND length(value) <= 320
        AND value ~ '^[^@[:space:][:cntrl:]]{1,64}@([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+([a-z]{2,63}|xn--[a-z0-9-]{1,59})$'))),
  CONSTRAINT org_trusted_senders_removed_shape CHECK ((removed_at IS NULL) OR (removed_at >= created_at))
);

-- 살아 있는 항목은 (조직, 종류, 값)마다 하나 · 수신 소비자의 조회(조직의 살아 있는 항목).
CREATE UNIQUE INDEX org_trusted_senders_live_key ON org_trusted_senders (organization_id, kind, value) WHERE removed_at IS NULL;

-- 지우기는 표시 한 번(removed_at · removed_by) — 다른 칸은 바뀌지 않고, 지운 행은 되살아나지 않는다(다시 넣기 = 새 행). DELETE · TRUNCATE 금지.
CREATE FUNCTION org_trusted_senders_remove_once() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF OLD.removed_at IS NOT NULL OR NEW.removed_at IS NULL THEN
    RAISE EXCEPTION 'org_trusted_senders: 지우기 표시는 한 번만 — 되살리거나 다시 지울 수 없다(id=%)', OLD.id USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER org_trusted_senders_immutable BEFORE UPDATE ON org_trusted_senders
  FOR EACH ROW EXECUTE FUNCTION reject_column_update_except('removed_at', 'removed_by');
CREATE TRIGGER org_trusted_senders_remove_once BEFORE UPDATE ON org_trusted_senders
  FOR EACH ROW EXECUTE FUNCTION org_trusted_senders_remove_once();
CREATE TRIGGER org_trusted_senders_no_delete BEFORE DELETE ON org_trusted_senders
  FOR EACH ROW EXECUTE FUNCTION reject_row_delete();
CREATE TRIGGER org_trusted_senders_no_truncate AFTER TRUNCATE ON org_trusted_senders
  FOR EACH STATEMENT EXECUTE FUNCTION reject_truncate();

-- 조직마다 살아 있는 항목 200 — 조직 잠금 아래 센다(동시 INSERT 둘이 199 를 함께 보지 않게).
CREATE FUNCTION org_trusted_senders_limit() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  live integer;
BEGIN
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('org_trusted_senders:' || NEW.organization_id::text, 0));
  SELECT count(*)::integer INTO live FROM public.org_trusted_senders s WHERE s.organization_id = NEW.organization_id AND s.removed_at IS NULL;
  IF live >= 200 THEN
    RAISE EXCEPTION 'org_trusted_senders: 조직마다 신뢰 발신자는 200개까지' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER org_trusted_senders_limit BEFORE INSERT ON org_trusted_senders
  FOR EACH ROW EXECUTE FUNCTION org_trusted_senders_limit();

COMMENT ON TABLE org_trusted_senders IS
  '감시 탭 — 신뢰 발신자(ADR-0016 2026-10-08). DMARC 인증된 From 이 항목(정확한 주소 · 정확한 도메인)과 같을 때만 탐지 효과를 건너뛴다(스캐너는 돌고 기록은 남는다). 살아 있는 항목 200. 지우기는 표시 한 번.';

-- ---------------------------------------------------------------------------
-- ② inbound_messages — 등급 · 우회 · 풀기
-- ---------------------------------------------------------------------------

ALTER TABLE inbound_messages
  ADD COLUMN watch_level text,
  ADD COLUMN trusted_bypass boolean NOT NULL DEFAULT false,
  ADD COLUMN released_at timestamptz,
  ADD COLUMN released_by uuid,
  ADD COLUMN released_from text;

-- 사유 목록에 risk_hold 를 더한다(같은 이름 — 목록 전체를 다시 적는다).
ALTER TABLE inbound_messages
  DROP CONSTRAINT inbound_messages_quarantine_reason_check,
  ADD CONSTRAINT inbound_messages_quarantine_reason_check
    CHECK (quarantine_reason IN ('injection_risk', 'scanner_error', 'policy_blocked', 'risk_hold')) NOT VALID;

-- high ⇒ 격리 — 신뢰 발신자 우회(소유자가 고른 DMARC 인증 발신자)와 소유자가 풀어 준 행만 예외(같은 이름).
ALTER TABLE inbound_messages
  DROP CONSTRAINT inbound_messages_high_is_quarantined,
  ADD CONSTRAINT inbound_messages_high_is_quarantined
    CHECK (injection_risk IS DISTINCT FROM 'high' OR quarantined OR trusted_bypass OR released_at IS NOT NULL) NOT VALID;

ALTER TABLE inbound_messages
  ADD CONSTRAINT inbound_messages_watch_level_check CHECK (watch_level IN ('none', 'risk', 'block')) NOT VALID,
  ADD CONSTRAINT inbound_messages_released_from_check CHECK (released_from IN ('injection_risk', 'risk_hold')) NOT VALID,
  -- 풀린 행 = 세 칸이 함께 · 보이고 · 판정이 있다(판정 없음은 풀 수 없다).
  ADD CONSTRAINT inbound_messages_release_shape CHECK (
    (released_at IS NULL) = (released_from IS NULL) AND (released_at IS NULL) = (released_by IS NULL)
    AND (released_at IS NULL OR (NOT quarantined AND quarantine_reason IS NULL AND injection_risk IS NOT NULL))) NOT VALID,
  -- 신뢰 발신자 우회 = DMARC 인증된 From 만 · 판정이 있다 · 인젝션 사유로 숨지 않았다(우회가 그 효과를 지웠다).
  ADD CONSTRAINT inbound_messages_trusted_bypass_shape CHECK (
    NOT trusted_bypass OR (from_authenticated AND injection_risk IS NOT NULL
                           AND quarantine_reason IS DISTINCT FROM 'injection_risk' AND quarantine_reason IS DISTINCT FROM 'risk_hold'
                           AND quarantine_reason IS DISTINCT FROM 'scanner_error')) NOT VALID,
  -- 등급과 숨김 사유가 어긋나지 않는다: 인젝션 · 판정 없음 = block · 위험 보류 = risk · 우회 = none · 풀린 행은 무엇에서 풀었나와 같은 등급 ·
  -- 풀리지 않은 block 은 숨어 있다.
  ADD CONSTRAINT inbound_messages_watch_level_shape CHECK (
    watch_level IS NULL OR (
      (quarantine_reason IS NULL OR quarantine_reason = 'policy_blocked'
        OR watch_level = CASE quarantine_reason WHEN 'risk_hold' THEN 'risk' ELSE 'block' END)
      AND (NOT trusted_bypass OR watch_level = 'none')
      AND (released_from IS NULL OR watch_level = CASE released_from WHEN 'risk_hold' THEN 'risk' ELSE 'block' END)
      AND (watch_level <> 'block' OR quarantined OR released_at IS NOT NULL))) NOT VALID;

COMMENT ON COLUMN inbound_messages.watch_level IS
  '수신 시점 사용자 등급(src/security/levels.ts) — none|risk|block. 202610081000 이전 행은 NULL. 풀어도 바뀌지 않는다.';
COMMENT ON COLUMN inbound_messages.trusted_bypass IS
  '신뢰 발신자 우회가 적용됐다 — DMARC 인증된 From 이 조직 목록과 같았다. 스캐너 판정 · 적중은 그대로 남는다(security_findings).';
COMMENT ON COLUMN inbound_messages.released_at IS
  '소유자가 콘솔에서 풀어 준 시각(atmark_watch_release_inbound). 풀린 메일의 노출은 늘 오염 T2(src/security/taint.ts).';

-- INSERT 는 풀린 칸을 채울 수 없다 · 풀기는 격리(injection_risk | risk_hold) → 보임 한 방향 한 번. 다른 변화는 없다(모든 롤).
CREATE FUNCTION inbound_messages_release_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.released_at IS NOT NULL OR NEW.released_by IS NOT NULL OR NEW.released_from IS NOT NULL THEN
      RAISE EXCEPTION 'inbound_messages: 풀린 칸은 INSERT 로 채울 수 없다' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF (NEW.quarantined, NEW.quarantine_reason, NEW.released_at, NEW.released_by, NEW.released_from)
     IS NOT DISTINCT FROM (OLD.quarantined, OLD.quarantine_reason, OLD.released_at, OLD.released_by, OLD.released_from) THEN
    RETURN NEW;
  END IF;
  IF NOT (OLD.released_at IS NULL AND OLD.quarantined AND OLD.quarantine_reason IN ('injection_risk', 'risk_hold') AND OLD.injection_risk IS NOT NULL
          AND NOT NEW.quarantined AND NEW.quarantine_reason IS NULL
          AND NEW.released_at IS NOT NULL AND NEW.released_by IS NOT NULL AND NEW.released_from = OLD.quarantine_reason) THEN
    RAISE EXCEPTION 'inbound_messages: 격리 칸은 풀기(격리 → 보임 한 번)로만 바뀐다(id=%)', OLD.id USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER inbound_messages_release_guard
  BEFORE INSERT OR UPDATE OF quarantined, quarantine_reason, released_at, released_by, released_from ON inbound_messages
  FOR EACH ROW EXECUTE FUNCTION inbound_messages_release_guard();

-- 불변 allow-list 에 풀기 다섯 칸을 더한다(표시 · 감시 보류 칸 + 풀기). 무엇이 어떻게 바뀌는지는 위 가드가 정한다.
DROP TRIGGER inbound_messages_immutable_except_display ON inbound_messages;
CREATE TRIGGER inbound_messages_immutable_except_display
  BEFORE UPDATE ON inbound_messages
  FOR EACH ROW EXECUTE FUNCTION reject_column_update_except('display_thread_id', 'ai_hold_until', 'ai_watch_job_id',
                                                            'quarantined', 'quarantine_reason', 'released_at', 'released_by', 'released_from');

-- ---------------------------------------------------------------------------
-- ③ 정의자 함수 — admin 롤(콘솔). 조직 인자는 범위다(인가 · 역할은 라우트). 감사 행은 라우트가 같은 트랜잭션에 적는다(`audited`).
-- ---------------------------------------------------------------------------

-- 에이전트 설정 바꾸기 — NULL 인자는 지금 값 그대로. 결과: not_found | unchanged | changed (+ 바뀐 뒤 값).
CREATE FUNCTION atmark_watch_set_agent(p_organization_id uuid, p_agent_id text, p_risk_handling text, p_risk_notify boolean, p_user_id uuid)
RETURNS TABLE (outcome text, r_risk_handling text, r_risk_notify boolean, r_updated_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  current_handling text;
  current_notify boolean;
  current_at timestamptz;
  next_handling text;
  next_notify boolean;
BEGIN
  PERFORM 1 FROM public.agents a WHERE a.id = p_agent_id::bpchar AND a.organization_id = p_organization_id FOR SHARE OF a;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'not_found'::text, NULL::text, NULL::boolean, NULL::timestamptz;
    RETURN;
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('agent_watch_settings:' || p_agent_id, 0));
  SELECT s.risk_handling, s.risk_notify, s.updated_at INTO current_handling, current_notify, current_at
    FROM public.agent_watch_settings s WHERE s.agent_id = p_agent_id::bpchar;
  current_handling := coalesce(current_handling, 'deliver');
  current_notify := coalesce(current_notify, true);
  next_handling := coalesce(p_risk_handling, current_handling);
  next_notify := coalesce(p_risk_notify, current_notify);
  IF next_handling = current_handling AND next_notify = current_notify THEN
    RETURN QUERY SELECT 'unchanged'::text, current_handling, current_notify, current_at;
    RETURN;
  END IF;
  INSERT INTO public.agent_watch_settings AS s (agent_id, risk_handling, risk_notify, updated_at, updated_by)
  VALUES (p_agent_id::bpchar, next_handling, next_notify, pg_catalog.now(), p_user_id)
  ON CONFLICT (agent_id) DO UPDATE
    SET risk_handling = EXCLUDED.risk_handling, risk_notify = EXCLUDED.risk_notify, updated_at = EXCLUDED.updated_at, updated_by = EXCLUDED.updated_by
  RETURNING s.updated_at INTO current_at;
  RETURN QUERY SELECT 'changed'::text, next_handling, next_notify, current_at;
END;
$$;

REVOKE ALL ON FUNCTION atmark_watch_set_agent(uuid, text, text, boolean, uuid) FROM PUBLIC;

-- 신뢰 발신자 목록을 **통째로** 바꾼다(콘솔 저장 한 번 = 목록 하나). 빠진 항목은 지우기 표시 · 새 항목은 새 행 · 남은 항목은 그대로(만든 시각 보존).
-- 결과: too_many(200 초과 — 아무것도 바꾸지 않는다) | unchanged | changed (+ 더한 수 · 지운 수). 값 모양은 표의 CHECK 가 본다(23514).
CREATE FUNCTION atmark_watch_set_trusted_senders(p_organization_id uuid, p_kinds text[], p_values text[], p_user_id uuid)
RETURNS TABLE (outcome text, r_added integer, r_removed integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  n integer := coalesce(pg_catalog.array_length(p_kinds, 1), 0);
  added integer := 0;
  removed integer := 0;
BEGIN
  IF n <> coalesce(pg_catalog.array_length(p_values, 1), 0) THEN
    RAISE EXCEPTION 'atmark_watch_set_trusted_senders: 종류와 값의 수가 다르다' USING ERRCODE = '22023';
  END IF;
  IF n > 200 THEN
    RETURN QUERY SELECT 'too_many'::text, 0, 0;
    RETURN;
  END IF;
  PERFORM 1 FROM public.organizations o WHERE o.id = p_organization_id FOR SHARE OF o;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'atmark_watch_set_trusted_senders: 조직이 없다' USING ERRCODE = '23503';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('org_trusted_senders:' || p_organization_id::text, 0));
  WITH wanted AS (SELECT DISTINCT k AS kind, v AS value FROM unnest(p_kinds, p_values) AS w(k, v)),
       gone AS (
         UPDATE public.org_trusted_senders s SET removed_at = pg_catalog.now(), removed_by = p_user_id
          WHERE s.organization_id = p_organization_id AND s.removed_at IS NULL
            AND NOT EXISTS (SELECT 1 FROM wanted w WHERE w.kind = s.kind AND w.value = s.value)
         RETURNING 1)
  SELECT count(*)::integer INTO removed FROM gone;
  WITH wanted AS (SELECT DISTINCT k AS kind, v AS value FROM unnest(p_kinds, p_values) AS w(k, v)),
       fresh AS (
         INSERT INTO public.org_trusted_senders (organization_id, kind, value, created_by)
         SELECT p_organization_id, w.kind, w.value, p_user_id FROM wanted w
          WHERE NOT EXISTS (SELECT 1 FROM public.org_trusted_senders s
                             WHERE s.organization_id = p_organization_id AND s.removed_at IS NULL AND s.kind = w.kind AND s.value = w.value)
         RETURNING 1)
  SELECT count(*)::integer INTO added FROM fresh;
  IF added = 0 AND removed = 0 THEN
    RETURN QUERY SELECT 'unchanged'::text, 0, 0;
    RETURN;
  END IF;
  INSERT INTO public.org_watch_settings AS o (organization_id, updated_at, updated_by)
  VALUES (p_organization_id, pg_catalog.now(), p_user_id)
  ON CONFLICT (organization_id) DO UPDATE SET updated_at = EXCLUDED.updated_at, updated_by = EXCLUDED.updated_by;
  RETURN QUERY SELECT 'changed'::text, added, removed;
END;
$$;

REVOKE ALL ON FUNCTION atmark_watch_set_trusted_senders(uuid, text[], text[], uuid) FROM PUBLIC;

-- 풀어 주기 — 조직의 숨은 메일(격리 injection_risk · 위험 보류 risk_hold) 하나를 에이전트에게 보이게 하고, **같은 트랜잭션에서** `message.received`
-- 웹훅을 적는다(받을 때 격리 행은 웹훅이 없었다 — 에이전트가 풀린 메일을 알게). 웹훅 본문은 라우트가 `messageReceivedEvent` 로 만들어 넘기고,
-- 이 함수는 그 본문이 이 메일의 것인지(id · 종류 · 에이전트 · 시각 · data 전부) 확인한 뒤에만 적는다(다른 메일 · 다른 에이전트의 이벤트를 실을 수 없다).
-- 결과: not_found(없음 · 다른 조직) | replayed(이미 풀림) | policy_blocked(소유자 정책 차단 — 풀지 않는다: 정책을 고칠 일) |
--       not_releasable(판정 없음 — 검사를 마치지 못한 메일은 풀지 않는다, fail closed) | not_held(숨은 메일이 아니다) | released.
CREATE FUNCTION atmark_watch_release_inbound(p_organization_id uuid, p_message_id uuid, p_user_id uuid, p_event_id uuid, p_event_body text)
RETURNS TABLE (outcome text, r_agent_id text, r_released_at timestamptz, r_released_from text, r_webhooks integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  target record;
  body jsonb;
  expected jsonb;
  at_text text;
  stamped timestamptz;
  queued integer := 0;
BEGIN
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'atmark_watch_release_inbound: 푼 사용자가 필요하다' USING ERRCODE = '22004';
  END IF;
  SELECT m.id, m.agent_id::text AS agent_id, m.thread_id, m.received_at, m.quarantined, m.quarantine_reason, m.injection_risk,
         m.released_at, m.released_from
    INTO target
    FROM public.inbound_messages m JOIN public.agents a ON a.id = m.agent_id
   WHERE m.id = p_message_id AND a.organization_id = p_organization_id
     FOR UPDATE OF m;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'not_found'::text, NULL::text, NULL::timestamptz, NULL::text, 0;
    RETURN;
  END IF;
  IF target.released_at IS NOT NULL THEN
    RETURN QUERY SELECT 'replayed'::text, target.agent_id, target.released_at, target.released_from, 0;
    RETURN;
  END IF;
  IF target.quarantine_reason = 'policy_blocked' THEN
    RETURN QUERY SELECT 'policy_blocked'::text, target.agent_id, NULL::timestamptz, NULL::text, 0;
    RETURN;
  END IF;
  IF target.quarantine_reason = 'scanner_error' OR target.injection_risk IS NULL THEN
    RETURN QUERY SELECT 'not_releasable'::text, target.agent_id, NULL::timestamptz, NULL::text, 0;
    RETURN;
  END IF;
  IF NOT target.quarantined OR target.quarantine_reason IS NULL OR target.quarantine_reason NOT IN ('injection_risk', 'risk_hold') THEN
    RETURN QUERY SELECT 'not_held'::text, target.agent_id, NULL::timestamptz, NULL::text, 0;
    RETURN;
  END IF;

  at_text := pg_catalog.to_char(target.received_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
  body := p_event_body::jsonb;
  expected := pg_catalog.jsonb_build_object(
    'id', p_event_id::text, 'type', 'message.received', 'created_at', at_text, 'agent_id', target.agent_id,
    'data', pg_catalog.jsonb_build_object('message_id', target.id::text, 'thread_id', target.thread_id::text, 'received_at', at_text));
  IF pg_catalog.jsonb_typeof(body) IS DISTINCT FROM 'object' OR pg_catalog.jsonb_typeof(body -> 'api_version') IS DISTINCT FROM 'string'
     OR (body - 'api_version') IS DISTINCT FROM expected THEN
    RAISE EXCEPTION 'atmark_watch_release_inbound: 웹훅 본문이 이 메일의 message.received 가 아니다' USING ERRCODE = '22023';
  END IF;

  UPDATE public.inbound_messages m
     SET quarantined = false, quarantine_reason = NULL, released_at = pg_catalog.now(), released_by = p_user_id, released_from = target.quarantine_reason
   WHERE m.id = target.id
  RETURNING m.released_at INTO stamped;

  -- `enqueueWebhookEvent`(webhook-store.ts)와 같은 문장 — 켜진 엔드포인트 중 이 종류를 구독한 것(구독 목록 NULL = 옛 4종). 받은 시각이 아니라 지금 보낸다.
  INSERT INTO public.webhook_deliveries (event_id, endpoint_id, event_type, dedupe_key, body, next_attempt_at)
  SELECT p_event_id, e.id, 'message.received'::public.webhook_event_type, 'message.received:' || target.id::text, p_event_body, pg_catalog.now()
    FROM public.webhook_endpoints e
   WHERE e.agent_id = target.agent_id::bpchar AND e.disabled_at IS NULL
     AND 'message.received'::public.webhook_event_type = ANY (COALESCE(e.event_types,
           ARRAY['approval.resolved', 'approval.expired', 'message.sent', 'message.received']::public.webhook_event_type[]))
  ON CONFLICT (endpoint_id, dedupe_key) DO NOTHING;
  GET DIAGNOSTICS queued = ROW_COUNT;
  RETURN QUERY SELECT 'released'::text, target.agent_id, stamped, target.quarantine_reason::text, queued;
END;
$$;

REVOKE ALL ON FUNCTION atmark_watch_release_inbound(uuid, uuid, uuid, uuid, text) FROM PUBLIC;

-- ---------------------------------------------------------------------------
-- ④ 격리 알림 — 종류(block | risk) · 위험 항목 사유 두 값. 트리거 함수 · 열린 창 색인은 1002 · 1003.
-- ---------------------------------------------------------------------------

ALTER TABLE quarantine_notices ADD COLUMN kind text NOT NULL DEFAULT 'block';
ALTER TABLE quarantine_notices ADD CONSTRAINT quarantine_notices_kind_check CHECK (kind IN ('block', 'risk')) NOT VALID;

ALTER TABLE quarantine_notice_items
  DROP CONSTRAINT quarantine_notice_items_reason_check,
  ADD CONSTRAINT quarantine_notice_items_reason_check
    CHECK (reason IN ('injection_risk', 'scanner_error', 'risk_hold', 'risk_delivered')) NOT VALID;

COMMENT ON COLUMN quarantine_notices.kind IS
  '알림 종류 — block(차단 등급 · 항상 알림) | risk(위험 등급 · 에이전트 설정 risk_notify). 에이전트 · 종류마다 열린 창 하나(1002 색인).';

-- ---------------------------------------------------------------------------
-- GRANT — `src/runtime/role-bootstrap.ts` `RESTRICTED_ROLE_GRANTS` 와 같다(migrate status 가 대조)
-- ---------------------------------------------------------------------------

-- 앱 롤(수신 소비자 · 알림기): 설정 읽기만. 표 쓰기 0.
GRANT SELECT (agent_id, risk_handling, risk_notify) ON agent_watch_settings TO atmark_app;
GRANT SELECT (organization_id, kind, value, removed_at) ON org_trusted_senders TO atmark_app;
GRANT SELECT (kind) ON quarantine_notices TO atmark_app;
-- admin 롤(콘솔): 읽기 + 정의자 함수 셋. 표 쓰기 0.
GRANT SELECT ON agent_watch_settings, org_watch_settings, org_trusted_senders TO atmark_admin;
-- 보류 목록의 계열(본문 없음 — 계열 이름 · 완화 여부뿐).
GRANT SELECT (inbound_message_id, scanner_version, family, damped) ON security_findings TO atmark_admin;
GRANT EXECUTE ON FUNCTION atmark_watch_set_agent(uuid, text, text, boolean, uuid) TO atmark_admin;
GRANT EXECUTE ON FUNCTION atmark_watch_set_trusted_senders(uuid, text[], text[], uuid) TO atmark_admin;
GRANT EXECUTE ON FUNCTION atmark_watch_release_inbound(uuid, uuid, uuid, uuid, text) TO atmark_admin;
