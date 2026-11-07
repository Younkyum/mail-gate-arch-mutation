-- 202610081300_realtime_connections.sql
-- 실시간 WebSocket(묶음 E — docs/internal/plans/watch-and-dev-surface.md): **연결 표** · 정의 함수 · 권한.
--
--   ① `realtime_connections` — API Gateway WebSocket 연결 하나 = 행 하나(`connection_id` = API Gateway 가 준 id). 에이전트 · 조직 · 연결에 쓴 토큰
--      (`api_key_id` — 토큰을 폐기하면 그 연결로 가는 푸시도 멈춘다) · 연결 시각 · 만료(연결 + 2시간 — API Gateway 하드 한도) · 마지막 핑 · 닫힘.
--      **지우지 않는다 — 닫는다**(`closed_at` · `close_reason`: disconnect | gone(410) | expired | stale(핑 15분 없음)). 닫힌 지 7일 넘은 행만 스윕이
--      지운다(트리거가 그 밖의 DELETE 를 거부한다 — 운영 메타데이터라 보존할 이유가 없다). 시각은 DB 가 적는다.
--      **에이전트당 열린 연결 5개**(트리거 — 에이전트 잠금 아래 셈, SQLSTATE 53400).
--   ② 정의 함수(소유자 소유 · search_path 고정 · PUBLIC 실행 불가):
--      - `atmark_realtime_connect(connection_id, agent_id, token_hash)` — 앱 롤(실시간 λ). 토큰 재확인(그 에이전트의 것 · 폐기/만료 아님 ·
--        `messages:read`) · 에이전트 활성 · 조직 정지/동결/검토 전 아님 → 행. 결과 connected | duplicate | limit | inactive | token_invalid.
--      - `atmark_realtime_disconnect(connection_id, reason)` — 앱(실시간 λ의 $disconnect · 만드는 λ 의 410) · admin · AI 감시 롤. 열린 행만 닫는다.
--      - `atmark_realtime_seen(connection_id)` — 앱. 핑 — `last_seen_at`(1분 코얼레싱).
--      - `atmark_realtime_inbound_targets(ids uuid[])` — 앱 · admin. **에이전트에게 지금 보이는 메일만**(읽기 저장소의 `visibleToAgent` ·
--        `releasedToAgent` 와 같은 술어 — 격리 · 위험 보류 · 판정 없음 · AI 보류 중이면 0행) × **그 메일의 에이전트의** 열린 연결(만료 · 닫힘 ·
--        폐기된 토큰 · 정지된 에이전트/조직 제외). 이 함수가 대상을 정하므로 호출자가 다른 에이전트의 연결을 고를 길이 없다.
--      - `atmark_realtime_job_targets(job_id)` — AI 감시 롤. 그 작업의 메일들 → 위 함수.
--      - `atmark_realtime_approval_targets(approval_id)` — 앱. 결정된(승인 · 거절) 요청 × 그 에이전트의 열린 연결.
--      - `atmark_realtime_sweep()` — 앱(approval-expiry 5분 틱). 만료 · 핑 없는 열린 행 닫기 · 7일 넘게 닫힌 행 지우기(각 5000).
--   ③ 권한: 표 권한은 어느 제한 롤에도 없다(EXECUTE 만 — `RESTRICTED_ROLE_GRANTS`). AI 감시 롤은 `ai_watch_apply_role_grants()` 를 다시 정의해 준다
--      (롤이 없으면 아무것도 하지 않는다 — bootstrap-roles 가 롤을 만든 뒤 부른다).
--
-- 잠금: 새 표 하나 · 함수 · `ai_watch_apply_role_grants` 다시 정의. 다른 표를 잠그지 않는다(FK 대상 agents · organizations · agent_api_keys 는
-- SHARE ROW EXCLUSIVE — 짧다). 5초 안에 못 잡으면 실패한다.
-- **순서:** 터널 migrate(1300) → `deploy-compute migrate=false`. 옛 코드는 이 표 · 함수를 모른다(expand-only).

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
-- ① realtime_connections
-- ---------------------------------------------------------------------------

