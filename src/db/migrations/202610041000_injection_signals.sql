-- 202610041000_injection_signals.sql
-- 이메일 프롬프트 인젝션 구조 방어 M1·M2 배선(ADR-0016 — 위험 적응 승인 A · 발신 DLP B). 표 셋 · 칸 하나 · 승인 범위 `once` · 보존 함수.
--
--   ① `agent_exposures` — **에이전트가 무엇을 읽었는가.** 읽기 라우트(상세 · 스레드 · 첨부 content · 첨부 URL · 인증 코드)가 본문을 돌려주기 **전에**
--      UPSERT 한다(실패 → 503, fail closed). 키 (agent_id, inbound_message_id, part) — 같은 것을 다시 읽으면 `last_at` 만 민다. 등급은 내려가지 않는다
--      (`GREATEST` — 재분류가 창을 닫지 못한다). 오염 창(에이전트 4시간 · 스레드·발신자 7일, `src/security/taint.ts`)은 `last_at` 에서 센다 — 시각은 DB
--      `now()` 다(호출자 시각을 믿지 않는다). 본문·제목은 없다 — 등급 · 계열 이름(닫힌 어휘 모양) · 스레드 · 발신 주소뿐.
--   ② `inbound_fingerprints` — 받은 메일의 **복사 지문**(8-gram winnowing HMAC, `src/security/dlp/shingle.ts`) 최대 256개. 수신 소비자가 메일 행과
--      **같은 트랜잭션**에서 적는다. 원문 없음(HMAC 16 hex). `participants` = DMARC 통과 메일의 From·To·Cc(소문자) — reply-all 의 동료를 원 메일의
--      복사로 보지 않게(ADR-0016 M1 배선 계약 5). 불변(UPDATE·DELETE 거부 — 보존 함수만 지운다). 보존 30일.
--   ③ `agent_code_fingerprints` — 에이전트가 읽은 **인증 코드의 HMAC 지문**(`src/security/dlp/codes.ts`) · 출처 등록 도메인. 24시간 보존 —
--      다시 읽으면 `created_at` 을 민다. 코드 원문은 어디에도 없다(ADR-0013 경계 개정 — 좁히는 방향으로만 쓴다).
--   ④ `messages.outbound_dlp` — 발송 시도의 DLP 계열(닫힌 다섯 값). NULL = 이 파일 전의 행. CHECK 는 `NOT VALID`, 검증은 202610041001.
--   ⑤ `approval_requests.granted_scope` 에 `once` — 위험 보류(사유 `tainted_context`·`dlp_*`)의 승인은 그 메일 한 통만이다(상시 관계를 만들지
--      않는다). 트리거 둘이 그것을 DB 에서 강제한다:
--        · `approval_requests_risk_hold_once` — 항목의 audit 사유에 위험 보류가 있으면 승인 전이의 `granted_scope` 는 `once` 여야 한다.
--        · `sender_relationships_reject_once_grant` — `once` 승인으로는 관계 행을 만들 수 없다.
--   ⑥ `purge_injection_signals()` — 보존(노출 8일 · 복사 지문 30일 · 코드 지문 24시간), 표마다 한 번에 10 000. 앱 롤(TTL 스위퍼)만 EXECUTE.
--
-- 권한(앱 롤 — `RESTRICTED_ROLE_GRANTS`): 노출 SELECT·INSERT·UPDATE(level·families·surface·last_at) · 복사 지문 SELECT·INSERT · 코드 지문
-- SELECT·INSERT·UPDATE(created_at). DELETE 0(보존 함수만).
-- 잠금: 새 표 셋 · `messages`·`approval_requests` ADD/DROP CONSTRAINT(짧은 ACCESS EXCLUSIVE — 표를 읽지 않는다) · 트리거. 5초 안에 못 잡으면 실패한다.
-- **순서:** 터널 migrate(이 파일 · 1001) → `deploy-compute migrate=false`. 옛 코드는 새 표·칸을 모른다(expand-only — 옛 코드가 도는 동안 노출은 기록되지
-- 않고 `outbound_dlp` 는 NULL 이다).

SET LOCAL lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- ① agent_exposures
-- ---------------------------------------------------------------------------

