-- 202610131620_platform_reputation_freeze.sql
-- **공유 도메인(`atmark.ai`) 조직 평판 자동 동결**(2026-10-13 보안 후속 Medium — 새 에이전트 기본값 "발신 전체" 의 공유 평판 위험).
-- 판정 식 · 선 · 세는 범위 · 예외의 근거는 `src/mail/events/platform-reputation.ts` 머리말(정본). 이 파일은 같은 식을 SQL 로 두고 집행한다.
--
--   ① `atmark_wilson_lower(k, n)` — 이항 비율의 윌슨 95% 하한(TS `wilsonLowerBound` 와 같은 식 · z = 1.96 · k 는 [0, n] 으로 자른다).
--   ② `atmark_platform_reputation_judge(…)` — 두 창 + 계정 기여분 → (action, reasons). TS `judgePlatformReputation` 과 같다(통합 테스트가 격자 대조).
--      수는 **수신자 단위**(202610131612 — PR #94 적대 검토 M-4): 전달 시도 · 영구 bounce 는 `recipient_count` 합(bounce 는 `OnAccountSuppressionList`
--      제외), complaint 는 서로 다른 신고자(정규형 — `+tag` 절단) · 신고 도메인 **계열** 수. 신고 경로는 창 전달 ≥ 50 · 계열 ≥ 2, bounce 경로는 창 전달 ≥ 50,
--      계정 기여분은 조직 7일 전달 ≥ 200(M-3 · 재검증 R-1).
--   ③ `atmark_platform_reputation_check(message_id)` — SECURITY DEFINER · 앱 롤 EXECUTE(SES 이벤트 소비자가 bounce · complaint 를 기록한 뒤 부른다).
--      메시지 → 에이전트의 조직. `atmark.ai` 발신이 아니면 `not_platform`. **먼저 조직 행을 잠근다**(FOR NO KEY UPDATE — 적대 검토 L-1: 운영자 해제
--      트랜잭션과 줄 서서, 해제가 커밋된 뒤의 판정은 해제 시각을 보고 센다). 조직의 **모든 에이전트**(삭제 · 정지 포함) · 모든 `atmark.ai` 발신을
--      7일 · 24시간 창(운영자의 마지막 감사된 해제 이후만)으로 세고 판정한다. 동결이면 — 운영자 예약 주소 조직은 `freeze_exempt`, 서열기 능력이 아직
--      없으면 `freeze_deferred`(둘 다 쓰기 0) — `abuse_freeze = true` + 감사 1행(`owner_actions` · `org.abuse_freeze` · `system:platform_reputation` ·
--      사유 = 걸린 선과 수) → 투명성 로그 `owner.action` 잎.
--
-- **앱 롤에 대해(적대 검토 L-2 — 고침):** 호출자는 메시지 id 하나만 넘기고 수는 DB 가 세지만, 앱 롤은 `ses_events` 에 INSERT 할 수 있다. 앱 롤이 탈취되면
-- 가짜 bounce · complaint 행을 적어 **어느 조직이든** 선을 넘게 만들고 이 함수로 얼릴 수 있다(동결은 운영자가 풀 수 있고 감사 행 · 알람 62 가 남는다).
-- 이 함수가 그 길을 새로 연 것은 아니지만(앱 롤은 이미 `ses_events` 를 쓴다) 막지도 않는다 — 후속(백로그): SES 이벤트 소비자 전용 DB 롤(ses_events ·
-- 억제 · 웹훅 outbox 쓰기만)을 만들어 api 와 나누고, 이 함수 EXECUTE 를 그 롤로만 옮긴다.
--
-- 잠금: 함수 셋 · GRANT 하나. 5초. **운영 무변화** — 함수를 부르는 코드(새 compute)가 올라가야 동결이 시작된다(deploy §54 순서). 색인은 기존 것
-- (`ses_events_received_at_idx` · `messages_agent_created_idx` · `agents_organization_id_idx`)으로 충분하다.

SET LOCAL lock_timeout = '5s';

