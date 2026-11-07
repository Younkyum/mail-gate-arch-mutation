-- 202609222410_inbound_messages.sql
-- P3a — 수신 메일 메타 (계획 §6 P3 "원문 S3 저장 + 메타만 Postgres", AC-3·AC-4, GATE B2③)
--
-- **원문·본문은 여기 없다(PRD).** 원문은 SES receipt rule 이 S3 `inbound/raw/{sesMessageId}` 에
-- 쓰고, 파싱 결과(본문 텍스트 포함)는 소비자가 S3 `inbound/parsed/{sesMessageId}.json` 에 쓴다.
-- 이 파일의 테이블은 그 두 **키**와 판정 메타만 갖는다. 컬럼 집합은 스키마 테스트가 **동일**로
-- 단언한다(부분집합이 아니라 — 잡으려는 사고가 "본문 컬럼이 늘어나는 것" 이기 때문이다).
--
-- 왜 `messages` 가 아니라 별도 테이블인가 (핸드오프 ⚠):
--   `messages_message_id_header_key` 는 **전역 UNIQUE** 다. 발신 id 는 우리가 만들지만 수신 id 는
--   외부인이 정한다 — 같은 id 로 두 번 보내거나, 우리 발신 id 를 베껴 보내면 INSERT 가 죽는다
--   (poison pill). 그리고 `messages` 의 상태기계·lease·멱등 키 CHECK 전부가 수신에는 의미가 없다.

-- ---------------------------------------------------------------------------
-- 열거형
-- ---------------------------------------------------------------------------

-- SES receipt 판정(`receipt.{spf,dkim,dmarc,spam,virus}Verdict.status`)의 소문자형.
-- 'unknown' = 필드가 없거나 모르는 값. **통과로 읽지 않는다.**
CREATE TYPE ses_verdict AS ENUM ('pass', 'fail', 'gray', 'processing_failed', 'disabled', 'unknown');

-- ---------------------------------------------------------------------------
-- inbound_messages
-- ---------------------------------------------------------------------------

