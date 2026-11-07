-- 202610061100_ai_mail_watch.sql
-- AI 의심 메일 감시(ai-mail-watch, ADR-0017 초안 · docs/internal/plans/ai-mail-watch.md §7.1). **경고 전용** — 이 파일의 어떤 칸·함수도 격리 ·
-- 정책 · 관문 · 승인 · 위험 보류 · 오염 등급의 입력이 아니다(arch `ai-watch-boundary`). 본문 · 발췌 · 점수 원값은 어디에도 없다.
--
--   ① `org_features.feature` 에 `ai_mail_watch`(운영자 허용 목록 — 베타 관문). CHECK 교체는 NOT VALID, 검증은 1101.
--   ② `organizations.ai_mail_watch_enabled` — 소유자 토글(기본 꺼짐). 켜기(false→true)는 `org_features` 행이 있어야 한다 — 가드 트리거
--      `organizations_ai_mail_watch_guard`(모든 롤, SQLSTATE P0A07 = 고객 도메인과 같은 "기능 허용 목록에 없다"). 끄기는 언제나 된다.
--      쓰기는 admin(콘솔) 칸 UPDATE 하나 — 감사는 콘솔의 `owner_actions` 가 같은 트랜잭션에서 남긴다.
--   ③ `ai_watch_jobs` — 메일(조직 × SES 메시지) 하나에 작업 하나(승격 규칙 8). 상태 pending → done | skipped | expired, 한 번만 바뀐다.
--      앱 롤은 식별 칸 셋(조직 · SES id · shadow)만 INSERT 한다 — 시각·상태는 기본값이다. 판정은 결과 λ 롤의 DEFINER 함수로만.
--   ④ `inbound_messages.ai_watch_job_id` · `ai_hold_until` — 보류는 에이전트에게 **보이는 시각**만 늦춘다(읽기 술어 `releasedToAgent`).
--      CHECK `ai_hold_until <= created_at + 30s` — **30초 상한을 DB 가 집행**(NOT VALID, 검증 1101). 두 칸은 INSERT 뒤에 NULL 로만 바뀐다
--      (불변 트리거 allow-list 에 더하고, `inbound_messages_ai_watch_release_only` 가 "NULL 로만" 을 한 번 더).
--   ⑤ `ai_watch_runtime` — 워커 하트비트(단일 행). inbound 는 정의 함수 `ai_watch_worker_healthy()` 로만 본다.
--   ⑥ 정의 함수(소유자 롤, search_path 고정):
--        · `ai_watch_record_verdict(job, verdict, band, model_version)` · `ai_watch_record_heartbeat(...)` — **`atmark_ai_watch` 만** EXECUTE.
--        · `ai_watch_org_context(org)` · `ai_watch_worker_healthy()` · `ai_watch_skip_job(job)` — 앱 롤.
--        · `purge_ai_watch_jobs()` — 결과 λ 롤(하트비트마다 — 판정 쪽 TTL 스위퍼(approval-expiry)에 감시 SQL 을 들이지 않는다, arch ai-watch-boundary ①).
--        · `ai_watch_release(job)` — 보류 풀기 + 보류된 `message.received` 웹훅 앞당기기. 어느 롤에도 EXECUTE 없음(위 함수들이 소유자로 부른다).
--   ⑦ 롤 `atmark_ai_watch`(CONNECTION LIMIT 2): schema USAGE + 세 함수(판정 · 하트비트 · 보존) EXECUTE. **표 권한 0.**
--      **이 파일은 그 롤을 요구하지 않는다**(보안 리뷰 H1 — 배포 교착): 소유자 롤은 CREATEROLE 이 없어 마이그레이션이 롤을 만들 수 없고, 롤을 만드는
--      bootstrap-roles 는 새 compute(migrate 번들) 뒤에만 있다. 그래서 그 롤의 GRANT 다섯 줄은 정의자 아닌 함수 `ai_watch_apply_role_grants()`(소유자
--      소유 · EXECUTE 0) 안에 두고, 롤이 **이미 있으면** 이 파일이 끝에서 부른다(로컬·CI · 재적용). 운영은 bootstrap-roles 가 롤을 만든 같은
--      트랜잭션에서 소유자로 잠시 SET ROLE 해 부른다(`role-bootstrap.ts`). 배포 순서 = 터널 migrate → compute(migrate=false) → bootstrap-roles.
--
-- 잠금: `organizations`·`inbound_messages`·`org_features` ADD COLUMN(상수 기본값 — 재작성 없음) · ADD/DROP CONSTRAINT(NOT VALID — 표를 읽지 않는다) ·
-- 트리거 교체(짧은 ACCESS EXCLUSIVE). 5초 안에 못 잡으면 실패한다.
-- **순서:** 터널 migrate(이 파일 · 1101~1104) → `deploy-compute migrate=false`. 옛 코드는 새 칸을 모른다(작업 0 · 보류 0 — expand-only 지만
-- 새 코드가 새 칸을 읽으므로 compute 보다 먼저).

