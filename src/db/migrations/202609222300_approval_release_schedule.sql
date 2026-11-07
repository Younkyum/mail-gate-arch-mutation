-- 202609222300_approval_release_schedule.sql
-- P2 수정 — 릴리스 일정 (계획 §4.3 · §4.5-6, `src/workers/approval-release.ts`)
--
-- ★ 고치는 결함 (T3 실측, 실 DB):
--   기본 per_minute=5 에서 전환 공지 20통을 승인하면 5통이 나가고 15통이 `release_denied:rate_limit_per_minute`
--   로 **영구 종결**됐다. 릴리스가 "시간이 지나면 풀리는" Stage 4 거부를 영구 거부로 닫았다. 사람이 승인했는데
--   메일이 안 나가고, 그 사실은 audit 에만 남는다.
--
-- 이 파일이 세우는 것:
--   ① `approval_releases` — 승인된 요청의 항목마다 1행. **"승인됐고 아직 나가지 않았다"** 의 표지이자 재시도
--      일정(`next_release_at`)이다. 관문이 일시적으로 거부하면 audit 행은 `pending_approval` 그대로 두고
--      여기 `next_release_at` 만 민다. 창(`deadline_at`) 끝의 재평가가 마지막이다.
--   ② 승인 전이 트리거 — `pending → approved` 와 **같은 트랜잭션에서** 항목 전부의 일정 행을 만든다.
--      승인 경로(API 라우트·매직링크·테스트)가 몇 개든 "승인됐는데 일정이 없는" 요청이 없다.
--   ③ `audit_pending_overdue(at)` — §4.3 보조 불변식의 **재정의된** 측정 함수(아래).
--
-- 왜 큐(SQS)가 아니라 DB 일정인가 — 이 저장소의 outbox 규율이다(`approval_notifications`·`webhook_deliveries`).
--   릴리스 잡 투입처는 아직 없다(`onApproved(approvalId)` 포트뿐). 일정이 DB 에 있으면 워커가 주기적으로 집어서
--   **큐 없이 동작**하고, 잡이 유실돼도 행은 남는다. SQS 가 생기면 그것은 "지금 집어라" 는 **깨우기 신호**일
--   뿐이다 — 신호가 유실돼도 다음 주기 스윕이 같은 행을 집는다. 재예약도 같은 행의 UPDATE 하나라서, 지연
--   메시지(최대 15분)로 표현할 수 없는 "UTC 자정까지" 같은 대기가 자연스럽다.
--
-- 마이그레이션은 append-only 다. 기존 파일은 한 글자도 건드리지 않았다.

-- ---------------------------------------------------------------------------
-- ① approval_releases
-- ---------------------------------------------------------------------------

-- 상태:
--   scheduled — 아직 결말이 없다(첫 시도 전 + 일시적 거부로 재예약 + 임대 중). 임대는 `next_release_at` 을
--               미래로 미는 것으로 표현한다(approval_notifications 와 같다).
--   settled   — 관문이 결말을 냈다(발송·실패·영구 거부·창 끝의 종결·중복). 다시 집히지 않는다.
CREATE TYPE approval_release_status AS ENUM ('scheduled', 'settled');

CREATE TABLE approval_releases (
  -- 한 시도(= 한 messages 행 = 한 audit 행)는 일정 하나만 갖는다.
  message_id            uuid PRIMARY KEY,
  approval_id           uuid NOT NULL,
  audit_id              uuid NOT NULL UNIQUE REFERENCES audit_logs (id) ON DELETE RESTRICT,
  -- 페이싱의 축(워커가 에이전트마다 첫 일시적 거부에서 멈춘다). 요청의 에이전트를 INSERT 때 굳힌다 —
  --   `approval_requests.agent_id` 는 불변이다(트리거).
  agent_id              char(32) NOT NULL REFERENCES agents (id) ON DELETE RESTRICT,
  status                approval_release_status NOT NULL DEFAULT 'scheduled',
  claim_count           integer NOT NULL DEFAULT 0 CHECK (claim_count >= 0),
  next_release_at       timestamptz NOT NULL,
  -- 왜 불변인가: 가변이면 UPDATE 한 줄로 창이 무기한 늘어난다 — "승인한 메일이 한 달 뒤에 나간다".
  deadline_at           timestamptz NOT NULL,
  -- 닫힌 어휘(거부 사유 코드). 자유 문자열이면 예외 메시지가 들어오고, 거기에는 주소가 들어 있을 수 있다.
  last_deferral_reason  text CHECK (last_deferral_reason IS NULL OR last_deferral_reason ~ '^[a-z_]{1,64}$'),
  settled_outcome       text CHECK (settled_outcome IS NULL OR settled_outcome ~ '^[a-z_]{1,40}$'),
  settled_at            timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),

  -- 일정은 **사람이 본 봉투**(항목)에만 걸린다. 항목 없는 일정은 무엇을 보낼지 모른다.
  CONSTRAINT approval_releases_item_fkey FOREIGN KEY (approval_id, message_id)
    REFERENCES approval_request_items (approval_id, message_id) ON DELETE RESTRICT,
  CONSTRAINT approval_releases_settled_shape
    CHECK ((status = 'settled') = (settled_at IS NOT NULL AND settled_outcome IS NOT NULL))
);

