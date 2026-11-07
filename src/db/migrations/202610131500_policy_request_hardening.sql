-- 202610131500_policy_request_hardening.sql
-- 정책 변경 요청(#90 · #91) 교차 감사의 보안 핫픽스(2026-10-13).
--
--   M-1 운영자 예약 주소(support@ 등 — `atmark_operator_assignable_addresses()`)를 쥔 에이전트는 정책 변경을 요청하지 못한다 — 지원 에이전트는
--       바깥 메일을 읽는 것이 일이라 인젝션의 첫 표적이고, 그 정책은 운영자가 런북(§29-3)으로만 바꾼다.
--       ① 함의 판정 `atmark_agent_token_policy_request_legacy` 가 예약 에이전트를 뺀다(TS `impliedAgentTokenCapabilities` 와 같은 규칙).
--       ② 만들기 `atmark_policy_request_create` 가 열에 `policy:request` 가 있어도 거부한다(P0A51 — 권한이 없는 것과 같은 응답).
--       ③ 결정을 기다리는 예약 에이전트의 요청을 stale(`operator_reserved`)로 닫는다(아래 데이터 단계 — 승인 연산도 409 `operator_reserved`).
--   L-2 소유자가 거절한 같은 변경(`request_hash`)은 24시간 동안 다시 만들지 못한다(P0A58 — 같은 요청을 두드려 지쳐 승인하게 만드는 길).
--   L-3 콘솔의 위험 경고 정의자 `atmark_agent_last_risk_exposure` 가 조직 id 를 받아 에이전트가 그 조직의 것인지 확인한다(아니면 42501).
--       옛 두 인자 판은 지운다 — admin 롤이 조직 경계 없이 아무 에이전트의 노출 시각을 읽던 길.
--
-- 잠금: 함수 셋 교체 · 하나 지우고 새로 · `policy_change_requests` 의 결정 칸 UPDATE(예약 에이전트의 pending 만 — 지금 운영 0~수 행). 5초.
-- **순서:** 터널 migrate → `deploy-compute migrate=false`(deploy §53). 그 사이 몇 분 옛 콘솔 코드의 변경 요청 목록 · 승인은 500 이다(두 인자 함수가
-- 없다 — 쓰기 0, 새 코드가 올라가면 낫는다). 에이전트의 요청 만들기는 그 사이에도 새 규칙으로 돈다.

SET LOCAL lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- M-1 ① 함의 판정 — 예약 에이전트 제외
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION atmark_agent_token_policy_request_legacy(
  p_capabilities agent_token_capability[], p_created_at timestamptz, p_agent_id bpchar) RETURNS boolean
LANGUAGE sql STABLE SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT p_created_at < '2026-10-13T03:10:00Z'::timestamptz
     AND 'agent:read_self'::public.agent_token_capability = ANY (p_capabilities)
     AND ('messages:send'::public.agent_token_capability = ANY (p_capabilities)
          OR 'messages:read'::public.agent_token_capability = ANY (p_capabilities))
     AND NOT EXISTS (SELECT 1 FROM public.agent_enrollments e WHERE e.child_agent_id = p_agent_id)
     AND NOT EXISTS (SELECT 1 FROM public.agent_addresses d
                      WHERE d.agent_id = p_agent_id AND d.retired_at IS NULL
                        AND d.address = ANY (public.atmark_operator_assignable_addresses()));
$$;

REVOKE ALL ON FUNCTION atmark_agent_token_policy_request_legacy(agent_token_capability[], timestamptz, bpchar) FROM PUBLIC;

COMMENT ON FUNCTION atmark_agent_token_policy_request_legacy(agent_token_capability[], timestamptz, bpchar) IS
  '기본값 이전 토큰의 policy:request 함의(2026-10-13) — src/identity/agent-token.ts impliedAgentTokenCapabilities 와 같은 규칙 · 같은 경계. 운영자 예약 주소 에이전트는 제외(202610131500).';

-- ---------------------------------------------------------------------------
-- M-1 ② · L-2 만들기 — 202610131400 본문 + 예약 에이전트 거부 + 24시간 거절 재요청 거부
-- ---------------------------------------------------------------------------
--
-- 거부 코드(라우트가 옮긴다 — `db/repositories/policy-request-store.ts`): 202610131201 의 P0A51~P0A56 + **P0A58** 같은 변경을 24시간 안에 거절했다.
-- 예약 에이전트는 P0A51(권한 없음과 같은 응답 — 에이전트에게 다른 사실을 알리지 않는다).
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
  -- 운영자 예약 주소 에이전트(보안 감사 M-1) — 열에 권한이 있어도 거부한다.
  PERFORM 1 FROM public.agent_addresses d
   WHERE d.agent_id = p_agent_id::bpchar AND d.retired_at IS NULL AND d.address = ANY (public.atmark_operator_assignable_addresses());
  IF FOUND THEN
    RAISE EXCEPTION 'atmark_policy_request_create: 운영자 예약 주소 에이전트는 요청하지 못한다' USING ERRCODE = 'P0A51';
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

  -- 거절된 같은 변경 — 24시간 동안 다시 묻지 못한다(보안 감사 L-2).
  PERFORM 1 FROM public.policy_change_requests r
   WHERE r.agent_id = p_agent_id::bpchar AND r.request_hash = p_request_hash AND r.status = 'rejected'
     AND r.decided_at > pg_catalog.now() - interval '24 hours';
  IF FOUND THEN
    RAISE EXCEPTION 'atmark_policy_request_create: 같은 변경을 24시간 안에 거절했다' USING ERRCODE = 'P0A58';
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
-- 권한(앱 롤 EXECUTE)은 CREATE OR REPLACE 가 그대로 둔다(202610131201).

-- ---------------------------------------------------------------------------
-- L-3 위험 경고 정의자 — 조직 경계
-- ---------------------------------------------------------------------------

DROP FUNCTION atmark_agent_last_risk_exposure(bpchar, timestamptz);

CREATE FUNCTION atmark_agent_last_risk_exposure(p_organization_id uuid, p_agent_id bpchar, p_since timestamptz) RETURNS timestamptz
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  last_at timestamptz;
BEGIN
  -- 부르는 쪽(콘솔 세션의 조직)이 그 에이전트의 조직이어야 한다 — 아니면 NULL(위험 없음으로 읽힌다)이 아니라 거부한다.
  PERFORM 1 FROM public.agents a WHERE a.id = p_agent_id AND a.organization_id = p_organization_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'atmark_agent_last_risk_exposure: 그 조직의 에이전트가 아니다' USING ERRCODE = '42501';
  END IF;
  SELECT max(e.last_at) INTO last_at FROM public.agent_exposures e WHERE e.agent_id = p_agent_id AND e.level >= 2 AND e.last_at >= p_since;
  RETURN last_at;
END;
$$;

REVOKE ALL ON FUNCTION atmark_agent_last_risk_exposure(uuid, bpchar, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION atmark_agent_last_risk_exposure(uuid, bpchar, timestamptz) TO atmark_admin;

-- ---------------------------------------------------------------------------
-- M-1 ③ 데이터 — 결정을 기다리는 예약 에이전트의 요청을 닫는다
-- ---------------------------------------------------------------------------
--
-- 전이 트리거(pending → stale 한 번 · 만료 전만)를 그대로 지난다. 이미 만료 시각이 지난 행은 건드리지 않는다(만들기 · 콘솔이 expired 로 읽는다).
UPDATE policy_change_requests r
   SET status = 'stale', decided_by = 'migration:202610131500', stale_reason = 'operator_reserved'
 WHERE r.status = 'pending' AND r.expires_at > now()
   AND EXISTS (SELECT 1 FROM agent_addresses d
                WHERE d.agent_id = r.agent_id AND d.retired_at IS NULL AND d.address = ANY (atmark_operator_assignable_addresses()));
