-- 202610081301_realtime_live_cap_review.sql
-- 실시간 WebSocket 적대적 검증(2026-10-08 · docs/internal/adversarial/watch-e.md) 수정 — 202610081300 의 함수 셋을 같은 이름 · 같은 서명으로 다시 정의한다.
--
--   ① V-E-01 — 에이전트당 열린 연결 5 의 계수는 **살아 있는 토큰의 연결만** 센다(`realtime_connections_guard`). 유출 토큰을 폐기하고 새 토큰을
--      발급하면, 폐기 토큰으로 열어 둔 연결(핑으로 최대 2시간 유지)이 새 토큰의 `$connect` 를 429 로 막던 길을 닫는다. 그 연결로는 이미 푸시가 가지 않는다
--      (대상 함수가 토큰을 본다) — 남는 것은 스윕 전까지의 행뿐이다.
--   ② V-E-02 — 푸시 대상 함수 둘(`atmark_realtime_inbound_targets` · `atmark_realtime_approval_targets`)이 `$connect` 와 같은 조직 술어를 쓴다:
--      `review_status = 'active'` 를 더했다(정지 · 동결 · 에이전트 활성은 그대로 — 운영자 정지(suspended_by = operator)도 status <> active 다).
--      `atmark_realtime_job_targets` 는 받은 메일 대상 함수를 부르므로 따로 고치지 않는다.
--
-- 권한 · 소유 · 트리거 연결은 그대로(CREATE OR REPLACE 는 ACL 을 지킨다). 잠금: 함수 정의뿐(표 잠금 없음).
-- **순서:** 터널 migrate(1301) → `deploy-compute migrate=false`. 옛 코드와 함께 돌아도 된다(서명 · 결과 모양 그대로).

SET LOCAL lock_timeout = '5s';

CREATE OR REPLACE FUNCTION realtime_connections_guard() RETURNS trigger
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
    -- 202610081301 — 살아 있는 토큰의 연결만 센다(V-E-01: 폐기 · 만료된 토큰으로 열어 둔 연결이 새 토큰의 자리를 막지 않게).
    IF (SELECT count(*) FROM realtime_connections c
          JOIN agent_api_keys k ON k.id = c.api_key_id
         WHERE c.agent_id = NEW.agent_id AND c.closed_at IS NULL AND c.expires_at > now()
           AND k.revoked_at IS NULL AND (k.expires_at IS NULL OR k.expires_at > now())) >= 5 THEN
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

CREATE OR REPLACE FUNCTION atmark_realtime_inbound_targets(p_inbound_message_ids uuid[])
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
     -- 202610081301 — `$connect` 와 같은 조직 술어(V-E-02): 검토를 마친 조직만(pending_review · rejected 로 돌아가면 밀지 않는다).
     AND a.status = 'active' AND NOT o.owner_paused AND NOT o.abuse_freeze AND o.review_status = 'active'
   ORDER BY m.id, c.connected_at
   LIMIT 500
$$;

CREATE OR REPLACE FUNCTION atmark_realtime_approval_targets(p_approval_id uuid)
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
     AND a.status = 'active' AND NOT o.owner_paused AND NOT o.abuse_freeze AND o.review_status = 'active'
   ORDER BY c.connected_at
   LIMIT 10
$$;
