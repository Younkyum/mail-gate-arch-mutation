-- 202610081200_drafts_labels.sql
-- 개발자 표면(묶음 B — docs/internal/plans/watch-and-dev-surface.md): **초안** · **라벨 · 읽음** · **첨부 업로드 중복 방지 키**.
--
--   ① `drafts` — 에이전트별 초안. 받는 사람 · 제목 · 발신 주소 · 답장 대상 · 첨부 id 만 Postgres 에 두고, **본문(text · html)은 S3**
--      `outbound/drafts/{id}/{revision}.json` 에 둔다(본문은 Postgres 에 없다 — `scheduled_sends` 와 같은 규율). 고칠 때마다 판(revision)이
--      오르고 새 객체를 쓴다(write-once — 옛 판은 덮이지 않는다). **지우지 않는다** — 버리기는 `discarded_at` 하나(소프트). 보낸 초안은
--      `sent_message_id` 가 서고 그 뒤로 바뀌지 않는다(트리거). 보내는 중(키를 잡은 뒤)에도 내용은 바뀌지 않는다 — 판정한 내용과 나가는
--      내용이 갈라지지 않게. 발송은 `POST /v1/drafts/{id}/send`(매니페스트 `draft_send`) — `send`·`reply` 와 같은 관문 · DLP 를 지난다.
--      에이전트당 살아 있는 초안(버리지도 보내지도 않은 것) 500 개까지(트리거 — 에이전트 잠금).
--   ② `inbound_message_state` — 받은 메일 한 통의 **에이전트 상태**: 라벨(소문자 `[a-z0-9][a-z0-9._-]{0,63}` · 메일당 20) · 처음 읽은
--      시각(`first_read_at` — 상세 조회가 적는다, 앞으로만). 행은 메일당 하나(PK). 지우지 않는다 — 라벨을 다 떼면 빈 배열이다. 에이전트당
--      서로 다른 라벨 200 개 상한은 앱이 에이전트 잠금 아래 본다(`message-state-store.ts`). 라벨 목록 · 필터는 **보이는 메일만** 센다.
--   ③ `outbound_attachments.idempotency_key` · `request_hash` — `POST /v1/attachments` 의 선택 헤더 `Idempotency-Key`(같은 키 + 같은 요청 →
--      같은 첨부 id, 다른 요청 → 409 `idempotency_key_reused`). 모양 CHECK 는 NOT VALID(검증 202610081201), 에이전트별 UNIQUE 는 비트랜잭션
--      202610081202.
--
-- 권한(앱 롤 — `RESTRICTED_ROLE_GRANTS`): 초안 SELECT · INSERT · 고칠 칸 UPDATE · 상태 SELECT · INSERT · UPDATE(labels · first_read_at ·
-- updated_at). DELETE 0(두 표 모두 트리거도 막는다).
-- 잠금: 새 표 둘 · `outbound_attachments` ADD COLUMN(NULL 기본 — 표를 다시 쓰지 않는다) · ADD CONSTRAINT NOT VALID(짧은 ACCESS EXCLUSIVE).
-- 5초 안에 못 잡으면 실패한다.
-- **순서:** 터널 migrate(1200 · 1201 · 1202) → `deploy-compute migrate=false`. 옛 코드는 새 표 · 칸을 모른다(expand-only).

SET LOCAL lock_timeout = '5s';

DO $$
DECLARE
  missing text;
BEGIN
  SELECT string_agg(name, ', ') INTO missing
    FROM unnest(ARRAY['atmark_admin', 'atmark_app']) AS name
   WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = name);
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION 'role % does not exist — migrate 핸들러의 bootstrap-roles 를 먼저 돌려라', missing;
  END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- ① drafts
-- ---------------------------------------------------------------------------

