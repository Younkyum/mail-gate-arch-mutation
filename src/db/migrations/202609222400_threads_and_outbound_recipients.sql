-- 202609222400_threads_and_outbound_recipients.sql
-- P3a — threads · outbound_recipients · messages.thread_id 의 FK (계획 §6 P3, AC-4,
--        .omc/handoffs/p3-integration.md "스키마 요구")
--
-- 스레드 소속은 **권한 판단의 입력**이다(`src/mail/thread/resolve.ts` 머리말). reply_only·
-- `auto_approve_reply_within_thread` 가 이 값을 읽으므로, 메시지를 남의 스레드에 붙이는 것은
-- 표시 오류가 아니라 승인 우회다. 그래서 이 파일의 제약은 전부 한 방향을 본다 —
-- **스레드 소속이 사후에 바뀌거나 에이전트 경계를 넘을 수 없게 한다.**

-- ---------------------------------------------------------------------------
-- threads
-- ---------------------------------------------------------------------------

-- 왜 2값인가: 스레드를 연 쪽이 누구인가는 권한의 출발점이 다르다는 뜻이다. 에이전트가 연 스레드의
--   참여자는 "우리가 실제로 보낸 수신자" 이고, 외부가 연 스레드의 참여자는 "그 발신자 한 명" 이다.
CREATE TYPE thread_starter AS ENUM ('agent', 'external');

CREATE TABLE threads (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id            char(32) NOT NULL REFERENCES agents (id) ON DELETE RESTRICT,
  started_by          thread_starter NOT NULL,
  -- 에이전트 스레드: 에이전트 발신 주소. 외부 스레드: 첫 inbound 의 From.
  -- 왜 NULL 을 허용하는가: 이 마이그레이션 이전의 발송 행은 발신 주소를 해시로만 남겼다
  --   (`messages.from_address_hash`). 그 행들을 위해 만드는 스레드(아래 백필)는 평문을 복원할 수 없다.
  --   **새 행은 항상 채운다** — 저장소 코드가 NULL 을 쓰는 경로가 없다.
  starter_address     text CHECK (
                        starter_address IS NULL
                        OR (starter_address = lower(starter_address) AND starter_address ~ '^[^@[:space:]]+@[^@[:space:]]+$')
                      ),
  -- **표시용.** `normalizeSubject()` 의 결과. 제목 폴백(표시 전용)만 이 값을 읽는다 — 권한 판정은
  --   절대 읽지 않는다(resolve.ts: `authority.matchedBy` 에 'subject' 가 들어갈 자리가 없다).
  subject_normalized  text CHECK (subject_normalized IS NULL OR length(subject_normalized) <= 998),
  created_at          timestamptz NOT NULL DEFAULT now(),
  last_message_at     timestamptz NOT NULL DEFAULT now(),

  -- 왜 (id, agent_id) 유니크가 따로 있는가: 메시지 쪽이 **복합 FK** 로 이 쌍을 참조한다.
  --   thread_id 만 참조하면 에이전트 A 의 메시지를 에이전트 B 의 스레드에 붙이는 행이 합법이다 —
  --   resolve.ts 가 코드로 거르는 "범위 밖 에이전트의 행" 을 DB 가 한 번 더 막는다.
  CONSTRAINT threads_id_agent_key UNIQUE (id, agent_id)
);

-- 핸드오프 요구 인덱스 둘. 제목 폴백(표시 전용)과 최근 스레드 목록.
CREATE INDEX threads_agent_subject_idx ON threads (agent_id, subject_normalized) WHERE subject_normalized IS NOT NULL;
CREATE INDEX threads_agent_last_message_idx ON threads (agent_id, last_message_at DESC);

-- 왜 allow-list 인가: 스레드의 정체(누구 것인가·누가 열었나)가 바뀌면 그 스레드에 쌓인 권한이
--   다른 곳으로 옮겨 간다. 바뀌어도 되는 것은 "마지막 메시지 시각" 하나뿐이고, 나중에 추가되는
--   컬럼의 기본도 불변이다(reject_column_update_except).
CREATE TRIGGER threads_immutable_except_activity
  BEFORE UPDATE ON threads
  FOR EACH ROW EXECUTE FUNCTION reject_column_update_except('last_message_at');

-- ---------------------------------------------------------------------------
-- messages.thread_id — P1a 가 FK 없이 남겨 둔 컬럼 (202609221420 주석: "P3 마이그레이션이 FK 를 추가한다")
-- ---------------------------------------------------------------------------

-- 백필: 이전 발송 행마다 에이전트 스레드 하나. **스레드 id = 메시지 id** — 매핑 테이블 없이 행을
--   짝지을 수 있는 가장 단순한 규칙이다(두 테이블의 uuid 가 겹쳐도 충돌하지 않는다).
--   이전 행은 수신자를 남기지 않았으므로(아래 outbound_recipients 가 없었다) 이 스레드로는 어떤
--   회신도 권한 연결을 얻지 못한다 — 안전한 방향이다(resolve.ts: 수신자에 없으면 `new`).
INSERT INTO threads (id, agent_id, started_by, starter_address, subject_normalized, created_at, last_message_at)
SELECT m.id, m.agent_id, 'agent', NULL, NULL, m.created_at, m.created_at
  FROM messages m
 WHERE m.thread_id IS NULL AND m.direction = 'outbound';