-- 워커의 유일한 조회 경로. 종단 행은 이 인덱스를 키우지 않는다.
CREATE INDEX approval_releases_due_idx ON approval_releases (next_release_at) WHERE status = 'scheduled';
-- 승인 직후의 깨우기(`approvalId` 한정 집기).
CREATE INDEX approval_releases_approval_idx ON approval_releases (approval_id) WHERE status = 'scheduled';

-- 식별·창 컬럼 불변. allow-list 라 새 컬럼의 기본도 불변이다(audit_logs 와 같은 방향).
CREATE TRIGGER approval_releases_immutable_core
  BEFORE UPDATE ON approval_releases
  FOR EACH ROW EXECUTE FUNCTION reject_column_update_except(
    'status', 'claim_count', 'next_release_at', 'last_deferral_reason', 'settled_outcome', 'settled_at');

-- 왜: 종단 행이 다시 scheduled 가 되면 이미 닫힌(또는 나간) 시도가 다시 관문에 선다. 관문의 lease 가 중복
--   발송은 막지만, `release_denied` 로 닫힌 행을 되살리는 경로 자체를 두지 않는다.
CREATE OR REPLACE FUNCTION approval_releases_reject_terminal_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status <> 'scheduled' THEN
    RAISE EXCEPTION 'approval release % is terminal (%)', OLD.message_id, OLD.status
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER approval_releases_terminal_guard
  BEFORE UPDATE ON approval_releases
  FOR EACH ROW EXECUTE FUNCTION approval_releases_reject_terminal_change();

CREATE TRIGGER approval_releases_no_delete
  BEFORE DELETE ON approval_releases
  FOR EACH ROW EXECUTE FUNCTION reject_row_delete();

CREATE TRIGGER approval_releases_no_truncate
  AFTER TRUNCATE ON approval_releases
  FOR EACH STATEMENT EXECUTE FUNCTION reject_truncate();

COMMENT ON TABLE approval_releases IS
  '승인된 요청의 항목별 릴리스 일정 — "승인됐고 아직 나가지 않았다" 의 표지. 승인 전이 트리거가 같은 트랜잭션에서 만든다. 일시적 거부는 next_release_at 을 밀고, deadline_at(승인 + 48h) 끝의 재평가가 마지막이다.';

-- ---------------------------------------------------------------------------
-- ② 승인 전이 → 일정 (같은 트랜잭션)
-- ---------------------------------------------------------------------------

-- 왜 앱 코드가 아니라 트리거인가: `approval_notifications` 와 같은 이유다. 승인 경로는 이미 둘이고
--   (API 라우트의 `approveRequest`, 매직링크의 `createPostgresApprovalStoreOn`), 경로마다 INSERT 한 줄을 기억해야
--   하면 잊은 경로의 승인은 **아무도 집지 않는다** — 그 메일은 audit 에 `pending_approval` 로 영원히 남는다.
--   승인이 롤백되면 일정도 없다.
--
-- 48시간의 근거는 `src/approval/service.ts` 의 `APPROVAL_RELEASE_WINDOW_HOURS` 주석에 있다(값의 출처는 여기다).
CREATE OR REPLACE FUNCTION approval_requests_schedule_release() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO approval_releases (message_id, approval_id, audit_id, agent_id, next_release_at, deadline_at)
  SELECT i.message_id, i.approval_id, i.audit_id, NEW.agent_id, NEW.decided_at, NEW.decided_at + interval '48 hours'
    FROM approval_request_items i
   WHERE i.approval_id = NEW.id;
  RETURN NEW;
END;
$$;

