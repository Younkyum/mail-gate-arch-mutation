-- 202609221800_approval_requests.sql
-- P2 — ApprovalRequest (계획 §3.4 설계 4조 · §4.3 r3-V2 · §4.5-6)
--
-- ★ 설계의 전부 (§3.4):
--     "승인이 *메시지당* 비용이면 워크로드를 죽인다. *상대방당* 비용으로 상환되면 죽이지 않는다."
--   이 테이블은 **사람의 단위**다. 발송의 단위는 audit_logs 이고(시도당 1행), 둘을 잇는 것은
--   audit_logs.approval_id 와 아래 approval_request_items 다. 배치 승인 20건 = 요청 1행 + 항목 20행
--   + audit 20행. 승인은 사람의 단위이고 audit 는 발송의 단위다(§4.3 표).

-- ---------------------------------------------------------------------------
-- 열거형
-- ---------------------------------------------------------------------------

-- 왜 4값인가 (§3.4 4조): 'expired' 가 'rejected' 와 다른 값인 이유는 **누가 결정했는가**가
--   다르기 때문이다. 거절은 사람의 결정이고 만료는 결정의 부재다. 둘을 합치면 "사람이 거절한
--   상대" 와 "사람이 못 본 상대" 가 같은 행이 되고, 재시도 판단(에이전트의 몫)이 근거를 잃는다.
--   **'sent' 같은 값이 없는 것이 요점이다.** 발송 결과는 messages·audit_logs 의 일이다 —
--   여기에 발송 상태를 두면 두 곳이 "나갔는가" 에 각자 답하게 된다.
CREATE TYPE approval_status AS ENUM ('pending', 'approved', 'rejected', 'expired');

-- 왜: §3.2 전환 공지는 신규 상대 다수를 **단일** ApprovalRequest 로 묶는다(AC-b1).
--   'message' 는 시도 1건이 요청 1건, 'batch' 는 시도 N건이 요청 1건.
CREATE TYPE approval_subject AS ENUM ('message', 'batch');

-- ---------------------------------------------------------------------------
-- approval_requests
-- ---------------------------------------------------------------------------

