-- 202610081105_enroll_precheck.sql
-- 자가 등록 앞 거르개(배포 전 보안 리뷰 M — 2026-10-08): admin λ 예약 동시성은 3 이다. `POST /v1/agents` · MCP `create_agent` 가 admin 을 부르기 **전에**
-- api λ 가 싼 DB 읽기 하나로 거른다 — 조직 설정 켜짐 · 조직 하루 상한 미만 · **에이전트당 분당 3 번**(시도 수 — 결과와 무관). 걸리면 api 가 admin 을 부르지 않는다.
-- 판정의 정본은 그대로 admin 연산 + 슬롯 트리거다(이것은 앞 거르개 — 지나도 admin 이 처음부터 다시 본다).
--
--   ① `agent_enroll_attempts` — 에이전트 · 시각(운영 계수 표 — 감사 표가 아니다. 지난 1시간보다 오래된 행은 함수가 지운다).
--   ② `atmark_enroll_precheck(agent_id)` — 정의자(앱 롤 EXECUTE). 결과: ok | not_found | disabled | daily_cap | rate_limited. ok 일 때만 시도를 센다.
--      에이전트 잠금(advisory) 아래에서 센다(동시 요청 넷이 셋을 함께 보지 않게).
--
-- 잠금: 새 표 · 새 함수. 5초. expand-only.

SET LOCAL lock_timeout = '5s';

CREATE TABLE agent_enroll_attempts (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  agent_id      character(32) NOT NULL REFERENCES agents (id) ON DELETE RESTRICT,
  attempted_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX agent_enroll_attempts_agent_at_idx ON agent_enroll_attempts (agent_id, attempted_at);

COMMENT ON TABLE agent_enroll_attempts IS
  '자가 등록 앞 거르개의 시도 계수(에이전트 · 시각) — 운영 표. 쓰기는 atmark_enroll_precheck 만 · 1시간 넘은 행은 그 함수가 지운다. 감사는 agent_enrollments.';

CREATE FUNCTION atmark_enroll_precheck(p_agent_id text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  org uuid;
  enabled boolean;
  cap integer;
  used integer;
  recent integer;
BEGIN
  SELECT a.organization_id INTO org FROM public.agents a WHERE a.id = p_agent_id::bpchar;
  IF org IS NULL THEN
    RETURN 'not_found';
  END IF;
  SELECT s.agent_self_enroll, s.enroll_daily_cap INTO enabled, cap FROM public.org_watch_settings s WHERE s.organization_id = org;
  IF NOT coalesce(enabled, false) THEN
    RETURN 'disabled';
  END IF;
  SELECT count(*)::integer INTO used FROM public.agent_enrollments e
   WHERE e.organization_id = org AND e.created_at > pg_catalog.now() - interval '24 hours';
  IF used >= coalesce(cap, 5) THEN
    RETURN 'daily_cap';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('agent_enroll_attempts:' || p_agent_id, 0));
  DELETE FROM public.agent_enroll_attempts t WHERE t.agent_id = p_agent_id::bpchar AND t.attempted_at < pg_catalog.now() - interval '1 hour';
  SELECT count(*)::integer INTO recent FROM public.agent_enroll_attempts t
   WHERE t.agent_id = p_agent_id::bpchar AND t.attempted_at > pg_catalog.now() - interval '1 minute';
  IF recent >= 3 THEN
    RETURN 'rate_limited';
  END IF;
  INSERT INTO public.agent_enroll_attempts (agent_id) VALUES (p_agent_id::bpchar);
  RETURN 'ok';
END;
$$;

REVOKE ALL ON FUNCTION atmark_enroll_precheck(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION atmark_enroll_precheck(text) TO atmark_app;