CREATE TABLE realtime_connections (
  -- API Gateway connectionId(예: `L0SM9cOFvHcCIhw=`) — 모양만 본다.
  connection_id   text PRIMARY KEY CHECK (connection_id ~ '^[A-Za-z0-9_=+/-]{1,128}$'),
  agent_id        char(32) NOT NULL REFERENCES agents (id) ON DELETE RESTRICT,
  organization_id uuid NOT NULL REFERENCES organizations (id) ON DELETE RESTRICT,
  api_key_id      uuid NOT NULL REFERENCES agent_api_keys (id) ON DELETE RESTRICT,
  connected_at    timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz NOT NULL,
  last_seen_at    timestamptz NOT NULL DEFAULT now(),
  closed_at       timestamptz,
  close_reason    text,
  CONSTRAINT realtime_connections_ttl CHECK (expires_at > connected_at AND expires_at <= connected_at + interval '2 hours'),
  CONSTRAINT realtime_connections_closed_shape CHECK ((closed_at IS NULL) = (close_reason IS NULL)),
  CONSTRAINT realtime_connections_close_reason_check CHECK (close_reason IN ('disconnect', 'gone', 'expired', 'stale')),
  CONSTRAINT realtime_connections_time_order CHECK (last_seen_at >= connected_at AND (closed_at IS NULL OR closed_at >= connected_at))
);

-- 열린 연결(상한 계수 · 대상 조회) · 닫힌 행(보존 스윕).
CREATE INDEX realtime_connections_open_agent_idx ON realtime_connections (agent_id) WHERE closed_at IS NULL;
CREATE INDEX realtime_connections_closed_idx ON realtime_connections (closed_at) WHERE closed_at IS NOT NULL;

-- 정체성 · 시각은 DB 가 정한다 · 상한 5 · 닫힘은 한 번 · 핑 시각은 앞으로만.
CREATE FUNCTION realtime_connections_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.connected_at := now();
    NEW.last_seen_at := NEW.connected_at;
    NEW.expires_at := NEW.connected_at + interval '2 hours';
    IF NEW.closed_at IS NOT NULL OR NEW.close_reason IS NOT NULL THEN
      RAISE EXCEPTION 'a new realtime connection starts open' USING ERRCODE = '23514';
    END IF;
    PERFORM pg_advisory_xact_lock(hashtextextended('realtime_connections:' || NEW.agent_id, 0));
    IF (SELECT count(*) FROM realtime_connections c
         WHERE c.agent_id = NEW.agent_id AND c.closed_at IS NULL AND c.expires_at > now()) >= 5 THEN
      RAISE EXCEPTION 'realtime connection limit reached for agent' USING ERRCODE = '53400', HINT = 'realtime_connection_limit';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.connection_id <> OLD.connection_id OR NEW.agent_id <> OLD.agent_id OR NEW.organization_id <> OLD.organization_id
     OR NEW.api_key_id <> OLD.api_key_id OR NEW.connected_at <> OLD.connected_at OR NEW.expires_at <> OLD.expires_at THEN
    RAISE EXCEPTION 'realtime_connections identity columns are immutable' USING ERRCODE = '23514';
  END IF;
  IF OLD.closed_at IS NOT NULL THEN
    IF NEW.closed_at IS DISTINCT FROM OLD.closed_at OR NEW.close_reason IS DISTINCT FROM OLD.close_reason OR NEW.last_seen_at <> OLD.last_seen_at THEN
      RAISE EXCEPTION 'a closed realtime connection cannot change' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.closed_at IS NOT NULL THEN
    NEW.closed_at := greatest(now(), OLD.connected_at);
  END IF;
  NEW.last_seen_at := greatest(OLD.last_seen_at, least(NEW.last_seen_at, now()));
  RETURN NEW;
