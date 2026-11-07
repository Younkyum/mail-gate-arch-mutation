-- 202609221420_messages.sql
-- P1a — Message + 멱등성 상태기계 (계획 §4.5, §5.2 V5, §10 PRD 제약)

-- ---------------------------------------------------------------------------
-- 열거형
-- ---------------------------------------------------------------------------

CREATE TYPE message_direction AS ENUM ('outbound', 'inbound');

-- 왜 이 4+1 값인가 (§4.5 2번):
--   pending → dispatching(lease) → sent | failed 가 관문의 exactly-once 상태기계다.
--   SQS 는 at-least-once 이므로 재전달이 중복 발송이 된다. 상태 전이를 조건부 UPDATE 로
--   묶어야 중복이 DB 에서 죽는다. 'received' 는 direction='inbound' 전용 종단 상태로,
--   P1a 에 inbound 경로는 없지만 direction 컬럼을 가진 채 표현 불가능한 행을 남기지
--   않기 위해 지금 정의한다(P3 에서 사용).
CREATE TYPE message_status AS ENUM ('pending', 'dispatching', 'sent', 'failed', 'received');

CREATE TYPE sender_trust AS ENUM ('unknown', 'untrusted', 'known', 'trusted');
CREATE TYPE injection_risk AS ENUM ('none', 'low', 'medium', 'high');

-- ---------------------------------------------------------------------------
-- messages
-- ---------------------------------------------------------------------------