CREATE TABLE drafts (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id             char(32) NOT NULL REFERENCES agents (id) ON DELETE RESTRICT,
  revision             integer NOT NULL DEFAULT 1 CHECK (revision BETWEEN 1 AND 100000),
  -- 발신 주소(정규형 — 소문자 · `+tag` 없음은 앱이 본다). NULL = 보낼 때 정한다(답장은 받은 주소 · 대표).
  from_address         text CHECK (from_address IS NULL OR (from_address = lower(from_address) AND length(from_address) <= 320
                                   AND from_address ~ '^[^@[:space:]]+@[^@[:space:]]+$')),
  recipients           text[] NOT NULL DEFAULT '{}'
                         CHECK (cardinality(recipients) <= 50 AND array_to_string(recipients, ' ') !~ '[[:cntrl:]]'),
  subject              text CHECK (subject IS NULL OR length(subject) <= 998),
  -- 답장 초안이면 답하는 받은 메일. 보낼 때 그 메일의 권한용 스레드로 답한다(`reply` 와 같은 경로).
  in_reply_to          uuid REFERENCES inbound_messages (id) ON DELETE RESTRICT,
  attachment_ids       uuid[] NOT NULL DEFAULT '{}' CHECK (cardinality(attachment_ids) <= 10),
  -- 본문 객체 — **id · 판에서 유도된 값만**(다른 초안의 본문을 가리킬 수 없다).
  content_storage_key  text NOT NULL,
  content_bytes        integer NOT NULL CHECK (content_bytes BETWEEN 0 AND 10485760),
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  discarded_at         timestamptz,
  -- 보내기: 키를 잡으면(`send_idempotency_key`) 내용이 굳고, 관문이 평가한 뒤 `sent_message_id` 가 선다.
  send_idempotency_key text CHECK (send_idempotency_key IS NULL OR length(send_idempotency_key) BETWEEN 1 AND 255),
  send_claimed_at      timestamptz,
  sent_message_id      uuid REFERENCES messages (id) ON DELETE RESTRICT,
  sent_at              timestamptz,
  CONSTRAINT drafts_content_key_shape CHECK (content_storage_key = 'outbound/drafts/' || id::text || '/' || revision::text || '.json'),
  CONSTRAINT drafts_claim_shape CHECK ((send_idempotency_key IS NULL) = (send_claimed_at IS NULL)),
  CONSTRAINT drafts_sent_shape CHECK ((sent_message_id IS NULL) = (sent_at IS NULL)
                                      AND (sent_message_id IS NULL OR send_idempotency_key IS NOT NULL)),
  CONSTRAINT drafts_sent_or_discarded CHECK (sent_message_id IS NULL OR discarded_at IS NULL),
  CONSTRAINT drafts_time_order CHECK (updated_at >= created_at)
);

-- 목록(살아 있는 것 · 최근 고친 것부터) · 상한 계수.
CREATE INDEX drafts_agent_active_idx ON drafts (agent_id, updated_at DESC, id DESC) WHERE discarded_at IS NULL AND sent_message_id IS NULL;
CREATE INDEX drafts_agent_updated_idx ON drafts (agent_id, updated_at DESC, id DESC);

