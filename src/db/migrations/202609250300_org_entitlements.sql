-- 202609250300_org_entitlements.sql
-- 과금 P0 "엔타이틀먼트"(ADR-0011, docs/research/billing-stripe-korea.md Part B B3·B6). 공급자 독립 — 결제 공급자(Paddle, WP-2)는 아직 없다.
--
--   ① `org_entitlements` — 조직 하나의 요금제 한도(단일 진실 원천). 카탈로그는 코드 상수(`src/billing/plans.ts`)이고 이 행은 "이 조직이 지금
--      받는 값" 이다. **행이 없으면 Free**(로더가 fail-closed). 칸 상한(CHECK)은 코드 천장(`ENTITLEMENT_CEILINGS`)과 같다 — 천장을 올리려면
--      코드·마이그레이션·리뷰가 함께 든다(워밍업 표와 같은 이유, R22). `version` 은 1 에서 시작해 **하나씩 앞으로만**(트리거) · 조직·생성
--      시각 불변 · `updated_at` 은 DB 가 적는다 · 지우기·비우기 거부.
--   ② `billing_audit` — 엔타이틀먼트 변경 원장(append-only: 고치기·지우기·비우기 거부). **버전마다 정확히 한 행**이어야 커밋된다(지연 제약
--      트리거 `org_entitlements_audited`) — 감사 행 없이 한도를 바꾸는 쓰기는 트랜잭션째 되돌아간다.
--   ③ 투명성 로그(ADR-0008) — 잎 종류 `billing.entitlement`, 원천 `org_entitlements`(INSERT·UPDATE). 행이 변경 가능하므로 그때 값을 outbox
--      스냅샷에 싣는다(`agents` 와 같은 규율). 잎에는 요금제 코드 · 한도 수치 · 유예 끝 · 버전 · 원인만 — **금액·고객 id·이메일은 없다**
--      (이 표에 그런 칸이 없다).
--   ④ 백필 — 지금 조직 전부에 한 행: 검토가 끝난(`review_status = 'active'`) 조직은 `beta`(현행 한도 그대로 — 에이전트 10 · 발송은 워밍업과
--      정책이 정한다), 그 밖(검토 대기·거절)은 `free`. 원인 `backfill` · 감사 행 · 잎이 함께 생긴다(도입 시각의 사건 — 과거 시각을 꾸미지 않는다).
--   ⑤ 권한 — 앱·admin 롤은 `org_entitlements` **읽기만**(정책 로더·콘솔·상한 검사). 쓰기는 소유자 롤(운영자 CLI `pnpm admin:plan` ·
--      `pnpm admin:org-review --activate` 의 베타 자동 부여)뿐이고 WP-2 가 `atmark_billing` 롤을 더한다. `billing_audit` 은 두 롤 모두 0.
--      서열 롤은 원천 행이 있는지만 본다(값은 스냅샷).
--   ⑥ 천장 트리거(심층 방어) — 앱 코드의 상한 검사가 빠지거나 동시 요청이 겹쳐도 DB 가 절대 천장을 지킨다: 에이전트당 활성 웹훅
--      엔드포인트 10(`webhook_endpoints_active_limit`) · 조직당 에이전트 1000(비활성 포함, `agents_org_ceiling`). 잠금 키는 앱의 상한 검사와
--      같다(같은 세션은 다시 잡아도 된다) — `agent_api_keys_active_limit`(202609250010)과 같은 모양.
--
-- 원인 `review`: 베타 기간에는 검토 활성화가 같은 트랜잭션에서 `beta` 를 준다(ADR-0011 §10, 스위치 `BETA_ON_ACTIVATION`) — 출처 `operator`.
--
-- `billing_customers` · `billing_subscriptions` · `billing_events` 는 **만들지 않는다**(WP-2) — 공급자(Paddle) 모양이 정해진 뒤 `atmark_billing`
-- 롤·grant 와 한 파일로 만든다. 빈 표를 먼저 두면 권한 표면만 늘고, 공급자 칸을 고치는 ALTER 가 뒤따른다(ADR-0011 §미룬 것).
--
-- 잠금(M5): `organizations` 를 REFERENCES 하고 tlog 표의 CHECK 를 바꾼다 — 5초 안에 못 잡으면 실패하고 아무것도 바뀌지 않는다.
-- **배포 순서**(런북 deploy §20): 새 서열기(`AtmarkTransparency`)가 이 원천을 먼저 알아야 한다 — 옛 서열기는 `org_entitlements` outbox 행에서 멈춘다.

