-- 202609230310_scheduled_sends.sql
-- P3c — 예약 발송 (`OUTBOUND_ROUTES.scheduled_send`, 계획 §6 P1 Thin slice 잔여분 회수)
--
-- ---------------------------------------------------------------------------
-- ★ 평가 시점 = **발송 시점** (예약 시점이 아니다)
-- ---------------------------------------------------------------------------
--
-- 이 테이블에는 **판정이 없다.** 예약은 "이 시각에 이 시도를 관문에 넣어라" 는 요청일 뿐이고, 관문 평가는
-- `workers/scheduled-sender` 가 기한이 된 행을 집어 `dispatch` 를 부를 때 **그때의 정책·억제·캡**으로 한다.
-- 예약과 발송 사이에 kill-switch·억제(바운스)·차단·예산이 바뀐다 — 승인 릴리스가 관문을 재통과하는 것과
-- 같은 이유다(§4.3). 예약 시점에 판정해 두고 발송 때 그 판정을 믿으면, 그 사이에 바운스로 억제된 주소로
-- 메일이 나간다(계획 프리모템 "scheduled_send 가 gate 를 건너뛰었다" 의 정확한 모양).
-- 그래서 판정·사유·policy_version 컬럼이 **없다** — 넣을 자리가 없으면 읽을 수도 없다.
--
-- ---------------------------------------------------------------------------
-- 본문은 여기 없다
-- ---------------------------------------------------------------------------
--
-- 제목·본문은 객체 저장소 `outbound/scheduled/{id}.json`(write-once). 발송 본문(`outbound/content/`)과 같은
-- 규율이다 — Postgres 에는 키만. 수신자 주소는 평문이다(`outbound_recipients` 와 같은 판단: 대조·발송에
-- 필요하고, 에이전트 소유자의 데이터다).
--
-- ---------------------------------------------------------------------------
-- 멱등성 — 두 겹
-- ---------------------------------------------------------------------------
--
-- ① 생성: `(agent_id, idempotency_key)` 유니크. 같은 키 재호출은 같은 예약을 돌려준다(요청 해시가 다르면 409).
-- ② 발송: 워커는 잡마다 **안정적인** 멱등 키(`scheduled:{id}`)로 `prepareOutbound` 를 부른다. SQS·lease 재전달이
--    같은 예약을 두 번 집어도 `messages` 는 한 행이고 SES 는 한 번이다(scheduled-sender.ts 머리말).

CREATE TYPE scheduled_send_status AS ENUM ('scheduled', 'dispatched');

CREATE TABLE scheduled_sends (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id            char(32) NOT NULL REFERENCES agents (id) ON DELETE RESTRICT,
  -- 생성 요청의 `Idempotency-Key`. `messages.idempotency_key` 와 같은 상한.
  idempotency_key     text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 255),
  -- 같은 키의 다른 요청을 가리기 위한 해시(`hashOutboundRequest` 와 같은 모양).
  request_hash        text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  from_address        text NOT NULL CHECK (from_address = lower(from_address) AND from_address ~ '^[^@[:space:]]+@[^@[:space:]]+$'),
  recipients          text[] NOT NULL CHECK (cardinality(recipients) BETWEEN 1 AND 100),
  send_at             timestamptz NOT NULL,
  -- 본문 객체 키. **id 에서 유도된 값만** — 다른 예약의 본문을 가리킬 수 없다.
  content_storage_key text NOT NULL CHECK (content_storage_key = 'outbound/scheduled/' || id::text || '.json'),
  trace_id            text CHECK (trace_id IS NULL OR length(trace_id) <= 200),
  cost_cents          integer NOT NULL CHECK (cost_cents >= 0),

  status              scheduled_send_status NOT NULL DEFAULT 'scheduled',
  -- 워커가 집은 횟수(집을 때 먼저 올린다). 결과 기록의 펜싱 토큰이다.
  attempt_count       integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  -- 임대. 집은 워커가 이 시각 전에 결과를 쓰지 못하면 다른 워커가 다시 집는다.
  lease_expires_at    timestamptz,
  dispatched_at       timestamptz,
  -- 잡의 결말(`OutboundOutcome.kind` 또는 'abandoned'). 닫힌 어휘 모양 — 오류 문장이 들어올 자리가 없다.
  dispatch_outcome    text CHECK (dispatch_outcome IS NULL OR dispatch_outcome ~ '^[a-z_]{1,40}$'),
  -- 발송 시도의 `messages` 행. 관문에 닿기 전에 끝난 잡(invalid)은 NULL.
  message_id          uuid REFERENCES messages (id) ON DELETE RESTRICT,
  created_at          timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT scheduled_sends_idempotency_key UNIQUE (agent_id, idempotency_key),
  CONSTRAINT scheduled_sends_dispatched_shape CHECK (
    (status = 'dispatched') = (dispatched_at IS NOT NULL AND dispatch_outcome IS NOT NULL)
  )
);

-- 워커의 유일한 조회 경로. 끝난 행은 인덱스를 키우지 않는다.
CREATE INDEX scheduled_sends_due_idx ON scheduled_sends (send_at) WHERE status = 'scheduled';

-- 왜 allow-list 인가: 무엇을·누구에게·언제 보낼지는 예약의 정체다. 바뀌면 에이전트가 요청하지 않은 발송이
--   된다. 진행 상태만 연다.
CREATE TRIGGER scheduled_sends_immutable_core
  BEFORE UPDATE ON scheduled_sends
  FOR EACH ROW EXECUTE FUNCTION reject_column_update_except(
    'status', 'attempt_count', 'lease_expires_at', 'dispatched_at', 'dispatch_outcome', 'message_id');

-- 왜: 끝난 예약이 다시 scheduled 가 되면 같은 예약이 두 번 관문에 들어간다(두 번째는 멱등 키가 막지만,
--   그 방어를 한 겹으로 두지 않는다).
CREATE OR REPLACE FUNCTION scheduled_sends_reject_terminal_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status <> 'scheduled' THEN
    RAISE EXCEPTION 'scheduled send % is terminal (%)', OLD.id, OLD.status
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER scheduled_sends_terminal_guard
  BEFORE UPDATE ON scheduled_sends
  FOR EACH ROW EXECUTE FUNCTION scheduled_sends_reject_terminal_change();

CREATE TRIGGER scheduled_sends_no_delete
  BEFORE DELETE ON scheduled_sends
  FOR EACH ROW EXECUTE FUNCTION reject_row_delete();

CREATE TRIGGER scheduled_sends_no_truncate
  AFTER TRUNCATE ON scheduled_sends
  FOR EACH STATEMENT EXECUTE FUNCTION reject_truncate();

GRANT SELECT, INSERT, UPDATE ON scheduled_sends TO atmark_app;

COMMENT ON TABLE scheduled_sends IS
  '예약 발송. 판정 컬럼이 없다 — 관문 평가는 발송 시점에 scheduled-sender 워커가 한다. 본문은 outbound/scheduled/{id}.json.';