CREATE TABLE approval_requests (
  id           uuid PRIMARY KEY,
  agent_id     char(32) NOT NULL REFERENCES agents (id) ON DELETE RESTRICT,
  subject      approval_subject NOT NULL DEFAULT 'message',
  status       approval_status NOT NULL DEFAULT 'pending',

  -- 왜 created_at 에 기본값이 없는가: expires_at 과 **같은 시계**여야 한다. 관문이 평가 시각
  --   (`request.now`)으로 둘 다 적는다 — now() 와 앱 시각이 섞이면 아래 TTL 범위 CHECK 가
  --   시계 차이만큼 흔들린다.
  created_at   timestamptz NOT NULL,
  -- 왜 1h–7d 인가 (§3.4 4조 "approval_ttl 기본 24시간, 범위 1h–7d"): 1시간 미만은 사람이 못 보고,
  --   7일 초과는 "기다리는 메일" 이 사실상 영구 보류가 된다. 범위는 정책(config_json)이 정하지만
  --   **범위 밖의 값이 행으로 존재할 수 없게** 여기서 한 번 더 막는다.
  expires_at   timestamptz NOT NULL,

  -- ---- 아래 3개만 갱신 가능하다 ----
  decided_at   timestamptz,
  -- 왜 text 인가: 소유자 식별은 P2 의 매직링크(HMAC 토큰)가 만든다. 사용자 테이블은 P5 다.
  decided_by   text,
  -- 왜: 승인할 때 고른 standing approval 스코프(§3.4 2조). 'domain' 은 소유자 확인이 필요하고
  --   (AC-d5) 그 확인은 sender_relationships 의 CHECK 가 집행한다.
  granted_scope text CHECK (granted_scope IS NULL OR granted_scope IN ('recipient', 'thread', 'domain')),

  CONSTRAINT approval_requests_ttl_range CHECK (
    expires_at - created_at BETWEEN interval '1 hour' AND interval '7 days'
  ),

  -- 왜 상태마다 모양을 고정하는가: 'approved' 인데 결정자가 없는 행은 "누가 이 발송을
  --   허락했는가" 에 답하지 못한다(AC-9). 'expired' 에 결정자가 **없어야** 하는 것도 같은 이유다 —
  --   만료를 사람의 결정처럼 적으면 audit 가 거짓말을 한다.
  CONSTRAINT approval_requests_decision_shape CHECK (
    CASE status
      WHEN 'pending'  THEN decided_at IS NULL AND decided_by IS NULL AND granted_scope IS NULL
      WHEN 'approved' THEN decided_at IS NOT NULL AND decided_by IS NOT NULL AND granted_scope IS NOT NULL
      WHEN 'rejected' THEN decided_at IS NOT NULL AND decided_by IS NOT NULL AND granted_scope IS NULL
      WHEN 'expired'  THEN decided_at IS NOT NULL AND decided_by IS NULL AND granted_scope IS NULL
      ELSE false
    END
  ),

  -- ★ 왜 이 두 줄이 이 테이블에서 가장 중요한가 (§3.4 4조 — "타임아웃 기본동작 = 만료. 절대
  --   auto-send 아님"): 스위퍼가 아직 돌지 않았어도 **TTL 을 넘긴 요청은 승인될 수 없다.**
  --   앱 쪽 조건부 UPDATE 가 `expires_at > now` 를 이미 걸지만, 그 한 줄이 리팩터로 빠지는 날
  --   만료된 요청이 승인되고 곧바로 발송된다 — 창업 사고("의도하지 않은 발송")의 정확한 모양이다.
  --   반대로 만료는 TTL 전에 찍힐 수 없다(스위퍼의 시계가 틀려도 살아 있는 요청을 죽이지 않는다).
  CONSTRAINT approval_requests_approve_before_expiry CHECK (
    status <> 'approved' OR decided_at < expires_at
  ),
  CONSTRAINT approval_requests_expire_after_ttl CHECK (
    status <> 'expired' OR decided_at >= expires_at
  )
);

CREATE INDEX approval_requests_agent_created_idx ON approval_requests (agent_id, created_at DESC);
-- 왜: TTL 스위퍼의 조회 경로이자 §4.3 보조 불변식("TTL 을 넘겨 pending 인 행 0개")의 측정 경로.
CREATE INDEX approval_requests_pending_expiry_idx
  ON approval_requests (expires_at) WHERE status = 'pending';

-- 왜 전이 가드가 필요한가 (§4.5-6 · AC-i4):
--   릴리스와 만료는 **둘 다** `WHERE status='pending'` 조건부 UPDATE 로만 상태를 바꾼다 — 먼저
--   이긴 쪽이 유일한 전이자이고 진 쪽은 0행이다. 그런데 그 규율은 앱의 WHERE 절에만 있다.
--   `UPDATE approval_requests SET status='approved' WHERE id=$1` 한 줄(WHERE 를 빠뜨린 코드)이
--   이미 'expired' 인 요청을 되살리면 만료된 메일이 나간다. 그래서 **종단 상태를 트리거로 동결한다**
--   — messages 의 상태기계 트리거·audit_logs 의 decision 가드와 같은 규율이다.
CREATE OR REPLACE FUNCTION approval_requests_reject_terminal_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status <> 'pending' THEN
    RAISE EXCEPTION
      'approval_requests is terminal once decided: % -> % (id=%)',
      OLD.status, NEW.status, OLD.id
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER approval_requests_terminal_freeze
  BEFORE UPDATE ON approval_requests
  FOR EACH ROW EXECUTE FUNCTION approval_requests_reject_terminal_update();

-- 왜 allow-list 인가: audit_logs_partial_immutability 와 같은 이유다 — 새 컬럼의 기본이 불변이다.
--   특히 expires_at 이 가변이면 "만료 직전에 TTL 을 늘려 승인" 하는 경로가 생긴다.
CREATE TRIGGER approval_requests_partial_immutability
  BEFORE UPDATE ON approval_requests
  FOR EACH ROW EXECUTE FUNCTION reject_column_update_except('status', 'decided_at', 'decided_by', 'granted_scope');

CREATE TRIGGER approval_requests_no_delete
  BEFORE DELETE ON approval_requests
  FOR EACH ROW EXECUTE FUNCTION reject_row_delete();

CREATE TRIGGER approval_requests_no_truncate
  AFTER TRUNCATE ON approval_requests
  FOR EACH STATEMENT EXECUTE FUNCTION reject_truncate();

COMMENT ON TABLE approval_requests IS
  '사람의 승인 단위 (계획 §3.4). 상태 전이는 WHERE status=''pending'' 조건부 UPDATE 로만 — 종단 상태는 트리거가 동결한다(AC-i4). TTL 을 넘긴 요청은 승인될 수 없다(CHECK).';

-- ---------------------------------------------------------------------------
-- approval_request_items — 요청 1건이 덮는 발송 시도들
-- ---------------------------------------------------------------------------

-- 왜 별도 테이블인가:
--   ① **릴리스가 다시 보낼 수 있어야 한다.** messages 에는 수신자 컬럼이 없고(§5.2 V5 — 발송 행에
--      제3자 주소를 두지 않는다) 발신 주소도 해시뿐이다. 승인이 떨어진 뒤 관문을 다시 통과하려면
--      (§4.3 "릴리스는 관문을 재통과") 평가에 필요한 봉투(from·to·비용)가 어딘가 남아 있어야 한다.
--   ② **배치(§3.2)를 스키마 변경 없이 담는다.** 요청 1 : 항목 N.
--   이 행들은 승인 대상 상대의 주소를 담는다 — 승인되면 곧 sender_relationships 가 되는 값이고,
--   suppression_entries 와 같은 범주(조직 자신의 연락 관계)다. 본문은 여기 없다.
CREATE TABLE approval_request_items (
  approval_id     uuid NOT NULL REFERENCES approval_requests (id) ON DELETE RESTRICT,
  -- 왜 UNIQUE 인가: 한 시도(= 한 messages 행 = 한 audit 행)는 요청 하나에만 속한다.
  --   둘에 속하면 한쪽 거절·다른 쪽 승인이 같은 메일을 두고 다툰다.
  message_id      uuid NOT NULL UNIQUE REFERENCES messages (id) ON DELETE RESTRICT,
  audit_id        uuid NOT NULL UNIQUE REFERENCES audit_logs (id) ON DELETE RESTRICT,
  -- 호출자가 넘긴 **원본** 주소다(+tag 보존). 판정용 정규화는 로더가 매번 다시 한다.
  from_address    text NOT NULL CHECK (from_address ~ '^[^@[:space:]]+@[^@[:space:]]+$'),
  recipients      text[] NOT NULL CHECK (cardinality(recipients) >= 1),
  is_thread_reply boolean NOT NULL,
  -- threads 테이블은 P3 다(messages.thread_id 에 FK 가 없는 것과 같은 이유).
  thread_id       uuid,
  cost_cents      integer NOT NULL CHECK (cost_cents >= 0),
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (approval_id, message_id)
);

-- 왜 UPDATE 까지 막는가: 승인은 **사람이 본 봉투**에 대한 결정이다. 승인 뒤 수신자가 바뀌면
--   사람이 허락하지 않은 상대에게 나간다 — 이 프로젝트가 막으려는 사고 그 자체다.
CREATE TRIGGER approval_request_items_immutable_update
  BEFORE UPDATE ON approval_request_items
  FOR EACH ROW EXECUTE FUNCTION reject_row_update();

CREATE TRIGGER approval_request_items_no_delete
  BEFORE DELETE ON approval_request_items
  FOR EACH ROW EXECUTE FUNCTION reject_row_delete();

CREATE TRIGGER approval_request_items_no_truncate
  AFTER TRUNCATE ON approval_request_items
  FOR EACH STATEMENT EXECUTE FUNCTION reject_truncate();

-- ---------------------------------------------------------------------------
-- audit_logs — P1a 가 깔아 둔 구조에 **두 가지만** 더한다
-- ---------------------------------------------------------------------------

-- ① approval_id 의 FK. P1a 는 "approval_requests 는 P2 범위" 라 FK 없이 컬럼만 두었다
--   (202609221430 주석). 대상 테이블이 생겼으니 존재하지 않는 요청을 가리키는 행을 막는다.
--   기존 행은 전부 NULL 이라 검증에 걸리지 않는다.
ALTER TABLE audit_logs
  ADD CONSTRAINT audit_logs_approval_id_fkey
  FOREIGN KEY (approval_id) REFERENCES approval_requests (id) ON DELETE RESTRICT;

-- ② bootstrap_grace 잔여 카운트 (§3.1 층 3 · AC-a4 "API 와 audit 양쪽에서 1로 일치").
--   **왜 기존 구조로 부족한가:** reasons[] 는 닫힌 사유 **코드**의 어휘다(`DecisionReason`).
--   잔여 '1' 은 코드가 아니라 수치이고, reasons 에 'bootstrap_grace_remaining:1' 같은 값을 넣는
--   순간 어휘가 열려 집계 축(AC-9)이 무한히 갈라진다. 수치는 수치 컬럼에 둔다.
--   **갱신 불가다** — audit_logs_partial_immutability 가 allow-list 이므로 새 컬럼의 기본이 불변이다
--   (202609221430 이 그 방향을 고른 이유가 정확히 이 순간이다).
ALTER TABLE audit_logs
  ADD COLUMN bootstrap_grace_remaining integer
  CHECK (bootstrap_grace_remaining IS NULL OR bootstrap_grace_remaining >= 0);

-- ---------------------------------------------------------------------------
-- 권한
-- ---------------------------------------------------------------------------

-- 왜 DELETE 가 없는가: 결정 이력은 audit 의 일부다("누가 이 발송을 허락했는가").
GRANT SELECT, INSERT, UPDATE ON approval_requests TO atmark_app;
-- 왜 UPDATE 도 없는가: 항목은 사람이 본 봉투다 — 위 트리거와 같은 이유로 권한 단계에서 막는다.
GRANT SELECT, INSERT ON approval_request_items TO atmark_app;
