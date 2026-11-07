-- 202610131600_policy_request_rejection_widening.sql
-- 정책 변경 요청 L-2 후속(2026-10-13 교차 감사 — L-2 우회): 거절된 변경의 24시간 재요청 거부(P0A58)가 지문(`request_hash`) 정확 일치만 봐서
-- `+tag` 만 바꾼 같은 주소(`ceo+1@corp.com`)나 그 주소를 덮는 도메인(`corp.com` · `*.com` 류 와일드카드)으로 같은 것을 다시 물을 수 있었다.
--
--   ① `atmark_policy_request_rule_covers(new, rejected)` — 새 값이 거절된 값을 **덮는가**(IMMUTABLE · 정의자 함수 안에서만 — PUBLIC 실행 0):
--      - 새 값이 주소 → 거절된 값도 주소이고 `+tag` 를 뗀 형태가 같다(`a+x@d` ≡ `a@d` ≡ `a+y@d`).
--      - 새 값이 도메인 `d` → 거절된 주소의 도메인이 `d` · 거절된 도메인이 `d`.
--      - 새 값이 `*.d` → 거절된 주소·도메인이 `d` 의 하위 도메인 · 거절된 와일드카드 `*.e` 의 `e` 가 `d` 이거나 그 하위(관문의 `domainRuleCovers` 와 같은 뜻 —
--        `*.d` 는 정점 `d` 를 덮지 않는다).
--      **좁히기는 막지 않는다** — 도메인을 거절당한 뒤 그 도메인의 주소 하나를 묻는 것은 소유자가 바랄 수 있는 다른 질문이다.
--   ② `atmark_policy_request_create` — 202610131500 본문 그대로 + 거절 검사 한 곳: 같은 지문 **또는**(add_rule) 같은 방향 · 같은 목록의 거절된 값을 덮는 값.
--      remove_rule 은 목록에 있는 값 그대로만 지우므로 지문 일치로 충분하다. set_mode 는 모드 넷뿐이라 지문 일치 그대로 — 거절된 add_rule 뒤의
--      "발신 전체" 요청은 막지 않는다(다른 질문이고 콘솔이 모드 변경을 위험 문구와 함께 보인다 — ADR-0007 2026-10-13 L-2 후속).
--
-- 잠금: 함수 둘(하나 새로 · 하나 교체). 5초. 운영 무변화 외 — 거부가 넓어질 뿐(expand-only). 순서 무관(터널 migrate 만 — deploy §54).

SET LOCAL lock_timeout = '5s';

CREATE FUNCTION atmark_policy_request_rule_covers(p_new text, p_rejected text) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $$
  SELECT CASE
    WHEN p_new IS NULL OR p_rejected IS NULL THEN false
    -- 주소 ↔ 주소: `+tag` 를 뗀 형태(로컬파트의 첫 `+` 부터 `@` 앞까지).
    WHEN strpos(p_new, '@') > 0 THEN
      strpos(p_rejected, '@') > 0
      AND regexp_replace(p_new, '\+[^@]*@', '@') = regexp_replace(p_rejected, '\+[^@]*@', '@')
    -- 와일드카드 `*.d`: 거절된 주소·도메인이 d 의 하위 · 거절된 `*.e` 의 e 가 d 이거나 d 의 하위.
    WHEN left(p_new, 2) = '*.' THEN
      length(p_new) > 2 AND (
        CASE
          WHEN strpos(p_rejected, '@') > 0 THEN right(split_part(p_rejected, '@', 2), length(p_new) - 1) = substr(p_new, 2)
          WHEN left(p_rejected, 2) = '*.' THEN substr(p_rejected, 3) = substr(p_new, 3)
                                            OR right(substr(p_rejected, 3), length(p_new) - 1) = substr(p_new, 2)
          ELSE right(p_rejected, length(p_new) - 1) = substr(p_new, 2)
        END)
    -- 정확 도메인 d: 거절된 주소의 도메인이 d · 거절된 도메인이 d(와일드카드는 덮지 않는다).
    WHEN strpos(p_rejected, '@') > 0 THEN split_part(p_rejected, '@', 2) = p_new
    ELSE p_rejected = p_new
  END
$$;

REVOKE ALL ON FUNCTION atmark_policy_request_rule_covers(text, text) FROM PUBLIC;

COMMENT ON FUNCTION atmark_policy_request_rule_covers(text, text) IS
  '정책 변경 요청 L-2 후속(202610131600) — 새 add_rule 값이 24시간 안에 거절된 값을 덮는가(+tag 절단 주소 · 그 도메인 · 덮는 와일드카드). 좁히기는 false.';

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

  -- 거절된 같은 변경 — 24시간 동안 다시 묻지 못한다(보안 감사 L-2). 같은 지문 **또는**(add_rule) 같은 방향 · 목록에서 거절된 값을 덮는 값
  -- (`atmark_policy_request_rule_covers` — `+tag` 만 바꾼 같은 주소 · 그 주소의 도메인 · 그것을 덮는 `*.` 와일드카드)도 같은 변경으로 본다(202610131600).
  PERFORM 1 FROM public.policy_change_requests r
   WHERE r.agent_id = p_agent_id::bpchar AND r.status = 'rejected'
     AND r.decided_at > pg_catalog.now() - interval '24 hours'
     AND (r.request_hash = p_request_hash
          OR (p_action = 'add_rule' AND r.action = 'add_rule' AND r.direction = p_direction AND r.list = p_list
              AND public.atmark_policy_request_rule_covers(p_value, r.value)));
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
