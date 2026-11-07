-- 202610010900_ops_weekly_board.sql
-- 주간 운영판(마케팅 계획 2026-09-30 §6.1–6.3 · §9.2) — **읽기 전용 집계** 정의 함수 하나 + 내부 술어 하나. 표 · 칸 · 트리거 · 색인을 바꾸지 않는다.
--
--   ① `ops_weekly_board(p_now, p_internal)` → jsonb — SECURITY DEFINER · search_path 고정 · PUBLIC 0 · EXECUTE 는 `atmark_ops` 만(로컬 화면은 소유자 롤).
--      운영판이 읽는 칸(수신 발신자 주소 · 발신 수신자 주소 · 시스템 억제 주소 · 대기자 주소 · 멤버 주소)은 개인 정보라 ops 롤에 칸 GRANT 를 주지 않고
--      **건수만** 돌려준다. 내보내는 식별자는 조직 id 뿐이다(주소 · 이름 · 메모 0).
--      묶음 셋:
--        - `guard`   — 사다리 신호의 재료. 외부 발신량(7·14·28일, 판정 분모) · SES 불만·반송(ses_events — 반송 유형은 저장하지 않는다) · 시스템 메일
--                      불만·하드 바운스(system_mail_suppressions) 와 그중 대기자 주소(onve@ 확인·초대 메일) · Gmail 수신자 일 최대 · 가입 14일 안에 발신 모드를
--                      전체(unrestricted · blocklist_only)로 바꾼 조직(수 + id 20개까지) · 조직별 하루 서로 다른 외부 수신자 상위 5 · 조직별 7일 수신 발신 도메인 수 상위 5.
--                      문턱(L1 · L2 · 하한)은 TS(`src/ops/console/board.ts`)가 가진다 — 여기서는 숫자만 낸다. 내부 조직도 센다(SES 평판은 계정 하나다).
--        - `north`   — 북극성: 최근 7일에 외부 발신자 메일을 받고(격리 제외) 그 뒤 그 에이전트의 토큰이 쓰인 조직 수(내부 조직 제외 · Beta 따로).
--        - `cohorts` — 초대 주차(KST ISO 주) 12주: 초대 수(`waitlist_events` 의 항목별 마지막 초대) · 가입 조직(`organizations.signup_invite_week`) 의 7일
--                      단계(첫 에이전트 · 첫 MCP 사용 · 첫 외부 수신 · 읽기 근사 · 첫 허용목록 거부 · 첫 답장 성공) · 2주차 유지(8~14일) · 창 미종료 수.
--                      내부 조직 제외 · Beta(요금제 행 plan_code = beta) 따로.
--      모든 창은 `p_now` 위쪽에서 닫힌다(`< p_now`) — 테스트가 시각을 고정한다. 훑기는 전부 시간 상한이 있고 색인을 탄다:
--        `messages_agent_created_idx` · `inbound_messages_agent_received_idx` · `audit_logs_agent_created_idx` · `policy_versions_agent_created_idx` ·
--        `ses_events_received_at_idx` · `waitlist_events_action_created_idx`(migrate status `lookup_index:` 가드가 이 여섯을 본다).
--   ② `ops_board_external_sender(org, owner_email, from)` — 내부 술어(정의 함수 아님 · 소유자만 EXECUTE). "외부 발신자" = 그 조직의 소유자 주소 ·
--      살아 있는 멤버 주소 · 그 조직 에이전트 주소가 아닌 주소(계획 §6.1).
--
-- 쓰기 0 · 메일 0. 배포 순서: migrate → Compute(이 함수가 없으면 호스팅 λ 는 42883 → 503 `ops_unavailable`, 로컬 화면은 그 오류를 그대로 보인다).
-- 계약: `docs/contracts/ops-sql.md` · `src/ops/contract.ts` `OPS_SQL_FUNCTIONS`. 허용 목록: `RESTRICTED_ROLE_GRANTS[atmark_ops]` · `OPS_FUNCTION_EXECUTORS`.

SET LOCAL lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- ② 외부 발신자 술어(내부)
-- ---------------------------------------------------------------------------

