-- 202609250400_billing_provider.sql
-- WP-2 결제 공급자 연동(Paddle Billing) — 계획 `.omc/plans/wp2-paddle-adapter.md` §4 · ADR-0012. 202609250300(엔타이틀먼트) 위에 얹는다.
--
--   ① 새 표 다섯 — 공급자 모양은 여기에만 있다(엔타이틀먼트·정책 관문·투명성 잎은 공급자를 모른다). **이메일·주소·금액·포털 URL 칸은 없다.**
--      `billing_events`(웹훅 멱등 원장) · `billing_customers`(조직 ↔ 공급자 고객) · `billing_subscriptions`(재조회한 구독) ·
--      `billing_checkouts`(admin 이 만든 거래 = **결속의 유일한 근거**) · `billing_reconcile_state`(reconcile 커서 한 행).
--   ② `org_entitlements.provider_override_allowed` — 운영자가 `admin:plan --release-to-provider` 로 "공급자가 이 운영자 행을 덮어도 된다" 고 넘긴
--      표시. 한도가 아니라 제어 칸이라 투명성 잎·스냅샷에 넣지 않는다(`tlog_enqueue` 무변경).
--   ③ 출처-롤 가드(D-3) — `atmark_billing` 은 provider 출처만 쓰고, 넘기지 않은 운영자·백필 행은 **한도 아홉 칸이 모두 지금 적용 한도 이상**일
--      때만 덮는다(Free 로 떨어뜨리지 못한다 — 공급자 강등은 provider 행에만). `atmark_billing_operator` 는 operator/operator 만. 모든 롤에서
--      provider 출처의 요금제는 free·pro·team·scale(L9 — 결제로 beta 를 만들지 못한다). 심층 방어(L-4): `atmark_billing` 의 행은 한도가 그
--      요금제의 카탈로그 값과 같아야 하고, 그 롤의 감사 행위자는 `provider:paddle` 뿐이다(`billing_audit_actor_by_role`).
--   ④ 롤 둘의 컬럼 단위 GRANT · admin 의 체크아웃 쓰기. 허용 목록은 `src/runtime/role-bootstrap.ts` `RESTRICTED_ROLE_GRANTS`, 가드 목록은
--      `src/runtime/handlers/migrate.ts` `REQUIRED_GUARDS` — migrate `status` 가 실제 ACL·트리거와 대조한다.
--
-- 공통 CHECK 의 집합은 `src/billing/constants.ts` 와 같다 — `BILLING_PROVIDERS`(provider) · `PADDLE_ENVIRONMENTS`(environment) ·
-- `BILLING_EVENT_TYPES`(event_type) · `BILLING_EVENT_REASON_CODES`(last_error). 단위 테스트 `test/unit/billing/billing-provider-sql.test.ts` 가 대조한다.
--
-- **새 SECURITY DEFINER 함수는 없다.** 엔타이틀먼트 쓰기의 감사·잎은 202609250300 의 definer 둘(`org_entitlements_audited` · `tlog_enqueue`)이
-- 맡는다 — billing 롤에 `billing_audit` SELECT · `tlog_outbox` 권한이 없는 이유다. 출처-롤 가드는 **호출자 롤**(`current_user`)을 봐야 하므로
-- definer 가 아니다.
--
-- 투명성 로그 표 CHECK 무변경 → 서열기 선후·스케줄 멈춤 불필요. 잠금: `org_entitlements` 칸 추가 · `organizations`·`users` 를 REFERENCES —
-- 5초 안에 못 잡으면 실패하고 아무것도 바뀌지 않는다(다시 돌린다).

SET LOCAL lock_timeout = '5s';

DO $$
DECLARE
  missing text;
BEGIN
  SELECT string_agg(name, ', ') INTO missing
    FROM unnest(ARRAY['atmark_admin', 'atmark_billing', 'atmark_billing_operator']) AS name
   WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = name);
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION 'role % does not exist — migrate 핸들러의 bootstrap-roles 를 먼저 돌려라(로컬: docs/runbooks/admin.md §8-2)', missing;
  END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- ① billing_events — 웹훅 이벤트 멱등 원장(PK = (provider, event_id), 영구). 본문 없이 좌표와 원문 SHA-256 만.
-- ---------------------------------------------------------------------------

