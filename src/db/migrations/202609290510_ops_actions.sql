-- 202609290510_ops_actions.sql
-- 호스팅 운영자 콘솔의 **특권 행위 층**(`.omc/plans/ops-console.md` §3.2 결정 B5 · 계약 `docs/contracts/ops-sql.md`).
--
--   티켓 → 행위 정의 함수 → 소유자 코어:
--   ① 소유자 코어 `ops_org_activate_core(p_org, p_actor)` · `ops_org_reject_core(p_org)` — `reviewOrganizationOp`(ops-pre-p1 의 TS 구현)를 그대로
--      SQL 로 옮겼다(잠금 순서: 조직 행 FOR NO KEY UPDATE → `org_entitlements:<조직>` advisory · 베타 부여 = ops-pre-p1 의 `grantActivationPlanOp` +
--      `writeEntitlementVersion`). CLI(`admin:org-review` — 소유자 롤)와 호스팅이 **같은 코어**를 부른다. EXECUTE 는 소유자뿐이다.
--      반환 TABLE 과 SQLSTATE 는 계약 M2(래퍼 `src/ops/core/review.ts` 가 `ReviewOutcome`·`AdminInputError` 로 되돌린다). 차분 테스트
--      `test/integration/ops/review-differential.test.ts` 가 동결한 v0 TS 와 결과 DB 를 대조한다.
--   ② 스위치 쌍(M3) — `ops_activation_beta_enabled()` 는 TS `BETA_ON_ACTIVATION` 과 같아야 한다(단위 테스트 · migrate status 경고).
--      **베타를 끝낼 때는 TS 커밋과 이 함수를 false 로 바꾸는 마이그레이션을 함께 한다.** beta 한도 11칸은 `ops_beta_catalog()` 의 고정 상수다
--      (`PLAN_CATALOG.beta` · `LIMIT_COLUMNS` 순서 — 단위 테스트가 대조한다). 호출자는 값을 넘기지 못한다.
--   ③ 티켓 `ops_authorize`(내부 — EXECUTE 0): 콘솔 열림 → 세션 → step-up(활성화 window · 거절 once) → 상한(세션 10분 20 · 거절 세션 시간 3 ·
--      전역 하루 10) → `ops_actions` 에 티켓 한 행(xact_id = 이 트랜잭션). 행위 정의 함수 `ops_org_activate` · `ops_org_reject` 는 티켓을 만든 뒤
--      코어를 부른다(행위자 `ops:<운영자 uuid>`, I-2).
--   ④ 심층 방어 `zz_ops_require_ticket`(BEFORE) · `zz_ops_record_effect`(AFTER) — 도메인 표 다섯에. **session_user 가 atmark_ops 가 아니면 아무
--      일도 하지 않는다**(다른 모든 롤·경로의 쓰기는 그대로다, I-3). atmark_ops 세션이면 이 트랜잭션의 티켓이 그 행의 조직과 같아야 하고, 바뀐
--      행을 `ops_action_effects` 에 적는다. 이름 접두 `zz_` = 같은 시점 트리거 중 마지막(H4). 기존 가드는 **바꾸지 않았다**.
--   ⑤ 실패 기록 `ops_record_failure` — 롤백 뒤 별도 트랜잭션에서(세션당 · 무효 세션이면 요청자당 10분 30, 넘으면 조용히 버린다).
--
-- 잠금: 도메인 표 다섯에 트리거를 만든다(SHARE ROW EXCLUSIVE — 쓰기를 잠시 막는다). 5초 안에 못 잡으면 실패하고 아무것도 바뀌지 않는다(다시 돌린다).
-- 롤백 호환: 옛 코드는 ops_* 를 모르고 zz_ 트리거는 atmark_ops 가 아니면 no-op 이다. 사고 대응(zz_ 제거)은 런북 ops-console 의 템플릿.

SET LOCAL lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- ② 스위치와 카탈로그(소유자만)
-- ---------------------------------------------------------------------------