-- 왜 이 컬럼 집합인가 (PRD 제약 · §5.2 V5):
--   PRD 는 raw email 을 Postgres 에 저장하는 것을 금지한다. 검증은 "크기 상한"이 아니라
--   **컬럼 화이트리스트**다 — 40KB 평문 본문은 크기 검사를 통과하면서 제약을 위반한다.
--   본문·원문·첨부는 body_storage_key / raw_storage_key(S3) 로만 참조된다.
--   이 테이블에 본문성 컬럼을 추가하면 §5.2 V5 의 스키마 리플렉션 단언이 실패한다.
CREATE TABLE messages (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id           char(32) NOT NULL REFERENCES agents (id) ON DELETE RESTRICT,
  -- 왜 FK 가 없는가: Thread 테이블은 P3 범위다(§6 P3). P1a 에서 FK 를 걸 대상이 없으므로
  --   컬럼만 먼저 두고 P3 마이그레이션이 FK 를 추가한다.
  thread_id          uuid,
  direction          message_direction NOT NULL,
  -- 왜 해시인가 (§5.4 · §5.2 V5 화이트리스트):
  --   inbound 의 from 은 제3자 PII 다. 정책 판정은 평문 주소를 필요로 하지 않고
  --   (Stage 1 은 요청의 from 을 agent_addresses 와 비교한다), 도메인만 평문으로 남긴다.
  from_address_hash  text NOT NULL CHECK (from_address_hash ~ '^[0-9a-f]{64}$'),
  from_domain        text NOT NULL CHECK (from_domain = lower(from_domain)),
  subject            text CHECK (subject IS NULL OR length(subject) <= 998),
  -- 왜 512 인가: §5.2 V5 가 snippet 의 512자 상한을 별도 단언한다. 상한이 없으면
  --   snippet 이 사실상 본문 저장 컬럼으로 자라 PRD 제약을 우회한다.
  snippet            text CHECK (snippet IS NULL OR length(snippet) <= 512),
  -- 왜: 본문은 S3 에만 있다. 이 두 컬럼이 Postgres 가 본문에 대해 아는 전부다.
  body_storage_key   text,
  raw_storage_key    text,
  sender_trust       sender_trust NOT NULL DEFAULT 'unknown',
  injection_risk     injection_risk NOT NULL DEFAULT 'none',
  status             message_status NOT NULL DEFAULT 'pending',

  -- 왜 전송 *전에* 생성·저장하는가 (§4.5 4번):
  --   재시도 시 같은 Message-ID 로 재전송되면 수신측 MUA·MTA 가 중복을 병합할 수 있다.
  --   "전송 성공 직후 프로세스 사망"이라는 최악 케이스의 2차 방어선이며, 전송 후에
  --   기록하면 바로 그 케이스에서 값이 없다.
  message_id_header  text NOT NULL CHECK (message_id_header ~ '^<[^<>[:space:]]+@[^<>[:space:]]+>$'),

  -- 왜: 중복 발송 방어의 뿌리(§4.5 1번). OUTBOUND_ROUTES 의 kind:'http' 5종
  --   (send/reply/forward/draft_send/transition_announcement)이 Idempotency-Key 를
  --   필수로 받고, 동일 키 재호출은 최초 결과를 그대로 반환한다.
  idempotency_key    text CHECK (idempotency_key IS NULL OR length(idempotency_key) BETWEEN 1 AND 255),

  -- 왜 요청 해시를 **지금** 두는가 (멱등 키의 남은 절반):
  --   유니크 인덱스는 같은 키의 2회차 INSERT 를 막을 뿐, 그 2회차가 *같은 요청*이었는지는
  --   말해 주지 않는다. 같은 키로 다른 수신자를 보내면 최초 결과가 조용히 반환되고 차이는
  --   어디에도 남지 않는다. 그런데 수신자 집합은 이 테이블에 **컬럼 자체가 없다**(본문·
  --   수신자는 S3). 즉 해시를 INSERT 시점에 남기지 않으면 그 차이는 나중에 **어떤 방법으로도
  --   복원되지 않는다** — 테이블이 비어 있는 지금이 컬럼을 넣는 유일한 시점이다.
  --   저장은 P1a 의 일이고, 불일치 시 409 판정은 P1b API 층의 일이다.
  request_hash       text CHECK (request_hash IS NULL OR request_hash ~ '^[0-9a-f]{64}$'),

  -- 왜 lease 인가 (§4.5 3번):
  --   gate.dispatch 는 조건부 UPDATE 로 lease 를 취득한 뒤에만 transport 를 호출한다.
  --   WHERE id=$2 AND (status='pending' OR (status='dispatching' AND lease_expires_at < now()))
  --   영향 행이 0이면 다른 워커가 이미 처리 중이므로 즉시 반환 — 중복 SQS 전달이 여기서 죽는다.
  lease_id           uuid,
  lease_expires_at   timestamptz,
  attempt            integer NOT NULL DEFAULT 0 CHECK (attempt >= 0),

  ses_message_id     text,
  failure_reason     text,

  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  sent_at            timestamptz,
  failed_at          timestamptz,

  -- 왜 상태기계를 CHECK 로 쓰는가:
  --   "status 는 sent 인데 ses_message_id 가 NULL" 같은 행이 하나라도 생기면 AC-i1~i3 의
  --   판정 기준(SES 호출 정확히 1회)을 DB 로 확인할 수 없게 된다. 표현 불가능하게 만든다.
  CONSTRAINT messages_state_machine CHECK (
    CASE status
      WHEN 'pending' THEN
        lease_id IS NULL AND lease_expires_at IS NULL
        AND ses_message_id IS NULL AND failure_reason IS NULL
        AND sent_at IS NULL AND failed_at IS NULL
      WHEN 'dispatching' THEN
        lease_id IS NOT NULL AND lease_expires_at IS NOT NULL
        AND ses_message_id IS NULL AND failure_reason IS NULL
        AND sent_at IS NULL AND failed_at IS NULL
      WHEN 'sent' THEN
        ses_message_id IS NOT NULL AND failure_reason IS NULL
        AND sent_at IS NOT NULL AND failed_at IS NULL
      WHEN 'failed' THEN
        failure_reason IS NOT NULL AND ses_message_id IS NULL
        AND failed_at IS NOT NULL AND sent_at IS NULL
      WHEN 'received' THEN
        lease_id IS NULL AND lease_expires_at IS NULL
        AND ses_message_id IS NULL AND failure_reason IS NULL
        AND sent_at IS NULL AND failed_at IS NULL
      -- 왜 ELSE 가 없으면 안 되는가 (fail-open):
      --   어느 WHEN 에도 안 걸리면 CASE 는 NULL 을 반환하고 **CHECK 는 NULL 을 통과로
      --   취급한다.** `ALTER TYPE message_status ADD VALUE` 가 들어오는 순간(P2 approval,
      --   P3 inbound) 그 상태의 행은 어떤 컬럼 조합이든 합법이 된다 — status='queued' 에
      --   ses_message_id 와 sent_at 이 동시에 있는 행이 통과한다. 위 주석이 "표현
      --   불가능하게 만든다"고 선언한 것의 정반대다. 새 상태는 여기 WHEN 을 추가해야만
      --   존재할 수 있다.
      ELSE false
    END
  ),

  -- 왜: inbound 는 발송 상태기계를 타지 않는다. 섞이면 lease 스위퍼가 inbound 행을 집는다.
  CONSTRAINT messages_direction_status CHECK (
    (direction = 'outbound' AND status <> 'received')
    OR (direction = 'inbound' AND status = 'received')
  ),

  -- 왜: 멱등 키는 발송 요청에만 의미가 있다. inbound 는 키도 요청 해시도 갖지 않는다.
  CONSTRAINT messages_inbound_has_no_dispatch_state CHECK (
    direction = 'outbound' OR (idempotency_key IS NULL AND request_hash IS NULL)
  ),

  -- 왜 컬럼을 NOT NULL 로 하지 않고 이 CHECK 를 쓰는가 (그리고 왜 이게 없으면 안 되는가):
  --   컬럼 NOT NULL 은 inbound 행에도 키를 요구하므로 쓸 수 없다. 그렇다고 nullable 로만
  --   두면 아래 유니크 인덱스가 `WHERE idempotency_key IS NOT NULL` 이라 **키 없이 INSERT 한
  --   outbound 행은 제약을 아예 만나지 않는다** — 중복 방어가 호출자의 opt-in 이 된다.
  --   키 강제가 매니페스트 리터럴 타입과 아직 존재하지 않는 API 층에만 있으면 그 둘은
  --   전부 DB 밖이고, DB 밖의 강제는 워커가 직접 INSERT 하는 순간 사라진다.
  CONSTRAINT messages_outbound_requires_idempotency CHECK (
    direction <> 'outbound' OR (idempotency_key IS NOT NULL AND request_hash IS NOT NULL)
  )
);