-- 정체성은 바뀌지 않는다 · 판은 앞으로만 · 보냈거나 버린 초안은 굳는다 · 키를 잡은 초안은 내용이 굳는다 · 키는 한 번 잡으면 같은 값이거나
-- (보내기 전) 풀린다. 시각은 DB 가 적는다 — 밀리초로 자른다(목록 커서가 JS 시각이라 마이크로초가 남으면 페이지 사이에서 행이 빠진다).
CREATE FUNCTION drafts_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.created_at := date_trunc('milliseconds', now());
    NEW.updated_at := NEW.created_at;
    IF NEW.revision <> 1 OR NEW.discarded_at IS NOT NULL OR NEW.send_idempotency_key IS NOT NULL OR NEW.sent_message_id IS NOT NULL THEN
      RAISE EXCEPTION 'a new draft starts at revision 1, not discarded, not claimed, not sent' USING ERRCODE = '23514';
    END IF;
    PERFORM pg_advisory_xact_lock(hashtextextended('drafts:' || NEW.agent_id, 0));
    IF (SELECT count(*) FROM drafts d WHERE d.agent_id = NEW.agent_id AND d.discarded_at IS NULL AND d.sent_message_id IS NULL) >= 500 THEN
      RAISE EXCEPTION 'draft limit reached for agent' USING ERRCODE = 'P0001', HINT = 'draft_limit';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.id <> OLD.id OR NEW.agent_id <> OLD.agent_id OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'drafts identity columns are immutable' USING ERRCODE = '23514';
  END IF;
  IF OLD.sent_message_id IS NOT NULL OR OLD.discarded_at IS NOT NULL THEN
    RAISE EXCEPTION 'a sent or discarded draft cannot change' USING ERRCODE = '23514';
  END IF;
  IF NEW.revision < OLD.revision THEN
    RAISE EXCEPTION 'drafts.revision never goes back' USING ERRCODE = '23514';
  END IF;
  IF OLD.send_idempotency_key IS NOT NULL AND NEW.send_idempotency_key IS NOT NULL AND NEW.send_idempotency_key <> OLD.send_idempotency_key THEN
    RAISE EXCEPTION 'a claimed draft keeps its idempotency key' USING ERRCODE = '23514';
  END IF;
  IF (OLD.send_idempotency_key IS NOT NULL OR NEW.send_idempotency_key IS NOT NULL)
     AND (NEW.revision <> OLD.revision OR NEW.from_address IS DISTINCT FROM OLD.from_address OR NEW.recipients <> OLD.recipients
          OR NEW.subject IS DISTINCT FROM OLD.subject OR NEW.in_reply_to IS DISTINCT FROM OLD.in_reply_to
          OR NEW.attachment_ids <> OLD.attachment_ids OR NEW.content_storage_key <> OLD.content_storage_key
          OR NEW.content_bytes <> OLD.content_bytes) THEN
    RAISE EXCEPTION 'a draft being sent cannot be edited' USING ERRCODE = '23514';
  END IF;
  IF NEW.sent_message_id IS NOT NULL AND NEW.send_idempotency_key IS DISTINCT FROM OLD.send_idempotency_key THEN
    RAISE EXCEPTION 'a draft is sent under the key that claimed it' USING ERRCODE = '23514';
  END IF;
  NEW.updated_at := greatest(OLD.updated_at, date_trunc('milliseconds', now()));
  IF NEW.sent_message_id IS NOT NULL THEN NEW.sent_at := now(); END IF;
  IF NEW.discarded_at IS NOT NULL THEN NEW.discarded_at := now(); END IF;
  IF NEW.send_idempotency_key IS NOT NULL AND OLD.send_idempotency_key IS NULL THEN NEW.send_claimed_at := now(); END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER drafts_guard
  BEFORE INSERT OR UPDATE ON drafts
  FOR EACH ROW EXECUTE FUNCTION drafts_guard();

CREATE TRIGGER drafts_no_delete
  BEFORE DELETE ON drafts
  FOR EACH ROW EXECUTE FUNCTION reject_row_delete();

CREATE TRIGGER drafts_no_truncate
  AFTER TRUNCATE ON drafts
  FOR EACH STATEMENT EXECUTE FUNCTION reject_truncate();

COMMENT ON TABLE drafts IS
  '에이전트 초안(묶음 B) — 받는 사람·제목·발신·답장 대상·첨부 id 만, 본문은 S3 outbound/drafts/{id}/{revision}.json. 지우지 않는다(discarded_at). 보낸 초안은 굳는다(sent_message_id). 발송은 draft_send 경로(관문).';

-- ---------------------------------------------------------------------------
-- ② inbound_message_state
-- ---------------------------------------------------------------------------