SET LOCAL lock_timeout = '5s';

-- 이 파일이 GRANT 하는 롤이 먼저 있어야 한다 — 없으면 아무것도 바꾸지 않고 멈춘다.
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
-- ① org_features
-- ---------------------------------------------------------------------------

ALTER TABLE org_features DROP CONSTRAINT org_features_feature_check;
ALTER TABLE org_features ADD CONSTRAINT org_features_feature_check
  CHECK (feature IN ('custom_domains', 'ai_mail_watch')) NOT VALID;

-- ---------------------------------------------------------------------------
-- ② organizations.ai_mail_watch_enabled
-- ---------------------------------------------------------------------------

ALTER TABLE organizations ADD COLUMN ai_mail_watch_enabled boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN organizations.ai_mail_watch_enabled IS
  'AI 의심 메일 감시 소유자 토글(ADR-0017 초안, 기본 꺼짐). 켜려면 org_features(ai_mail_watch) 행이 있어야 한다(가드 트리거). 경고 전용 — 판정 입력 아님.';

CREATE FUNCTION organizations_ai_mail_watch_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF NEW.ai_mail_watch_enabled
     AND (TG_OP = 'INSERT' OR NOT OLD.ai_mail_watch_enabled)
     AND NOT EXISTS (SELECT 1 FROM public.org_features f WHERE f.organization_id = NEW.id AND f.feature = 'ai_mail_watch') THEN
    RAISE EXCEPTION 'organizations: 조직이 AI 의심 메일 감시 기능 허용 목록에 없다' USING ERRCODE = 'P0A07';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER organizations_ai_mail_watch_guard
  BEFORE INSERT OR UPDATE OF ai_mail_watch_enabled ON organizations
  FOR EACH ROW EXECUTE FUNCTION organizations_ai_mail_watch_guard();

GRANT UPDATE (ai_mail_watch_enabled) ON organizations TO atmark_admin;

-- ---------------------------------------------------------------------------
-- ③ ai_watch_jobs
-- ---------------------------------------------------------------------------

