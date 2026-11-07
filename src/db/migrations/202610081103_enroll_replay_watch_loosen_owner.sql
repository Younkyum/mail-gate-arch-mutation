-- 202610081103_enroll_replay_watch_loosen_owner.sql
-- 묶음 D 적대 검증 후속(2026-10-08 — `docs/internal/adversarial/watch-d.md`, 리드 지시).
--
--   ① 자가 등록 재생 방지(D2-J005): `agent_enrollments.request_id`(api 가 요청마다 만든 id — 내부 이벤트의 `requestId`). admin 연산이 새 슬롯에 요청 id 를
--      싣고(칸은 NULL 허용 — 옛 행 · 배포 사이의 옛 코드), 슬롯 트리거는 이미 있는 id 면 P0A36(admin 연산 → `enroll_replayed`, 새 에이전트 없음). 동시 재생은 1104 의
--      UNIQUE 색인이 23505 로 막는다.
--      admin 롤 INSERT 칸 하나 더(`request_id`).
--   ② 위험 보류 풀기는 소유자만: `atmark_watch_set_agent` 가 hold → deliver 를 그 조직 owner 멤버십의 사용자에게만 허락한다(42501). 발신 승인 always → auto 는
--      정책 새 버전 경로(표 쓰기)라 DB 함수가 없다 — 콘솔 연산이 막는다(`admin/ops/watch.ts`).
--
-- 잠금: `agent_enrollments`(작은 새 표) 칸 하나 · 함수 교체 둘. 5초. 순서: 터널 migrate(1103 · 1104) → `deploy-compute migrate=false`.
-- 옛 코드는 request_id 를 넣지 않는다(NULL — 재생 방지만 배포 뒤부터). expand-only.

SET LOCAL lock_timeout = '5s';

ALTER TABLE agent_enrollments ADD COLUMN request_id text;

COMMENT ON COLUMN agent_enrollments.request_id IS
  '자가 등록 요청 id(api 가 요청마다 만든다 — 내부 이벤트 requestId). 같은 id 의 두 번째 슬롯은 없다(트리거 P0A36 · UNIQUE 색인). 202610081103 이전 행은 NULL.';

CREATE OR REPLACE FUNCTION agent_enrollments_admit() RETURNS trigger
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
  -- 재생 방지(적대 검증 D2-J005) — 요청 id 는 api 가 요청마다 만든다. 같은 id 는 두 번째 슬롯이 될 수 없다(커밋된 행 — 여기서 결정적으로 ·
  -- 동시 재생 — UNIQUE 색인 agent_enrollments_request_id_key 가 23505 로).
  --   admin 연산(`admin/ops/enroll.ts`)은 늘 싣는다 — 칸은 NULL 을 허용한다(옛 행 · 배포 사이의 옛 코드). 모양만 본다.
  IF NEW.request_id IS NOT NULL AND NEW.request_id !~ '^[A-Za-z0-9._:-]{1,128}$' THEN
    RAISE EXCEPTION 'agent_enrollments: 요청 id 모양' USING ERRCODE = '23514';
  END IF;
  IF NEW.request_id IS NOT NULL AND EXISTS (SELECT 1 FROM public.agent_enrollments e WHERE e.request_id = NEW.request_id) THEN
    RAISE EXCEPTION 'agent_enrollments: 이미 처리한 요청 id 다' USING ERRCODE = 'P0A36';
  END IF;
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

CREATE OR REPLACE FUNCTION atmark_watch_set_agent(p_organization_id uuid, p_agent_id text, p_risk_handling text, p_risk_notify boolean, p_user_id uuid)
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
  -- 풀기는 소유자만(2026-10-08 리드 — 적대 검증 후속): hold → deliver(위험 메일을 에이전트에게 보인다)는 그 조직의 살아 있는 owner 멤버십이 있는 사용자만.
  -- 관리자는 조이기만(deliver → hold) 한다. 콘솔 연산(`admin/ops/watch.ts`)이 먼저 403 으로 답하고, 이 검사는 그 뒤의 마지막 선이다.
  IF current_handling = 'hold' AND next_handling = 'deliver'
     AND NOT EXISTS (SELECT 1 FROM public.memberships m
                      WHERE m.user_id = p_user_id AND m.organization_id = p_organization_id AND m.role = 'owner' AND m.removed_at IS NULL) THEN
    RAISE EXCEPTION 'atmark_watch_set_agent: 위험 보류를 푸는 것은 소유자만' USING ERRCODE = '42501';
  END IF;
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
GRANT EXECUTE ON FUNCTION atmark_watch_set_agent(uuid, text, text, boolean, uuid) TO atmark_admin;

GRANT INSERT (request_id) ON agent_enrollments TO atmark_admin;