CREATE TABLE inbound_message_state (
  inbound_message_id uuid PRIMARY KEY REFERENCES inbound_messages (id) ON DELETE RESTRICT,
  agent_id           char(32) NOT NULL REFERENCES agents (id) ON DELETE RESTRICT,
  -- 라벨 — 정렬 · 중복 없음은 앱이 맞춘다. 쉼표가 들어갈 수 없는 모양이라 이어 붙여 본다.
  labels             text[] NOT NULL DEFAULT '{}'
                       CHECK (cardinality(labels) <= 20 AND array_to_string(labels, ',') ~ '^([a-z0-9][a-z0-9._-]{0,63}(,|$))*$'),
  first_read_at      timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX inbound_message_state_agent_idx ON inbound_message_state (agent_id);
CREATE INDEX inbound_message_state_labels_idx ON inbound_message_state USING gin (labels);

-- 행의 메일은 그 에이전트의 것이어야 한다 · 정체성은 바뀌지 않는다 · 처음 읽은 시각은 한 번만 선다. 시각은 DB 가 적는다.
CREATE FUNCTION inbound_message_state_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NOT EXISTS (SELECT 1 FROM inbound_messages m WHERE m.id = NEW.inbound_message_id AND m.agent_id = NEW.agent_id) THEN
      RAISE EXCEPTION 'inbound_message_state must belong to the agent of its message' USING ERRCODE = '23514';
    END IF;
    NEW.created_at := now();
    NEW.updated_at := NEW.created_at;
    IF NEW.first_read_at IS NOT NULL THEN NEW.first_read_at := NEW.created_at; END IF;
    RETURN NEW;
  END IF;
  IF NEW.inbound_message_id <> OLD.inbound_message_id OR NEW.agent_id <> OLD.agent_id OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'inbound_message_state identity columns are immutable' USING ERRCODE = '23514';
  END IF;
  IF OLD.first_read_at IS NOT NULL THEN
    NEW.first_read_at := OLD.first_read_at;
  ELSIF NEW.first_read_at IS NOT NULL THEN
    NEW.first_read_at := now();
  END IF;
  NEW.updated_at := greatest(OLD.updated_at, now());
  RETURN NEW;
END;
$$;

CREATE TRIGGER inbound_message_state_guard
  BEFORE INSERT OR UPDATE ON inbound_message_state
  FOR EACH ROW EXECUTE FUNCTION inbound_message_state_guard();

CREATE TRIGGER inbound_message_state_no_delete
  BEFORE DELETE ON inbound_message_state
  FOR EACH ROW EXECUTE FUNCTION reject_row_delete();

CREATE TRIGGER inbound_message_state_no_truncate
  AFTER TRUNCATE ON inbound_message_state
  FOR EACH STATEMENT EXECUTE FUNCTION reject_truncate();

COMMENT ON TABLE inbound_message_state IS
  '받은 메일의 에이전트 상태(묶음 B) — 라벨(메일당 20 · 에이전트당 서로 다른 200) · 처음 읽은 시각. 지우지 않는다. 라벨 목록·필터는 보이는 메일만.';

-- ---------------------------------------------------------------------------
-- ③ outbound_attachments 중복 방지 키
-- ---------------------------------------------------------------------------

ALTER TABLE outbound_attachments ADD COLUMN idempotency_key text;
ALTER TABLE outbound_attachments ADD COLUMN request_hash text;
ALTER TABLE outbound_attachments ADD CONSTRAINT outbound_attachments_idempotency_shape CHECK (
  (idempotency_key IS NULL) = (request_hash IS NULL)
  AND (idempotency_key IS NULL OR length(idempotency_key) BETWEEN 1 AND 255)
  AND (request_hash IS NULL OR request_hash ~ '^[0-9a-f]{64}$')) NOT VALID;

-- ---------------------------------------------------------------------------
-- GRANT — `src/runtime/role-bootstrap.ts` `RESTRICTED_ROLE_GRANTS` 와 같다(migrate status 가 대조)
-- ---------------------------------------------------------------------------

GRANT SELECT, INSERT ON drafts TO atmark_app;
GRANT UPDATE (revision, from_address, recipients, subject, in_reply_to, attachment_ids, content_storage_key, content_bytes,
              discarded_at, send_idempotency_key, send_claimed_at, sent_message_id, sent_at)
  ON drafts TO atmark_app;
GRANT SELECT, INSERT ON inbound_message_state TO atmark_app;
GRANT UPDATE (labels, first_read_at) ON inbound_message_state TO atmark_app;