CREATE TABLE ai_watch_jobs (
  job_id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations (id) ON DELETE RESTRICT,
  -- `inbound_messages.ses_message_id` 와 같은 모양.
  ses_message_id  text NOT NULL CHECK (ses_message_id ~ '^[A-Za-z0-9][A-Za-z0-9._=-]{0,254}$'),
  -- 같은 문장의 now() — 마감은 정확히 30초 뒤(DB 시계).
  enqueued_at     timestamptz NOT NULL DEFAULT now(),
  deadline        timestamptz NOT NULL DEFAULT now() + interval '30 seconds',
  -- 킬 스위치 `shadow` 로 만든 작업 — 보류 0 · 에이전트 표시 0(결과는 기록한다).
  shadow          boolean NOT NULL DEFAULT false,
  state           text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'done', 'skipped', 'expired')),
  verdict         text CHECK (verdict IN ('flagged', 'clear', 'error')),
  band            text CHECK (band IN ('high', 'mid', 'low')),
  model_version   text CHECK (model_version ~ '^[a-z0-9][a-z0-9._-]{0,63}$'),
  decided_at      timestamptz,
  -- 마감 뒤(늦은 결과 창 10분 안)에 온 판정.
  late            boolean NOT NULL DEFAULT false,
  skip_reason     text CHECK (skip_reason IN ('enqueue_failed')),
  CONSTRAINT ai_watch_jobs_org_ses_key UNIQUE (organization_id, ses_message_id),
  CONSTRAINT ai_watch_jobs_deadline_window CHECK (deadline > enqueued_at AND deadline <= enqueued_at + interval '30 seconds'),
  CONSTRAINT ai_watch_jobs_state_shape CHECK (
    (state = 'pending' AND verdict IS NULL AND band IS NULL AND model_version IS NULL AND decided_at IS NULL AND skip_reason IS NULL AND NOT late)
    OR (state = 'done' AND verdict IS NOT NULL AND model_version IS NOT NULL AND decided_at IS NOT NULL AND skip_reason IS NULL
        AND ((verdict = 'flagged' AND band IN ('high', 'mid')) OR (verdict = 'clear' AND band = 'low') OR (verdict = 'error' AND band IS NULL)))
    OR (state = 'skipped' AND verdict IS NULL AND band IS NULL AND model_version IS NULL AND decided_at IS NOT NULL
        AND skip_reason IS NOT NULL AND NOT late)
    OR (state = 'expired' AND verdict IS NULL AND band IS NULL AND model_version IS NULL AND skip_reason IS NULL AND NOT late)
  )
);

COMMENT ON TABLE ai_watch_jobs IS
  'AI 의심 메일 감시 작업(ADR-0017 초안) — 조직 × SES 메시지 하나. 본문·발췌·점수 원값 없음. 판정은 atmark_ai_watch 롤의 ai_watch_record_verdict() 로만. 경고 전용. 보존 90일(purge_ai_watch_jobs()).';

-- 새 표라 같은 트랜잭션에서 만든다(쓰기를 막을 행이 없다). 조직 1시간 상한(ai_watch_org_context) · 늦은 결과 창 정리(ai_watch_record_verdict) · 보존.
CREATE INDEX ai_watch_jobs_org_enqueued_idx ON ai_watch_jobs (organization_id, enqueued_at);
CREATE INDEX ai_watch_jobs_pending_idx ON ai_watch_jobs (enqueued_at) WHERE state = 'pending';
CREATE INDEX ai_watch_jobs_enqueued_idx ON ai_watch_jobs (enqueued_at);

-- 식별 칸·시각은 바뀌지 않고, 상태는 pending 에서 한 번만 나간다(모든 롤).
CREATE FUNCTION ai_watch_jobs_transition() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF NEW.job_id <> OLD.job_id OR NEW.organization_id <> OLD.organization_id OR NEW.ses_message_id <> OLD.ses_message_id
     OR NEW.enqueued_at <> OLD.enqueued_at OR NEW.deadline <> OLD.deadline OR NEW.shadow <> OLD.shadow THEN
    RAISE EXCEPTION 'ai_watch_jobs identity columns are immutable' USING ERRCODE = '23514';
  END IF;
  IF OLD.state <> 'pending' THEN
    RAISE EXCEPTION 'ai_watch_jobs: % 작업은 다시 바뀌지 않는다', OLD.state USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER ai_watch_jobs_transition
  BEFORE UPDATE ON ai_watch_jobs
  FOR EACH ROW EXECUTE FUNCTION ai_watch_jobs_transition();

CREATE TRIGGER ai_watch_jobs_no_truncate
  AFTER TRUNCATE ON ai_watch_jobs
  FOR EACH STATEMENT EXECUTE FUNCTION reject_truncate();

-- ---------------------------------------------------------------------------
-- ④ inbound_messages — 작업 연결 · 보류
-- ---------------------------------------------------------------------------

ALTER TABLE inbound_messages ADD COLUMN ai_watch_job_id uuid;
ALTER TABLE inbound_messages ADD COLUMN ai_hold_until timestamptz;

ALTER TABLE inbound_messages ADD CONSTRAINT inbound_messages_ai_watch_job_fkey
  FOREIGN KEY (ai_watch_job_id) REFERENCES ai_watch_jobs (job_id) ON DELETE SET NULL NOT VALID;