CREATE FUNCTION ops_activation_beta_enabled() RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT true
$$;

-- `LIMIT_COLUMNS` 순서: max_agents · org_daily_recipients · agent_per_day_max · agent_per_minute_max · recipients_per_message_max ·
--   tokens_per_agent_max · webhook_endpoints_per_agent_max · org_api_keys_max · inbound_storage_bytes · aliases_per_agent_max ·
--   attachment_bytes_total_max.
CREATE FUNCTION ops_beta_catalog() RETURNS bigint[]
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT ARRAY[10, 1000, 10000, 9999, 50, 5, 10, 5, 10737418240, 3, 10485760]::bigint[]
$$;

-- ---------------------------------------------------------------------------
-- ① 소유자 코어
-- ---------------------------------------------------------------------------

CREATE FUNCTION ops_org_activate_core(p_org uuid, p_actor text)
RETURNS TABLE(from_status text, changed boolean, "grant" text, from_plan text, kept_plan text, version integer)
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_from text;
  v_row public.org_entitlements%ROWTYPE;
  v_has_row boolean;
  v_limits bigint[] := public.ops_beta_catalog();
  v_version bigint;
BEGIN
  IF p_actor IS NULL OR btrim(p_actor) = '' THEN
    RAISE EXCEPTION 'ops_org_activate_core: actor is required' USING ERRCODE = '22023';
  END IF;
  -- FOR NO KEY UPDATE(코드 검토 L-2) — 요금제 쓰기가 FK 검사로 거는 KEY SHARE 와 충돌하지 않는다(교착 없음).
  SELECT o.review_status::text INTO v_from FROM public.organizations o WHERE o.id = p_org FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'organization not found' USING ERRCODE = 'AT404', DETAIL = 'organization_not_found';
  END IF;
  IF v_from = 'active' THEN
    RETURN QUERY SELECT v_from, false, 'none'::text, NULL::text, NULL::text, NULL::integer;
    RETURN;
  END IF;
  UPDATE public.organizations SET review_status = 'active', reviewed_at = now() WHERE id = p_org;
  IF NOT public.ops_activation_beta_enabled() THEN
    RETURN QUERY SELECT v_from, true, 'disabled'::text, NULL::text, NULL::text, NULL::integer;
    RETURN;
  END IF;
  -- 베타 기간 자동 부여 — 요금제 잠금(`lockOrgEntitlements` 와 같은 키) → 지금 행 → 행이 없거나 백필 Free 일 때만 beta.
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('org_entitlements:' || p_org::text, 0));
  SELECT e.* INTO v_row FROM public.org_entitlements e WHERE e.organization_id = p_org;
  v_has_row := FOUND;
  IF v_has_row AND NOT (v_row.plan_code = 'free' AND v_row.source = 'default') THEN
    RETURN QUERY SELECT v_from, true, 'kept'::text, NULL::text, v_row.plan_code, NULL::integer;
    RETURN;
  END IF;
  v_version := CASE WHEN v_has_row THEN v_row.version + 1 ELSE 1 END;
  INSERT INTO public.billing_audit (organization_id, from_plan, to_plan, cause, actor, note, entitlement_version)
  VALUES (p_org, CASE WHEN v_has_row THEN v_row.plan_code END, 'beta', 'review', p_actor, 'review activation (BETA_ON_ACTIVATION)', v_version);
  IF v_has_row THEN
    UPDATE public.org_entitlements e
       SET plan_code = 'beta', source = 'operator', cause = 'review',
           max_agents = v_limits[1], org_daily_recipients = v_limits[2], agent_per_day_max = v_limits[3], agent_per_minute_max = v_limits[4],
           recipients_per_message_max = v_limits[5], tokens_per_agent_max = v_limits[6], webhook_endpoints_per_agent_max = v_limits[7],
           org_api_keys_max = v_limits[8], inbound_storage_bytes = v_limits[9], aliases_per_agent_max = v_limits[10],
           attachment_bytes_total_max = v_limits[11], grace_until = NULL, provider_override_allowed = false,
           version = e.version + 1
     WHERE e.organization_id = p_org;
  ELSE
    INSERT INTO public.org_entitlements (organization_id, plan_code, source, cause, max_agents, org_daily_recipients, agent_per_day_max,
                                         agent_per_minute_max, recipients_per_message_max, tokens_per_agent_max,
                                         webhook_endpoints_per_agent_max, org_api_keys_max, inbound_storage_bytes, aliases_per_agent_max,
                                         attachment_bytes_total_max, grace_until, provider_override_allowed, version)
    VALUES (p_org, 'beta', 'operator', 'review', v_limits[1], v_limits[2], v_limits[3], v_limits[4], v_limits[5], v_limits[6], v_limits[7],
            v_limits[8], v_limits[9], v_limits[10], v_limits[11], NULL, false, 1);
  END IF;
  RETURN QUERY SELECT v_from, true, 'granted'::text, CASE WHEN v_has_row THEN v_row.plan_code END, NULL::text, v_version::integer;