SET LOCAL lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- ① org_entitlements
-- ---------------------------------------------------------------------------

CREATE TABLE org_entitlements (
  organization_id                 uuid PRIMARY KEY REFERENCES organizations (id) ON DELETE RESTRICT,
  plan_code                       text NOT NULL CHECK (plan_code IN ('free', 'beta', 'pro', 'team', 'scale')),
  source                          text NOT NULL CHECK (source IN ('default', 'provider', 'operator')),
  -- `review` = 검토 활성화의 베타 자동 부여(ADR-0011 §10). 수동 `admin:plan` 은 `operator`.
  cause                           text NOT NULL CHECK (cause IN ('backfill', 'operator', 'review', 'provider_event', 'grace_expired', 'reconcile')),
  -- 칸 상한 = 코드 천장(`ENTITLEMENT_CEILINGS`). 에이전트는 비활성 제외 · 조직 수신자/일은 워밍업 정상상태 1000 이 절대 상한.
  max_agents                      integer NOT NULL CHECK (max_agents BETWEEN 0 AND 1000),
  org_daily_recipients            integer NOT NULL CHECK (org_daily_recipients BETWEEN 1 AND 1000),
  agent_per_day_max               integer NOT NULL CHECK (agent_per_day_max BETWEEN 1 AND 10000),
  agent_per_minute_max            integer NOT NULL CHECK (agent_per_minute_max BETWEEN 1 AND 9999),
  recipients_per_message_max      integer NOT NULL CHECK (recipients_per_message_max BETWEEN 1 AND 50),
  tokens_per_agent_max            integer NOT NULL CHECK (tokens_per_agent_max BETWEEN 1 AND 5),
  webhook_endpoints_per_agent_max integer NOT NULL CHECK (webhook_endpoints_per_agent_max BETWEEN 0 AND 10),
  org_api_keys_max                integer NOT NULL CHECK (org_api_keys_max BETWEEN 0 AND 5),
  inbound_storage_bytes           bigint NOT NULL CHECK (inbound_storage_bytes BETWEEN 0 AND 1099511627776),
  -- 다운그레이드·연체 유예 끝. 지나면 로더가 Free 를 쓴다(동기화가 늦어도 강등은 제시각 — ADR-0011 B7).
  grace_until                     timestamptz,
  version                         bigint NOT NULL CHECK (version >= 1),
  created_at                      timestamptz NOT NULL DEFAULT now(),
  updated_at                      timestamptz NOT NULL DEFAULT now(),
  -- 출처와 원인이 맞물린다 — 운영자 행을 "공급자가 바꿨다" 로 적지 못한다.
  CONSTRAINT org_entitlements_source_cause CHECK (
    (source = 'default' AND cause = 'backfill')
    OR (source = 'operator' AND cause IN ('operator', 'review'))
    OR (source = 'provider' AND cause IN ('provider_event', 'grace_expired', 'reconcile')))
);

-- version: 첫 행 1 · 이후 정확히 +1. 조직·생성 시각은 불변. 시각은 DB 가 적는다(잎의 `at` = updated_at — 꾸민 시각으로 창 밖에 숨지 못한다).
CREATE FUNCTION org_entitlements_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.version <> 1 THEN
      RAISE EXCEPTION 'org_entitlements: 첫 행의 version 은 1 이다(받은 값 %)', NEW.version USING ERRCODE = '23514';
    END IF;
    NEW.created_at := now();
    NEW.updated_at := now();
    RETURN NEW;
  END IF;
  IF NEW.organization_id IS DISTINCT FROM OLD.organization_id OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'org_entitlements: 조직·생성 시각은 바꿀 수 없다' USING ERRCODE = '23514';
  END IF;
  IF NEW.version IS DISTINCT FROM OLD.version + 1 THEN
    RAISE EXCEPTION 'org_entitlements: version 은 하나씩 앞으로만 간다(% → %)', OLD.version, NEW.version USING ERRCODE = '23514';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER org_entitlements_version_forward_only BEFORE INSERT OR UPDATE ON org_entitlements
  FOR EACH ROW EXECUTE FUNCTION org_entitlements_guard();