CREATE TABLE inbound_messages (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- **봉투 수신자(SES receipt.recipients)로 정한 에이전트.** 헤더 To 가 아니다 — To 는 발신자가
  --   마음대로 쓰고 Bcc 수신이면 에이전트 주소가 아예 없다.
  agent_id              char(32) NOT NULL REFERENCES agents (id) ON DELETE RESTRICT,
  -- 이 에이전트를 결정한 봉투 수신 주소(agent_addresses.address 와 같은 값).
  envelope_recipient    text NOT NULL CHECK (envelope_recipient = lower(envelope_recipient) AND envelope_recipient ~ '^[^@[:space:]]+@[^@[:space:]]+$'),
  -- SES 메시지 ID. 멱등성의 키이자 원문 객체 키의 마지막 세그먼트.
  ses_message_id        text NOT NULL CHECK (ses_message_id ~ '^[A-Za-z0-9][A-Za-z0-9._=-]{0,254}$'),

  -- ---- 스레드 (resolve.ts) ----------------------------------------------
  -- **권한용.** 정책(reply_only·스레드 내 회신 면제)이 읽는 값. 강한 증거로만 기존 스레드에 잇는다.
  thread_id             uuid NOT NULL,
  -- **표시용. 정책은 절대 읽지 않는다.** 검증 안 된 헤더 매칭·제목 폴백도 여기는 쓴다.
  display_thread_id     uuid,
  -- 권한용 연결의 근거. 셋이 함께 있거나 함께 없다(아래 CHECK).
  matched_by            text CHECK (matched_by IS NULL OR matched_by IN ('message_id_header', 'ses_message_id')),
  -- 근거가 된 우리 쪽 행. `messages.id` 또는 `inbound_messages.id` — 어느 쪽인지는 matched_direction.
  --   FK 를 걸 수 없다(대상 테이블이 둘이다). 권한의 감사 흔적이지 조인 키가 아니다.
  matched_message_id    uuid,
  matched_direction     message_direction,
  -- 권한 연결이 없을 때의 이유(resolve.ts `NewThreadReason`). 감사·디버깅용.
  new_thread_reason     text CHECK (
                          new_thread_reason IS NULL
                          OR new_thread_reason IN ('no_header_ids', 'no_known_message', 'sender_unauthenticated',
                                                   'sender_unparseable', 'sender_not_participant')
                        ),

  -- ---- 헤더 메타 -----------------------------------------------------------
  -- `<local@lowercased-domain>`. 외부가 정하므로 **유니크가 아니다**(에이전트 범위 인덱스만).
  message_id_header     text CHECK (message_id_header IS NULL OR message_id_header ~ '^<[^<>[:space:]]+@[^<>[:space:]]+>$'),
  in_reply_to           text CHECK (in_reply_to IS NULL OR in_reply_to ~ '^<[^<>[:space:]]+@[^<>[:space:]]+>$'),
  -- 헤더 From 의 주소(소문자). 회신 대상 계산·스레드 발신자 대조·Sender Trust(P4)가 읽는다.
  from_address          text NOT NULL CHECK (from_address = lower(from_address) AND from_address ~ '^[^@[:space:]]+@[^@[:space:]]+$'),
  from_domain           text NOT NULL,
  -- **DMARC 통과만이 인증이다.** 아래 CHECK 가 그 문장을 DB 에 새긴다 — SPF·DKIM 단독 통과는
  --   From 을 인증하지 않는다(SPF 는 봉투 발신자, DKIM 은 서명 도메인을 본다. 정렬은 DMARC 의 일이다).
  from_authenticated    boolean NOT NULL,
  subject               text CHECK (subject IS NULL OR length(subject) <= 998),
  header_date           timestamptz,
  -- RFC 3834 Auto-Submitted ≠ no, X-Autoreply, Precedence: bulk|junk|list|auto_reply. 턴 계산에서 빠진다(turns.ts).
  auto_submitted        boolean NOT NULL,

  -- ---- GATE B2③ forwarded_from_human_mailbox 의 원자료 -----------------------
  -- 봉투 발신자(SMTP MAIL FROM = SES `mail.source` = Return-Path). Gmail 자동 전달은 이것을
  --   **전달자 주소**(`owner+caf_=agent=atmark.ai@gmail.com` 꼴)로 재작성하고 헤더 From 은 보존한다.
  --   판정식(P4 확정)은 이 값과 from_address 를 함께 본다. 널 발신자(`<>`, 반송)는 NULL.
  --   **정규화하지 않는다** — `+caf_=` 꼬리를 어떻게 읽을지는 판정식의 일이고, 여기서 잘라 두면 되돌릴 수 없다.
  envelope_sender       text CHECK (envelope_sender IS NULL OR (length(envelope_sender) BETWEEN 1 AND 998 AND envelope_sender !~ '[[:cntrl:]]')),
  -- Gmail 전달 흔적 헤더 원문(첫 번째 값, 제어문자 제거, 998자 상한). **발신자가 쓸 수 있는 값이다** —
  --   판정의 단독 근거가 아니라 보조 신호다.
  forwarded_for_header  text CHECK (forwarded_for_header IS NULL OR length(forwarded_for_header) <= 998),
  forwarded_to_header   text CHECK (forwarded_to_header IS NULL OR length(forwarded_to_header) <= 998),

  -- ---- SES 판정 ------------------------------------------------------------
  spf_verdict           ses_verdict NOT NULL,
  dkim_verdict          ses_verdict NOT NULL,
  dmarc_verdict         ses_verdict NOT NULL,
  spam_verdict          ses_verdict NOT NULL,
  virus_verdict         ses_verdict NOT NULL,
  -- SES 가 알림에 헤더를 다 싣지 못했다(auto_submitted·전달 헤더가 빠졌을 수 있다).
  headers_truncated     boolean NOT NULL,

  -- ---- S3 키 (본문·원문은 여기만) -----------------------------------------------
  raw_storage_key       text NOT NULL CHECK (raw_storage_key = 'inbound/raw/' || ses_message_id),
  parsed_storage_key    text NOT NULL CHECK (parsed_storage_key = 'inbound/parsed/' || ses_message_id || '.json'),
  text_source           text NOT NULL CHECK (text_source IN ('plain', 'html', 'none')),
  has_html_text         boolean NOT NULL,
  attachment_count      integer NOT NULL CHECK (attachment_count >= 0),

  received_at           timestamptz NOT NULL,
  created_at            timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT inbound_messages_from_domain_matches CHECK (from_domain = split_part(from_address, '@', 2)),

  -- ★ `fromAuthenticated` 는 DMARC 에서만 온다. 코드가 SPF 나 DKIM 으로 true 를 만들면 INSERT 가 죽는다.
  CONSTRAINT inbound_messages_authentication_is_dmarc CHECK (NOT from_authenticated OR dmarc_verdict = 'pass'),

  -- 권한 연결의 근거는 셋이 한 벌이고, 없을 때는 이유가 있다. 둘이 동시에 있을 수 없다.
  CONSTRAINT inbound_messages_match_shape CHECK (
    (matched_by IS NOT NULL AND matched_message_id IS NOT NULL AND matched_direction IS NOT NULL AND new_thread_reason IS NULL)
    OR (matched_by IS NULL AND matched_message_id IS NULL AND matched_direction IS NULL AND new_thread_reason IS NOT NULL)
  ),
  -- 권한 연결은 인증된 발신자에게만 있다(resolve.ts 강한 증거). 해석기가 뒤집혀도 DB 가 막는다.
  CONSTRAINT inbound_messages_match_requires_authentication CHECK (matched_by IS NULL OR from_authenticated),

  -- 스레드는 같은 에이전트의 것이어야 한다(복합 FK — threads_id_agent_key).
  CONSTRAINT inbound_messages_thread_fkey
    FOREIGN KEY (thread_id, agent_id) REFERENCES threads (id, agent_id) ON DELETE RESTRICT,
  CONSTRAINT inbound_messages_display_thread_fkey
    FOREIGN KEY (display_thread_id, agent_id) REFERENCES threads (id, agent_id) ON DELETE RESTRICT
);