CREATE TABLE billing_events (
  provider        text NOT NULL,
  event_id        text NOT NULL,
  event_type      text NOT NULL,
  occurred_at     timestamptz NOT NULL,
  notification_id text,
  environment     text NOT NULL,
  payload_sha256  text NOT NULL,
  subscription_id text,
  transaction_id  text,
  -- 새 행은 pending · 시도 1. 다시 받으면(재시도) attempts + 1.
  status          text NOT NULL DEFAULT 'pending',
  attempts        integer NOT NULL DEFAULT 1,
  last_error      text,
  received_at     timestamptz NOT NULL DEFAULT now(),
  processed_at    timestamptz,
  CONSTRAINT billing_events_pkey PRIMARY KEY (provider, event_id),
  CONSTRAINT billing_events_provider_check CHECK (provider IN ('paddle')),
  CONSTRAINT billing_events_environment_check CHECK (environment IN ('sandbox', 'production')),
  CONSTRAINT billing_events_event_id_shape CHECK (event_id ~ '^evt_[a-z0-9]{26}$'),
  CONSTRAINT billing_events_event_type_check CHECK (event_type IN (
    'subscription.created', 'subscription.activated', 'subscription.updated', 'subscription.trialing', 'subscription.past_due',
    'subscription.paused', 'subscription.resumed', 'subscription.canceled',
    'transaction.completed', 'transaction.payment_failed', 'transaction.past_due')),
  CONSTRAINT billing_events_notification_id_shape CHECK (notification_id IS NULL OR notification_id ~ '^ntf_[a-z0-9]{26}$'),
  CONSTRAINT billing_events_payload_sha256_shape CHECK (payload_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT billing_events_subscription_id_shape CHECK (subscription_id IS NULL OR subscription_id ~ '^sub_[a-z0-9]{26}$'),
  CONSTRAINT billing_events_transaction_id_shape CHECK (transaction_id IS NULL OR transaction_id ~ '^txn_[a-z0-9]{26}$'),
  CONSTRAINT billing_events_status_check CHECK (status IN ('pending', 'done', 'ignored', 'failed')),
  CONSTRAINT billing_events_attempts_check CHECK (attempts BETWEEN 1 AND 1000),
  -- 이유 코드는 ignored·failed 에만, 코드 목록 안에서만(고객 id·URL·응답 본문을 적을 자리가 없다).
  CONSTRAINT billing_events_reason_check CHECK (
    (status IN ('pending', 'done') AND last_error IS NULL)
    OR (status IN ('ignored', 'failed') AND last_error IN (
      'not_found', 'sandbox_not_allowed', 'environment_mismatch', 'unbound_subscription', 'provider_error', 'internal_error'))),
  CONSTRAINT billing_events_processed_shape CHECK ((status = 'pending') = (processed_at IS NULL))
);

CREATE INDEX billing_events_open_idx ON billing_events (received_at) WHERE status IN ('pending', 'failed');
-- 웹훅 누락 탐지(reconcile) — "그 구독에 updated_at 뒤의 이벤트가 있었나".
CREATE INDEX billing_events_subscription_idx ON billing_events (subscription_id, occurred_at) WHERE subscription_id IS NOT NULL;

-- 새 행은 pending·시도 1 로만 · 핵심 칸 불변 · done/ignored 종단 · 시도 수 앞으로만.
CREATE FUNCTION billing_events_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'pending' OR NEW.attempts <> 1 OR NEW.last_error IS NOT NULL OR NEW.processed_at IS NOT NULL THEN
      RAISE EXCEPTION 'billing_events: 새 행은 pending · attempts 1 로만 들어온다' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.status IN ('done', 'ignored') THEN
    RAISE EXCEPTION 'billing_events: % 는 종단이다(이벤트 %)', OLD.status, OLD.event_id USING ERRCODE = '23514';
  END IF;
  IF NEW.provider IS DISTINCT FROM OLD.provider OR NEW.event_id IS DISTINCT FROM OLD.event_id
     OR NEW.event_type IS DISTINCT FROM OLD.event_type OR NEW.occurred_at IS DISTINCT FROM OLD.occurred_at
     OR NEW.notification_id IS DISTINCT FROM OLD.notification_id OR NEW.environment IS DISTINCT FROM OLD.environment
     OR NEW.payload_sha256 IS DISTINCT FROM OLD.payload_sha256 OR NEW.subscription_id IS DISTINCT FROM OLD.subscription_id
     OR NEW.transaction_id IS DISTINCT FROM OLD.transaction_id OR NEW.received_at IS DISTINCT FROM OLD.received_at THEN
    RAISE EXCEPTION 'billing_events: 봉투 칸은 바꿀 수 없다' USING ERRCODE = '23514';
  END IF;
  IF NEW.attempts < OLD.attempts THEN
    RAISE EXCEPTION 'billing_events: attempts 는 앞으로만 간다(% → %)', OLD.attempts, NEW.attempts USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER billing_events_guard BEFORE INSERT OR UPDATE ON billing_events
  FOR EACH ROW EXECUTE FUNCTION billing_events_guard();
CREATE TRIGGER billing_events_no_delete BEFORE DELETE ON billing_events
  FOR EACH ROW EXECUTE FUNCTION reject_row_delete();
CREATE TRIGGER billing_events_no_truncate BEFORE TRUNCATE ON billing_events
  FOR EACH STATEMENT EXECUTE FUNCTION reject_truncate();

COMMENT ON TABLE billing_events IS
  '결제 웹훅 이벤트 멱등 원장(ADR-0012) — 좌표와 원문 SHA-256 만. done/ignored 종단 · 지우기 거부. sync 는 이벤트 본문이 아니라 재조회 결과를 쓴다.';

-- ---------------------------------------------------------------------------
-- ② billing_checkouts — admin 이 만든 공급자 거래. 결속의 유일한 근거(공개 클라이언트 토큰으로 만든 체크아웃은 여기 없다).
-- ---------------------------------------------------------------------------

CREATE TABLE billing_checkouts (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id    uuid NOT NULL REFERENCES organizations (id) ON DELETE RESTRICT,
  provider           text NOT NULL,
  environment        text NOT NULL,
  transaction_id     text NOT NULL,
  plan_code          text NOT NULL,
  created_by_user_id uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  status             text NOT NULL DEFAULT 'open',
  created_at         timestamptz NOT NULL DEFAULT now(),
  completed_at       timestamptz,
  CONSTRAINT billing_checkouts_transaction_key UNIQUE (transaction_id),
  -- 구독 결속 FK 의 대상(거래 · 조직 · 환경이 한꺼번에 맞아야 한다).
  CONSTRAINT billing_checkouts_binding_key UNIQUE (transaction_id, organization_id, environment),
  CONSTRAINT billing_checkouts_provider_check CHECK (provider IN ('paddle')),
  CONSTRAINT billing_checkouts_environment_check CHECK (environment IN ('sandbox', 'production')),
  CONSTRAINT billing_checkouts_transaction_id_shape CHECK (transaction_id ~ '^txn_[a-z0-9]{26}$'),
  CONSTRAINT billing_checkouts_plan_check CHECK (plan_code IN ('pro', 'team', 'scale')),
  CONSTRAINT billing_checkouts_status_check CHECK (status IN ('open', 'completed', 'superseded')),
  -- completed 는 completed_at 과 함께만 — admin 은 completed_at 을 쓸 수 없으니 거래를 "완료" 로 적지 못한다(superseded 만).
  CONSTRAINT billing_checkouts_completed_shape CHECK ((status = 'completed') = (completed_at IS NOT NULL))
);

CREATE INDEX billing_checkouts_open_idx ON billing_checkouts (organization_id, environment, created_at) WHERE status = 'open';
-- 조직의 하루 체크아웃 상한(admin, 보안 검증 M-1) — 상태·환경과 무관하게 만든 거래 수를 센다.
CREATE INDEX billing_checkouts_org_created_idx ON billing_checkouts (organization_id, created_at);

-- 새 행은 open 으로만 · 시각은 DB 가 · 핵심 칸 불변 · open → completed | superseded 한 번.
CREATE FUNCTION billing_checkouts_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'open' OR NEW.completed_at IS NOT NULL THEN
      RAISE EXCEPTION 'billing_checkouts: 새 거래는 open 으로만 들어온다' USING ERRCODE = '23514';
    END IF;
    NEW.created_at := now();
    RETURN NEW;
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.organization_id IS DISTINCT FROM OLD.organization_id
     OR NEW.provider IS DISTINCT FROM OLD.provider OR NEW.environment IS DISTINCT FROM OLD.environment
     OR NEW.transaction_id IS DISTINCT FROM OLD.transaction_id OR NEW.plan_code IS DISTINCT FROM OLD.plan_code
     OR NEW.created_by_user_id IS DISTINCT FROM OLD.created_by_user_id OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'billing_checkouts: 거래 칸은 바꿀 수 없다' USING ERRCODE = '23514';
  END IF;
  IF OLD.status <> 'open' THEN
    RAISE EXCEPTION 'billing_checkouts: % 는 종단이다(거래 %)', OLD.status, OLD.transaction_id USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER billing_checkouts_guard BEFORE INSERT OR UPDATE ON billing_checkouts
  FOR EACH ROW EXECUTE FUNCTION billing_checkouts_guard();
CREATE TRIGGER billing_checkouts_no_delete BEFORE DELETE ON billing_checkouts
  FOR EACH ROW EXECUTE FUNCTION reject_row_delete();
CREATE TRIGGER billing_checkouts_no_truncate BEFORE TRUNCATE ON billing_checkouts
  FOR EACH STATEMENT EXECUTE FUNCTION reject_truncate();

COMMENT ON TABLE billing_checkouts IS
  'admin 이 만든 공급자 거래(ADR-0012) — 구독 결속의 유일한 근거. open → completed | superseded. 금액·고객 정보 없음.';

-- ---------------------------------------------------------------------------
-- ③ billing_customers — 조직 ↔ 공급자 고객(조직·환경마다 하나). 고치기·지우기 거부.
--    **한 고객이 여러 조직에 붙을 수 있다**(H-1/M-4 결정) — Paddle 은 고객을 이메일로 다시 쓰므로 같은 사람이 두 조직에서 결제하면 같은
--    `ctm_` 가 온다. 그래서 고객 id 에 UNIQUE 가 없다. 대신 공유 고객에게는 포털을 열지 않고(그 고객의 구독이 상태와 무관하게 **전부** 이
--    조직 것일 때만 — 보안 검증 R-1) 체크아웃에 고객을 미리 채우지 않는다 — 판단은 admin(`src/admin/ops/billing.ts`), 조회는 `billing.ts`
--    `loadOrgCustomer` · `customerHasOtherOrgSubscription`.
-- ---------------------------------------------------------------------------

CREATE TABLE billing_customers (
  organization_id      uuid NOT NULL REFERENCES organizations (id) ON DELETE RESTRICT,
  provider             text NOT NULL,
  provider_customer_id text NOT NULL,
  environment          text NOT NULL,
  created_at           timestamptz NOT NULL DEFAULT now(),
  -- 결속의 키 = 조직(환경마다 하나). 고객 쪽은 키가 아니다(위).
  CONSTRAINT billing_customers_pkey PRIMARY KEY (organization_id, provider, environment),
  CONSTRAINT billing_customers_provider_check CHECK (provider IN ('paddle')),
  CONSTRAINT billing_customers_environment_check CHECK (environment IN ('sandbox', 'production')),
  CONSTRAINT billing_customers_customer_id_shape CHECK (provider_customer_id ~ '^ctm_[a-z0-9]{26}$')
);

CREATE TRIGGER billing_customers_no_update BEFORE UPDATE ON billing_customers
  FOR EACH ROW EXECUTE FUNCTION reject_row_update();
CREATE TRIGGER billing_customers_no_delete BEFORE DELETE ON billing_customers
  FOR EACH ROW EXECUTE FUNCTION reject_row_delete();
CREATE TRIGGER billing_customers_no_truncate BEFORE TRUNCATE ON billing_customers
  FOR EACH STATEMENT EXECUTE FUNCTION reject_truncate();

-- 공유 판단(같은 고객을 가진 다른 조직이 있는가).
CREATE INDEX billing_customers_customer_idx ON billing_customers (provider, environment, provider_customer_id);

COMMENT ON TABLE billing_customers IS
  '조직 ↔ 공급자 고객 결속(ADR-0012) — 조직·환경마다 하나(한 고객은 여러 조직에 붙을 수 있다), 고치기·지우기 거부. 이메일·주소 없음.';

-- ---------------------------------------------------------------------------
-- ④ billing_subscriptions — 재조회한 공급자 구독. 우리 거래(billing_checkouts)에서 나온 것만 — FK 가 거래·조직·환경을 함께 묶는다.
-- ---------------------------------------------------------------------------

CREATE TABLE billing_subscriptions (
  provider                 text NOT NULL,
  provider_subscription_id text NOT NULL,
  environment              text NOT NULL,
  organization_id          uuid NOT NULL REFERENCES organizations (id) ON DELETE RESTRICT,
  provider_customer_id     text NOT NULL,
  origin_transaction_id    text NOT NULL,
  status                   text NOT NULL,
  -- NULL = 모르는 가격(결정 함수가 noop + 알람).
  plan_code                text,
  price_id                 text,
  current_period_end       timestamptz,
  scheduled_change_action  text,
  scheduled_change_at      timestamptz,
  past_due_since           timestamptz,
  provider_updated_at      timestamptz NOT NULL,
  synced_at                timestamptz NOT NULL,
  created_at               timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT billing_subscriptions_pkey PRIMARY KEY (provider, provider_subscription_id),
  -- 결속 = 우리가 만든 거래 · 그 거래를 만든 조직 · 같은 환경(H2). 공개 클라이언트 토큰으로 만든 거래의 구독은 이 FK 를 지나지 못한다.
  CONSTRAINT billing_subscriptions_origin_checkout FOREIGN KEY (origin_transaction_id, organization_id, environment)
    REFERENCES billing_checkouts (transaction_id, organization_id, environment) ON DELETE RESTRICT,
  CONSTRAINT billing_subscriptions_provider_check CHECK (provider IN ('paddle')),
  CONSTRAINT billing_subscriptions_environment_check CHECK (environment IN ('sandbox', 'production')),
  CONSTRAINT billing_subscriptions_id_shape CHECK (provider_subscription_id ~ '^sub_[a-z0-9]{26}$'),
  CONSTRAINT billing_subscriptions_customer_id_shape CHECK (provider_customer_id ~ '^ctm_[a-z0-9]{26}$'),
  CONSTRAINT billing_subscriptions_price_id_shape CHECK (price_id IS NULL OR price_id ~ '^pri_[a-z0-9]{26}$'),
  CONSTRAINT billing_subscriptions_status_check CHECK (status IN ('active', 'trialing', 'past_due', 'paused', 'canceled')),
  CONSTRAINT billing_subscriptions_plan_check CHECK (plan_code IS NULL OR plan_code IN ('pro', 'team', 'scale')),
  CONSTRAINT billing_subscriptions_scheduled_change_shape CHECK (
    (scheduled_change_action IS NULL) = (scheduled_change_at IS NULL)
    AND (scheduled_change_action IS NULL OR scheduled_change_action IN ('cancel', 'pause', 'resume'))),
  CONSTRAINT billing_subscriptions_past_due_shape CHECK (past_due_since IS NULL OR status = 'past_due')
);

CREATE INDEX billing_subscriptions_org_idx ON billing_subscriptions (organization_id, environment);
CREATE INDEX billing_subscriptions_open_idx ON billing_subscriptions (environment) WHERE status <> 'canceled';
-- 포털 판단 — 그 고객의 구독 중 다른 조직 것이 있는가(상태 무관 — 해지된 구독도 포털에 보인다, R-1).
CREATE INDEX billing_subscriptions_customer_idx ON billing_subscriptions (provider, environment, provider_customer_id);

-- 조직·고객·원 거래·환경 불변 · provider_updated_at 은 같거나 커질 때만(옛 재조회가 새 상태를 덮지 못한다) · canceled 종단(P13).
CREATE FUNCTION billing_subscriptions_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.created_at := now();
    RETURN NEW;
  END IF;
  IF NEW.provider IS DISTINCT FROM OLD.provider OR NEW.provider_subscription_id IS DISTINCT FROM OLD.provider_subscription_id
     OR NEW.environment IS DISTINCT FROM OLD.environment OR NEW.organization_id IS DISTINCT FROM OLD.organization_id
     OR NEW.provider_customer_id IS DISTINCT FROM OLD.provider_customer_id
     OR NEW.origin_transaction_id IS DISTINCT FROM OLD.origin_transaction_id OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'billing_subscriptions: 조직·고객·원 거래·환경은 바꿀 수 없다' USING ERRCODE = '23514';
  END IF;
  IF NEW.provider_updated_at < OLD.provider_updated_at THEN
    RAISE EXCEPTION 'billing_subscriptions: provider_updated_at 은 뒤로 가지 않는다(구독 %)', OLD.provider_subscription_id USING ERRCODE = '23514';
  END IF;
  IF OLD.status = 'canceled' AND NEW.status <> 'canceled' THEN
    RAISE EXCEPTION 'billing_subscriptions: 해지된 구독은 되살아나지 않는다(구독 %)', OLD.provider_subscription_id USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER billing_subscriptions_guard BEFORE INSERT OR UPDATE ON billing_subscriptions
  FOR EACH ROW EXECUTE FUNCTION billing_subscriptions_guard();
CREATE TRIGGER billing_subscriptions_no_delete BEFORE DELETE ON billing_subscriptions
  FOR EACH ROW EXECUTE FUNCTION reject_row_delete();
CREATE TRIGGER billing_subscriptions_no_truncate BEFORE TRUNCATE ON billing_subscriptions
  FOR EACH STATEMENT EXECUTE FUNCTION reject_truncate();

COMMENT ON TABLE billing_subscriptions IS
  '재조회한 공급자 구독(ADR-0012) — 우리 거래에서 나온 것만(FK). 앞으로만 · canceled 종단 · 지우기 거부. 금액·이메일 없음.';

-- ---------------------------------------------------------------------------
-- ⑤ billing_reconcile_state — 15분 틱이 이어 가는 하루 1회 대조의 커서(한 행). completed_at = 마지막으로 **끝난** 판의 시각 — 새 판을 시작해도
--    이전 값을 이어받고(진행 중에도 남는다), 그 판이 `done` 에 닿을 때만 바뀐다. NULL = 아직 한 판도 끝나지 않았다.
-- ---------------------------------------------------------------------------

CREATE TABLE billing_reconcile_state (
  id            smallint PRIMARY KEY,
  run_id        uuid NOT NULL,
  phase         text NOT NULL,
  paddle_cursor text,
  org_cursor    uuid,
  started_at    timestamptz NOT NULL,
  updated_at    timestamptz NOT NULL,
  completed_at  timestamptz,
  CONSTRAINT billing_reconcile_state_singleton CHECK (id = 1),
  CONSTRAINT billing_reconcile_state_phase_check CHECK (phase IN ('list', 'stale', 'orgs', 'done')),
  CONSTRAINT billing_reconcile_state_paddle_cursor_shape CHECK (paddle_cursor IS NULL OR length(paddle_cursor) BETWEEN 1 AND 500)
);

CREATE TRIGGER billing_reconcile_state_no_delete BEFORE DELETE ON billing_reconcile_state
  FOR EACH ROW EXECUTE FUNCTION reject_row_delete();
CREATE TRIGGER billing_reconcile_state_no_truncate BEFORE TRUNCATE ON billing_reconcile_state
  FOR EACH STATEMENT EXECUTE FUNCTION reject_truncate();

COMMENT ON TABLE billing_reconcile_state IS 'reconcile 커서(ADR-0012) — 한 행(id = 1). 지우기 거부.';

-- ---------------------------------------------------------------------------
-- ⑥ org_entitlements — 제어 칸 + 출처-롤 가드(D-3 · L9)
-- ---------------------------------------------------------------------------

-- 기존 행은 false(넘기지 않음). 운영자 행에서만 true 가 될 수 있다 — 공급자 행으로 바뀌면 false 로 돌아온다.
ALTER TABLE org_entitlements ADD COLUMN provider_override_allowed boolean NOT NULL DEFAULT false;
ALTER TABLE org_entitlements ADD CONSTRAINT org_entitlements_override_source CHECK (NOT provider_override_allowed OR source = 'operator');
-- L9 — 모든 롤에서: 공급자 출처는 결제로 살 수 있는 요금제와 free(해지·만료)만. beta 는 운영자 부여뿐이다.
ALTER TABLE org_entitlements ADD CONSTRAINT org_entitlements_provider_plan CHECK (source <> 'provider' OR plan_code IN ('free', 'pro', 'team', 'scale'));

-- **호출자 롤**을 본다(SECURITY DEFINER 아님 — definer 면 current_user 가 소유자가 되어 규칙이 사라진다). 소유자 롤(마이그레이션·
-- `admin:org-review`)에는 이 규칙이 없다 — 그 롤은 이미 DDL 을 쥔다.
--   atmark_billing_operator: source = operator · cause = operator 만.
--   atmark_billing: source = provider 만 · **한도 아홉 칸 = 그 요금제의 카탈로그 값**(보안 검증 L-4 — 결제 경로는 카탈로그 밖 한도를 쓸 이유가
--     없다. 결정 함수가 `PLAN_CATALOG[plan]` 을 쓰고, 여기서 다시 본다). 넘기지 않은(provider_override_allowed = false) default·operator 행 위에서는
--     Free 가 아니고 **한도 아홉 칸이 모두 지금 적용 한도 이상**일 때만(D-3 — 결제가 운영자 보상 요금제를 깎지 못한다). "지금 적용" = 유예가
--     지났으면 Free 카탈로그(로더와 같은 해석, `src/billing/plans.ts` `resolveEntitlements`).
--   아래 배열 넷은 `PLAN_CATALOG.{free,pro,team,scale}` 을 `LIMIT_COLUMNS` 순서로 적은 것이다(단위 테스트 `billing-provider-sql.test.ts` 가 대조 —
--   카탈로그를 바꾸면 새 마이그레이션으로 이 함수를 다시 만든다). beta 는 없다 — provider 출처의 beta 는 L9 CHECK 가 거부한다.
CREATE FUNCTION org_entitlements_source_by_role() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  free_limits CONSTANT bigint[] := ARRAY[3, 100, 100, 5, 10, 2, 1, 1, 1073741824]::bigint[];
  pro_limits CONSTANT bigint[] := ARRAY[10, 1000, 300, 30, 25, 5, 3, 2, 10737418240]::bigint[];
  team_limits CONSTANT bigint[] := ARRAY[50, 1000, 1000, 120, 50, 5, 10, 5, 53687091200]::bigint[];
  scale_limits CONSTANT bigint[] := ARRAY[200, 1000, 5000, 600, 50, 5, 10, 5, 214748364800]::bigint[];
  catalog bigint[];
  applied bigint[];
  wanted bigint[];
BEGIN
  IF current_user = 'atmark_billing_operator' THEN
    IF NEW.source <> 'operator' OR NEW.cause <> 'operator' THEN
      RAISE EXCEPTION 'org_entitlements: atmark_billing_operator 는 operator 출처·원인만 쓴다(받은 %/%)', NEW.source, NEW.cause
        USING ERRCODE = '42501';
    END IF;
  ELSIF current_user = 'atmark_billing' THEN
    IF NEW.source <> 'provider' THEN
      RAISE EXCEPTION 'org_entitlements: atmark_billing 은 provider 출처만 쓴다(받은 %)', NEW.source USING ERRCODE = '42501';
    END IF;
    wanted := ARRAY[NEW.max_agents, NEW.org_daily_recipients, NEW.agent_per_day_max, NEW.agent_per_minute_max,
                    NEW.recipients_per_message_max, NEW.tokens_per_agent_max, NEW.webhook_endpoints_per_agent_max,
                    NEW.org_api_keys_max, NEW.inbound_storage_bytes]::bigint[];
    catalog := CASE NEW.plan_code WHEN 'free' THEN free_limits WHEN 'pro' THEN pro_limits WHEN 'team' THEN team_limits
                                  WHEN 'scale' THEN scale_limits END;
    IF catalog IS NOT NULL AND wanted IS DISTINCT FROM catalog THEN
      RAISE EXCEPTION 'org_entitlements: atmark_billing 은 요금제 % 의 카탈로그 한도만 쓴다(조직 %)', NEW.plan_code, NEW.organization_id
        USING ERRCODE = '42501';
    END IF;
    IF TG_OP = 'UPDATE' AND OLD.source IN ('default', 'operator') AND NOT OLD.provider_override_allowed THEN
      IF NEW.plan_code = 'free' THEN
        RAISE EXCEPTION 'org_entitlements: 공급자는 운영자·백필 행을 Free 로 떨어뜨리지 못한다(조직 %)', OLD.organization_id USING ERRCODE = '42501';
      END IF;
      IF OLD.grace_until IS NOT NULL AND OLD.grace_until <= now() THEN
        applied := free_limits;
      ELSE
        applied := ARRAY[OLD.max_agents, OLD.org_daily_recipients, OLD.agent_per_day_max, OLD.agent_per_minute_max,
                         OLD.recipients_per_message_max, OLD.tokens_per_agent_max, OLD.webhook_endpoints_per_agent_max,
                         OLD.org_api_keys_max, OLD.inbound_storage_bytes]::bigint[];
      END IF;
      FOR i IN 1 .. 9 LOOP
        IF wanted[i] < applied[i] THEN
          RAISE EXCEPTION 'org_entitlements: 공급자 요금제가 운영자·백필 행의 한도를 칸별로 넘지 못한다(조직 % · 칸 %) — admin:plan --release-to-provider',
            OLD.organization_id, i USING ERRCODE = '42501';
        END IF;
      END LOOP;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER org_entitlements_source_by_role BEFORE INSERT OR UPDATE ON org_entitlements
  FOR EACH ROW EXECUTE FUNCTION org_entitlements_source_by_role();

-- 감사 행위자 — `atmark_billing` 이 쓰는 감사 행은 `provider:paddle` 뿐이다(보안 검증 L-4 — 결제 경로가 운영자·검토 행위자를 사칭하지 못한다).
-- 값은 `src/billing/sync.ts` `BILLING_SYNC_ACTOR`(단위 테스트가 대조). 호출자 롤을 보므로 definer 가 아니다. 다른 롤은 규칙 없음.
CREATE FUNCTION billing_audit_actor_by_role() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF current_user = 'atmark_billing' AND NEW.actor <> 'provider:paddle' THEN
    RAISE EXCEPTION 'billing_audit: atmark_billing 의 감사 행위자는 provider:paddle 뿐이다' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER billing_audit_actor_by_role BEFORE INSERT ON billing_audit
  FOR EACH ROW EXECUTE FUNCTION billing_audit_actor_by_role();

-- ---------------------------------------------------------------------------
-- ⑦ 권한 — 허용 목록(`RESTRICTED_ROLE_GRANTS`)과 같다. 앱·서열 롤은 새 표 다섯 모두 0.
-- ---------------------------------------------------------------------------

REVOKE ALL ON billing_events FROM PUBLIC;
REVOKE ALL ON billing_customers FROM PUBLIC;
REVOKE ALL ON billing_subscriptions FROM PUBLIC;
REVOKE ALL ON billing_checkouts FROM PUBLIC;
REVOKE ALL ON billing_reconcile_state FROM PUBLIC;

-- atmark_billing(sync λ) — 이벤트 원장 · 결속 · 구독 · 체크아웃 완료 표시 · 커서 · 엔타이틀먼트 provider 쓰기 · 감사 INSERT(SELECT 없음).
GRANT USAGE ON SCHEMA public TO atmark_billing;
GRANT SELECT ON billing_events TO atmark_billing;
GRANT INSERT (provider, event_id, event_type, occurred_at, notification_id, environment, payload_sha256, subscription_id, transaction_id)
  ON billing_events TO atmark_billing;
GRANT UPDATE (status, attempts, last_error, processed_at) ON billing_events TO atmark_billing;
GRANT SELECT ON billing_customers TO atmark_billing;
GRANT INSERT (organization_id, provider, provider_customer_id, environment) ON billing_customers TO atmark_billing;
GRANT SELECT ON billing_subscriptions TO atmark_billing;
GRANT INSERT (provider, provider_subscription_id, environment, organization_id, provider_customer_id, origin_transaction_id, status, plan_code,
              price_id, current_period_end, scheduled_change_action, scheduled_change_at, past_due_since, provider_updated_at, synced_at)
  ON billing_subscriptions TO atmark_billing;
GRANT UPDATE (status, plan_code, price_id, current_period_end, scheduled_change_action, scheduled_change_at, past_due_since, provider_updated_at,
              synced_at)
  ON billing_subscriptions TO atmark_billing;
GRANT SELECT (organization_id, environment, transaction_id, status) ON billing_checkouts TO atmark_billing;
GRANT UPDATE (status, completed_at) ON billing_checkouts TO atmark_billing;
GRANT SELECT, INSERT ON billing_reconcile_state TO atmark_billing;
GRANT UPDATE (run_id, phase, paddle_cursor, org_cursor, started_at, updated_at, completed_at) ON billing_reconcile_state TO atmark_billing;
GRANT SELECT ON org_entitlements TO atmark_billing;
GRANT INSERT (organization_id, plan_code, source, cause, max_agents, org_daily_recipients, agent_per_day_max, agent_per_minute_max,
              recipients_per_message_max, tokens_per_agent_max, webhook_endpoints_per_agent_max, org_api_keys_max, inbound_storage_bytes,
              grace_until, version, provider_override_allowed)
  ON org_entitlements TO atmark_billing;
GRANT UPDATE (plan_code, source, cause, max_agents, org_daily_recipients, agent_per_day_max, agent_per_minute_max, recipients_per_message_max,
              tokens_per_agent_max, webhook_endpoints_per_agent_max, org_api_keys_max, inbound_storage_bytes, grace_until, version,
              provider_override_allowed)
  ON org_entitlements TO atmark_billing;
GRANT INSERT (organization_id, from_plan, to_plan, cause, actor, provider_event_id, note, entitlement_version) ON billing_audit TO atmark_billing;
GRANT SELECT (id) ON organizations TO atmark_billing;

-- atmark_billing_operator(`pnpm admin:plan`) — 보기(`planUsageOp` 의 칸) · operator 행 쓰기 · 감사 INSERT(provider_event_id·SELECT 없음) ·
-- 샌드박스 공급자 행 찾기(구독 세 칸). 이벤트·체크아웃·고객·이메일·본문·해시 칸은 0.
GRANT USAGE ON SCHEMA public TO atmark_billing_operator;
GRANT SELECT (id, sending_started_at) ON organizations TO atmark_billing_operator;
GRANT SELECT ON org_entitlements TO atmark_billing_operator;
GRANT INSERT (organization_id, plan_code, source, cause, max_agents, org_daily_recipients, agent_per_day_max, agent_per_minute_max,
              recipients_per_message_max, tokens_per_agent_max, webhook_endpoints_per_agent_max, org_api_keys_max, inbound_storage_bytes,
              grace_until, version, provider_override_allowed)
  ON org_entitlements TO atmark_billing_operator;
GRANT UPDATE (plan_code, source, cause, max_agents, org_daily_recipients, agent_per_day_max, agent_per_minute_max, recipients_per_message_max,
              tokens_per_agent_max, webhook_endpoints_per_agent_max, org_api_keys_max, inbound_storage_bytes, grace_until, version,
              provider_override_allowed)
  ON org_entitlements TO atmark_billing_operator;
GRANT INSERT (organization_id, from_plan, to_plan, cause, actor, note, entitlement_version) ON billing_audit TO atmark_billing_operator;
GRANT SELECT (id, organization_id, status) ON agents TO atmark_billing_operator;
GRANT SELECT (agent_id, revoked_at, expires_at) ON agent_api_keys TO atmark_billing_operator;
GRANT SELECT (organization_id, revoked_at, expires_at) ON org_api_keys TO atmark_billing_operator;
GRANT SELECT (agent_id, direction, status, recipient_count, sent_at, created_at) ON messages TO atmark_billing_operator;
GRANT SELECT (organization_id, environment, status) ON billing_subscriptions TO atmark_billing_operator;

-- atmark_admin(콘솔) — 결제 개요(고객 · 구독의 표시 칸) · 포털 판단(구독의 공급자·고객 칸 — 공유 고객의 다른 조직 구독이 살아 있는가) ·
-- 체크아웃 기록(INSERT 여섯 칸 · 옛 거래 superseded · 하루 상한 계수).
GRANT SELECT (organization_id, provider, provider_customer_id, environment) ON billing_customers TO atmark_admin;
GRANT SELECT (organization_id, environment, status, plan_code, current_period_end, scheduled_change_action, scheduled_change_at, past_due_since,
              provider, provider_customer_id)
  ON billing_subscriptions TO atmark_admin;
GRANT SELECT ON billing_checkouts TO atmark_admin;
GRANT INSERT (organization_id, provider, environment, transaction_id, plan_code, created_by_user_id) ON billing_checkouts TO atmark_admin;
GRANT UPDATE (status) ON billing_checkouts TO atmark_admin;