END;
$$;

CREATE FUNCTION ops_org_reject_core(p_org uuid)
RETURNS TABLE(from_status text, changed boolean, suspended text[], revoked_tokens integer)
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_from text;
  v_suspended text[];
  v_revoked integer;
BEGIN
  SELECT o.review_status::text INTO v_from FROM public.organizations o WHERE o.id = p_org FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'organization not found' USING ERRCODE = 'AT404', DETAIL = 'organization_not_found';
  END IF;
  IF v_from = 'rejected' THEN
    RETURN QUERY SELECT v_from, false, ARRAY[]::text[], 0;
    RETURN;
  END IF;
  UPDATE public.organizations SET review_status = 'rejected', reviewed_at = now() WHERE id = p_org;
  -- 활성 에이전트는 운영자 정지로, 소유자가 정지한 에이전트는 운영자 정지로 넘겨받는다. provisioning · disabled 는 그대로.
  WITH changed_agents AS (
    UPDATE public.agents SET status = 'suspended', suspended_by = 'operator'
     WHERE organization_id = p_org AND (status = 'active' OR (status = 'suspended' AND suspended_by = 'owner'))
    RETURNING id
  )
  SELECT coalesce(array_agg(c.id::text ORDER BY c.id::text COLLATE "C"), ARRAY[]::text[]) INTO v_suspended FROM changed_agents c;
  -- 그 조직 에이전트의 살아 있는 토큰 전부 폐기(이미 폐기된 토큰은 그대로 — 1회 쓰기 트리거).
  UPDATE public.agent_api_keys SET revoked_at = now()
   WHERE revoked_at IS NULL AND agent_id IN (SELECT a.id FROM public.agents a WHERE a.organization_id = p_org);
  GET DIAGNOSTICS v_revoked = ROW_COUNT;
  RETURN QUERY SELECT v_from, true, v_suspended, v_revoked;
END;
$$;

REVOKE ALL ON FUNCTION ops_activation_beta_enabled() FROM PUBLIC;
REVOKE ALL ON FUNCTION ops_beta_catalog() FROM PUBLIC;
REVOKE ALL ON FUNCTION ops_org_activate_core(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION ops_org_reject_core(uuid) FROM PUBLIC;

-- ---------------------------------------------------------------------------
-- ③ 티켓(내부)
-- ---------------------------------------------------------------------------

-- 이 트랜잭션에 그 조직의 티켓이 있는가(H2 — 조회 조건은 늘 이것).
CREATE FUNCTION ops_ticket_allows(p_org uuid) RETURNS boolean
LANGUAGE sql STABLE SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM public.ops_actions a
                  WHERE a.kind = 'ticket' AND a.result = 'ok' AND a.xact_id = pg_catalog.pg_current_xact_id() AND a.organization_id = p_org)
$$;