END;
$$;

CREATE TRIGGER realtime_connections_guard
  BEFORE INSERT OR UPDATE ON realtime_connections
  FOR EACH ROW EXECUTE FUNCTION realtime_connections_guard();

-- 지우기는 닫힌 지 7일 넘은 행만(보존 스윕). 열린 연결 · 최근 행을 지우면 상한 계수와 조사 기록이 사라진다.
CREATE FUNCTION realtime_connections_delete_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.closed_at IS NULL OR OLD.closed_at > now() - interval '7 days' THEN
    RAISE EXCEPTION 'only realtime connections closed more than 7 days ago may be deleted' USING ERRCODE = '23514';
  END IF;
  RETURN OLD;
END;
$$;

CREATE TRIGGER realtime_connections_delete_guard
  BEFORE DELETE ON realtime_connections
  FOR EACH ROW EXECUTE FUNCTION realtime_connections_delete_guard();

CREATE TRIGGER realtime_connections_no_truncate
  AFTER TRUNCATE ON realtime_connections
  FOR EACH STATEMENT EXECUTE FUNCTION reject_truncate();

COMMENT ON TABLE realtime_connections IS
  '실시간 WebSocket 연결(묶음 E) — 행 하나 = API Gateway 연결 하나. 닫는다(closed_at · close_reason), 닫힌 지 7일 넘은 행만 스윕이 지운다. 에이전트당 열린 연결 5(트리거). 표 권한은 제한 롤에 없다 — 정의 함수로만.';

-- ---------------------------------------------------------------------------
-- ② 정의 함수
-- ---------------------------------------------------------------------------

CREATE FUNCTION atmark_realtime_connect(p_connection_id text, p_agent_id text, p_token_hash text)
RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  key_id uuid;
  org_id uuid;
  existing record;
BEGIN
  -- 토큰 재확인 — 판정의 정본은 앱(`authenticateAgentToken`)이고, 여기서는 "그 에이전트의 살아 있는 `messages:read` 토큰" 인지만 본다(이중 방어).
  SELECT k.id INTO key_id FROM public.agent_api_keys k
   WHERE k.token_hash = p_token_hash AND k.agent_id = p_agent_id AND k.revoked_at IS NULL
     AND (k.expires_at IS NULL OR k.expires_at > now())
     AND 'messages:read'::public.agent_token_capability = ANY (k.capabilities);
  IF key_id IS NULL THEN
    RETURN 'token_invalid';
  END IF;
  SELECT a.organization_id INTO org_id FROM public.agents a JOIN public.organizations o ON o.id = a.organization_id
   WHERE a.id = p_agent_id AND a.status = 'active' AND NOT o.owner_paused AND NOT o.abuse_freeze AND o.review_status = 'active';
  IF org_id IS NULL THEN
    RETURN 'inactive';
  END IF;
  BEGIN
    INSERT INTO public.realtime_connections (connection_id, agent_id, organization_id, api_key_id, expires_at)
    VALUES (p_connection_id, p_agent_id, org_id, key_id, now() + interval '2 hours');
  EXCEPTION
    WHEN configuration_limit_exceeded THEN
      RETURN 'limit';
    WHEN unique_violation THEN
      SELECT c.agent_id, c.closed_at INTO existing FROM public.realtime_connections c WHERE c.connection_id = p_connection_id;
      IF existing.agent_id = p_agent_id AND existing.closed_at IS NULL THEN
        RETURN 'duplicate';
      END IF;
      RETURN 'token_invalid';
  END;
  RETURN 'connected';
END;
$$;