-- ★ 멱등성. SNS/SQS 는 at-least-once 다. 같은 SES 메시지는 에이전트당 한 행이다 — 한 통이 봉투
--   수신자 둘(에이전트 둘)에게 가면 행 둘이다. 애플리케이션 선조회가 아니라 이 인덱스가 집행한다.
CREATE UNIQUE INDEX inbound_messages_agent_ses_message_key ON inbound_messages (agent_id, ses_message_id);

-- 스레드 해석 조회(핸드오프 "조회 인덱스"): 에이전트 범위의 헤더 id 역조회.
CREATE INDEX inbound_messages_agent_message_id_idx
  ON inbound_messages (agent_id, message_id_header) WHERE message_id_header IS NOT NULL;
CREATE INDEX inbound_messages_thread_received_idx ON inbound_messages (thread_id, received_at);
CREATE INDEX inbound_messages_agent_received_idx ON inbound_messages (agent_id, received_at DESC);
-- 제목 폴백의 "이 상대가 참여한 스레드".
CREATE INDEX inbound_messages_agent_from_idx ON inbound_messages (agent_id, from_address);

-- 왜 allow-list 인가: 권한용 thread_id·판정·S3 키는 **받은 사실**이다. 바뀌면 이 메일이 다른 스레드의
--   권한을 얻거나 증거가 다른 객체를 가리킨다. 표시 묶음만 사후에 바뀔 수 있다.
CREATE TRIGGER inbound_messages_immutable_except_display
  BEFORE UPDATE ON inbound_messages
  FOR EACH ROW EXECUTE FUNCTION reject_column_update_except('display_thread_id');

-- ---------------------------------------------------------------------------
-- inbound_attachments
-- ---------------------------------------------------------------------------