CREATE TABLE agent_exposures (
  agent_id           char(32) NOT NULL REFERENCES agents (id) ON DELETE RESTRICT,
  inbound_message_id uuid NOT NULL REFERENCES inbound_messages (id) ON DELETE RESTRICT,
  -- 무엇이 보였나 — 본문(제목 포함) · 첨부 n 번의 내용 · 인증 코드.
  part               text NOT NULL CHECK (part ~ '^(body|verification_code|attachment:(0|[1-9][0-9]{0,3}))$'),
  -- 마지막으로 보인 읽기 면.
  surface            text NOT NULL CHECK (surface IN ('message_detail', 'thread', 'attachment_content', 'attachment_url', 'verification_code')),
  -- T0 · T1 · T2(`src/security/taint.ts`). T2 만 오염 창을 연다.
  level              smallint NOT NULL CHECK (level BETWEEN 0 AND 2),
  -- 스캐너 적중 계열(`RuleFamily`) — 닫힌 어휘의 모양만. 본문 조각이 들어갈 자리가 없다.
  families           text[] NOT NULL DEFAULT '{}'
                       CHECK (cardinality(families) <= 32 AND array_to_string(families, ',') ~ '^([a-z0-9_]{1,64}(,|$))*$'),
  -- 노출된 메일의 **권한용** 스레드와 발신 주소(소문자 · `+tag` 보존) — 스레드·발신자 7일 창의 키.
  thread_id          uuid NOT NULL,
  sender             text NOT NULL CHECK (sender = lower(sender) AND length(sender) <= 320 AND sender ~ '^[^@[:space:]]+@[^@[:space:]]+$'),
  first_at           timestamptz NOT NULL DEFAULT now(),
  last_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT agent_exposures_pkey PRIMARY KEY (agent_id, inbound_message_id, part),
  CONSTRAINT agent_exposures_time_order CHECK (last_at >= first_at)
);

-- 위험 신호 로더(`db/repositories/risk-signal-store.ts`)의 조회 — 에이전트의 최근 T2 노출만.
CREATE INDEX agent_exposures_tainted_idx ON agent_exposures (agent_id, last_at DESC) WHERE level >= 2;
-- 보존 함수의 조회.
CREATE INDEX agent_exposures_last_at_idx ON agent_exposures (last_at);

-- 등급은 내려가지 않고, 정체성 칸은 바뀌지 않는다(모든 롤). 첫 시각도 그대로다.
CREATE FUNCTION agent_exposures_monotonic() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.agent_id <> OLD.agent_id OR NEW.inbound_message_id <> OLD.inbound_message_id OR NEW.part <> OLD.part
     OR NEW.thread_id <> OLD.thread_id OR NEW.sender <> OLD.sender OR NEW.first_at <> OLD.first_at THEN
    RAISE EXCEPTION 'agent_exposures identity columns are immutable' USING ERRCODE = '23514';
  END IF;
  IF NEW.level < OLD.level THEN
    RAISE EXCEPTION 'agent_exposures.level never goes down (% -> %)', OLD.level, NEW.level USING ERRCODE = '23514';
  END IF;
  IF NEW.last_at < OLD.last_at THEN
    RAISE EXCEPTION 'agent_exposures.last_at never goes back' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER agent_exposures_monotonic
  BEFORE UPDATE ON agent_exposures
  FOR EACH ROW EXECUTE FUNCTION agent_exposures_monotonic();

CREATE TRIGGER agent_exposures_no_truncate
  AFTER TRUNCATE ON agent_exposures
  FOR EACH STATEMENT EXECUTE FUNCTION reject_truncate();

COMMENT ON TABLE agent_exposures IS
  '에이전트가 읽은 받은 메일(ADR-0016 A) — 읽기 라우트가 본문을 돌려주기 전에 UPSERT(실패 503). T2 노출이 오염 창(에이전트 4h · 스레드·발신자 7d)을 연다. 본문 없음. 보존 purge_injection_signals().';

-- ---------------------------------------------------------------------------
-- ② inbound_fingerprints
-- ---------------------------------------------------------------------------