CREATE FUNCTION atmark_realtime_disconnect(p_connection_id text, p_reason text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF p_reason NOT IN ('disconnect', 'gone') THEN
    RAISE EXCEPTION 'atmark_realtime_disconnect: reason must be disconnect | gone' USING ERRCODE = '22023';
  END IF;
  UPDATE public.realtime_connections SET closed_at = now(), close_reason = p_reason
   WHERE connection_id = p_connection_id AND closed_at IS NULL;
  RETURN FOUND;
END;
$$;

CREATE FUNCTION atmark_realtime_seen(p_connection_id text) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  UPDATE public.realtime_connections SET last_seen_at = now()
   WHERE connection_id = p_connection_id AND closed_at IS NULL AND last_seen_at < now() - interval '1 minute';
$$;

CREATE FUNCTION atmark_realtime_inbound_targets(p_inbound_message_ids uuid[])
RETURNS TABLE (connection_id text, agent_id text, inbound_message_id uuid, thread_id uuid, received_at timestamptz, risk_level text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT c.connection_id, c.agent_id::text, m.id, m.thread_id, m.received_at, coalesce(m.watch_level, 'none')
    FROM public.inbound_messages m
    JOIN public.realtime_connections c ON c.agent_id = m.agent_id
    JOIN public.agent_api_keys k ON k.id = c.api_key_id
    JOIN public.agents a ON a.id = m.agent_id
    JOIN public.organizations o ON o.id = a.organization_id
   WHERE m.id = ANY (p_inbound_message_ids[1:100])
     -- 에이전트에게 보이는 메일(`inbound-read-store.ts` visibleToAgent · releasedToAgent 와 같은 술어).
     AND NOT m.quarantined AND m.injection_risk IS NOT NULL
     AND (m.ai_hold_until IS NULL OR m.ai_hold_until <= now())
     -- 살아 있는 연결 · 토큰 · 에이전트 · 조직.
     AND c.closed_at IS NULL AND c.expires_at > now()
     AND k.revoked_at IS NULL AND (k.expires_at IS NULL OR k.expires_at > now())
     AND a.status = 'active' AND NOT o.owner_paused AND NOT o.abuse_freeze
   ORDER BY m.id, c.connected_at
   LIMIT 500
$$;

CREATE FUNCTION atmark_realtime_job_targets(p_job_id uuid)
RETURNS TABLE (connection_id text, agent_id text, inbound_message_id uuid, thread_id uuid, received_at timestamptz, risk_level text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT t.* FROM public.atmark_realtime_inbound_targets(
    ARRAY(SELECT m.id FROM public.inbound_messages m WHERE m.ai_watch_job_id = p_job_id ORDER BY m.id LIMIT 100)) AS t
$$;

CREATE FUNCTION atmark_realtime_approval_targets(p_approval_id uuid)
RETURNS TABLE (connection_id text, agent_id text, approval_id uuid, decision text, resolved_at timestamptz, message_ids uuid[])
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT c.connection_id, c.agent_id::text, r.id, r.status::text, r.decided_at,
         ARRAY(SELECT i.message_id FROM public.approval_request_items i WHERE i.approval_id = r.id ORDER BY i.created_at, i.message_id LIMIT 100)
    FROM public.approval_requests r
    JOIN public.realtime_connections c ON c.agent_id = r.agent_id
    JOIN public.agent_api_keys k ON k.id = c.api_key_id
    JOIN public.agents a ON a.id = r.agent_id
    JOIN public.organizations o ON o.id = a.organization_id
   WHERE r.id = p_approval_id AND r.status IN ('approved', 'rejected') AND r.decided_at IS NOT NULL
     AND c.closed_at IS NULL AND c.expires_at > now()
     AND k.revoked_at IS NULL AND (k.expires_at IS NULL OR k.expires_at > now())
     AND a.status = 'active' AND NOT o.owner_paused AND NOT o.abuse_freeze
   ORDER BY c.connected_at
   LIMIT 10
$$;

CREATE FUNCTION atmark_realtime_sweep() RETURNS TABLE (closed integer, purged integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  n_closed integer;
  n_purged integer;
BEGIN
  UPDATE public.realtime_connections c
     SET closed_at = now(), close_reason = CASE WHEN c.expires_at <= now() THEN 'expired' ELSE 'stale' END
   WHERE c.connection_id IN (SELECT o.connection_id FROM public.realtime_connections o
                              WHERE o.closed_at IS NULL AND (o.expires_at <= now() OR o.last_seen_at < now() - interval '15 minutes')
                              LIMIT 5000);
  GET DIAGNOSTICS n_closed = ROW_COUNT;
  DELETE FROM public.realtime_connections c
   WHERE c.connection_id IN (SELECT o.connection_id FROM public.realtime_connections o
                              WHERE o.closed_at IS NOT NULL AND o.closed_at < now() - interval '7 days'
                              LIMIT 5000);
  GET DIAGNOSTICS n_purged = ROW_COUNT;
  RETURN QUERY SELECT n_closed, n_purged;
END;
$$;

-- ---------------------------------------------------------------------------
-- ③ 권한
-- ---------------------------------------------------------------------------

REVOKE ALL ON realtime_connections FROM PUBLIC;
REVOKE ALL ON FUNCTION atmark_realtime_connect(text, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION atmark_realtime_disconnect(text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION atmark_realtime_seen(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION atmark_realtime_inbound_targets(uuid[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION atmark_realtime_job_targets(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION atmark_realtime_approval_targets(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION atmark_realtime_sweep() FROM PUBLIC;
REVOKE ALL ON FUNCTION realtime_connections_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION realtime_connections_delete_guard() FROM PUBLIC;

-- 앱 롤 — 실시간 λ(연결 · 끊김 · 핑) · 수신 소비자 · 승인 링크(대상 · 410) · approval-expiry(스윕).
GRANT EXECUTE ON FUNCTION atmark_realtime_connect(text, text, text) TO atmark_app;
GRANT EXECUTE ON FUNCTION atmark_realtime_disconnect(text, text) TO atmark_app;
GRANT EXECUTE ON FUNCTION atmark_realtime_seen(text) TO atmark_app;
GRANT EXECUTE ON FUNCTION atmark_realtime_inbound_targets(uuid[]) TO atmark_app;
GRANT EXECUTE ON FUNCTION atmark_realtime_approval_targets(uuid) TO atmark_app;
GRANT EXECUTE ON FUNCTION atmark_realtime_sweep() TO atmark_app;
-- admin — 콘솔 풀기 뒤 푸시(대상 · 410).
GRANT EXECUTE ON FUNCTION atmark_realtime_inbound_targets(uuid[]) TO atmark_admin;
GRANT EXECUTE ON FUNCTION atmark_realtime_disconnect(text, text) TO atmark_admin;

-- AI 감시 결과 λ 롤 — 판정 기록(보류 풀림) 뒤 푸시. 202610061100 의 함수를 같은 모양으로 다시 정의하고 두 줄을 더한다.
CREATE OR REPLACE FUNCTION ai_watch_apply_role_grants() RETURNS boolean
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'atmark_ai_watch') THEN
    RETURN false;
  END IF;
  GRANT USAGE ON SCHEMA public TO atmark_ai_watch;
  GRANT EXECUTE ON FUNCTION public.ai_watch_record_verdict(uuid, text, text, text) TO atmark_ai_watch;
  GRANT EXECUTE ON FUNCTION public.ai_watch_record_heartbeat(text, text, boolean, boolean) TO atmark_ai_watch;
  GRANT EXECUTE ON FUNCTION public.purge_ai_watch_jobs() TO atmark_ai_watch;
  -- 202610081300 — 실시간 푸시(묶음 E).
  GRANT EXECUTE ON FUNCTION public.atmark_realtime_job_targets(uuid) TO atmark_ai_watch;
  GRANT EXECUTE ON FUNCTION public.atmark_realtime_disconnect(text, text) TO atmark_ai_watch;
  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION ai_watch_apply_role_grants() FROM PUBLIC;

SELECT ai_watch_apply_role_grants();