CREATE TABLE inbound_attachments (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  inbound_message_id  uuid NOT NULL REFERENCES inbound_messages (id) ON DELETE RESTRICT,
  -- 파서의 `ParsedAttachment.index` — 원문 속 등장 순서. **저장 키는 이것으로 만든다.**
  part_index          integer NOT NULL CHECK (part_index >= 0),
  -- **표시 전용.** 경로 문자(`/`·`\`·`..`)가 그대로 있을 수 있다 — 키로 쓰지 않는다.
  filename            text CHECK (filename IS NULL OR length(filename) <= 1000),
  -- 발신자가 선언한 값. 내용과 일치한다는 보장은 없다.
  content_type        text NOT NULL CHECK (length(content_type) BETWEEN 1 AND 255),
  disposition         text CHECK (disposition IS NULL OR disposition IN ('attachment', 'inline')),
  size_bytes          bigint NOT NULL CHECK (size_bytes >= 0),
  content_id          text CHECK (content_id IS NULL OR length(content_id) <= 998),
  -- `inbound/attachments/{sesMessageId}/{part_index}` — 파일명이 아니다.
  storage_key         text NOT NULL CHECK (storage_key ~ '^inbound/attachments/[A-Za-z0-9][A-Za-z0-9._=-]*/[0-9]+$'),
  -- 디코딩된 바이트의 sha256. AC-4 "첨부 체크섬 일치" 의 우리 쪽 절반.
  sha256              text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  created_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT inbound_attachments_part_key UNIQUE (inbound_message_id, part_index)
);

CREATE TRIGGER inbound_attachments_no_update
  BEFORE UPDATE ON inbound_attachments
  FOR EACH ROW EXECUTE FUNCTION reject_row_update();

-- ---------------------------------------------------------------------------
-- inbound_rejections — 저장하지 않은 수신의 결말
-- ---------------------------------------------------------------------------

-- 왜 이 테이블이 있는가: 소비자는 파싱 거부·알 수 없는 수신자·바이러스를 **던지지 않고**(poison pill)
--   결말로 기록한다. 기록이 없으면 "메일이 안 왔다" 와 "왔는데 버렸다" 가 구분되지 않는다 —
--   Gmail 전달 확인 메일(런북 3단계)이 안 보일 때 가장 먼저 물을 질문이 그것이다.
--   **내용은 싣지 않는다.** 봉투 수신 주소(우리 도메인)와 판정·이유 코드뿐. 조사는 S3 원문으로 한다.
CREATE TABLE inbound_rejections (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ses_message_id        text NOT NULL CHECK (ses_message_id ~ '^[A-Za-z0-9][A-Za-z0-9._=-]{0,254}$'),
  reason                text NOT NULL CHECK (reason IN ('unknown_recipient', 'virus', 'mime_rejected', 'raw_too_large')),
  -- 파서 거부 사유 코드 등. 메일 내용 금지 — 코드·숫자만(파서 `MimeParseResult.detail` 은 싣지 않는다).
  detail                text CHECK (detail IS NULL OR length(detail) <= 200),
  -- 이 결말에 해당하는 봉투 수신 주소(우리 도메인). unknown_recipient 면 에이전트가 없던 주소들.
  envelope_recipients   text[] NOT NULL,
  virus_verdict         ses_verdict NOT NULL,
  spam_verdict          ses_verdict NOT NULL,
  raw_storage_key       text NOT NULL CHECK (raw_storage_key = 'inbound/raw/' || ses_message_id),
  received_at           timestamptz NOT NULL,
  created_at            timestamptz NOT NULL DEFAULT now()
);

-- 멱등성 — 같은 SES 메시지의 같은 결말은 한 행.
CREATE UNIQUE INDEX inbound_rejections_ses_reason_key ON inbound_rejections (ses_message_id, reason);

CREATE TRIGGER inbound_rejections_no_update
  BEFORE UPDATE ON inbound_rejections
  FOR EACH ROW EXECUTE FUNCTION reject_row_update();

GRANT SELECT, INSERT, UPDATE ON inbound_messages TO atmark_app;
GRANT SELECT, INSERT ON inbound_attachments TO atmark_app;
GRANT SELECT, INSERT ON inbound_rejections TO atmark_app;

COMMENT ON TABLE inbound_messages IS
  '수신 메일 메타. 원문(inbound/raw/)·본문(inbound/parsed/*.json)은 S3 키로만 참조한다 (PRD). 컬럼 집합은 스키마 테스트가 동일로 단언.';