CREATE TABLE inbound_fingerprints (
  inbound_message_id uuid PRIMARY KEY REFERENCES inbound_messages (id) ON DELETE RESTRICT,
  agent_id           char(32) NOT NULL REFERENCES agents (id) ON DELETE RESTRICT,
  thread_id          uuid NOT NULL,
  sender             text NOT NULL CHECK (sender = lower(sender) AND length(sender) <= 320 AND sender ~ '^[^@[:space:]]+@[^@[:space:]]+$'),
  -- DMARC 통과 메일이면 그 메일의 From·To·Cc(소문자, 최대 64) — 아니면 빈 배열(위조된 머리글로 제외를 얻지 못한다).
  participants       text[] NOT NULL DEFAULT '{}'
                       CHECK (cardinality(participants) <= 64 AND array_to_string(participants, ' ') !~ '[[:upper:][:cntrl:]]'),
  kid                text NOT NULL CHECK (kid ~ '^[a-z0-9]{1,16}$'),
  fingerprints       text[] NOT NULL
                       CHECK (cardinality(fingerprints) <= 256 AND array_to_string(fingerprints, ',') ~ '^([0-9a-f]{16}(,|$))*$'),
  created_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX inbound_fingerprints_agent_created_idx ON inbound_fingerprints (agent_id, created_at DESC);
CREATE INDEX inbound_fingerprints_created_idx ON inbound_fingerprints (created_at);

CREATE TRIGGER inbound_fingerprints_no_update
  BEFORE UPDATE ON inbound_fingerprints
  FOR EACH ROW EXECUTE FUNCTION reject_row_update();

CREATE TRIGGER inbound_fingerprints_no_truncate
  AFTER TRUNCATE ON inbound_fingerprints
  FOR EACH STATEMENT EXECUTE FUNCTION reject_truncate();

COMMENT ON TABLE inbound_fingerprints IS
  '받은 메일의 복사 지문(ADR-0016 B inbound_copy) — HMAC 8-gram winnowing 최대 256 · 원문 없음. 수신 소비자가 메일 행과 같은 트랜잭션에서 적는다. 불변 · 보존 30일(purge_injection_signals()).';

-- ---------------------------------------------------------------------------
-- ③ agent_code_fingerprints
-- ---------------------------------------------------------------------------

CREATE TABLE agent_code_fingerprints (
  agent_id           char(32) NOT NULL REFERENCES agents (id) ON DELETE RESTRICT,
  kid                text NOT NULL CHECK (kid ~ '^[a-z0-9]{1,16}$'),
  mac                text NOT NULL CHECK (mac ~ '^[0-9a-f]{32}$'),
  -- 코드를 보낸 메일의 **등록 도메인**(소문자) — 수신자 도메인이 전부 이것이면 DLP 가 세지 않는다(그 서비스에 되돌려 보내기).
  origin_domain      text NOT NULL CHECK (origin_domain = lower(origin_domain) AND origin_domain ~ '^[^@[:space:]]{1,253}$'),
  inbound_message_id uuid NOT NULL REFERENCES inbound_messages (id) ON DELETE RESTRICT,
  created_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT agent_code_fingerprints_pkey PRIMARY KEY (agent_id, kid, mac, origin_domain)
);

CREATE INDEX agent_code_fingerprints_agent_created_idx ON agent_code_fingerprints (agent_id, created_at DESC);
CREATE INDEX agent_code_fingerprints_created_idx ON agent_code_fingerprints (created_at);

-- 다시 읽으면 시각만 앞으로 민다 — 다른 칸은 그대로(모든 롤).
CREATE FUNCTION agent_code_fingerprints_refresh_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.agent_id <> OLD.agent_id OR NEW.kid <> OLD.kid OR NEW.mac <> OLD.mac OR NEW.origin_domain <> OLD.origin_domain
     OR NEW.inbound_message_id <> OLD.inbound_message_id THEN
    RAISE EXCEPTION 'agent_code_fingerprints identity columns are immutable' USING ERRCODE = '23514';
  END IF;
  IF NEW.created_at < OLD.created_at THEN
    RAISE EXCEPTION 'agent_code_fingerprints.created_at never goes back' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER agent_code_fingerprints_refresh_only
  BEFORE UPDATE ON agent_code_fingerprints
  FOR EACH ROW EXECUTE FUNCTION agent_code_fingerprints_refresh_only();

CREATE TRIGGER agent_code_fingerprints_no_truncate
  AFTER TRUNCATE ON agent_code_fingerprints
  FOR EACH STATEMENT EXECUTE FUNCTION reject_truncate();

COMMENT ON TABLE agent_code_fingerprints IS
  '에이전트가 읽은 인증 코드의 HMAC 지문(ADR-0016 B verification_code · ADR-0013 개정 — 좁히는 방향으로만). 코드 원문 없음. 24시간(purge_injection_signals()).';

-- ---------------------------------------------------------------------------
-- ④ messages.outbound_dlp
-- ---------------------------------------------------------------------------

ALTER TABLE messages ADD COLUMN outbound_dlp text[];
ALTER TABLE messages ADD CONSTRAINT messages_outbound_dlp_check CHECK (
  outbound_dlp IS NULL
  OR outbound_dlp <@ ARRAY['atmark_credential', 'third_party_secret', 'verification_code', 'inbound_copy', 'scan_limit']::text[]
) NOT VALID;

COMMENT ON COLUMN messages.outbound_dlp IS
  '발신 DLP 계열(ADR-0016 B — 닫힌 다섯 값, 값·위치 없음). 발송 서비스가 서버가 조립한 최종 내용으로 계산해 INSERT 때 적는다. NULL = 202610041000 전의 행.';

-- ---------------------------------------------------------------------------
-- ⑤ granted_scope 'once' + 위험 보류 승인은 once
-- ---------------------------------------------------------------------------

ALTER TABLE approval_requests DROP CONSTRAINT approval_requests_granted_scope_check;
ALTER TABLE approval_requests ADD CONSTRAINT approval_requests_granted_scope_check
  CHECK (granted_scope IS NULL OR granted_scope IN ('recipient', 'thread', 'domain', 'once')) NOT VALID;

-- 위험 보류 사유 — `src/policy/types.ts` `RiskHoldReason`(통합 테스트가 같은 집합인지 대조한다).
CREATE FUNCTION approval_requests_risk_hold_once() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF OLD.status = 'pending' AND NEW.status = 'approved' AND NEW.granted_scope IS DISTINCT FROM 'once' AND EXISTS (
       SELECT 1
         FROM public.approval_request_items i
         JOIN public.audit_logs a ON a.id = i.audit_id
        WHERE i.approval_id = NEW.id
          AND a.reasons && ARRAY['tainted_context', 'dlp_atmark_credential', 'dlp_third_party_secret', 'dlp_verification_code',
                                 'dlp_inbound_copy', 'dlp_scan_limit']::text[]) THEN
    RAISE EXCEPTION 'approval % is a risk hold — it can only be approved once (granted_scope once)', NEW.id USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION approval_requests_risk_hold_once() FROM PUBLIC;

CREATE TRIGGER approval_requests_risk_hold_once
  BEFORE UPDATE ON approval_requests
  FOR EACH ROW EXECUTE FUNCTION approval_requests_risk_hold_once();

CREATE FUNCTION sender_relationships_reject_once_grant() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF NEW.granted_via_approval_id IS NOT NULL AND EXISTS (
       SELECT 1 FROM public.approval_requests r WHERE r.id = NEW.granted_via_approval_id AND r.granted_scope = 'once') THEN
    RAISE EXCEPTION 'approval % was granted once — it creates no standing relationship', NEW.granted_via_approval_id USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION sender_relationships_reject_once_grant() FROM PUBLIC;

CREATE TRIGGER sender_relationships_reject_once_grant
  BEFORE INSERT ON sender_relationships
  FOR EACH ROW EXECUTE FUNCTION sender_relationships_reject_once_grant();

-- ---------------------------------------------------------------------------
-- ⑥ 보존
-- ---------------------------------------------------------------------------

-- 노출 보존은 8일 — 스레드·발신자 창(7일)보다 하루 길게(경계의 행을 창 안에서 지우지 않는다).
CREATE FUNCTION purge_injection_signals() RETURNS integer
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  WITH exposures AS (
    DELETE FROM public.agent_exposures e
     WHERE (e.agent_id, e.inbound_message_id, e.part) IN (
             SELECT o.agent_id, o.inbound_message_id, o.part FROM public.agent_exposures o
              WHERE o.last_at < now() - interval '8 days'
              ORDER BY o.last_at
              LIMIT 10000)
    RETURNING 1
  ), copies AS (
    DELETE FROM public.inbound_fingerprints f
     WHERE f.inbound_message_id IN (
             SELECT o.inbound_message_id FROM public.inbound_fingerprints o
              WHERE o.created_at < now() - interval '30 days'
              ORDER BY o.created_at
              LIMIT 10000)
    RETURNING 1
  ), codes AS (
    DELETE FROM public.agent_code_fingerprints c
     WHERE (c.agent_id, c.kid, c.mac, c.origin_domain) IN (
             SELECT o.agent_id, o.kid, o.mac, o.origin_domain FROM public.agent_code_fingerprints o
              WHERE o.created_at < now() - interval '24 hours'
              ORDER BY o.created_at
              LIMIT 10000)
    RETURNING 1
  )
  SELECT ((SELECT count(*) FROM exposures) + (SELECT count(*) FROM copies) + (SELECT count(*) FROM codes))::int
$$;

COMMENT ON FUNCTION purge_injection_signals() IS
  '인젝션 구조 방어 보존 — 노출 8일 · 복사 지문 30일 · 코드 지문 24시간 넘은 행, 표마다 한 번에 10 000, 지운 수. 인자 없음. 앱 롤(TTL 스위퍼)만 EXECUTE.';

REVOKE ALL ON FUNCTION purge_injection_signals() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION purge_injection_signals() TO atmark_app;

-- ---------------------------------------------------------------------------
-- 권한
-- ---------------------------------------------------------------------------

REVOKE ALL ON agent_exposures, inbound_fingerprints, agent_code_fingerprints FROM PUBLIC;
GRANT SELECT, INSERT ON agent_exposures TO atmark_app;
GRANT UPDATE (level, families, surface, last_at) ON agent_exposures TO atmark_app;
GRANT SELECT, INSERT ON inbound_fingerprints TO atmark_app;
GRANT SELECT, INSERT ON agent_code_fingerprints TO atmark_app;
GRANT UPDATE (created_at) ON agent_code_fingerprints TO atmark_app;