CREATE FUNCTION ops_board_external_sender(p_org uuid, p_owner_email text, p_from text) RETURNS boolean
LANGUAGE sql STABLE SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT p_from IS DISTINCT FROM p_owner_email
     AND NOT EXISTS (SELECT 1 FROM public.memberships m JOIN public.users u ON u.id = m.user_id
                      WHERE m.organization_id = p_org AND m.removed_at IS NULL AND u.email = p_from)
     AND NOT EXISTS (SELECT 1 FROM public.agent_addresses d JOIN public.agents a ON a.id = d.agent_id
                      WHERE d.address = p_from AND a.organization_id = p_org)
$$;

-- ---------------------------------------------------------------------------
-- ① 주간 운영판
-- ---------------------------------------------------------------------------

CREATE FUNCTION ops_weekly_board(p_now timestamptz, p_internal uuid[]) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_internal uuid[] := coalesce(p_internal, ARRAY[]::uuid[]);
  v_d7 timestamptz;
  v_d14 timestamptz;
  v_d28 timestamptz;
  v_cohort_since timestamptz;
  v_first_week text;
  v_guard jsonb;
  v_north jsonb;
  v_cohorts jsonb;
BEGIN
  IF p_now IS NULL THEN
    RAISE EXCEPTION 'ops_weekly_board: p_now is required' USING ERRCODE = '22004';
  END IF;
  v_d7 := p_now - interval '7 days';
  v_d14 := p_now - interval '14 days';
  v_d28 := p_now - interval '28 days';
  -- 코호트 12주 — 그 주의 월요일 00:00 KST 부터(첫 주가 잘리지 않게).
  v_cohort_since := date_trunc('week', (p_now - interval '84 days') AT TIME ZONE 'Asia/Seoul') AT TIME ZONE 'Asia/Seoul';
  v_first_week := to_char(v_cohort_since AT TIME ZONE 'Asia/Seoul', 'IYYY-"W"IW');

  -- ---- guard ----
  WITH sent AS (
    SELECT m.id, a.organization_id, m.created_at
      FROM public.agents a
      JOIN public.messages m ON m.agent_id = a.id AND m.created_at >= v_d28 AND m.created_at < p_now
     WHERE m.direction = 'outbound' AND m.status = 'sent'
  ),
  ext_rcpt AS (
    -- 외부 수신자 = 어떤 에이전트 주소(은퇴 포함)도 아닌 주소.
    SELECT s.id, s.organization_id, s.created_at, r.address
      FROM sent s JOIN public.outbound_recipients r ON r.message_id = s.id
     WHERE NOT EXISTS (SELECT 1 FROM public.agent_addresses x WHERE x.address = r.address)
  ),
  ext_msg AS (
    SELECT DISTINCT e.id, e.organization_id, e.created_at FROM ext_rcpt e
  ),
  vol AS (
    SELECT count(*) FILTER (WHERE m.created_at >= v_d7)::int AS d7,
           count(*) FILTER (WHERE m.created_at >= v_d14)::int AS d14,
           count(*)::int AS d28,
           count(*) FILTER (WHERE m.created_at >= v_d7 AND o.created_at > m.created_at - interval '7 days')::int AS new_org_d7
      FROM ext_msg m JOIN public.organizations o ON o.id = m.organization_id
  ),
  daily AS (
    SELECT d.organization_id, max(d.n)::int AS peak
      FROM (SELECT organization_id, (created_at AT TIME ZONE 'Asia/Seoul')::date AS day, count(DISTINCT address) AS n
              FROM ext_rcpt WHERE created_at >= v_d7 GROUP BY 1, 2) d
     GROUP BY 1
  ),
  gmail AS (
    SELECT coalesce(max(g.n), 0)::int AS peak
      FROM (SELECT (created_at AT TIME ZONE 'Asia/Seoul')::date AS day, count(*) AS n
              FROM ext_rcpt
             WHERE created_at >= v_d7 AND split_part(address, '@', 2) IN ('gmail.com', 'googlemail.com')
             GROUP BY 1) g
  ),
  ses AS (
    SELECT count(*) FILTER (WHERE event_type = 'complaint')::int AS complaints,
           count(*) FILTER (WHERE event_type = 'bounce')::int AS bounces
      FROM public.ses_events
     WHERE received_at >= v_d7 AND received_at < p_now
  ),
  sys AS (
    SELECT count(*) FILTER (WHERE s.reason = 'complaint')::int AS complaints,
           count(*) FILTER (WHERE s.reason = 'hard_bounce')::int AS hard_bounces,
           count(*) FILTER (WHERE s.reason = 'hard_bounce'
                              AND EXISTS (SELECT 1 FROM public.waitlist_entries w WHERE w.email = s.address))::int AS waitlist_hard_bounces
      FROM public.system_mail_suppressions s
     WHERE s.created_at >= v_d7 AND s.created_at < p_now
  ),
  all_mode AS (
    SELECT DISTINCT o.id
      FROM public.organizations o
      JOIN public.agents a ON a.organization_id = o.id
      JOIN public.policy_versions v ON v.agent_id = a.id AND v.created_at >= v_d7 AND v.created_at < p_now
     WHERE o.created_at >= v_d7 - interval '14 days'
       AND v.outbound_mode IN ('unrestricted', 'blocklist_only')
       AND v.created_at < o.created_at + interval '14 days'
  ),
  harvest AS (
    SELECT a.organization_id, count(DISTINCT i.from_domain)::int AS domains
      FROM public.agents a
      JOIN public.inbound_messages i ON i.agent_id = a.id AND i.received_at >= v_d7 AND i.received_at < p_now
     GROUP BY 1
  )
  SELECT jsonb_build_object(
           'externalSends', jsonb_build_object('d7', vol.d7, 'd14', vol.d14, 'd28', vol.d28, 'newOrgD7', vol.new_org_d7),
           'sesComplaints', ses.complaints,
           'sesBounces', ses.bounces,
           'systemComplaints', sys.complaints,
           'systemHardBounces', sys.hard_bounces,
           'waitlistHardBounces', sys.waitlist_hard_bounces,
           'gmailDailyPeak', gmail.peak,
           'allModeCount', (SELECT count(*)::int FROM all_mode),
           'allModeOrgs', coalesce((SELECT jsonb_agg(t.id ORDER BY t.id) FROM (SELECT id FROM all_mode ORDER BY id LIMIT 20) t), '[]'::jsonb),
           'dailyRecipientsTop', coalesce((SELECT jsonb_agg(jsonb_build_object('organizationId', t.organization_id, 'value', t.peak) ORDER BY t.peak DESC, t.organization_id)
                                             FROM (SELECT * FROM daily ORDER BY peak DESC, organization_id LIMIT 5) t), '[]'::jsonb),
           'harvestTop', coalesce((SELECT jsonb_agg(jsonb_build_object('organizationId', t.organization_id, 'value', t.domains) ORDER BY t.domains DESC, t.organization_id)
                                     FROM (SELECT * FROM harvest ORDER BY domains DESC, organization_id LIMIT 5) t), '[]'::jsonb))
    INTO v_guard
    FROM vol, ses, sys, gmail;

  -- ---- north star ----
  WITH ext_in AS (
    SELECT o.id AS organization_id, i.agent_id, min(i.received_at) AS first_at
      FROM public.organizations o
      JOIN public.agents a ON a.organization_id = o.id
      JOIN public.inbound_messages i ON i.agent_id = a.id AND i.received_at >= v_d7 AND i.received_at < p_now
     WHERE o.id <> ALL (v_internal) AND NOT i.quarantined
       AND public.ops_board_external_sender(o.id, o.owner_email, i.from_address)
     GROUP BY 1, 2
  ),
  active AS (
    SELECT DISTINCT e.organization_id
      FROM ext_in e
     WHERE EXISTS (SELECT 1 FROM public.agent_api_keys k
                    WHERE k.agent_id = e.agent_id AND k.last_used_at >= date_trunc('minute', e.first_at))
  )
  SELECT jsonb_build_object(
           'global', count(*) FILTER (WHERE coalesce(e.plan_code, '') <> 'beta')::int,
           'beta', count(*) FILTER (WHERE e.plan_code = 'beta')::int)
    INTO v_north
    FROM active x LEFT JOIN public.org_entitlements e ON e.organization_id = x.organization_id;

  -- ---- cohorts ----
  WITH inv AS (
    -- 항목별 **마지막** 초대 — `signup_invite_week` 가 같은 규칙(가입 때 항목의 `invited_at`)이다.
    SELECT DISTINCT ON (e.entry_id) e.entry_id, to_char(e.created_at AT TIME ZONE 'Asia/Seoul', 'IYYY-"W"IW') AS week
      FROM public.waitlist_events e
     WHERE e.action = 'invite' AND e.created_at >= v_cohort_since AND e.created_at < p_now
     ORDER BY e.entry_id, e.created_at DESC
  ),
  invited AS (
    SELECT week, count(*)::int AS n FROM inv GROUP BY 1
  ),
  co AS (
    SELECT o.id, o.owner_email, o.created_at, o.signup_invite_week AS week, coalesce(e.plan_code = 'beta', false) AS beta,
           least(o.created_at + interval '7 days', p_now) AS w7,
           least(o.created_at + interval '14 days', p_now) AS w14
      FROM public.organizations o
      LEFT JOIN public.org_entitlements e ON e.organization_id = o.id
     WHERE o.signup_invite_week >= v_first_week AND o.created_at < p_now AND o.id <> ALL (v_internal)
  ),
  flags AS (
    SELECT c.week, c.beta, c.created_at,
           EXISTS (SELECT 1 FROM public.agents a WHERE a.organization_id = c.id AND a.created_at < c.w7) AS agent,
           EXISTS (SELECT 1 FROM public.agents a JOIN public.agent_api_keys k ON k.agent_id = a.id
                    WHERE a.organization_id = c.id AND k.first_used_at < c.w7) AS mcp,
           x.first_at IS NOT NULL AS inbound,
           coalesce(x.read, false) AS read,
           EXISTS (SELECT 1 FROM public.agents a
                     JOIN public.audit_logs l ON l.agent_id = a.id AND l.created_at >= c.created_at AND l.created_at < c.w7
                    WHERE a.organization_id = c.id AND l.decision = 'denied' AND 'recipient_not_allowlisted' = ANY (l.reasons)) AS deny,
           EXISTS (SELECT 1 FROM public.agents a
                     JOIN public.messages m ON m.agent_id = a.id AND m.created_at >= c.created_at AND m.created_at < c.w7
                     JOIN public.threads t ON t.id = m.thread_id AND t.agent_id = m.agent_id
                    WHERE a.organization_id = c.id AND m.direction = 'outbound' AND m.status = 'sent' AND t.started_by = 'external') AS reply,
           (EXISTS (SELECT 1 FROM public.agents a
                      JOIN public.messages m ON m.agent_id = a.id AND m.created_at >= c.created_at + interval '7 days' AND m.created_at < c.w14
                     WHERE a.organization_id = c.id AND m.direction = 'outbound')
            OR EXISTS (SELECT 1 FROM public.agents a
                         JOIN public.audit_logs l ON l.agent_id = a.id AND l.created_at >= c.created_at + interval '7 days' AND l.created_at < c.w14
                        WHERE a.organization_id = c.id)
            OR EXISTS (SELECT 1 FROM public.agents a JOIN public.agent_api_keys k ON k.agent_id = a.id
                        WHERE a.organization_id = c.id
                          AND ((k.first_used_at >= c.created_at + interval '7 days' AND k.first_used_at < c.w14)
                            OR (k.last_used_at >= c.created_at + interval '7 days' AND k.last_used_at < c.w14)))) AS retained
      FROM co c
      LEFT JOIN LATERAL (
        -- 에이전트별 첫 외부 수신(격리 제외) — 읽기 근사: 그 에이전트 토큰의 마지막 사용이 첫 수신의 분 이후.
        SELECT min(f.first_at) AS first_at,
               bool_or(EXISTS (SELECT 1 FROM public.agent_api_keys k
                                WHERE k.agent_id = f.agent_id AND k.last_used_at >= date_trunc('minute', f.first_at))) AS read
          FROM (SELECT i.agent_id, min(i.received_at) AS first_at
                  FROM public.agents a
                  JOIN public.inbound_messages i ON i.agent_id = a.id AND i.received_at >= c.created_at AND i.received_at < c.w7
                 WHERE a.organization_id = c.id AND NOT i.quarantined
                   AND public.ops_board_external_sender(c.id, c.owner_email, i.from_address)
                 GROUP BY i.agent_id) f
      ) x ON true
  ),
  weeks AS (
    SELECT week FROM invited UNION SELECT week FROM co
  ),
  per_week AS (
    SELECT w.week,
           coalesce(max(i.n), 0)::int AS invited,
           count(f.week) FILTER (WHERE f.created_at > p_now - interval '7 days')::int AS open7,
           count(f.week) FILTER (WHERE f.created_at > p_now - interval '14 days')::int AS open14,
           jsonb_build_object(
             'signedUp', count(f.week) FILTER (WHERE f.beta = false),
             'agent', count(f.week) FILTER (WHERE f.beta = false AND f.agent),
             'mcp', count(f.week) FILTER (WHERE f.beta = false AND f.mcp),
             'inbound', count(f.week) FILTER (WHERE f.beta = false AND f.inbound),
             'read', count(f.week) FILTER (WHERE f.beta = false AND f.read),
             'deny', count(f.week) FILTER (WHERE f.beta = false AND f.deny),
             'reply', count(f.week) FILTER (WHERE f.beta = false AND f.reply),
             'retained', count(f.week) FILTER (WHERE f.beta = false AND f.retained)) AS global,
           jsonb_build_object(
             'signedUp', count(f.week) FILTER (WHERE f.beta),
             'agent', count(f.week) FILTER (WHERE f.beta AND f.agent),
             'mcp', count(f.week) FILTER (WHERE f.beta AND f.mcp),
             'inbound', count(f.week) FILTER (WHERE f.beta AND f.inbound),
             'read', count(f.week) FILTER (WHERE f.beta AND f.read),
             'deny', count(f.week) FILTER (WHERE f.beta AND f.deny),
             'reply', count(f.week) FILTER (WHERE f.beta AND f.reply),
             'retained', count(f.week) FILTER (WHERE f.beta AND f.retained)) AS beta
      FROM weeks w
      LEFT JOIN invited i ON i.week = w.week
      LEFT JOIN flags f ON f.week = w.week
     GROUP BY w.week
  )
  SELECT coalesce(jsonb_agg(jsonb_build_object('week', p.week, 'invited', p.invited, 'open7', p.open7, 'open14', p.open14,
                                               'global', p.global, 'beta', p.beta) ORDER BY p.week DESC), '[]'::jsonb)
    INTO v_cohorts
    FROM per_week p;

  RETURN jsonb_build_object('guard', v_guard, 'north', v_north, 'cohorts', v_cohorts);
END;
$$;

COMMENT ON FUNCTION ops_weekly_board(timestamptz, uuid[]) IS
  '주간 운영판(202610010900) — 읽기 전용 집계(건수 · 조직 id 만). 가드레일 재료 · 북극성 · 초대 주차 코호트. 문턱은 TS(src/ops/console/board.ts). EXECUTE: atmark_ops.';
COMMENT ON FUNCTION ops_board_external_sender(uuid, text, text) IS
  '주간 운영판 내부 술어(202610010900) — 소유자 · 살아 있는 멤버 · 그 조직 에이전트 주소가 아니면 외부 발신자. 소유자만.';

-- ---------------------------------------------------------------------------
-- 권한 — PUBLIC 0 · 운영판은 atmark_ops 만(로컬 화면은 소유자 롤) · 술어는 소유자만.
-- ---------------------------------------------------------------------------

REVOKE ALL ON FUNCTION ops_board_external_sender(uuid, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION ops_weekly_board(timestamptz, uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ops_weekly_board(timestamptz, uuid[]) TO atmark_ops;
