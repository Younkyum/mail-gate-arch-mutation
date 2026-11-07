-- 202609270130_outbound_attachments.sql
-- (계획 §5 의 번호는 0100 이었다 — D6·A6(0105~0120)가 먼저 커밋·적용됐으므로 뒤 번호로 옮겼다. 파일명 순서 = 적용 순서.)
-- 메일 기본기 2차 A2 — **발신 첨부**(`.omc/plans/mail-basics.md` §4 A2 · §5, 진윤겸 결정 D8 "새 메일·답장만", ADR-0013 2차 절).
--
--   ① `outbound_attachments` — 업로드 한 건(에이전트 · 파일명 · MIME · 선언 크기 · SHA-256 · 스테이징 키 · 만료). **본문 바이트는 여기 없다**
--      (S3 `outbound/uploads/{agentId}/{attachmentId}`). 행은 불변이다(고치기·지우기·비우기 거부) — 선언값은 서명된 PUT 의 헤더(크기·체크섬·
--      타입)에 박혀 S3 가 같은 값만 받는다. 스테이징 객체는 2일 뒤 수명주기가 지우고(행은 남는다 — 만료 시각이 판정한다).
--      MIME 은 서명표(pdf · png · jpeg · text/plain)만, `text/plain` 은 1 MiB 이하, 한 파일은 천장 25 MiB 이하(요금제 값은 앱이 먼저 끊는다).
--   ② `message_attachments` — 발송 한 통의 첨부 결속(메시지 · 자리 0~9 · 업로드 id · 영구 키 `outbound/attachments/{messageId}/{position}`).
--      발송 준비가 스테이징 → 영구 복사 뒤 같은 요청 안에서 적는다. 승인 릴리스는 이 행으로 Stage 6 메타를 다시 만든다. 불변.
--   ③ 하루 업로드 천장(트리거 `outbound_attachments_daily_ceiling`) — 에이전트당 24시간 **100개 · 200 MiB**. 앱(`src/api/outbound-attachments.ts`)이
--      같은 잠금 키(`outbound_attachments:<agent>`) 아래에서 먼저 세고 429 를 낸다 — 이 트리거는 그 검사가 빠져도 넘지 못하는 바닥이다.
--   ④ 권한 — 앱 롤 SELECT·INSERT 만(두 표). admin·다른 롤 0.
--
-- 투명성 로그: 두 표는 잎의 원천이 아니다 — 발송 시도의 판정은 audit_logs 잎이고, 첨부 메타(총량·MIME)는 Stage 6 의 입력일 뿐이다
-- (`test/arch/transparency-log.arch.test.ts` 제외 목록에 사유를 적는다).
-- 잠금: 새 표 둘 · `agents`·`messages` 를 REFERENCES(짧은 SHARE ROW EXCLUSIVE). 5초 안에 못 잡으면 실패하고 아무것도 바뀌지 않는다.
-- 롤백 호환: 옛 코드는 두 표를 모른다(첨부 없는 발송은 그대로). 기능 플래그 `ATMARK_OUTBOUND_ATTACHMENTS_ENABLED` 가 꺼져 있으면 행이 생기지 않는다.

SET LOCAL lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- ① outbound_attachments
-- ---------------------------------------------------------------------------

CREATE TABLE outbound_attachments (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id     char(32) NOT NULL REFERENCES agents (id) ON DELETE RESTRICT,
  -- 에이전트가 정한 파일명 — 제어문자·경로 구분자 없음, 255 코드포인트 이하. MIME 헤더에는 RFC 2231 로 인코딩해 싣는다.
  filename     text NOT NULL,
  mime_type    text NOT NULL,
  bytes        integer NOT NULL,
  -- 선언 SHA-256(hex 소문자) — 서명된 PUT 의 `x-amz-checksum-sha256`(base64)과 같은 값. S3 가 다른 바이트를 `BadDigest` 로 거부한다.
  sha256       text NOT NULL,
  staging_key  text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  CONSTRAINT outbound_attachments_filename_check CHECK (
    char_length(filename) BETWEEN 1 AND 255 AND filename !~ '[[:cntrl:]]' AND filename !~ '[/\\]' AND filename !~ '^[.]+$'),
  CONSTRAINT outbound_attachments_mime_type_check CHECK (mime_type IN ('application/pdf', 'image/png', 'image/jpeg', 'text/plain')),
  CONSTRAINT outbound_attachments_bytes_check CHECK (
    bytes BETWEEN 1 AND 26214400 AND (mime_type <> 'text/plain' OR bytes <= 1048576)),
  CONSTRAINT outbound_attachments_sha256_check CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT outbound_attachments_staging_key_check CHECK (staging_key = 'outbound/uploads/' || agent_id || '/' || id::text),
  CONSTRAINT outbound_attachments_staging_key_key UNIQUE (staging_key),
  CONSTRAINT outbound_attachments_expiry_check CHECK (expires_at > created_at AND expires_at <= created_at + interval '2 days')
);

CREATE INDEX outbound_attachments_agent_created_idx ON outbound_attachments (agent_id, created_at DESC);