CREATE TRIGGER messages_set_updated_at
  BEFORE UPDATE ON messages
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- 전이 가드 — CHECK 로는 표현할 수 없는 절반
-- ---------------------------------------------------------------------------

-- 왜 CHECK 만으로는 부족한가 (exactly-once 가 서 있던 빈 가정):
--   messages_state_machine 은 **행 내부 컬럼 조합**의 불변식이지 **전이**의 불변식이 아니다.
--   그래서 이것이 통과한다:
--     UPDATE messages SET status='pending', ses_message_id=NULL, sent_at=NULL WHERE id=$1;
--   그 직후 §4.5-3 의 조건부 UPDATE(WHERE status='pending' OR ...)가 lease 를 새로 내준다
--   → **같은 메시지가 다시 나간다.** §4.5 의 exactly-once 주장 전체가 "status 는 역행하지
--   않는다"는 가정 위에 있었고, 그 가정을 집행하는 것은 아무 데도 없었다.
--
--   허용 전이 = §4.5-2 의 상태기계가 그리는 것 전부:
--     pending     → dispatching            (lease 취득)
--     dispatching → dispatching            (만료 후 재취득 — status 가 바뀌지 않는다)
--     dispatching → sent | failed          (전송 결과 확정)
--     sent | failed | received → 없음      **종단이다.**
CREATE OR REPLACE FUNCTION messages_reject_invalid_transition() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status
     AND NOT (
       (OLD.status = 'pending' AND NEW.status = 'dispatching')
       OR (OLD.status = 'dispatching' AND NEW.status IN ('sent', 'failed'))
     )
  THEN
    RAISE EXCEPTION
      'illegal messages.status transition % -> % (id=%)',
      OLD.status, NEW.status, OLD.id
      USING ERRCODE = '23514';
  END IF;

  -- 왜 종단 행의 결과 컬럼까지 얼리는가: status 를 그대로 둔 채 ses_message_id 만 갈아끼우면
  --   위 가드를 통과하면서 "SES 호출 정확히 1회"(AC-i1~i3)의 **증거**가 사후에 바뀐다.
  --   상태 전이를 막고 그 상태의 근거는 열어 두는 것은 반쪽이다.
  IF OLD.status IN ('sent', 'failed')
     AND (
       NEW.ses_message_id IS DISTINCT FROM OLD.ses_message_id
       OR NEW.failure_reason IS DISTINCT FROM OLD.failure_reason
       OR NEW.sent_at IS DISTINCT FROM OLD.sent_at
       OR NEW.failed_at IS DISTINCT FROM OLD.failed_at
     )
  THEN
    RAISE EXCEPTION
      'messages row % is terminal (%): dispatch outcome columns are frozen',
      OLD.id, OLD.status
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER messages_status_transition_guard
  BEFORE UPDATE ON messages
  FOR EACH ROW EXECUTE FUNCTION messages_reject_invalid_transition();