-- k 는 [0, n] 으로 자른다(bounce 는 전달 시도의 부분집합이라 넘을 수 없지만, 넘으면 sqrt 가 던져 소비자가 재전달만 되풀이한다 — TS 판정도 같은 자르기).
CREATE FUNCTION atmark_wilson_lower(p_k integer, p_n integer) RETURNS double precision
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $$
  SELECT CASE WHEN p_n IS NULL OR p_n <= 0 THEN 0::double precision ELSE
    greatest(0::double precision,
      ((least(greatest(p_k, 0), p_n)::double precision / p_n) + (1.96::double precision * 1.96) / (2 * p_n)
        - 1.96::double precision * sqrt(((least(greatest(p_k, 0), p_n)::double precision / p_n) * (1 - least(greatest(p_k, 0), p_n)::double precision / p_n)) / p_n
                                        + (1.96::double precision * 1.96) / (4 * p_n::double precision * p_n)))
      / (1 + (1.96::double precision * 1.96) / p_n))
  END
$$;

REVOKE ALL ON FUNCTION atmark_wilson_lower(integer, integer) FROM PUBLIC;

-- 선 — TS `PLATFORM_REPUTATION_THRESHOLDS` 와 같은 값(통합 테스트가 대조한다). 바꿀 때는 둘을 같은 커밋에서.
CREATE FUNCTION atmark_platform_reputation_judge(
  p_week_attempts integer, p_week_bounces integer, p_week_complaints integer, p_week_complaint_domains integer,
  p_day_attempts integer, p_day_bounces integer, p_day_complaints integer, p_day_complaint_domains integer,
  p_account_attempts integer)
RETURNS TABLE (action text, reasons text[])
LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_freeze text[] := ARRAY[]::text[];
  v_warn text[] := ARRAY[]::text[];
  v_windows text[] := ARRAY['7d', '24h'];
  v_a integer;
  v_b integer;
  v_c integer;
  v_d integer;
  v_rate double precision;
  v_lower double precision;
  i integer;
BEGIN
  FOR i IN 1..2 LOOP
    IF i = 1 THEN v_a := p_week_attempts; v_b := p_week_bounces; v_c := p_week_complaints; v_d := p_week_complaint_domains;
    ELSE v_a := p_day_attempts; v_b := p_day_bounces; v_c := p_day_complaints; v_d := p_day_complaint_domains; END IF;
    v_rate := CASE WHEN v_a > 0 THEN v_c::double precision / v_a ELSE 0 END;
    v_lower := public.atmark_wilson_lower(v_b, v_a);
    IF v_a >= 50 AND v_c >= 3 AND v_d >= 2 AND v_rate >= 0.0008 THEN v_freeze := v_freeze || (v_windows[i] || ':complaint_rate'); END IF;
    IF v_a >= 50 AND v_b >= 10 AND v_lower >= 0.03 THEN v_freeze := v_freeze || (v_windows[i] || ':bounce_wilson'); END IF;
    IF v_c >= 2 AND v_rate >= 0.0005 THEN v_warn := v_warn || (v_windows[i] || ':complaint_rate_warn'); END IF;
    IF v_b >= 5 AND v_lower >= 0.02 THEN v_warn := v_warn || (v_windows[i] || ':bounce_wilson_warn'); END IF;
  END LOOP;
  IF p_account_attempts > 0 AND p_week_attempts >= 200 THEN
    IF p_week_bounces >= 10 AND p_week_bounces::double precision / p_account_attempts >= 0.01 THEN
      v_freeze := v_freeze || '7d:account_bounce_contribution'::text;
    END IF;
    IF p_week_complaints >= 3 AND p_week_complaint_domains >= 2 AND p_week_complaints::double precision / p_account_attempts >= 0.0002 THEN
      v_freeze := v_freeze || '7d:account_complaint_contribution'::text;
    END IF;
  END IF;
  IF cardinality(v_freeze) > 0 THEN
    RETURN QUERY SELECT 'freeze'::text, v_freeze;
  ELSIF cardinality(v_warn) > 0 THEN
    RETURN QUERY SELECT 'warn'::text, v_warn;
  ELSE
    RETURN QUERY SELECT 'ok'::text, ARRAY[]::text[];
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION atmark_platform_reputation_judge(integer, integer, integer, integer, integer, integer, integer, integer, integer) FROM PUBLIC;

