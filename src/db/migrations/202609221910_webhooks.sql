-- 202609221910_webhooks.sql
-- P2 — 웹훅 엔드포인트 + 전달 outbox (계획 §3.4 1조 · 4조, `src/webhooks/**`).
--
-- 왜 outbox 인가: 이벤트(approval 전이, 발송 완료)와 "그 이벤트를 알려야 한다" 는 사실이
--   **같은 트랜잭션에서 커밋**돼야 한다. 요청 경로에서 HTTP 를 쏘면 커밋 전에 나가거나
--   (일어나지 않은 사건을 알림) 커밋 후 프로세스가 죽어 영영 안 나간다(유실). outbox 행은
--   사건과 함께 커밋되고, 디스패처가 at-least-once 로 꺼내 보낸다.

-- ---------------------------------------------------------------------------
-- webhook_endpoints
-- ---------------------------------------------------------------------------

-- ★ 시크릿 컬럼이 **없다.** 서명 시크릿은 마스터 키에서 `(id, secret_kid, secret_version)` 으로
--   파생한다(`src/webhooks/signing.ts`). DB 가 통째로 새도 웹훅은 위조되지 않는다.
CREATE TABLE webhook_endpoints (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id        char(32) NOT NULL REFERENCES agents (id) ON DELETE RESTRICT,
  -- 등록 시 `checkWebhookUrl` 이 정적 검사를 하고, 전달 때마다 DNS 해석 뒤 다시 검사한다.
  --   여기 CHECK 는 그 둘이 빠졌을 때의 바닥이다 — https 가 아니면 행이 존재할 수 없다.
  url             text NOT NULL CHECK (url ~ '^https://' AND length(url) <= 2048),
  secret_kid      text NOT NULL CHECK (secret_kid ~ '^[a-z0-9]{1,16}$'),
  secret_version  integer NOT NULL DEFAULT 1 CHECK (secret_version >= 1),
  disabled_at     timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX webhook_endpoints_agent_id_idx ON webhook_endpoints (agent_id) WHERE disabled_at IS NULL;

-- 왜 agent_id 가 불변인가: 가변이면 한 에이전트의 이벤트 스트림이 UPDATE 한 줄로 다른
--   에이전트의 소유자에게 간다. url 은 가변이다(소유자가 고친다) — 대기 중 전달은 집는 시점의
--   url 로 간다.
CREATE TRIGGER webhook_endpoints_immutable_core
  BEFORE UPDATE ON webhook_endpoints
  FOR EACH ROW EXECUTE FUNCTION reject_column_update_except('url', 'secret_kid', 'secret_version', 'disabled_at');

-- ---------------------------------------------------------------------------
-- webhook_deliveries (outbox)
-- ---------------------------------------------------------------------------

CREATE TYPE webhook_event_type AS ENUM ('approval.resolved', 'approval.expired', 'message.sent');

-- `pending` 은 "아직 끝나지 않았다"(첫 시도 전 + 재시도 대기 + 임대 중)를 한 값으로 둔다.
--   임대는 `next_attempt_at` 을 미래로 미는 것으로 표현한다 — 별도 잠금 컬럼을 두면 두 시각이
--   어긋나는 상태가 생긴다.
CREATE TYPE webhook_delivery_status AS ENUM ('pending', 'delivered', 'dead');

-- ★ 컬럼 집합의 규율 — **주소·제목·본문을 담지 않는다.** `body` 는 `src/webhooks/events.ts` 의
--   닫힌 빌더만 만들고, 그 빌더는 식별자와 시각만 싣는다. 이 테이블에 PII 가 없는 것은
--   컬럼이 아니라 빌더가 보장한다 — 그래서 크기 상한을 좁게(16KB) 둬 본문 한 통이 들어오는
--   경로를 바닥에서 막는다.
CREATE TABLE webhook_deliveries (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- 수신측 멱등 키. 같은 사건은 엔드포인트가 여럿이어도 같은 event_id 다.
  event_id         uuid NOT NULL,
  endpoint_id      uuid NOT NULL REFERENCES webhook_endpoints (id) ON DELETE RESTRICT,
  event_type       webhook_event_type NOT NULL,
  -- 생산 쪽 멱등 키 `<type>:<대상 id>`. 스위퍼가 두 번 돌아도 `approval.expired` 는 1회(AC-d3).
  dedupe_key       text NOT NULL CHECK (length(dedupe_key) <= 128),
  -- text 인 이유(jsonb 가 아니다): 서명 대상은 **바이트**다. jsonb 는 키 순서·공백을 바꾸므로
  --   재시도마다 같은 본문이라는 보장이 사라진다.
  body             text NOT NULL CHECK (length(body) <= 16384),
  status           webhook_delivery_status NOT NULL DEFAULT 'pending',
  attempt_count    integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  next_attempt_at  timestamptz NOT NULL,
  -- 닫힌 어휘(`DeliveryErrorKind`). 자유 문자열이면 오류 메시지가 들어오고, 오류 메시지에는
  --   URL·호스트명이 들어 있다.
  last_error       text CHECK (last_error ~ '^[a-z_]{1,40}$'),
  last_http_status integer CHECK (last_http_status BETWEEN 100 AND 599),
  delivered_at     timestamptz,
  dead_at          timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),

  -- 상태와 종단 시각이 어긋난 행을 표현 불가능하게.
  CONSTRAINT webhook_deliveries_delivered_shape CHECK ((status = 'delivered') = (delivered_at IS NOT NULL)),
  CONSTRAINT webhook_deliveries_dead_shape CHECK ((status = 'dead') = (dead_at IS NOT NULL))
);