ALTER TABLE inbound_messages ADD CONSTRAINT inbound_messages_ai_hold_max_30s
  CHECK (ai_hold_until IS NULL OR ai_hold_until <= created_at + interval '30 seconds') NOT VALID;

COMMENT ON COLUMN inbound_messages.ai_hold_until IS
  'AI 감시 보류 — 이 시각 전에는 에이전트 읽기 술어(releasedToAgent)가 행을 숨긴다. 최대 created_at+30s(CHECK). 판정·실패 때 NULL 로만 바뀐다. 인증 코드 조회는 보지 않는다.';
COMMENT ON COLUMN inbound_messages.ai_watch_job_id IS
  'AI 감시 작업(ai_watch_jobs). INSERT 때만 적고, 작업 보존 삭제(ON DELETE SET NULL) 때만 NULL 로 바뀐다.';

-- 불변 allow-list 에 두 칸을 더한다(표시 묶음 + 감시 두 칸).
DROP TRIGGER inbound_messages_immutable_except_display ON inbound_messages;
CREATE TRIGGER inbound_messages_immutable_except_display
  BEFORE UPDATE ON inbound_messages
  FOR EACH ROW EXECUTE FUNCTION reject_column_update_except('display_thread_id', 'ai_hold_until', 'ai_watch_job_id');

-- 두 칸은 **NULL 로만** 바뀐다 — 보류를 늘리거나 다른 작업에 다시 묶을 수 없다(모든 롤).
CREATE FUNCTION inbound_messages_ai_watch_release_only() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF NEW.ai_hold_until IS DISTINCT FROM OLD.ai_hold_until AND NEW.ai_hold_until IS NOT NULL THEN
    RAISE EXCEPTION 'inbound_messages.ai_hold_until 은 NULL 로만 바뀐다' USING ERRCODE = '23514';
  END IF;
  IF NEW.ai_watch_job_id IS DISTINCT FROM OLD.ai_watch_job_id AND NEW.ai_watch_job_id IS NOT NULL THEN
    RAISE EXCEPTION 'inbound_messages.ai_watch_job_id 는 NULL 로만 바뀐다' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER inbound_messages_ai_watch_release_only
  BEFORE UPDATE OF ai_hold_until, ai_watch_job_id ON inbound_messages
  FOR EACH ROW EXECUTE FUNCTION inbound_messages_ai_watch_release_only();

-- ---------------------------------------------------------------------------
-- ⑤ ai_watch_runtime
-- ---------------------------------------------------------------------------

CREATE TABLE ai_watch_runtime (
  id                boolean PRIMARY KEY DEFAULT true CHECK (id),
  last_heartbeat_at timestamptz,
  worker_id         text CHECK (worker_id ~ '^[a-z0-9][a-z0-9._-]{0,63}$'),
  model_version     text CHECK (model_version ~ '^[a-z0-9][a-z0-9._-]{0,63}$'),
  self_test_ok      boolean NOT NULL DEFAULT false,
  draining          boolean NOT NULL DEFAULT false
);

INSERT INTO ai_watch_runtime (id) VALUES (true);

COMMENT ON TABLE ai_watch_runtime IS
  'AI 감시 워커 상태(단일 행) — 결과 λ 의 하트비트가 갱신한다. inbound 는 ai_watch_worker_healthy() 로만 본다(5분 침묵 · draining · 자기 시험 실패면 보류 없음).';

-- ---------------------------------------------------------------------------
-- ⑥ 정의 함수
-- ---------------------------------------------------------------------------

