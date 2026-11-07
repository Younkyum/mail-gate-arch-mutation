-- 202610131400_policy_request_legacy_tokens.sql
-- 기본값 이전 토큰의 `policy:request` — **함의**(진윤겸 2026-10-13 "기존 토큰에도 추가").
--
--   `agent_api_keys.capabilities` 는 불변이다(트리거 `agent_api_keys_immutable_core`, 202609221450 — "권한 변경은 폐기 + 재발급", 감사 무결성). 그래서 행을
--   고치지 않고, 앱(`src/identity/agent-token.ts` `impliedAgentTokenCapabilities`)이 인증 때 함의하는 규칙을 DB 정의자도 같은 규칙으로 본다:
--     ① 토큰 발급 시각 < 2026-10-13 03:10 UTC(`LEGACY_POLICY_REQUEST_CUTOFF` — `policy:request` 가 신규 기본값이 된 운영 compute 배포 완료 무렵)
--     ② 토큰의 에이전트가 자가 등록으로 태어나지 않았다(`agent_enrollments.child_agent_id`)
--     ③ 토큰이 `agent:read_self` 와 `messages:send` · `messages:read` 중 하나 이상을 가진다(좁힌 웹훅 · 감사 전용 토큰은 아니다).
--   폐기 · 만료 검사는 부르는 쪽(`atmark_policy_request_create`)이 그대로 한다.
--
--   ① 판정 함수 `atmark_agent_token_policy_request_legacy`(정의자 아님 · PUBLIC 실행 회수 — 정의자 함수 안에서만 쓴다).
--   ② `atmark_policy_request_create` 교체 — 토큰 검사 한 줄만 바뀐다(열에 있거나 · 함의되거나). 나머지 본문은 202610131201 그대로.
--
-- 잠금: 함수 둘(새로 · 교체). 표 · 트리거 · 권한 무변경 — 불변 트리거도 그대로다. 5초.
-- **순서:** 터널 migrate → `deploy-compute migrate=false`. expand-only — 옛 코드도 그대로 돈다(정의자가 더 받을 뿐).

SET LOCAL lock_timeout = '5s';

CREATE FUNCTION atmark_agent_token_policy_request_legacy(
  p_capabilities agent_token_capability[], p_created_at timestamptz, p_agent_id bpchar) RETURNS boolean
LANGUAGE sql STABLE SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT p_created_at < '2026-10-13T03:10:00Z'::timestamptz
     AND 'agent:read_self'::public.agent_token_capability = ANY (p_capabilities)
     AND ('messages:send'::public.agent_token_capability = ANY (p_capabilities)
          OR 'messages:read'::public.agent_token_capability = ANY (p_capabilities))
     AND NOT EXISTS (SELECT 1 FROM public.agent_enrollments e WHERE e.child_agent_id = p_agent_id);
$$;

REVOKE ALL ON FUNCTION atmark_agent_token_policy_request_legacy(agent_token_capability[], timestamptz, bpchar) FROM PUBLIC;

COMMENT ON FUNCTION atmark_agent_token_policy_request_legacy(agent_token_capability[], timestamptz, bpchar) IS
  '기본값 이전 토큰의 policy:request 함의(2026-10-13) — src/identity/agent-token.ts impliedAgentTokenCapabilities 와 같은 규칙 · 같은 경계.';

CREATE OR REPLACE FUNCTION atmark_policy_request_create(
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
     AND ('policy:request'::public.agent_token_capability = ANY (k.capabilities)
          OR public.atmark_agent_token_policy_request_legacy(k.capabilities, k.created_at, k.agent_id));
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