CREATE FUNCTION ops_authorize(p_session_hash text, p_action text, p_org uuid) RETURNS public.ops_sessions
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_session public.ops_sessions%ROWTYPE;
  v_n integer;
BEGIN
  PERFORM public.ops_require_console_open();
  v_session := public.ops_session_resolve(p_session_hash, true);
  IF p_org IS NULL THEN
    RAISE EXCEPTION 'ops_authorize: organization is required' USING ERRCODE = 'AT404', DETAIL = 'organization_not_found';
  END IF;
  -- step-up(§3.6) — 로그인 시각은 step-up 으로 치지 않는다.
  IF p_action = 'org.activate' THEN
    IF NOT EXISTS (SELECT 1 FROM public.ops_step_up_grants g
                    WHERE g.session_id = v_session.id AND g.action = 'org.activate' AND g.mode = 'window'
                      AND g.organization_id = p_org AND g.expires_at > now()) THEN
      RAISE EXCEPTION 'ops: step-up required' USING ERRCODE = 'AT403', DETAIL = 'step_up_required';
    END IF;
  ELSIF p_action = 'org.reject' THEN
    PERFORM public.ops_consume_once_grant(v_session.id, 'org.reject', p_org, NULL);
  ELSE
    RAISE EXCEPTION 'ops_authorize: action % is not hosted', p_action USING ERRCODE = 'AT403', DETAIL = 'forbidden';
  END IF;
  -- 상한 — 세션당 티켓 10분 20 · 거절 세션 시간 3 · 거절 전역 하루 10(I-1).
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('ops_ticket:' || v_session.id::text, 0));
  SELECT count(*) INTO v_n FROM public.ops_actions a
   WHERE a.kind = 'ticket' AND a.session_id = v_session.id AND a.created_at > now() - interval '10 minutes';
  IF v_n >= 20 THEN
    RAISE EXCEPTION 'ops: ticket cap' USING ERRCODE = 'AT429', DETAIL = 'ticket_cap';
  END IF;
  IF p_action = 'org.reject' THEN
    SELECT count(*) INTO v_n FROM public.ops_actions a
     WHERE a.kind = 'ticket' AND a.action = 'org.reject' AND a.session_id = v_session.id AND a.created_at > now() - interval '1 hour';
    IF v_n >= 3 THEN
      RAISE EXCEPTION 'ops: reject cap per session' USING ERRCODE = 'AT429', DETAIL = 'action_cap';
    END IF;
    PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('ops_reject_global', 0));
    SELECT count(*) INTO v_n FROM public.ops_actions a
     WHERE a.kind = 'ticket' AND a.action = 'org.reject' AND a.created_at > now() - interval '1 day';
    IF v_n >= 10 THEN
      RAISE EXCEPTION 'ops: reject cap per day' USING ERRCODE = 'AT429', DETAIL = 'action_cap';
    END IF;
  END IF;
  INSERT INTO public.ops_actions (kind, result, operator_id, session_id, action, organization_id, xact_id)
  VALUES ('ticket', 'ok', v_session.operator_id, v_session.id, p_action, p_org, pg_catalog.pg_current_xact_id());
  RETURN v_session;
END;
$$;