UPDATE messages SET thread_id = id WHERE thread_id IS NULL AND direction = 'outbound';

ALTER TABLE messages
  ADD CONSTRAINT messages_thread_fkey
  FOREIGN KEY (thread_id, agent_id) REFERENCES threads (id, agent_id) ON DELETE RESTRICT;

-- 왜: 발송 행은 태어날 때 스레드를 갖는다(`outbound-store.ts` 가 같은 트랜잭션에서 만든다).
--   스레드 없는 발송 행은 그 수신자의 회신을 어디에도 잇지 못하게 하고, 나중에 누군가 "빈 칸이니
--   채우자" 로 아무 스레드에 붙이는 UPDATE 를 부른다 — 아래 불변 트리거가 그 UPDATE 를 막으므로
--   빈 칸 자체를 없앤다.
ALTER TABLE messages
  ADD CONSTRAINT messages_outbound_has_thread CHECK (direction <> 'outbound' OR thread_id IS NOT NULL);

-- 왜: 이미 나간 메일을 다른 스레드로 옮기면 그 수신자들이 다른 스레드의 참여자가 된다.
CREATE TRIGGER messages_thread_immutable
  BEFORE UPDATE ON messages
  FOR EACH ROW EXECUTE FUNCTION reject_column_update('thread_id');

-- ---------------------------------------------------------------------------
-- outbound_recipients — 보낸 메일의 수신자 전원
-- ---------------------------------------------------------------------------

-- 왜 이 테이블이 필요한가 (핸드오프 ⚠):
--   스레드 권한 판정은 "회신자가 원 메일의 **수신자**였는가" 를 묻는다(resolve.ts 강한 증거 1).
--   `messages` 에는 `recipient_count`(기수) 뿐이라 그 질문에 답할 수 없었다. id 는 비밀이 아니므로
--   (수신자에게 보이고 전달되면 제3자에게도 보인다) 수신자 대조 없이 id 만으로 스레드에 들이면
--   "id 를 아는 사람 = 참여자" 가 된다.
--
-- 왜 주소 평문인가 (202609221440 이 "주소가 아니라 개수" 라고 쓴 것과의 관계):
--   그때 요구는 **워밍업 캡의 눈금**이었고 개수로 충분했다. 지금 요구는 **대조**이고 개수로는
--   불가능하다. 해시로는 대조가 되지만 소유자 화면·승인 요청(approval_request_items)이 이미 평문을
--   쓰며, 해시는 여기서 보호하는 것이 없다(에이전트가 보낸 상대 주소는 그 에이전트 소유자의 데이터다).
--   PRD 가 금지한 것은 **원문·본문**이다 — 이 테이블에 본문성 컬럼이 없음을 스키마 테스트가 단언한다.
--
-- 왜 To/Cc/Bcc 구분이 없는가: 발송 API 가 그 구분을 받지 않는다(`OutboundSendRequest.recipients`
--   하나). 없는 구분을 만들어 넣으면 거짓이 된다. API 가 구분을 받는 날 컬럼을 더한다.
CREATE TABLE outbound_recipients (
  message_id  uuid NOT NULL REFERENCES messages (id) ON DELETE RESTRICT,
  address     text NOT NULL CHECK (address = lower(address) AND address ~ '^[^@[:space:]]+@[^@[:space:]]+$'),
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (message_id, address)
);

-- 제목 폴백(표시 전용)의 "이 상대가 참여한 스레드" 조회.
CREATE INDEX outbound_recipients_address_idx ON outbound_recipients (address);

-- 왜 append-only 인가: 수신자 집합은 `request_hash` 의 일부이고 이미 나간 사실이다. 바꾸면
--   "그 사람은 원 메일의 수신자였다" 가 사후에 참이 된다 — 스레드 권한을 사후에 발급하는 것이다.
CREATE TRIGGER outbound_recipients_no_update
  BEFORE UPDATE ON outbound_recipients
  FOR EACH ROW EXECUTE FUNCTION reject_row_update();
CREATE TRIGGER outbound_recipients_no_delete
  BEFORE DELETE ON outbound_recipients
  FOR EACH ROW EXECUTE FUNCTION reject_row_delete();

-- 앱 롤 권한. UPDATE 가 threads 에만 있는 것은 last_message_at 때문이다(트리거가 나머지를 막는다).
GRANT SELECT, INSERT, UPDATE ON threads TO atmark_app;
GRANT SELECT, INSERT ON outbound_recipients TO atmark_app;

COMMENT ON TABLE outbound_recipients IS
  '보낸 메일의 수신자 전원(주소). 스레드 권한 판정("회신자가 원 메일의 수신자인가")의 유일한 근거. append-only.';
COMMENT ON COLUMN messages.thread_id IS
  '권한용 스레드. outbound 는 NOT NULL(CHECK), (thread_id, agent_id) 복합 FK, 설정 후 불변(트리거).';