-- 시각은 DB 가 적는다(하루 천장이 꾸민 시각으로 창 밖에 숨지 못한다) · 만료는 생성 + 2일 이하(CHECK).
CREATE FUNCTION outbound_attachments_stamp() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.created_at := now();
  IF NEW.expires_at > NEW.created_at + interval '2 days' THEN
    NEW.expires_at := NEW.created_at + interval '2 days';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER outbound_attachments_stamp BEFORE INSERT ON outbound_attachments
  FOR EACH ROW EXECUTE FUNCTION outbound_attachments_stamp();
CREATE TRIGGER outbound_attachments_no_update BEFORE UPDATE ON outbound_attachments
  FOR EACH ROW EXECUTE FUNCTION reject_row_update();
CREATE TRIGGER outbound_attachments_no_delete BEFORE DELETE ON outbound_attachments
  FOR EACH ROW EXECUTE FUNCTION reject_row_delete();
CREATE TRIGGER outbound_attachments_no_truncate BEFORE TRUNCATE ON outbound_attachments
  FOR EACH STATEMENT EXECUTE FUNCTION reject_truncate();

-- ③ 하루 천장 — 앱과 같은 잠금 키. 이름 순서: daily(d) → stamp(s) 이므로 시각은 트리거 안에서 now() 로 직접 쓴다.
CREATE FUNCTION outbound_attachments_daily_ceiling() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  uploads integer;
  total bigint;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('outbound_attachments:' || NEW.agent_id, 0));
  SELECT count(*), coalesce(sum(a.bytes), 0) INTO uploads, total
    FROM public.outbound_attachments a
   WHERE a.agent_id = NEW.agent_id AND a.created_at > now() - interval '24 hours';
  IF uploads >= 100 THEN
    RAISE EXCEPTION 'outbound_attachments: agent % already uploaded % attachments in 24 hours (max 100)', NEW.agent_id, uploads
      USING ERRCODE = '23514';
  END IF;
  IF total + NEW.bytes > 209715200 THEN
    RAISE EXCEPTION 'outbound_attachments: agent % would exceed 200 MiB of uploads in 24 hours', NEW.agent_id
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER outbound_attachments_daily_ceiling BEFORE INSERT ON outbound_attachments
  FOR EACH ROW EXECUTE FUNCTION outbound_attachments_daily_ceiling();

COMMENT ON TABLE outbound_attachments IS
  '발신 첨부 업로드(A2, ADR-0013) — 메타만(바이트는 S3 outbound/uploads/). 불변 · 에이전트당 24시간 100개·200 MiB.';

-- ---------------------------------------------------------------------------
-- ② message_attachments
-- ---------------------------------------------------------------------------

CREATE TABLE message_attachments (
  message_id     uuid NOT NULL REFERENCES messages (id) ON DELETE RESTRICT,
  position       smallint NOT NULL CHECK (position BETWEEN 0 AND 9),
  attachment_id  uuid NOT NULL REFERENCES outbound_attachments (id) ON DELETE RESTRICT,
  permanent_key  text NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT message_attachments_pkey PRIMARY KEY (message_id, position),
  CONSTRAINT message_attachments_attachment_once UNIQUE (message_id, attachment_id),
  CONSTRAINT message_attachments_permanent_key_check CHECK (permanent_key = 'outbound/attachments/' || message_id::text || '/' || position::text)
);

CREATE TRIGGER message_attachments_no_update BEFORE UPDATE ON message_attachments
  FOR EACH ROW EXECUTE FUNCTION reject_row_update();
CREATE TRIGGER message_attachments_no_delete BEFORE DELETE ON message_attachments
  FOR EACH ROW EXECUTE FUNCTION reject_row_delete();
CREATE TRIGGER message_attachments_no_truncate BEFORE TRUNCATE ON message_attachments
  FOR EACH STATEMENT EXECUTE FUNCTION reject_truncate();

-- 같은 에이전트의 업로드만 결속한다 — 남의 첨부 id 를 적어 그 바이트를 내 메일에 싣지 못한다(앱이 먼저 404 로 본다).
CREATE FUNCTION message_attachments_same_agent() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.messages m JOIN public.outbound_attachments a ON a.agent_id = m.agent_id
     WHERE m.id = NEW.message_id AND a.id = NEW.attachment_id
  ) THEN
    RAISE EXCEPTION 'message_attachments: 첨부 % 는 메시지 % 의 에이전트 것이 아니다', NEW.attachment_id, NEW.message_id USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER message_attachments_same_agent BEFORE INSERT ON message_attachments
  FOR EACH ROW EXECUTE FUNCTION message_attachments_same_agent();

COMMENT ON TABLE message_attachments IS
  '발송 한 통의 첨부 결속(A2) — 영구 키 outbound/attachments/{messageId}/{position}. 불변. 릴리스가 Stage 6 메타를 여기서 다시 만든다.';

-- ---------------------------------------------------------------------------
-- ④ 권한 — 허용 목록 `RESTRICTED_ROLE_GRANTS`(앱 롤). 다른 제한 롤은 0.
-- ---------------------------------------------------------------------------

REVOKE ALL ON outbound_attachments FROM PUBLIC;
REVOKE ALL ON message_attachments FROM PUBLIC;
GRANT SELECT, INSERT ON outbound_attachments TO atmark_app;
GRANT SELECT, INSERT ON message_attachments TO atmark_app;