REVOKE ALL ON FUNCTION ops_ticket_allows(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION ops_authorize(text, text, uuid) FROM PUBLIC;

-- ---------------------------------------------------------------------------
-- 행위 정의 함수(atmark_ops) — 티켓 → 코어.
-- ---------------------------------------------------------------------------

CREATE FUNCTION ops_org_activate(p_session_hash text, p_org uuid)
RETURNS TABLE(from_status text, changed boolean, "grant" text, from_plan text, kept_plan text, version integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_session public.ops_sessions%ROWTYPE;
BEGIN
  v_session := public.ops_authorize(p_session_hash, 'org.activate', p_org);
  RETURN QUERY SELECT * FROM public.ops_org_activate_core(p_org, 'ops:' || v_session.operator_id::text);
END;
$$;

CREATE FUNCTION ops_org_reject(p_session_hash text, p_org uuid)
RETURNS TABLE(from_status text, changed boolean, suspended text[], revoked_tokens integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  PERFORM public.ops_authorize(p_session_hash, 'org.reject', p_org);
  RETURN QUERY SELECT * FROM public.ops_org_reject_core(p_org);
END;
$$;

-- ---------------------------------------------------------------------------
-- ④ 심층 방어 — zz_ 트리거(session_user = atmark_ops 일 때만)
-- ---------------------------------------------------------------------------

CREATE FUNCTION zz_ops_row_organization(p_table text, p_row jsonb) RETURNS uuid
LANGUAGE plpgsql STABLE SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_org uuid;
BEGIN
  IF p_table = 'organizations' THEN RETURN (p_row ->> 'id')::uuid; END IF;
  IF p_table = 'agent_api_keys' THEN
    SELECT a.organization_id INTO v_org FROM public.agents a WHERE a.id = p_row ->> 'agent_id';
    RETURN v_org;
  END IF;
  RETURN (p_row ->> 'organization_id')::uuid;
END;
$$;
REVOKE ALL ON FUNCTION zz_ops_row_organization(text, jsonb) FROM PUBLIC;

CREATE FUNCTION zz_ops_require_ticket() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_org uuid;
BEGIN
  IF session_user <> 'atmark_ops' THEN RETURN NEW; END IF;
  IF TG_OP = 'UPDATE' AND NEW IS NOT DISTINCT FROM OLD THEN RETURN NEW; END IF;
  v_org := public.zz_ops_row_organization(TG_TABLE_NAME, to_jsonb(NEW));
  IF v_org IS NULL OR NOT public.ops_ticket_allows(v_org) THEN
    RAISE EXCEPTION 'atmark_ops writes % only under a ticket for that organization', TG_TABLE_NAME
      USING ERRCODE = '42501', DETAIL = 'ticket_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION zz_ops_record_effect() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_ticket bigint;
  v_row jsonb := to_jsonb(NEW);
BEGIN
  IF session_user <> 'atmark_ops' THEN RETURN NULL; END IF;
  IF TG_OP = 'UPDATE' AND NEW IS NOT DISTINCT FROM OLD THEN RETURN NULL; END IF;
  SELECT a.id INTO v_ticket FROM public.ops_actions a
   WHERE a.kind = 'ticket' AND a.result = 'ok' AND a.xact_id = pg_catalog.pg_current_xact_id();
  IF v_ticket IS NULL THEN RETURN NULL; END IF;
  INSERT INTO public.ops_action_effects (action_id, table_name, row_key, op)
  VALUES (v_ticket, TG_TABLE_NAME,
          CASE TG_TABLE_NAME WHEN 'org_entitlements' THEN v_row ->> 'organization_id' ELSE v_row ->> 'id' END, TG_OP);
  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION zz_ops_require_ticket() FROM PUBLIC;
REVOKE ALL ON FUNCTION zz_ops_record_effect() FROM PUBLIC;

CREATE TRIGGER zz_ops_require_ticket BEFORE INSERT OR UPDATE ON organizations
  FOR EACH ROW EXECUTE FUNCTION zz_ops_require_ticket();
CREATE TRIGGER zz_ops_record_effect AFTER INSERT OR UPDATE ON organizations
  FOR EACH ROW EXECUTE FUNCTION zz_ops_record_effect();
CREATE TRIGGER zz_ops_require_ticket BEFORE INSERT OR UPDATE ON agents
  FOR EACH ROW EXECUTE FUNCTION zz_ops_require_ticket();
CREATE TRIGGER zz_ops_record_effect AFTER INSERT OR UPDATE ON agents
  FOR EACH ROW EXECUTE FUNCTION zz_ops_record_effect();
CREATE TRIGGER zz_ops_require_ticket BEFORE INSERT OR UPDATE ON agent_api_keys
  FOR EACH ROW EXECUTE FUNCTION zz_ops_require_ticket();
CREATE TRIGGER zz_ops_record_effect AFTER INSERT OR UPDATE ON agent_api_keys
  FOR EACH ROW EXECUTE FUNCTION zz_ops_record_effect();
CREATE TRIGGER zz_ops_require_ticket BEFORE INSERT OR UPDATE ON org_entitlements
  FOR EACH ROW EXECUTE FUNCTION zz_ops_require_ticket();
CREATE TRIGGER zz_ops_record_effect AFTER INSERT OR UPDATE ON org_entitlements
  FOR EACH ROW EXECUTE FUNCTION zz_ops_record_effect();
CREATE TRIGGER zz_ops_require_ticket BEFORE INSERT OR UPDATE ON billing_audit
  FOR EACH ROW EXECUTE FUNCTION zz_ops_require_ticket();
CREATE TRIGGER zz_ops_record_effect AFTER INSERT OR UPDATE ON billing_audit
  FOR EACH ROW EXECUTE FUNCTION zz_ops_record_effect();

-- ---------------------------------------------------------------------------
-- ⑤ 실패 기록 — 롤백 뒤 별도 트랜잭션. 상한을 넘으면 조용히 버린다.
-- ---------------------------------------------------------------------------

CREATE FUNCTION ops_record_failure(p_session_hash text, p_client_key text, p_action text, p_org uuid, p_agent text, p_code text)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_session public.ops_sessions%ROWTYPE;
  v_code text := CASE WHEN p_code ~ '^[a-z_]{1,40}$' THEN p_code ELSE 'unknown' END;
  v_action text := CASE WHEN p_action IN ('org.activate', 'org.reject', 'org.freeze_on', 'agent.suspend',
                                          'operator.approve', 'operator.deny', 'operator.revoke') THEN p_action END;
  v_agent text := CASE WHEN p_agent ~ '^[0-9a-f]{32}$' THEN p_agent END;
  v_n integer;
BEGIN
  v_session := public.ops_session_resolve(p_session_hash, false);
  IF v_session.id IS NOT NULL THEN
    PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('ops_failure_session:' || v_session.id::text, 0));
    SELECT count(*) INTO v_n FROM public.ops_actions a
     WHERE a.kind = 'failure' AND a.session_id = v_session.id AND a.created_at > now() - interval '10 minutes';
    IF v_n >= 30 THEN RETURN; END IF;
    INSERT INTO public.ops_actions (kind, result, operator_id, session_id, action, organization_id, agent_id, code)
    VALUES ('failure', 'failed', v_session.operator_id, v_session.id, v_action, p_org, v_agent, v_code);
    RETURN;
  END IF;
  -- 세션이 무효하면 요청자 키로 센다(I-9).
  IF p_client_key IS NULL OR p_client_key !~ '^[0-9a-f]{64}$' THEN RETURN; END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('ops_failure_client:' || p_client_key, 0));
  SELECT count(*) INTO v_n FROM public.ops_actions a
   WHERE a.kind = 'failure' AND a.client_key = p_client_key AND a.session_id IS NULL AND a.created_at > now() - interval '10 minutes';
  IF v_n >= 30 THEN RETURN; END IF;
  INSERT INTO public.ops_actions (kind, result, client_key, action, organization_id, agent_id, code)
  VALUES ('failure', 'failed', p_client_key, v_action, p_org, v_agent, v_code);
END;
$$;

REVOKE ALL ON FUNCTION ops_org_activate(text, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION ops_org_reject(text, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION ops_record_failure(text, text, text, uuid, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ops_org_activate(text, uuid) TO atmark_ops;
GRANT EXECUTE ON FUNCTION ops_org_reject(text, uuid) TO atmark_ops;
GRANT EXECUTE ON FUNCTION ops_record_failure(text, text, text, uuid, text, text) TO atmark_ops;