CREATE FUNCTION atmark_platform_reputation_check(p_message_id uuid)
RETURNS TABLE (organization_id uuid, outcome text, reasons text[])
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_org uuid;
  v_domain text;
  v_now timestamptz;
  v_unfrozen timestamptz;
  v_week_start timestamptz;
  v_day_start timestamptz;
  v_wa integer; v_wb integer; v_wc integer; v_wd integer;
  v_da integer; v_db integer; v_dc integer; v_dd integer;
  v_account integer;
  v_action text;
  v_reasons text[];
  v_frozen boolean;
BEGIN
  SELECT a.organization_id, m.from_domain INTO v_org, v_domain
    FROM public.messages m JOIN public.agents a ON a.id = m.agent_id
   WHERE m.id = p_message_id;
  IF NOT FOUND THEN
    RETURN;
  END IF;
  IF v_domain IS DISTINCT FROM 'atmark.ai' THEN
    RETURN QUERY SELECT v_org, 'not_platform'::text, ARRAY[]::text[];
    RETURN;
  END IF;

  -- 적대 검토 L-1 — 세기 **전에** 조직 행을 잠근다. 운영자 해제(`setOrganizationFreezeAuditedOp` — 같은 행 잠금 · 해제 + 감사 한 트랜잭션)와 줄 서고,
  -- 해제가 커밋된 뒤에 이 판정이 돌면 아래의 해제 시각을 본다(해제 직전 스냅샷으로 세어 곧바로 다시 얼리는 경합이 없다). 시각도 잠금 뒤에 잡는다.
  SELECT o.abuse_freeze INTO v_frozen FROM public.organizations o WHERE o.id = v_org FOR NO KEY UPDATE;
  v_now := pg_catalog.clock_timestamp();

  -- 운영자의 마지막 해제 이후만 센다(해제 직후 창에 남은 옛 이벤트로 다시 얼지 않게). **운영자 행위자 행만**(202610131610 — 소유자 롤 문장만 적는다):
  -- 콘솔 세션 · 조직 키 행위자로 같은 행위 코드를 적어 창을 지우는 길을 막는다.
  SELECT max(o.created_at) INTO v_unfrozen FROM public.owner_actions o
   WHERE o.organization_id = v_org AND o.action = 'org.abuse_unfreeze' AND o.operator_actor IS NOT NULL;
  v_week_start := greatest(v_now - interval '7 days', coalesce(v_unfrozen, '-infinity'::timestamptz));
  v_day_start := greatest(v_now - interval '24 hours', coalesce(v_unfrozen, '-infinity'::timestamptz));

  -- 수신자 단위(202610131612): 전달 시도 = delivery · bounce 의 recipient_count 합, 영구 bounce = 계정 억제 목록을 뺀 합,
  -- 신고 = 서로 다른 신고자(해시 — 옛 행은 그 이벤트 id 하나) · 서로 다른 신고 도메인(옛 행은 0).
  WITH ev AS (
    SELECT e.id, e.event_type, e.bounce_type, e.bounce_subtype, e.recipient_count, e.received_at,
           e.complaint_recipient_hashes, e.complaint_domain_hashes
      FROM public.agents a
      JOIN public.messages m ON m.agent_id = a.id
      JOIN public.ses_events e ON e.message_id = m.id
     WHERE a.organization_id = v_org
       AND m.from_domain = 'atmark.ai'
       AND m.created_at >= v_week_start - interval '30 days'
       AND e.received_at >= v_week_start
  ), complainers AS (
    SELECT ev.received_at, coalesce(h.hash, ev.id::text) AS who
      FROM ev LEFT JOIN LATERAL pg_catalog.unnest(ev.complaint_recipient_hashes) AS h(hash) ON true
     WHERE ev.event_type = 'complaint'
  ), complaint_domains AS (
    SELECT ev.received_at, d.hash AS domain
      FROM ev CROSS JOIN LATERAL pg_catalog.unnest(ev.complaint_domain_hashes) AS d(hash)
     WHERE ev.event_type = 'complaint'
  )
  SELECT (SELECT coalesce(sum(recipient_count), 0) FROM ev WHERE event_type IN ('delivery', 'bounce'))::integer,
         (SELECT coalesce(sum(recipient_count), 0) FROM ev
           WHERE event_type = 'bounce' AND bounce_type = 'permanent' AND bounce_subtype IS DISTINCT FROM 'OnAccountSuppressionList')::integer,
         (SELECT count(DISTINCT who) FROM complainers)::integer,
         (SELECT count(DISTINCT domain) FROM complaint_domains)::integer,
         (SELECT coalesce(sum(recipient_count), 0) FROM ev WHERE event_type IN ('delivery', 'bounce') AND received_at >= v_day_start)::integer,
         (SELECT coalesce(sum(recipient_count), 0) FROM ev
           WHERE event_type = 'bounce' AND bounce_type = 'permanent' AND bounce_subtype IS DISTINCT FROM 'OnAccountSuppressionList'
             AND received_at >= v_day_start)::integer,
         (SELECT count(DISTINCT who) FROM complainers WHERE received_at >= v_day_start)::integer,
         (SELECT count(DISTINCT domain) FROM complaint_domains WHERE received_at >= v_day_start)::integer
    INTO v_wa, v_wb, v_wc, v_wd, v_da, v_db, v_dc, v_dd;

  SELECT coalesce(sum(e.recipient_count), 0)::integer INTO v_account FROM public.ses_events e
   WHERE e.received_at >= v_now - interval '7 days' AND e.event_type IN ('delivery', 'bounce');

  SELECT j.action, j.reasons INTO v_action, v_reasons
    FROM public.atmark_platform_reputation_judge(v_wa, v_wb, v_wc, v_wd, v_da, v_db, v_dc, v_dd, v_account) j;
  IF v_action <> 'freeze' THEN
    RETURN QUERY SELECT v_org, v_action, v_reasons;
    RETURN;
  END IF;

  -- 운영자 예약 주소 조직(support@ · abuse@ · postmaster@ 의 운영 조직)은 자동으로 얼리지 않는다 — 신고 창구가 함께 멈춘다. 알람만.
  PERFORM 1 FROM public.operator_address_grants g WHERE g.organization_id = v_org;
  IF FOUND THEN
    RETURN QUERY SELECT v_org, 'freeze_exempt'::text, v_reasons;
    RETURN;
  END IF;
  IF v_frozen THEN
    RETURN QUERY SELECT v_org, 'already_frozen'::text, v_reasons;
    RETURN;
  END IF;
  -- 서열기가 아직 운영자 행위자를 잎으로 옮기지 못한다(배포 순서 — 적대 검토 M-1). 감사 없이 얼리지 않는다 — 알람만(다음 사건이 다시 판정한다).
  PERFORM 1 FROM public.tlog_capabilities t WHERE t.capability = 'owner_action_operator_actor' AND t.revoked_at IS NULL FOR SHARE;
  IF NOT FOUND THEN
    RETURN QUERY SELECT v_org, 'freeze_deferred'::text, v_reasons;
    RETURN;
  END IF;
  UPDATE public.organizations SET abuse_freeze = true WHERE id = v_org;
  INSERT INTO public.owner_actions (organization_id, action, target_id, operator_actor, operator_reason)
  VALUES (v_org, 'org.abuse_freeze', v_org::text, 'system:platform_reputation',
          pg_catalog.left(pg_catalog.array_to_string(v_reasons, ',')
            || ' · 7d attempts=' || v_wa || ' bounces=' || v_wb || ' complainers=' || v_wc || ' complaint_domains=' || v_wd
            || ' · 24h attempts=' || v_da || ' bounces=' || v_db || ' complainers=' || v_dc || ' complaint_domains=' || v_dd
            || ' · account_7d_attempts=' || v_account, 600));
  RETURN QUERY SELECT v_org, 'frozen'::text, v_reasons;
END;
$$;

REVOKE ALL ON FUNCTION atmark_platform_reputation_check(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION atmark_platform_reputation_check(uuid) TO atmark_app;

COMMENT ON FUNCTION atmark_platform_reputation_check(uuid) IS
  '공유 도메인 atmark.ai 조직 평판 자동 동결(202610131620) — SES 이벤트 소비자가 bounce·complaint 기록 뒤 부른다. 수신자 단위(202610131612). 판정 = TS judgePlatformReputation. 동결 = abuse_freeze + owner_actions(system:platform_reputation). 운영자 예약 주소 조직은 freeze_exempt, 서열기 능력 없으면 freeze_deferred.';