-- 왜 이 7개인가 (§4.5 의 exactly-once 가 값 자체에 기대는 컬럼들):
--   message_id_header 가 가변이면 AC-i3 의 "만료 후 **같은 Message-ID 로** 재전송"이
--   집행되지 않는다. idempotency_key·request_hash 가 가변이면 INSERT 직후 UPDATE 한 번으로
--   (agent_id, idempotency_key) 유니크 인덱스를 빠져나가 같은 요청을 다시 보낼 수 있다 —
--   위 CHECK 가 막은 구멍을 UPDATE 로 다시 여는 셈이다. direction 이 바뀌면 상태기계
--   자체가 갈아탄다.
CREATE TRIGGER messages_identity_immutable
  BEFORE UPDATE ON messages
  FOR EACH ROW EXECUTE FUNCTION reject_column_update(
    'id', 'agent_id', 'direction', 'message_id_header',
    'idempotency_key', 'request_hash', 'created_at'
  );

-- ---------------------------------------------------------------------------
-- 인덱스
-- ---------------------------------------------------------------------------

-- 왜: AC-i1 이 요구하는 "동일 Idempotency-Key 100회 동시 호출 → messages 행 1개"를
--     경합 없이 보장하는 유일한 수단. 애플리케이션 선조회는 경합에서 진다.
--     부분 인덱스지만 outbound 에 대해서는 전건이다 — messages_outbound_requires_idempotency
--     가 outbound 행의 키를 NOT NULL 로 못박으므로 이 인덱스를 피해 가는 발송 행이 없다.
--     (WHERE 절은 inbound 행을 인덱스 밖에 두기 위해 남긴다.)
CREATE UNIQUE INDEX messages_agent_idempotency_key
  ON messages (agent_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- 왜: 에이전트별 최신순 조회(감사·대시보드)의 기본 접근 경로.
CREATE INDEX messages_agent_created_idx ON messages (agent_id, created_at DESC);

-- 왜: 스레드 재구성(AC-4). thread_id 가 NULL 인 행이 다수이므로 부분 인덱스.
CREATE INDEX messages_thread_created_idx
  ON messages (thread_id, created_at) WHERE thread_id IS NOT NULL;

-- 왜: SES 이벤트(bounce/complaint/delivery)는 provider 의 message id 로 돌아온다.
--     이 인덱스가 없으면 ses-event-consumer 가 전건 스캔한다.
CREATE UNIQUE INDEX messages_ses_message_id_key
  ON messages (ses_message_id) WHERE ses_message_id IS NOT NULL;

-- 왜: RFC 5322 Message-ID 로의 역조회(재시도 시 같은 헤더 재사용 확인, AC-i3).
CREATE UNIQUE INDEX messages_message_id_header_key ON messages (message_id_header);

-- 왜: lease 만료 스위퍼가 읽는 유일한 경로. 부분 인덱스라 dispatching 행 수만큼만 자란다.
CREATE INDEX messages_lease_expiry_idx
  ON messages (lease_expires_at) WHERE status = 'dispatching';

COMMENT ON TABLE messages IS
  'raw email 본문은 저장하지 않는다. 본문/원문은 body_storage_key/raw_storage_key(S3)로만 참조 (PRD 제약, 계획 §10 · §5.2 V5 컬럼 화이트리스트).';