CREATE TRIGGER approval_requests_schedule_release
  AFTER UPDATE OF status ON approval_requests
  FOR EACH ROW
  WHEN (OLD.status = 'pending' AND NEW.status = 'approved')
  EXECUTE FUNCTION approval_requests_schedule_release();

-- 이 파일 이전에 승인됐고 아직 대기 행이 남은 항목 — 그 행을 집을 주체가 없었다. 일정을 준다. 창은 승인 시각
--   기준 그대로다: 이미 지났으면 첫 스윕의 재평가가 마지막이다(보내지거나, 닫히거나).
INSERT INTO approval_releases (message_id, approval_id, audit_id, agent_id, next_release_at, deadline_at)
SELECT i.message_id, i.approval_id, i.audit_id, r.agent_id, r.decided_at, r.decided_at + interval '48 hours'
  FROM approval_request_items i
  JOIN approval_requests r ON r.id = i.approval_id
  JOIN audit_logs a ON a.id = i.audit_id
 WHERE r.status = 'approved' AND a.decision = 'pending_approval';

-- ---------------------------------------------------------------------------
-- ③ §4.3 보조 불변식 — 재정의와 측정
-- ---------------------------------------------------------------------------

-- 원문: "`pending_approval` 행은 종료 상태가 아니다 … TTL 을 넘겨 `pending` 인 행이 0 이어야 한다."
--
-- 재예약이 생기면 원문 그대로는 참일 수 없다 — 승인 직전(TTL 23시간째)에 승인되고 분당 한도로 미뤄진 항목은
-- 요청 TTL 을 넘겨서도 audit 이 `pending_approval` 이다. 그런데 그 행은 **승인 대기가 아니다**: 요청은
-- `approved` 이고, 일정 행이 `scheduled` 이며, 창 끝이 있다. 두 상태를 가르는 표지가 `approval_releases` 다.
--
-- 재정의 — `decision='pending_approval'` 인 audit 행은 아래 중 **정확히 하나**여야 한다:
--   (a) 승인 대기: 요청이 `pending` 이고 `at < expires_at`            (TTL 스위퍼가 상한을 집행)
--   (b) 릴리스 대기: 요청이 `approved` 이고 일정이 `scheduled` 이며 `at < deadline_at` (릴리스 워커가 집행)
-- 이 함수는 둘 다 아닌 행을 돌려준다. **0행이 불변식이다.** 창 끝의 행은 다음 스윕이 닫을 때까지 여기 보인다 —
-- 스윕 주기만큼의 지연은 호출자(알람)가 허용 폭으로 둔다.
CREATE OR REPLACE FUNCTION audit_pending_overdue(at timestamptz)
RETURNS TABLE (audit_id uuid, approval_id uuid, request_status approval_status, release_status approval_release_status)
LANGUAGE sql STABLE AS $$
  SELECT a.id, a.approval_id, r.status, rel.status
    FROM audit_logs a
    JOIN approval_requests r ON r.id = a.approval_id
    LEFT JOIN approval_releases rel ON rel.audit_id = a.id
   WHERE a.decision = 'pending_approval'
     AND NOT (
       (r.status = 'pending' AND at < r.expires_at)
       OR (r.status = 'approved' AND rel.status = 'scheduled' AND at < rel.deadline_at)
     )
$$;

COMMENT ON FUNCTION audit_pending_overdue(timestamptz) IS
  '§4.3 보조 불변식(재정의) — 승인 대기(요청 pending, TTL 전)도 릴리스 대기(요청 approved, 일정 scheduled, 창 전)도 아닌 pending_approval audit 행. 0행이 불변식이다.';

-- ---------------------------------------------------------------------------
-- 권한
-- ---------------------------------------------------------------------------

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'atmark_app') THEN
    RAISE EXCEPTION
      'role atmark_app does not exist; provision the app role before running this migration'
      USING ERRCODE = '42704';
  END IF;
END;
$$;

-- INSERT 는 승인 전이 트리거가 앱 롤로 실행하기 때문이다(트리거 함수는 SECURITY DEFINER 가 아니다).
-- 왜 DELETE 가 없는가: 위 트리거의 1차 방어선. 일정 기록은 "승인분이 어떻게 끝났는가" 의 보존이다.
GRANT SELECT, INSERT, UPDATE ON approval_releases TO atmark_app;
GRANT EXECUTE ON FUNCTION audit_pending_overdue(timestamptz) TO atmark_app;
