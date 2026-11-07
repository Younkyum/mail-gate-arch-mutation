-- 202609241200_passport_publication.sql
-- P6 PP-B · PP-C — passport **게시**: 서명된 문서 · 버전 전이 가드 · 게시 요청 outbox · 서명 전용 DB 롤의 권한
-- (계획 §4B.1b · §4B.2 · §4B.3 · ADR-0003, 계약 `.omc/handoffs/v2-contract.md` §3)
--
-- **테이블 `passports` 는 만들지 않는다**(P1c 의 202609221600 이 만들었다 — 계획 §6 P6 r4 "한 번만 만든다"). 여기서 하는 것:
--
--   ① `passport_documents` — 버전 행 하나당 서명된 문서 하나. **JWS 페이로드 = 저장된 JCS 문자열 = 해시 대상**(ADR-0003 B1)을
--      DB 가 INSERT 시점에 대조한다. 행은 불변·삭제 불가.
--   ② `passports` 전이 가드 — UPDATE 로 바꿀 수 있는 status 는 `draft → published`(최초 게시) 하나뿐이고, 그 밖의 전이는
--      **새 버전 행**이다(§4B.1b append 철학). 새 버전은 직전 버전 + 1 · 직전 버전이 먼저 대체돼 있어야 · revoked 뒤에는 없음.
--      그리고 **게시된(draft 가 아닌) 버전에는 커밋 시점에 서명 문서가 있어야 한다**(지연 제약 트리거).
--   ③ `passport_publish_requests` — 게시 요청 outbox. admin(콘솔)이 INSERT, 서명 Lambda 가 처리한다. 에이전트당 처리 중 요청 1개.
--   ④ 권한 — 서명 전용 롤 `atmark_passport_signer`(컬럼 단위) · admin(outbox INSERT·조회) · 앱(공개 API 가 문서를 읽는다).
--
-- 롤은 여기서 만들지 않는다(`db/migrate.ts` 머리말 — 러너는 롤을 만들지 않는다). migrate 핸들러의 `bootstrap-roles` 가 만들고,
-- 로컬은 `CREATE ROLE atmark_passport_signer LOGIN NOINHERIT PASSWORD 'atmark';`(docs/runbooks/identity.md). 없으면 멈춘다.
-- 허용 목록은 코드에 한 번 더 있다 — `src/runtime/role-bootstrap.ts` `RESTRICTED_ROLE_GRANTS`(migrate `status` 가 대조).

DO $$
DECLARE
  missing text;
BEGIN
  SELECT string_agg(name, ', ') INTO missing
    FROM unnest(ARRAY['atmark_app', 'atmark_admin', 'atmark_passport_signer']) AS name
   WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = name);
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION 'role % does not exist — migrate 핸들러의 bootstrap-roles 를 먼저 돌려라(로컬: docs/runbooks/identity.md §2)', missing;
  END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- ① passport_documents
-- ---------------------------------------------------------------------------