CREATE TRIGGER org_entitlements_no_delete BEFORE DELETE ON org_entitlements
  FOR EACH ROW EXECUTE FUNCTION reject_row_delete();
CREATE TRIGGER org_entitlements_no_truncate BEFORE TRUNCATE ON org_entitlements
  FOR EACH STATEMENT EXECUTE FUNCTION reject_truncate();

COMMENT ON TABLE org_entitlements IS
  '조직 요금제 한도(ADR-0011). 행 없음 = Free(fail-closed). 앱·admin 은 읽기만 — 쓰기는 소유자 롤(pnpm admin:plan) · WP-2 billing 롤.';

-- ---------------------------------------------------------------------------
-- ② billing_audit (append-only) + 버전마다 감사 행
-- ---------------------------------------------------------------------------

CREATE TABLE billing_audit (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id     uuid NOT NULL REFERENCES organizations (id) ON DELETE RESTRICT,
  from_plan           text CHECK (from_plan IS NULL OR from_plan IN ('free', 'beta', 'pro', 'team', 'scale')),
  to_plan             text NOT NULL CHECK (to_plan IN ('free', 'beta', 'pro', 'team', 'scale')),
  cause               text NOT NULL CHECK (cause IN ('backfill', 'operator', 'review', 'provider_event', 'grace_expired', 'reconcile')),
  -- 누가 — 운영자 이름(`--by`) · `migration:<파일>` · (WP-2) `provider:<공급자>`. 투명성 잎에는 싣지 않는다.
  actor               text NOT NULL CHECK (length(actor) BETWEEN 1 AND 200),
  provider_event_id   text CHECK (provider_event_id IS NULL OR length(provider_event_id) BETWEEN 1 AND 200),
  note                text CHECK (note IS NULL OR length(note) BETWEEN 1 AND 500),
  entitlement_version bigint NOT NULL CHECK (entitlement_version >= 1),
  created_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT billing_audit_version_key UNIQUE (organization_id, entitlement_version)
);

CREATE TRIGGER billing_audit_no_update BEFORE UPDATE ON billing_audit
  FOR EACH ROW EXECUTE FUNCTION reject_row_update();
CREATE TRIGGER billing_audit_no_delete BEFORE DELETE ON billing_audit
  FOR EACH ROW EXECUTE FUNCTION reject_row_delete();
CREATE TRIGGER billing_audit_no_truncate BEFORE TRUNCATE ON billing_audit
  FOR EACH STATEMENT EXECUTE FUNCTION reject_truncate();

-- 엔타이틀먼트의 모든 버전은 **같은 트랜잭션에** 감사 행이 있어야 커밋된다(지연 — 감사 행을 먼저 쓰든 나중에 쓰든). 감사 행은 버전 ·
-- 요금제 · 원인 · **이전 요금제**(INSERT 면 NULL, UPDATE 면 그 직전 행의 요금제)가 맞고 **이 트랜잭션에서 쓴 것**(`created_at = now()` —
-- 트랜잭션 시작 시각)이어야 한다: 앞 트랜잭션에 미리 적어 둔 감사 행으로 나중 변경을 덮거나, from_plan 을 꾸며 강등을 승급으로 적지 못한다.
-- SECURITY DEFINER 인 이유: WP-2 의 billing 롤은 billing_audit 을 INSERT 만 하고 읽지 못한다 — 검사는 쓰는 롤의 권한과 무관해야 한다.
CREATE FUNCTION org_entitlements_audited() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  previous_plan text := NULL;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    previous_plan := OLD.plan_code;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM billing_audit b
     WHERE b.organization_id = NEW.organization_id AND b.entitlement_version = NEW.version AND b.to_plan = NEW.plan_code AND b.cause = NEW.cause
       AND b.from_plan IS NOT DISTINCT FROM previous_plan
       AND b.created_at = now()
  ) THEN
    RAISE EXCEPTION 'org_entitlements: 버전 % 의 billing_audit 행이 이 트랜잭션에 없다(조직 % · 요금제·원인·이전 요금제 대조) — 감사 없이 한도를 바꾸지 않는다',
      NEW.version, NEW.organization_id
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION org_entitlements_audited() FROM PUBLIC;