-- 왜 유니크 **인덱스**인가: `ON CONFLICT DO NOTHING` 의 대상이 되려면 인덱스여야 한다.
--   선조회는 동시 enqueue 두 번에 둘 다 "없다" 를 읽는다.
CREATE UNIQUE INDEX webhook_deliveries_endpoint_dedupe_key ON webhook_deliveries (endpoint_id, dedupe_key);

-- 디스패처의 유일한 조회 경로. 종단 행은 이 인덱스를 키우지 않는다.
CREATE INDEX webhook_deliveries_due_idx ON webhook_deliveries (next_attempt_at) WHERE status = 'pending';

-- 왜: 식별·내용 컬럼이 가변이면 재시도가 **다른 바이트**를 보내게 된다(서명은 맞겠지만
--   수신측이 같은 event_id 로 다른 내용을 받는다). 진행 상태 컬럼만 연다.
CREATE TRIGGER webhook_deliveries_immutable_core
  BEFORE UPDATE ON webhook_deliveries
  FOR EACH ROW EXECUTE FUNCTION reject_column_update_except(
    'status', 'attempt_count', 'next_attempt_at', 'last_error', 'last_http_status', 'delivered_at', 'dead_at');

-- 왜: 종단 행이 다시 pending 이 되면 이미 받은 이벤트가 또 가거나(delivered), 탐침으로 판정된
--   목적지로 다시 요청이 나간다(dead). 재전송이 필요해지는 날(P5 관리 UI)은 새 행이다.
CREATE OR REPLACE FUNCTION webhook_deliveries_reject_terminal_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status <> 'pending' THEN
    RAISE EXCEPTION 'webhook delivery % is terminal (%)', OLD.id, OLD.status
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER webhook_deliveries_terminal_guard
  BEFORE UPDATE ON webhook_deliveries
  FOR EACH ROW EXECUTE FUNCTION webhook_deliveries_reject_terminal_change();

CREATE TRIGGER webhook_deliveries_no_delete
  BEFORE DELETE ON webhook_deliveries
  FOR EACH ROW EXECUTE FUNCTION reject_row_delete();

CREATE TRIGGER webhook_deliveries_no_truncate
  AFTER TRUNCATE ON webhook_deliveries
  FOR EACH STATEMENT EXECUTE FUNCTION reject_truncate();

COMMENT ON TABLE webhook_endpoints IS
  '에이전트 소유자가 등록한 웹훅 URL. 시크릿은 저장하지 않는다 — 마스터 키에서 (id, secret_kid, secret_version) 으로 파생한다.';
COMMENT ON TABLE webhook_deliveries IS
  '웹훅 outbox. 사건과 같은 트랜잭션에서 적히고 디스패처가 at-least-once 로 보낸다. body 는 식별자·시각만 담는 닫힌 빌더의 출력이다.';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'atmark_app') THEN
    RAISE EXCEPTION
      'role atmark_app does not exist; provision the app role before running this migration'
      USING ERRCODE = '42704';
  END IF;
END;
$$;

-- 왜 DELETE 가 없는가: 엔드포인트 폐기는 `disabled_at`, 전달 기록은 보존이다.
GRANT SELECT, INSERT, UPDATE ON webhook_endpoints TO atmark_app;
GRANT SELECT, INSERT, UPDATE ON webhook_deliveries TO atmark_app;