-- 왜 `passports` 에 컬럼을 더하지 않고 표를 따로 두는가: `passports` 의 UPDATE 트리거는 allow-list(4컬럼)이고 새 컬럼의 기본은
--   불변이다(202609221600). 최초 게시(draft 행에 문서를 붙이는 것)는 그 행을 UPDATE 해야 하는데, 문서 컬럼을 그 목록에 더하면
--   "이미 서명된 문서를 행 갱신으로 바꾸는" 길이 열린다. 문서는 **따로 INSERT 만** 된다 — 바꿀 길이 구조적으로 없다.
CREATE TABLE passport_documents (
  passport_id  uuid PRIMARY KEY REFERENCES passports (id) ON DELETE RESTRICT,
  -- RFC 8785 JCS 로 정규화된 passport.json **문자열 그대로**. 이 UTF-8 바이트가 JWS 페이로드이고 SHA-256 대상이다.
  document     text NOT NULL CHECK (length(document) BETWEEN 2 AND 65536),
  -- JWS compact(EdDSA). 세 부분 모두 base64url. 길이 상한은 정규식 밖(POSIX 반복 상한 255 — 202609221600 주석).
  jws          text NOT NULL CHECK (jws ~ '^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$' AND length(jws) <= 131072),
  -- 문서의 validFrom/validUntil(= JWT nbf/exp). 재서명 워커가 만료 임박을 판정할 때 문서를 파싱하지 않게 둔다.
  valid_from   timestamptz NOT NULL,
  valid_until  timestamptz NOT NULL CHECK (valid_until >= valid_from),
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- ★ 서명 대상 = 저장 문서 = 해시 대상 (ADR-0003 B1). 셋이 갈라지면 "해시는 A 에 대한 것, 서명은 B 에 대한 것" 이 되고,
--   앵커(§3.6)가 붙는 날 앵커된 해시가 어느 서명과도 대응하지 않는다. 코드 한 줄의 실수로 조용히 갈라질 수 있으므로 DB 가 본다.
CREATE OR REPLACE FUNCTION passport_documents_match_passport() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  expected_hash text;
  payload text;
BEGIN
  SELECT content_hash INTO expected_hash FROM passports WHERE id = NEW.passport_id;
  IF expected_hash IS NULL THEN
    RAISE EXCEPTION 'passport % has no content_hash — set it before attaching the signed document', NEW.passport_id
      USING ERRCODE = '23514';
  END IF;
  IF encode(sha256(convert_to(NEW.document, 'UTF8')), 'hex') <> expected_hash THEN
    RAISE EXCEPTION 'passport_documents.document does not hash to passports.content_hash (%)', NEW.passport_id
      USING ERRCODE = '23514';
  END IF;
  -- base64url(문서 바이트), 패딩 없음. PG 의 base64 는 76자마다 줄바꿈을 넣는다 — 걷어 낸다.
  payload := rtrim(translate(replace(encode(convert_to(NEW.document, 'UTF8'), 'base64'), E'\n', ''), '+/', '-_'), '=');
  IF split_part(NEW.jws, '.', 2) <> payload THEN
    RAISE EXCEPTION 'passport_documents.jws payload is not the stored document (%)', NEW.passport_id
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER passport_documents_match
  BEFORE INSERT ON passport_documents
  FOR EACH ROW EXECUTE FUNCTION passport_documents_match_passport();

CREATE TRIGGER passport_documents_immutable
  BEFORE UPDATE ON passport_documents
  FOR EACH ROW EXECUTE FUNCTION reject_row_update();

-- 문서를 **삭제하지 않는다**(§4B.1b 핵심 원칙 — 삭제는 "이 DID 는 존재한 적 없다" 로 읽힌다).
CREATE TRIGGER passport_documents_no_delete
  BEFORE DELETE ON passport_documents
  FOR EACH ROW EXECUTE FUNCTION reject_row_delete();

CREATE TRIGGER passport_documents_no_truncate
  BEFORE TRUNCATE ON passport_documents
  FOR EACH STATEMENT EXECUTE FUNCTION reject_truncate();

COMMENT ON TABLE passport_documents IS
  '버전 행 하나당 서명 문서 하나. document(JCS) = JWS 페이로드 = content_hash 대상 — INSERT 트리거가 대조한다. 불변·삭제 불가 (ADR-0003 B1).';

-- ---------------------------------------------------------------------------
-- ② passports 전이 가드
-- ---------------------------------------------------------------------------

-- 전이 (§4B.1b 통합 상태값): draft → published → suspended → published, published|suspended → revoked (종단).
--   - UPDATE 로 바뀌는 status 는 **draft → published 하나**(PP-A 가 만든 v1 에 첫 문서를 붙이는 순간). 나머지 전이는 새 버전 행이다 —
--     행을 고치면 "v3 은 게시 당시 무엇이었나" 에 답이 없어진다.
--   - superseded_at 은 1회 쓰기(NULL → 값). draft 는 대체되지 않는다(게시되는 것이다).
--   - 새 버전: 직전 버전 + 1 · 직전 버전이 이미 대체됨 · draft 아님 · 직전이 draft/revoked 아님.
--   - 첫 행(버전 1)은 draft 뿐이다 — PP-A 의 계약(§4B.2)을 DB 가 한 번 더 본다.
CREATE OR REPLACE FUNCTION passports_transition_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  prev record;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.status IS DISTINCT FROM OLD.status AND NOT (OLD.status = 'draft' AND NEW.status = 'published') THEN
      RAISE EXCEPTION 'passports.status % -> % is not an in-place transition (only draft -> published; others are new versions)',
        OLD.status, NEW.status USING ERRCODE = '23514';
    END IF;
    IF OLD.superseded_at IS NOT NULL AND NEW.superseded_at IS DISTINCT FROM OLD.superseded_at THEN
      RAISE EXCEPTION 'passports.superseded_at is write-once' USING ERRCODE = '23514';
    END IF;
    IF NEW.superseded_at IS NOT NULL AND NEW.status = 'draft' THEN
      RAISE EXCEPTION 'a draft passport is published, not superseded' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  SELECT status, version, superseded_at INTO prev
    FROM passports WHERE agent_id = NEW.agent_id ORDER BY version DESC LIMIT 1;
  IF NOT FOUND THEN
    IF NEW.version <> 1 OR NEW.status <> 'draft' THEN
      RAISE EXCEPTION 'the first passport version of an agent is version 1 in draft (PP-A)' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.version <> prev.version + 1 THEN
    RAISE EXCEPTION 'passport version must be % (got %)', prev.version + 1, NEW.version USING ERRCODE = '23514';
  END IF;
  IF prev.superseded_at IS NULL THEN
    RAISE EXCEPTION 'supersede passport version % before inserting %', prev.version, NEW.version USING ERRCODE = '23514';
  END IF;
  IF NEW.status = 'draft' OR prev.status = 'draft' THEN
    RAISE EXCEPTION 'draft passports are published in place, never re-versioned (% -> %)', prev.status, NEW.status
      USING ERRCODE = '23514';
  END IF;
  IF prev.status = 'revoked' THEN
    RAISE EXCEPTION 'revoked is terminal — no passport version after it' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER passports_transition
  BEFORE INSERT OR UPDATE ON passports
  FOR EACH ROW EXECUTE FUNCTION passports_transition_guard();

-- ★ 게시된(= draft 가 아닌) 버전에는 **커밋 시점에** 서명 문서가 있어야 한다. content_hash·metadata_uri 만 있고 문서가 없는
--   published 행은 "무엇에 서명했는지 모르는 게시" 다. 행과 문서는 같은 트랜잭션에서 만들어지므로 지연 제약이다.
CREATE OR REPLACE FUNCTION passports_require_signed_document() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status <> 'draft' AND NOT EXISTS (SELECT 1 FROM passport_documents WHERE passport_id = NEW.id) THEN
    RAISE EXCEPTION 'passport % is % without a signed document', NEW.id, NEW.status USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER passports_signed_document_required
  AFTER INSERT OR UPDATE ON passports
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION passports_require_signed_document();

-- ---------------------------------------------------------------------------
-- ③ passport_publish_requests — outbox
-- ---------------------------------------------------------------------------

-- publish: draft→published · suspended→published · published→재서명(같으면 unchanged)
-- suspend: published→suspended (문서는 내리지 않고 status 로 재서명)
-- revoke : published|suspended→revoked (종단, validUntil = 지금) — **관리 API 에 없다**(런북 경로만)
-- resign : 서명 Lambda 의 일일 스캔 — 버킷 경계·만료 임박이면 새 버전, 아니면 unchanged(재업로드만)
CREATE TYPE passport_request_kind AS ENUM ('publish', 'suspend', 'revoke', 'resign');

-- pending → signed(DB 에 새 버전 커밋, 업로드 대기) → done / pending → rejected / (재시도 소진) → failed
CREATE TYPE passport_request_status AS ENUM ('pending', 'signed', 'done', 'rejected', 'failed');

CREATE TABLE passport_publish_requests (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id         char(32) NOT NULL REFERENCES agents (id) ON DELETE RESTRICT,
  kind             passport_request_kind NOT NULL,
  -- 누가: 콘솔 세션(`admin:session:<uuid>`) · 서명 Lambda 스캔(`system:resign`) · 운영자 런북(`operator:<이름>`). 사람 이름·메일 없음.
  requested_by     text NOT NULL
                     CHECK (requested_by ~ '^(admin:session:[0-9a-f-]{36}|system:[a-z_]{1,32}|operator:[A-Za-z0-9._-]{1,64})$'),
  status           passport_request_status NOT NULL DEFAULT 'pending',
  created_at       timestamptz NOT NULL DEFAULT now(),
  next_attempt_at  timestamptz NOT NULL DEFAULT now(),
  attempt_count    integer NOT NULL DEFAULT 0 CHECK (attempt_count BETWEEN 0 AND 100),
  -- **코드만**(오류 이름·단계). 메시지 원문·비밀·키 자료가 모양상 들어갈 수 없다.
  last_error       text CHECK (last_error IS NULL OR last_error ~ '^[a-z0-9_:.-]{1,120}$'),
  passport_id      uuid REFERENCES passports (id) ON DELETE RESTRICT,
  outcome          text CHECK (outcome IS NULL OR outcome IN ('published', 'suspended', 'revoked', 'unchanged', 'rejected')),
  outcome_reason   text CHECK (outcome_reason IS NULL OR outcome_reason ~ '^[a-z_]{1,64}$'),
  signed_at        timestamptz,
  completed_at     timestamptz,
  CONSTRAINT passport_publish_requests_state CHECK (
    (status = 'pending' AND passport_id IS NULL AND outcome IS NULL AND signed_at IS NULL AND completed_at IS NULL)
    OR (status = 'signed' AND passport_id IS NOT NULL AND outcome IN ('published', 'suspended', 'revoked', 'unchanged')
        AND signed_at IS NOT NULL AND completed_at IS NULL)
    OR (status = 'done' AND passport_id IS NOT NULL AND outcome IN ('published', 'suspended', 'revoked', 'unchanged')
        AND signed_at IS NOT NULL AND completed_at IS NOT NULL)
    OR (status = 'rejected' AND outcome = 'rejected' AND outcome_reason IS NOT NULL AND completed_at IS NOT NULL)
    OR (status = 'failed' AND completed_at IS NOT NULL)
  )
);

-- 에이전트당 처리 중(pending·signed) 요청 1개. 둘이면 "정지 요청 뒤에 온 게시 요청" 의 순서를 워커가 정해야 하고, 그 순서는
--   경쟁에서 진다. 콘솔은 같은 종류면 기존 요청을 돌려주고 다른 종류면 409 다(`src/passport/admin-view.ts`).
CREATE UNIQUE INDEX passport_publish_requests_one_inflight
  ON passport_publish_requests (agent_id) WHERE status IN ('pending', 'signed');
CREATE INDEX passport_publish_requests_due
  ON passport_publish_requests (next_attempt_at) WHERE status IN ('pending', 'signed');
CREATE INDEX passport_publish_requests_agent_recent
  ON passport_publish_requests (agent_id, created_at DESC);

-- 요청의 **정체**(누가·무엇을·언제)는 바뀌지 않는다 — allow-list 로 처리 칸만 연다(새 컬럼의 기본은 불변).
CREATE TRIGGER passport_publish_requests_processing_columns_only
  BEFORE UPDATE ON passport_publish_requests
  FOR EACH ROW EXECUTE FUNCTION reject_column_update_except(
    'status', 'next_attempt_at', 'attempt_count', 'last_error', 'passport_id', 'outcome', 'outcome_reason', 'signed_at', 'completed_at'
  );

-- 종단(done·rejected·failed)은 다시 열리지 않는다. 열리면 같은 요청이 두 번째 버전을 만든다(멱등성 붕괴).
CREATE OR REPLACE FUNCTION passport_publish_requests_reject_terminal_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status IN ('done', 'rejected', 'failed') THEN
    RAISE EXCEPTION 'passport publish request % is terminal (%)', OLD.id, OLD.status USING ERRCODE = '23514';
  END IF;
  IF OLD.status = 'signed' AND NEW.status NOT IN ('signed', 'done', 'failed') THEN
    RAISE EXCEPTION 'signed passport request cannot go back to %', NEW.status USING ERRCODE = '23514';
  END IF;
  IF OLD.passport_id IS NOT NULL AND NEW.passport_id IS DISTINCT FROM OLD.passport_id THEN
    RAISE EXCEPTION 'passport_publish_requests.passport_id is write-once' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER passport_publish_requests_terminal
  BEFORE UPDATE ON passport_publish_requests
  FOR EACH ROW EXECUTE FUNCTION passport_publish_requests_reject_terminal_change();

CREATE TRIGGER passport_publish_requests_no_delete
  BEFORE DELETE ON passport_publish_requests
  FOR EACH ROW EXECUTE FUNCTION reject_row_delete();

CREATE TRIGGER passport_publish_requests_no_truncate
  BEFORE TRUNCATE ON passport_publish_requests
  FOR EACH STATEMENT EXECUTE FUNCTION reject_truncate();

COMMENT ON TABLE passport_publish_requests IS
  'passport 게시 outbox. admin 이 INSERT(에이전트·종류·요청자 세 칸), 서명 Lambda(atmark_passport_signer)가 처리. 에이전트당 처리 중 1개. 종단은 불변.';

-- ---------------------------------------------------------------------------
-- ④ 권한
-- ---------------------------------------------------------------------------

REVOKE ALL ON passport_documents, passport_publish_requests FROM PUBLIC;

-- ---- atmark_passport_signer — 서명 Lambda(`atmark-passport-signer`) 전용. 아무것도 소유하지 않는다. ----
--   읽기는 문서를 만드는 데 필요한 칸만: 이름·상태·생성 시각 · 주소 · 공개키·키 참조 · 위반 판정(감사 결정·사유) ·
--   대화 수(스레드·방향·상태). **조직(소유자 메일·이름)·토큰·메시지 제목/본문·정책(모드·목록·수치)은 읽지 못한다** — 정책은
--   서명 문서에 들어가지 않는다(운영 상태라 자주 바뀐다 — 공개 API 가 살아 있는 값으로 준다, ADR-0003).
GRANT USAGE ON SCHEMA public TO atmark_passport_signer;
GRANT SELECT (id, name, status, created_at) ON agents TO atmark_passport_signer;
GRANT SELECT (agent_id, address, is_primary) ON agent_addresses TO atmark_passport_signer;
GRANT SELECT (agent_id, public_key, algorithm, key_ref) ON agent_keypairs TO atmark_passport_signer;
GRANT SELECT (agent_id, decision, reasons) ON audit_logs TO atmark_passport_signer;
GRANT SELECT (agent_id, thread_id, direction, status) ON messages TO atmark_passport_signer;
GRANT SELECT (agent_id, thread_id) ON inbound_messages TO atmark_passport_signer;
-- passports: 읽기 전부(버전 체인) · 새 버전 INSERT(행 정체 칸) · 수명주기 칸 UPDATE(최초 게시·대체 표시).
GRANT SELECT ON passports TO atmark_passport_signer;
-- `id` 를 받는 이유: 문서의 `jti`(= urn:uuid:<passports.id>)가 행보다 먼저 정해져야 서명 → INSERT 순서가 선다.
GRANT INSERT (id, agent_id, did, status, controller, metadata_uri, content_hash, version, issued_at) ON passports TO atmark_passport_signer;
GRANT UPDATE (status, metadata_uri, content_hash, superseded_at) ON passports TO atmark_passport_signer;
GRANT SELECT, INSERT ON passport_documents TO atmark_passport_signer;
-- outbox: 처리 칸 UPDATE · 일일 재서명 스캔의 INSERT(세 칸).
GRANT SELECT ON passport_publish_requests TO atmark_passport_signer;
GRANT INSERT (agent_id, kind, requested_by) ON passport_publish_requests TO atmark_passport_signer;
GRANT UPDATE (status, next_attempt_at, attempt_count, last_error, passport_id, outcome, outcome_reason, signed_at, completed_at)
  ON passport_publish_requests TO atmark_passport_signer;

-- ---- atmark_admin — 콘솔: 요청 INSERT(세 칸 — 상태를 미리 'done' 으로 적는 길 없음) · 요청·문서 조회(상태 화면). ----
GRANT SELECT ON passport_publish_requests TO atmark_admin;
GRANT INSERT (agent_id, kind, requested_by) ON passport_publish_requests TO atmark_admin;
GRANT SELECT ON passport_documents TO atmark_admin;

-- ---- atmark_app — 공개 API `GET /v1/identity/{address}` 가 서명된 문서(공개 전제)를 읽는다. 쓰기 없음. ----
GRANT SELECT ON passport_documents TO atmark_app;