-- 보류 풀기 + 보류된 `message.received` 웹훅 앞당기기. 아직 한 번도 시도하지 않은 pending 전달만(이미 나간 것은 다시 보내지 않는다).
CREATE FUNCTION ai_watch_release(p_job_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  UPDATE public.webhook_deliveries d
     SET next_attempt_at = now()
    FROM public.inbound_messages m
    JOIN public.webhook_endpoints e ON e.agent_id = m.agent_id
   WHERE m.ai_watch_job_id = p_job_id
     AND d.endpoint_id = e.id
     AND d.dedupe_key = 'message.received:' || m.id::text
     AND d.status = 'pending' AND d.attempt_count = 0 AND d.next_attempt_at > now();
  UPDATE public.inbound_messages m
     SET ai_hold_until = NULL
   WHERE m.ai_watch_job_id = p_job_id AND m.ai_hold_until IS NOT NULL;
END;
$$;

REVOKE ALL ON FUNCTION ai_watch_release(uuid) FROM PUBLIC;

-- 결과 λ — 판정 기록. 돌려주는 값: outcome 'recorded'(마감 안) · 'late'(마감 뒤 10분 안) · 'ignored'(모르는 job · 이미 결말 · 10분 넘음),
-- latency_ms = now() − enqueued_at(기록된 때만). 먼저 10분 넘은 pending 을 expired 로 닫는다(별도 틱 없음 — 결과가 올 때마다, 한 번에 1000).
CREATE FUNCTION ai_watch_record_verdict(p_job_id uuid, p_verdict text, p_band text, p_model_version text)
RETURNS TABLE (outcome text, latency_ms integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  was_late boolean;
  queued timestamptz;
BEGIN
  UPDATE public.ai_watch_jobs j SET state = 'expired'
   WHERE j.job_id IN (SELECT o.job_id FROM public.ai_watch_jobs o
                       WHERE o.state = 'pending' AND o.enqueued_at < now() - interval '10 minutes'
                       ORDER BY o.enqueued_at LIMIT 1000);
  UPDATE public.ai_watch_jobs j
     SET state = 'done', verdict = p_verdict, band = p_band, model_version = p_model_version,
         decided_at = now(), late = now() > j.deadline
   WHERE j.job_id = p_job_id AND j.state = 'pending' AND j.enqueued_at >= now() - interval '10 minutes'
  RETURNING j.late, j.enqueued_at INTO was_late, queued;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'ignored'::text, NULL::integer;
    RETURN;
  END IF;
  PERFORM public.ai_watch_release(p_job_id);
  RETURN QUERY SELECT CASE WHEN was_late THEN 'late' ELSE 'recorded' END,
                      least(2147483647, greatest(0, floor(extract(epoch FROM now() - queued) * 1000)))::integer;
END;
$$;

REVOKE ALL ON FUNCTION ai_watch_record_verdict(uuid, text, text, text) FROM PUBLIC;

-- 결과 λ — 하트비트. 시각은 DB now()(워커 시계를 믿지 않는다).
CREATE FUNCTION ai_watch_record_heartbeat(p_worker_id text, p_model_version text, p_self_test_ok boolean, p_draining boolean) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  UPDATE public.ai_watch_runtime
     SET last_heartbeat_at = now(), worker_id = p_worker_id, model_version = p_model_version,
         self_test_ok = p_self_test_ok, draining = p_draining
   WHERE id
$$;

REVOKE ALL ON FUNCTION ai_watch_record_heartbeat(text, text, boolean, boolean) FROM PUBLIC;

-- inbound — 승격 규칙 2·3·7 의 사실(허용 목록 · 소유자 토글 · 최근 1시간 작업 수). 앱 롤은 org_features 를 읽지 못한다(이 함수로만).
CREATE FUNCTION ai_watch_org_context(p_organization_id uuid)
RETURNS TABLE (feature_allowed boolean, owner_enabled boolean, jobs_last_hour integer)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM public.org_features f WHERE f.organization_id = p_organization_id AND f.feature = 'ai_mail_watch'),
         coalesce((SELECT o.ai_mail_watch_enabled FROM public.organizations o WHERE o.id = p_organization_id), false),
         (SELECT count(*)::int FROM public.ai_watch_jobs j
           WHERE j.organization_id = p_organization_id AND j.enqueued_at > now() - interval '1 hour')
$$;

REVOKE ALL ON FUNCTION ai_watch_org_context(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ai_watch_org_context(uuid) TO atmark_app;

-- inbound — 워커가 살아 있나(마지막 하트비트 5분 안 · draining 아님 · 자기 시험 통과). 거짓이면 보류 없이 기록한다(작업은 보낸다).
CREATE FUNCTION ai_watch_worker_healthy() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT coalesce((SELECT r.last_heartbeat_at > now() - interval '5 minutes' AND NOT r.draining AND r.self_test_ok
                     FROM public.ai_watch_runtime r WHERE r.id), false)
$$;

REVOKE ALL ON FUNCTION ai_watch_worker_healthy() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ai_watch_worker_healthy() TO atmark_app;

-- inbound — 요청 큐 전송 실패(fail-skip): 작업 skipped + 보류 풀기 + 웹훅 앞당기기. 30초를 헛되이 기다리지 않는다. pending 이 아니면 거짓.
CREATE FUNCTION ai_watch_skip_job(p_job_id uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  UPDATE public.ai_watch_jobs j
     SET state = 'skipped', skip_reason = 'enqueue_failed', decided_at = now()
   WHERE j.job_id = p_job_id AND j.state = 'pending';
  IF NOT FOUND THEN
    RETURN false;
  END IF;
  PERFORM public.ai_watch_release(p_job_id);
  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION ai_watch_skip_job(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ai_watch_skip_job(uuid) TO atmark_app;

-- 보존 — 90일 넘은 작업, 한 번에 10 000. 메일 행의 연결은 FK 가 NULL 로 바꾼다(release-only 트리거가 허용하는 유일한 방향). 인자 없음 — 부르는
-- 쪽(결과 λ, 하트비트마다)은 무엇을 지울지 고르지 못한다.
CREATE FUNCTION purge_ai_watch_jobs() RETURNS integer
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  WITH gone AS (
    DELETE FROM public.ai_watch_jobs j
     WHERE j.job_id IN (SELECT o.job_id FROM public.ai_watch_jobs o
                         WHERE o.enqueued_at < now() - interval '90 days'
                         ORDER BY o.enqueued_at LIMIT 10000)
    RETURNING 1
  )
  SELECT count(*)::int FROM gone
$$;

REVOKE ALL ON FUNCTION purge_ai_watch_jobs() FROM PUBLIC;

-- ---------------------------------------------------------------------------
-- ⑦ 권한
-- ---------------------------------------------------------------------------

REVOKE ALL ON ai_watch_jobs, ai_watch_runtime FROM PUBLIC;
-- 앱 롤: 작업 만들기(식별 칸 셋 — 시각·상태는 기본값) · 읽기(조회 API 의 provenance · 소비자의 같은 작업 찾기). UPDATE·DELETE 0.
GRANT SELECT ON ai_watch_jobs TO atmark_app;
GRANT INSERT (organization_id, ses_message_id, shadow) ON ai_watch_jobs TO atmark_app;
-- admin(콘솔 수신 로그 배지 — 밴드·모델 버전·늦음). 읽기만.
GRANT SELECT ON ai_watch_jobs TO atmark_admin;
-- 결과 λ 롤(`atmark_ai_watch`) — 스키마 USAGE + 위 세 함수 EXECUTE. 표 권한 0. 롤이 없으면(운영 첫 적용) 아무것도 하지 않는다 — bootstrap-roles 가
-- 롤을 만든 뒤 소유자로 이 함수를 부른다. 정의자가 아니다(부르는 쪽이 소유자여야 GRANT 가 선다) · EXECUTE 는 아무 롤에도 없다. 멱등.
CREATE FUNCTION ai_watch_apply_role_grants() RETURNS boolean
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'atmark_ai_watch') THEN
    RETURN false;
  END IF;
  GRANT USAGE ON SCHEMA public TO atmark_ai_watch;
  GRANT EXECUTE ON FUNCTION public.ai_watch_record_verdict(uuid, text, text, text) TO atmark_ai_watch;
  GRANT EXECUTE ON FUNCTION public.ai_watch_record_heartbeat(text, text, boolean, boolean) TO atmark_ai_watch;
  GRANT EXECUTE ON FUNCTION public.purge_ai_watch_jobs() TO atmark_ai_watch;
  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION ai_watch_apply_role_grants() FROM PUBLIC;

SELECT ai_watch_apply_role_grants();