CREATE CONSTRAINT TRIGGER org_entitlements_audited AFTER INSERT OR UPDATE ON org_entitlements
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION org_entitlements_audited();

COMMENT ON TABLE billing_audit IS
  '엔타이틀먼트 변경 원장(ADR-0011) — append-only. 버전마다 한 행(org_entitlements_audited). 금액·고객 id 없음.';

-- ---------------------------------------------------------------------------
-- ③ 투명성 로그 — 잎 종류 billing.entitlement · 원천 org_entitlements (202609242200 위에 얹는다)
-- ---------------------------------------------------------------------------

ALTER TABLE tlog_outbox DROP CONSTRAINT tlog_outbox_source_table_check;
ALTER TABLE tlog_outbox ADD CONSTRAINT tlog_outbox_source_table_check CHECK (source_table IN (
  'audit_logs', 'owner_actions', 'policy_versions', 'inbound_messages',
  'agents', 'agent_addresses', 'agent_keypairs', 'passport_documents', 'org_entitlements'));

-- 스냅샷은 변경 가능한 원천(audit_logs · agents · org_entitlements)만.
ALTER TABLE tlog_outbox DROP CONSTRAINT tlog_outbox_snapshot_shape;
ALTER TABLE tlog_outbox ADD CONSTRAINT tlog_outbox_snapshot_shape CHECK (source_table IN ('audit_logs', 'agents', 'org_entitlements') OR snapshot IS NULL);

ALTER TABLE tlog_leaves DROP CONSTRAINT tlog_leaves_kind_check;
ALTER TABLE tlog_leaves ADD CONSTRAINT tlog_leaves_kind_check CHECK (kind IN (
  'org.genesis', 'audit.evaluated', 'audit.updated', 'owner.action', 'policy.version', 'inbound.verdict', 'source.missing',
  'identity.agent_created', 'identity.agent_updated', 'identity.address_assigned', 'identity.key_bound', 'identity.passport_version',
  'billing.entitlement'));

-- billing.entitlement 잎은 org_entitlements 에서만, 다른 잎은 org_entitlements 를 가리키지 않는다(source.missing 은 어느 원천이든).
ALTER TABLE tlog_leaves ADD CONSTRAINT tlog_leaves_billing_source CHECK (
  CASE
    WHEN kind IN ('org.genesis', 'source.missing') THEN true
    WHEN kind = 'billing.entitlement' THEN source_table = 'org_entitlements'
    ELSE source_table IS DISTINCT FROM 'org_entitlements'
  END);

-- 202609242200 의 함수를 넓힌다 — 기존 여덟 원천의 동작은 한 글자도 다르지 않다.
CREATE OR REPLACE FUNCTION tlog_enqueue() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  org uuid;
  event text := CASE TG_OP WHEN 'INSERT' THEN 'insert' ELSE 'update' END;
  next_rev integer := 0;
  snap jsonb := NULL;
  src_id text;
  changed text[] := ARRAY[]::text[];
BEGIN
  IF TG_TABLE_NAME IN ('owner_actions', 'agents') THEN
    org := NEW.organization_id;
    src_id := NEW.id::text;
  ELSIF TG_TABLE_NAME = 'org_entitlements' THEN
    org := NEW.organization_id;
    src_id := NEW.organization_id::text;
  ELSIF TG_TABLE_NAME = 'agent_keypairs' THEN
    SELECT a.organization_id INTO org FROM agents a WHERE a.id = NEW.agent_id;
    src_id := NEW.agent_id::text;
  ELSIF TG_TABLE_NAME = 'passport_documents' THEN
    SELECT a.organization_id INTO org FROM passports p JOIN agents a ON a.id = p.agent_id WHERE p.id = NEW.passport_id;
    src_id := NEW.passport_id::text;
  ELSE
    SELECT a.organization_id INTO org FROM agents a WHERE a.id = NEW.agent_id;
    src_id := NEW.id::text;
  END IF;
  IF org IS NULL THEN
    RAISE EXCEPTION 'tlog_enqueue: % 행의 조직을 찾지 못했다', TG_TABLE_NAME USING ERRCODE = '23503';
  END IF;
  IF TG_TABLE_NAME = 'audit_logs' THEN
    snap := jsonb_build_object(
      'decision', NEW.decision::text,
      'resolved_at', to_char(NEW.resolved_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
      'resolution_reason', NEW.resolution_reason,
      'approved_by', NEW.approved_by);
    IF event = 'update' THEN
      SELECT coalesce(max(o.rev), 0) + 1 INTO next_rev
        FROM tlog_outbox o
       WHERE o.source_table = 'audit_logs' AND o.source_id = src_id AND o.event = 'update';
    END IF;
  ELSIF TG_TABLE_NAME = 'agents' THEN
    IF event = 'update' THEN
      IF OLD.name IS DISTINCT FROM NEW.name THEN changed := array_append(changed, 'name'); END IF;
      IF OLD.status IS DISTINCT FROM NEW.status THEN changed := array_append(changed, 'status'); END IF;
      IF OLD.suspended_by IS DISTINCT FROM NEW.suspended_by THEN changed := array_append(changed, 'suspended_by'); END IF;
      SELECT coalesce(max(o.rev), 0) + 1 INTO next_rev
        FROM tlog_outbox o
       WHERE o.source_table = 'agents' AND o.source_id = src_id AND o.event = 'update';
    END IF;
    snap := jsonb_build_object(
      'name', NEW.name,
      'status', NEW.status::text,
      'suspended_by', NEW.suspended_by,
      'changed', to_jsonb(changed));
  ELSIF TG_TABLE_NAME = 'org_entitlements' THEN
    -- 그때 값(서열 시점의 행을 읽으면 두 번 바뀐 행의 중간 버전이 사라진다). 금액·고객 id 는 이 표에 없다.
    IF event = 'update' THEN
      SELECT coalesce(max(o.rev), 0) + 1 INTO next_rev
        FROM tlog_outbox o
       WHERE o.source_table = 'org_entitlements' AND o.source_id = src_id AND o.event = 'update';
    END IF;
    snap := jsonb_build_object(
      'plan_code', NEW.plan_code,
      'cause', NEW.cause,
      'version', NEW.version,
      'max_agents', NEW.max_agents,
      'org_daily_recipients', NEW.org_daily_recipients,
      'agent_per_day_max', NEW.agent_per_day_max,
      'agent_per_minute_max', NEW.agent_per_minute_max,
      'recipients_per_message_max', NEW.recipients_per_message_max,
      'tokens_per_agent_max', NEW.tokens_per_agent_max,
      'webhook_endpoints_per_agent_max', NEW.webhook_endpoints_per_agent_max,
      'org_api_keys_max', NEW.org_api_keys_max,
      'inbound_storage_bytes', NEW.inbound_storage_bytes,
      'grace_until', to_char(NEW.grace_until AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
      'at', to_char(NEW.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'));
  END IF;
  INSERT INTO tlog_outbox (source_table, source_id, event, rev, organization_id, snapshot)
  VALUES (TG_TABLE_NAME, src_id, event, next_rev, org, snap);
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION tlog_enqueue() FROM PUBLIC;

CREATE TRIGGER org_entitlements_tlog_enqueue_insert AFTER INSERT ON org_entitlements FOR EACH ROW EXECUTE FUNCTION tlog_enqueue();
CREATE TRIGGER org_entitlements_tlog_enqueue_update AFTER UPDATE ON org_entitlements FOR EACH ROW EXECUTE FUNCTION tlog_enqueue();

-- ---------------------------------------------------------------------------
-- ④ 백필 — 검토가 끝난 조직은 beta(현행 한도), 그 밖은 free. 값은 `PLAN_CATALOG`(src/billing/plans.ts)와 같다(unit 테스트가 대조한다).
-- ---------------------------------------------------------------------------

INSERT INTO billing_audit (organization_id, from_plan, to_plan, cause, actor, entitlement_version)
SELECT o.id, NULL, CASE WHEN o.review_status = 'active' THEN 'beta' ELSE 'free' END, 'backfill', 'migration:202609250300', 1
  FROM organizations o;

INSERT INTO org_entitlements (
  organization_id, plan_code, source, cause, max_agents, org_daily_recipients, agent_per_day_max, agent_per_minute_max,
  recipients_per_message_max, tokens_per_agent_max, webhook_endpoints_per_agent_max, org_api_keys_max, inbound_storage_bytes, version)
SELECT o.id, p.plan_code, 'default', 'backfill', p.max_agents, p.org_daily_recipients, p.agent_per_day_max, p.agent_per_minute_max,
       p.recipients_per_message_max, p.tokens_per_agent_max, p.webhook_endpoints_per_agent_max, p.org_api_keys_max, p.inbound_storage_bytes, 1
  FROM organizations o
  JOIN (VALUES
    -- plan_code, max_agents, org_daily_recipients, agent_per_day_max, agent_per_minute_max, recipients_per_message_max,
    -- tokens_per_agent_max, webhook_endpoints_per_agent_max, org_api_keys_max, inbound_storage_bytes
    ('beta', 10, 1000, 10000, 9999, 50, 5, 10, 5, 10737418240::bigint),
    ('free', 3, 100, 100, 5, 10, 2, 1, 1, 1073741824::bigint)
  ) AS p (plan_code, max_agents, org_daily_recipients, agent_per_day_max, agent_per_minute_max, recipients_per_message_max,
          tokens_per_agent_max, webhook_endpoints_per_agent_max, org_api_keys_max, inbound_storage_bytes)
    ON p.plan_code = CASE WHEN o.review_status = 'active' THEN 'beta' ELSE 'free' END;

-- ---------------------------------------------------------------------------
-- ⑤ 권한
-- ---------------------------------------------------------------------------

REVOKE ALL ON org_entitlements FROM PUBLIC;
REVOKE ALL ON billing_audit FROM PUBLIC;
-- 앱(정책 로더 Stage 4 · 웹훅 상한) · admin(콘솔 요금제 화면 · 에이전트·토큰·조직 키 상한 · 검증 번들의 원천 행) — 읽기만.
GRANT SELECT ON org_entitlements TO atmark_app;
GRANT SELECT ON org_entitlements TO atmark_admin;
-- 서열 롤 — 원천 행이 있는지만(값은 스냅샷으로 온다).
GRANT SELECT (organization_id) ON org_entitlements TO atmark_tlog;

-- ---------------------------------------------------------------------------
-- ⑥ 천장 트리거(심층 방어) — 웹훅 엔드포인트 10/에이전트 · 에이전트 1000/조직(비활성 포함)
-- ---------------------------------------------------------------------------

-- 앱(`api/routes/webhook-endpoints.ts`)은 같은 잠금 아래에서 min(10, 요금제)을 센다. 이 트리거는 그 검사가 빠져도 천장 10 을 지킨다 —
-- 새 행과 되살림(disabled_at → NULL, 소유자 롤만 가능) 둘 다.
CREATE FUNCTION webhook_endpoints_active_limit() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  active integer;
BEGIN
  IF NEW.disabled_at IS NOT NULL THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.disabled_at IS NULL THEN
    RETURN NEW;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('webhook_endpoints_active:' || NEW.agent_id, 0));
  SELECT count(*) INTO active FROM public.webhook_endpoints e
   WHERE e.agent_id = NEW.agent_id AND e.disabled_at IS NULL AND e.id IS DISTINCT FROM NEW.id;
  IF active >= 10 THEN
    RAISE EXCEPTION 'webhook_endpoints: agent % already has % active endpoints (max 10)', NEW.agent_id, active
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER webhook_endpoints_active_limit
  BEFORE INSERT OR UPDATE OF disabled_at ON webhook_endpoints
  FOR EACH ROW EXECUTE FUNCTION webhook_endpoints_active_limit();

-- 조직당 에이전트의 절대 천장 1000(비활성 포함 — `MAX_AGENTS_PER_ORG` = `ENTITLEMENT_CEILINGS.maxAgents`). 요금제 한도(비활성 제외)와 총합
-- 3배는 앱(`admin/ops/agents.ts` `requireAgentCapacity`)이 같은 잠금 키로 센다 — 이 트리거는 어느 경로로 넣든 넘지 못하는 바닥이다.
CREATE FUNCTION agents_org_ceiling() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  total integer;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('agent_provision:' || NEW.organization_id::text, 0));
  SELECT count(*) INTO total FROM public.agents a WHERE a.organization_id = NEW.organization_id;
  IF total >= 1000 THEN
    RAISE EXCEPTION 'agents: organization % already has % agents (max 1000, disabled included)', NEW.organization_id, total
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER agents_org_ceiling
  BEFORE INSERT ON agents
  FOR EACH ROW EXECUTE FUNCTION agents_org_ceiling();
