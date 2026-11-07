-- 202609241600_transparency_log.sql
-- ADR-0008 Phase A (+B 의 증거 테이블) — 조직별 append-only 머클 로그 · 에폭 · 서명 체크포인트 · 외부 앵커 영수증 (US-010, 채택 2026-09-24)
--
--   ① 수집: 원천 테이블(audit_logs · owner_actions · policy_versions · inbound_messages)에 **AFTER 트리거** — 소유자가 소유한
--      SECURITY DEFINER 함수가 **같은 트랜잭션에서** `tlog_outbox` 에 한 행을 쓴다. 원천 행과 outbox 행은 같이 커밋되거나 같이 사라진다.
--      앱·admin 롤은 outbox 권한이 0 이다. 앱 코드가 잎을 쓰지 않는 이유: 잎을 쓰지 않는 경로가 하나라도 생기면 완결성이 조용히
--      깨진다 — 트리거는 경로 수와 무관하다(ADR-0008 §2.3). `audit_logs` 는 변경 가능한 4칸이 바뀔 때마다 `update` 사건(rev 1,2,…)이다.
--   ② 서열: 서열기(Lambda `atmark-transparency-logger`, 롤 `atmark_tlog`)가 outbox 를 **id 순서로, 처리 표시로** 비운다(커서가 아니다 —
--      커밋 순서와 id 순서가 달라도 빠지는 행이 없다). 잎 INSERT 와 outbox 처리 표시가 한 트랜잭션이다(멱등 — 같은 사건의 잎은
--      UNIQUE(source_table, source_id, event, rev) 가 두 번 막는다). 스냅샷(4칸의 그때 값 — 승인자 문자열 포함)은 처리와 함께 지운다.
--   ③ 잎: `(org_log_id, seq)` 연속(트리거) · seq 0 = org.genesis · **leaf_hash = SHA-256(0x00 ‖ leaf_json) 을 DB 가 대조**(CHECK) ·
--      잎 JSON 의 log·seq·kind·src 가 행의 칸과 같다(CHECK). UPDATE/DELETE/TRUNCATE 거부.
--   ④ 에폭(매시): 모든 조직 로그의 헤드 → 에폭 트리 → 전역 로그 잎 하나 → C2SP 체크포인트(KMS Ed25519 서명). **에폭은 모든 조직을
--      담는다**(지연 제약 트리거 — 헤드 수 = 로그 수). 체크포인트의 size·root 줄 = 행의 칸(CHECK). published_at 한 번만.
--   ⑤ 앵커: OpenTimestamps · Rekor v2 영수증. digest = SHA-256(체크포인트 전문)(트리거) · 영수증·업그레이드는 한 번만 쓴다 · 상태
--      전이는 pending → submitted → confirmed | failed 한 방향.
--   ⑥ 솔트 키: 조직마다 32바이트. 크립토 슈레딩(Q9) = 소유자 롤이 salt_key 를 NULL 로(한 번, shredded_at 과 함께). 누구에게도
--      UPDATE 권한을 주지 않는다 — 런북(docs/runbooks/transparency-log.md §6)의 소유자 롤 절차뿐.
--   ⑦ 권한: `atmark_tlog`(서열·에폭·게시) · `atmark_tlog_anchor`(앵커) — 컬럼 단위. admin 은 증명·번들용 SELECT 만.
--
-- 롤은 여기서 만들지 않는다(러너는 롤을 만들지 않는다 — `db/migrate.ts` 머리말). migrate `bootstrap-roles` 가 만들고, 로컬은
-- `CREATE ROLE atmark_tlog LOGIN NOINHERIT PASSWORD 'atmark'; CREATE ROLE atmark_tlog_anchor LOGIN NOINHERIT PASSWORD 'atmark';`
-- (docs/runbooks/transparency-log.md §2). 없으면 멈춘다. 허용 목록은 `src/runtime/role-bootstrap.ts` `RESTRICTED_ROLE_GRANTS`.

DO $$
DECLARE
  missing text;
BEGIN
  SELECT string_agg(name, ', ') INTO missing
    FROM unnest(ARRAY['atmark_app', 'atmark_admin', 'atmark_tlog', 'atmark_tlog_anchor']) AS name
   WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = name);
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION 'role % does not exist — migrate 핸들러의 bootstrap-roles 를 먼저 돌려라(로컬: docs/runbooks/transparency-log.md §2)', missing;
  END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- 조직 로그 · 솔트 키
-- ---------------------------------------------------------------------------

-- org_log_id 는 무작위 16바이트다 — 조직 uuid 와 연결되지 않는다(ADR-0008 §2.1). 로그는 조직의 첫 사건에서 서열기가 만든다.
CREATE TABLE tlog_logs (
  org_log_id       bytea PRIMARY KEY CHECK (length(org_log_id) = 16),
  organization_id  uuid NOT NULL UNIQUE REFERENCES organizations (id) ON DELETE RESTRICT,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER tlog_logs_no_update BEFORE UPDATE ON tlog_logs FOR EACH ROW EXECUTE FUNCTION reject_row_update();
CREATE TRIGGER tlog_logs_no_delete BEFORE DELETE ON tlog_logs FOR EACH ROW EXECUTE FUNCTION reject_row_delete();
CREATE TRIGGER tlog_logs_no_truncate AFTER TRUNCATE ON tlog_logs FOR EACH STATEMENT EXECUTE FUNCTION reject_truncate();

CREATE TABLE tlog_salt_keys (
  org_log_id   bytea PRIMARY KEY REFERENCES tlog_logs (org_log_id) ON DELETE RESTRICT,
  salt_key     bytea CHECK (salt_key IS NULL OR length(salt_key) = 32),
  created_at   timestamptz NOT NULL DEFAULT now(),
  shredded_at  timestamptz,
  CONSTRAINT tlog_salt_keys_shred_shape CHECK ((salt_key IS NULL) = (shredded_at IS NOT NULL))
);

-- 새 키는 살아 있어야 하고, 바꿀 수 있는 것은 "폐기"(키 → NULL, 시각 기록) 한 번뿐이다. 다른 키로 바꾸는 길이 없다 — 바꾸면 과거 커밋을
--   다른 솔트로 "열어" 보이는 위조가 된다.
CREATE OR REPLACE FUNCTION tlog_salt_keys_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.salt_key IS NULL OR NEW.shredded_at IS NOT NULL THEN
      RAISE EXCEPTION 'tlog_salt_keys: 새 키는 살아 있어야 한다' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.salt_key IS NULL OR NEW.salt_key IS NOT NULL OR NEW.shredded_at IS NULL
     OR NEW.org_log_id IS DISTINCT FROM OLD.org_log_id OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'tlog_salt_keys: 바꿀 수 있는 것은 폐기(salt_key → NULL) 한 번뿐이다' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER tlog_salt_keys_guard BEFORE INSERT OR UPDATE ON tlog_salt_keys FOR EACH ROW EXECUTE FUNCTION tlog_salt_keys_guard();
CREATE TRIGGER tlog_salt_keys_no_delete BEFORE DELETE ON tlog_salt_keys FOR EACH ROW EXECUTE FUNCTION reject_row_delete();
CREATE TRIGGER tlog_salt_keys_no_truncate AFTER TRUNCATE ON tlog_salt_keys FOR EACH STATEMENT EXECUTE FUNCTION reject_truncate();

-- ---------------------------------------------------------------------------
-- ① outbox
-- ---------------------------------------------------------------------------

CREATE TABLE tlog_outbox (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source_table     text NOT NULL CHECK (source_table IN ('audit_logs', 'owner_actions', 'policy_versions', 'inbound_messages')),
  source_id        text NOT NULL CHECK (source_id ~ '^[0-9a-f-]{32,36}$'),
  event            text NOT NULL CHECK (event IN ('insert', 'update')),
  rev              integer NOT NULL CHECK (rev >= 0),
  organization_id  uuid NOT NULL REFERENCES organizations (id) ON DELETE RESTRICT,
  -- audit_logs 의 변경 가능한 4칸의 **그때 값**(decision · resolved_at · resolution_reason · approved_by). 서열 뒤 NULL 로 지운다.
  snapshot         jsonb CHECK (snapshot IS NULL OR jsonb_typeof(snapshot) = 'object'),
  enqueued_at      timestamptz NOT NULL DEFAULT clock_timestamp(),
  processed_at     timestamptz,
  CONSTRAINT tlog_outbox_rev_shape CHECK ((event = 'insert') = (rev = 0)),
  CONSTRAINT tlog_outbox_snapshot_shape CHECK ((source_table = 'audit_logs') OR snapshot IS NULL),
  CONSTRAINT tlog_outbox_event_key UNIQUE (source_table, source_id, event, rev)
);
CREATE INDEX tlog_outbox_pending_idx ON tlog_outbox (id) WHERE processed_at IS NULL;

-- 바꿀 수 있는 것: processed_at(NULL → 값, 한 번) + 그와 **동시에만** snapshot → NULL. 처리 표시는 그 사건의 잎이 이미 있을 때만.
CREATE OR REPLACE FUNCTION tlog_outbox_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.processed_at IS NOT NULL OR NEW.processed_at IS NULL
     OR NEW.id IS DISTINCT FROM OLD.id OR NEW.source_table IS DISTINCT FROM OLD.source_table
     OR NEW.source_id IS DISTINCT FROM OLD.source_id OR NEW.event IS DISTINCT FROM OLD.event
     OR NEW.rev IS DISTINCT FROM OLD.rev OR NEW.organization_id IS DISTINCT FROM OLD.organization_id
     OR NEW.enqueued_at IS DISTINCT FROM OLD.enqueued_at
     OR (NEW.snapshot IS NOT NULL AND NEW.snapshot IS DISTINCT FROM OLD.snapshot) THEN
    RAISE EXCEPTION 'tlog_outbox: 바꿀 수 있는 것은 처리 표시 한 번(+ 스냅샷 지우기)뿐이다 (id=%)', OLD.id USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM tlog_leaves l WHERE l.outbox_id = OLD.id) THEN
    RAISE EXCEPTION 'tlog_outbox: 잎 없이 처리 표시를 할 수 없다 (id=%)', OLD.id USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

-- 원천 → outbox. 소유자 권한(SECURITY DEFINER)으로 돈다 — 앱·admin 롤은 outbox 에 권한이 없다. search_path 고정 · PUBLIC 실행 불가.
CREATE OR REPLACE FUNCTION tlog_enqueue() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  org uuid;
  event text := CASE TG_OP WHEN 'INSERT' THEN 'insert' ELSE 'update' END;
  next_rev integer := 0;
  snap jsonb := NULL;
BEGIN
  IF TG_TABLE_NAME = 'owner_actions' THEN
    org := NEW.organization_id;
  ELSE
    SELECT a.organization_id INTO org FROM agents a WHERE a.id = NEW.agent_id;
  END IF;
  IF org IS NULL THEN
    RAISE EXCEPTION 'tlog_enqueue: % 행의 조직을 찾지 못했다', TG_TABLE_NAME USING ERRCODE = '23503';
  END IF;
  IF TG_TABLE_NAME = 'audit_logs' THEN
    snap := jsonb_build_object(
      'decision', NEW.decision::text,
      'resolved_at', to_char(NEW.resolved_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
      'resolution_reason', NEW.resolution_reason,
      'approved_by', NEW.approved_by);
    IF event = 'update' THEN
      SELECT coalesce(max(o.rev), 0) + 1 INTO next_rev
        FROM tlog_outbox o
       WHERE o.source_table = 'audit_logs' AND o.source_id = NEW.id::text AND o.event = 'update';
    END IF;
  END IF;
  INSERT INTO tlog_outbox (source_table, source_id, event, rev, organization_id, snapshot)
  VALUES (TG_TABLE_NAME, NEW.id::text, event, next_rev, org, snap);
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION tlog_enqueue() FROM PUBLIC;

CREATE TRIGGER audit_logs_tlog_enqueue_insert AFTER INSERT ON audit_logs FOR EACH ROW EXECUTE FUNCTION tlog_enqueue();
CREATE TRIGGER audit_logs_tlog_enqueue_update AFTER UPDATE ON audit_logs FOR EACH ROW
  WHEN (OLD.decision IS DISTINCT FROM NEW.decision OR OLD.resolved_at IS DISTINCT FROM NEW.resolved_at
        OR OLD.resolution_reason IS DISTINCT FROM NEW.resolution_reason OR OLD.approved_by IS DISTINCT FROM NEW.approved_by)
  EXECUTE FUNCTION tlog_enqueue();
CREATE TRIGGER owner_actions_tlog_enqueue AFTER INSERT ON owner_actions FOR EACH ROW EXECUTE FUNCTION tlog_enqueue();
CREATE TRIGGER policy_versions_tlog_enqueue AFTER INSERT ON policy_versions FOR EACH ROW EXECUTE FUNCTION tlog_enqueue();
CREATE TRIGGER inbound_messages_tlog_enqueue AFTER INSERT ON inbound_messages FOR EACH ROW EXECUTE FUNCTION tlog_enqueue();

-- ---------------------------------------------------------------------------
-- ③ 잎
-- ---------------------------------------------------------------------------

CREATE TABLE tlog_leaves (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_log_id    bytea NOT NULL REFERENCES tlog_logs (org_log_id) ON DELETE RESTRICT,
  seq           bigint NOT NULL CHECK (seq >= 0),
  kind          text NOT NULL CHECK (kind IN ('org.genesis', 'audit.evaluated', 'audit.updated', 'owner.action',
                                              'policy.version', 'inbound.verdict', 'source.missing')),
  source_table  text,
  source_id     text,
  event         text,
  rev           integer,
  outbox_id     bigint UNIQUE REFERENCES tlog_outbox (id) ON DELETE RESTRICT,
  leaf_json     text NOT NULL CHECK (octet_length(leaf_json) BETWEEN 2 AND 65535),
  leaf_hash     bytea NOT NULL,
  appended_at   timestamptz NOT NULL DEFAULT clock_timestamp(),
  -- ★ 해시는 DB 가 다시 계산해 본다 — RFC 9162 잎 해시(0x00 접두사).
  CONSTRAINT tlog_leaves_hash CHECK (leaf_hash = sha256('\x00'::bytea || convert_to(leaf_json, 'UTF8'))),
  CONSTRAINT tlog_leaves_genesis CHECK ((seq = 0) = (kind = 'org.genesis')),
  CONSTRAINT tlog_leaves_source_shape CHECK (
    (kind = 'org.genesis' AND source_table IS NULL AND source_id IS NULL AND event IS NULL AND rev IS NULL AND outbox_id IS NULL)
    OR (kind <> 'org.genesis' AND source_table IS NOT NULL AND source_id IS NOT NULL AND event IS NOT NULL AND rev IS NOT NULL AND outbox_id IS NOT NULL)),
  -- 잎 JSON 의 봉투 칸 = 행의 칸. 칸과 다른 잎(= 다른 로그·다른 자리에 속한 잎)을 넣을 수 없다.
  CONSTRAINT tlog_leaves_envelope CHECK (
    (leaf_json::jsonb ->> 'v') = '1'
    AND (leaf_json::jsonb ->> 'log') = encode(org_log_id, 'hex')
    AND (leaf_json::jsonb ->> 'seq') = seq::text
    AND (leaf_json::jsonb ->> 'kind') = kind
    AND ((source_table IS NULL AND (leaf_json::jsonb -> 'src') = 'null'::jsonb)
         OR ((leaf_json::jsonb -> 'src' ->> 't') = source_table AND (leaf_json::jsonb -> 'src' ->> 'id') = source_id
             AND (leaf_json::jsonb -> 'src' ->> 'e') = event AND (leaf_json::jsonb -> 'src' ->> 'r') = rev::text))),
  CONSTRAINT tlog_leaves_seq_key UNIQUE (org_log_id, seq),
  CONSTRAINT tlog_leaves_event_key UNIQUE (source_table, source_id, event, rev)
);

-- 연속성: 새 잎의 seq = 그 로그의 max(seq) + 1(첫 잎은 0). outbox 가 있으면 그 사건·조직과 같아야 한다.
CREATE OR REPLACE FUNCTION tlog_leaves_append() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  expected bigint;
  box record;
BEGIN
  SELECT coalesce(max(seq), -1) + 1 INTO expected FROM tlog_leaves WHERE org_log_id = NEW.org_log_id;
  IF NEW.seq <> expected THEN
    RAISE EXCEPTION 'tlog_leaves: seq 는 연속이어야 한다 (기대 %, 받음 %)', expected, NEW.seq USING ERRCODE = '23514';
  END IF;
  IF NEW.outbox_id IS NOT NULL THEN
    SELECT o.source_table, o.source_id, o.event, o.rev, o.processed_at, l.org_log_id AS log INTO box
      FROM tlog_outbox o JOIN tlog_logs l ON l.organization_id = o.organization_id
     WHERE o.id = NEW.outbox_id;
    IF NOT FOUND OR box.processed_at IS NOT NULL OR box.log <> NEW.org_log_id
       OR box.source_table <> NEW.source_table OR box.source_id <> NEW.source_id
       OR box.event <> NEW.event OR box.rev <> NEW.rev THEN
      RAISE EXCEPTION 'tlog_leaves: 잎의 사건이 outbox 행과 맞지 않는다 (outbox=%)', NEW.outbox_id USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER tlog_leaves_append BEFORE INSERT ON tlog_leaves FOR EACH ROW EXECUTE FUNCTION tlog_leaves_append();
CREATE TRIGGER tlog_leaves_no_update BEFORE UPDATE ON tlog_leaves FOR EACH ROW EXECUTE FUNCTION reject_row_update();
CREATE TRIGGER tlog_leaves_no_delete BEFORE DELETE ON tlog_leaves FOR EACH ROW EXECUTE FUNCTION reject_row_delete();
CREATE TRIGGER tlog_leaves_no_truncate AFTER TRUNCATE ON tlog_leaves FOR EACH STATEMENT EXECUTE FUNCTION reject_truncate();

-- outbox guard 는 잎 테이블을 참조한다 — 잎 테이블 뒤에 건다.
CREATE TRIGGER tlog_outbox_guard BEFORE UPDATE ON tlog_outbox FOR EACH ROW EXECUTE FUNCTION tlog_outbox_guard();
CREATE TRIGGER tlog_outbox_no_delete BEFORE DELETE ON tlog_outbox FOR EACH ROW EXECUTE FUNCTION reject_row_delete();
CREATE TRIGGER tlog_outbox_no_truncate AFTER TRUNCATE ON tlog_outbox FOR EACH STATEMENT EXECUTE FUNCTION reject_truncate();

-- ---------------------------------------------------------------------------
-- 서명 키(공개키) — 체크포인트 키(Ed25519 vkey)와 앵커 키(P-256 SPKI)
-- ---------------------------------------------------------------------------

CREATE TABLE tlog_keys (
  key_id      text PRIMARY KEY CHECK (length(key_id) BETWEEN 8 AND 512),
  purpose     text NOT NULL CHECK (purpose IN ('checkpoint', 'anchor')),
  public_key  bytea NOT NULL CHECK (length(public_key) BETWEEN 32 AND 512),
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER tlog_keys_no_update BEFORE UPDATE ON tlog_keys FOR EACH ROW EXECUTE FUNCTION reject_row_update();
CREATE TRIGGER tlog_keys_no_delete BEFORE DELETE ON tlog_keys FOR EACH ROW EXECUTE FUNCTION reject_row_delete();
CREATE TRIGGER tlog_keys_no_truncate AFTER TRUNCATE ON tlog_keys FOR EACH STATEMENT EXECUTE FUNCTION reject_truncate();

-- ---------------------------------------------------------------------------
-- ④ 에폭 · 조직 헤드
-- ---------------------------------------------------------------------------

CREATE TABLE tlog_epochs (
  epoch             bigint PRIMARY KEY CHECK (epoch >= 0),
  closed_at         timestamptz NOT NULL,
  epoch_root        bytea NOT NULL CHECK (length(epoch_root) = 32),
  org_count         integer NOT NULL CHECK (org_count >= 0),
  global_leaf       text NOT NULL CHECK (octet_length(global_leaf) BETWEEN 2 AND 4096),
  global_leaf_hash  bytea NOT NULL,
  global_root       bytea NOT NULL CHECK (length(global_root) = 32),
  checkpoint        text NOT NULL CHECK (octet_length(checkpoint) BETWEEN 16 AND 4096),
  key_id            text NOT NULL REFERENCES tlog_keys (key_id) ON DELETE RESTRICT,
  published_at      timestamptz,
  CONSTRAINT tlog_epochs_leaf_hash CHECK (global_leaf_hash = sha256('\x00'::bytea || convert_to(global_leaf, 'UTF8'))),
  CONSTRAINT tlog_epochs_leaf_shape CHECK (
    (global_leaf::jsonb ->> 'kind') = 'epoch'
    AND (global_leaf::jsonb ->> 'epoch') = epoch::text
    AND (global_leaf::jsonb ->> 'epoch_root') = encode(epoch_root, 'hex')
    AND (global_leaf::jsonb ->> 'closed_at') = to_char(closed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')),
  -- 체크포인트 본문의 세 줄 = origin · 전역 트리 크기(= epoch + 1) · 전역 루트.
  CONSTRAINT tlog_epochs_checkpoint_shape CHECK (
    split_part(checkpoint, E'\n', 1) = 'id.atmark.ai/log/v1'
    AND split_part(checkpoint, E'\n', 2) = (epoch + 1)::text
    AND split_part(checkpoint, E'\n', 3) = encode(global_root, 'base64'))
);

CREATE TABLE tlog_org_heads (
  epoch       bigint NOT NULL REFERENCES tlog_epochs (epoch) ON DELETE RESTRICT,
  org_log_id  bytea NOT NULL REFERENCES tlog_logs (org_log_id) ON DELETE RESTRICT,
  position    integer NOT NULL CHECK (position >= 0),
  tree_size   bigint NOT NULL CHECK (tree_size >= 1),
  root        bytea NOT NULL CHECK (length(root) = 32),
  PRIMARY KEY (epoch, org_log_id),
  CONSTRAINT tlog_org_heads_position_key UNIQUE (epoch, position)
);

-- 에폭은 연속(0,1,2,…) · 시각은 앞으로만.
CREATE OR REPLACE FUNCTION tlog_epochs_append() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  last record;
BEGIN
  SELECT epoch, closed_at INTO last FROM tlog_epochs ORDER BY epoch DESC LIMIT 1;
  IF (last.epoch IS NULL AND NEW.epoch <> 0) OR (last.epoch IS NOT NULL AND NEW.epoch <> last.epoch + 1) THEN
    RAISE EXCEPTION 'tlog_epochs: 에폭은 연속이어야 한다 (받음 %)', NEW.epoch USING ERRCODE = '23514';
  END IF;
  IF last.closed_at IS NOT NULL AND NEW.closed_at <= last.closed_at THEN
    RAISE EXCEPTION 'tlog_epochs: 마감 시각은 앞으로만 간다' USING ERRCODE = '23514';
  END IF;
  IF NEW.published_at IS NOT NULL THEN
    RAISE EXCEPTION 'tlog_epochs: 게시 표시는 게시 뒤에' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER tlog_epochs_append BEFORE INSERT ON tlog_epochs FOR EACH ROW EXECUTE FUNCTION tlog_epochs_append();

-- 바꿀 수 있는 것: published_at(NULL → 값, 한 번).
CREATE OR REPLACE FUNCTION tlog_epochs_publish_once() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.published_at IS NOT NULL OR NEW.published_at IS NULL
     OR (to_jsonb(NEW) - 'published_at') IS DISTINCT FROM (to_jsonb(OLD) - 'published_at') THEN
    RAISE EXCEPTION 'tlog_epochs: 바꿀 수 있는 것은 게시 표시 한 번뿐이다 (epoch=%)', OLD.epoch USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER tlog_epochs_publish_once BEFORE UPDATE ON tlog_epochs FOR EACH ROW EXECUTE FUNCTION tlog_epochs_publish_once();
CREATE TRIGGER tlog_epochs_no_delete BEFORE DELETE ON tlog_epochs FOR EACH ROW EXECUTE FUNCTION reject_row_delete();
CREATE TRIGGER tlog_epochs_no_truncate AFTER TRUNCATE ON tlog_epochs FOR EACH STATEMENT EXECUTE FUNCTION reject_truncate();

-- ★ 에폭은 **모든** 조직 로그를 담는다(ADR-0008 §2.1 — 빠짐 자체가 증거). 커밋 시점에 헤드 수 = org_count = 로그 수, 위치는 0..n-1.
CREATE OR REPLACE FUNCTION tlog_epochs_complete() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  heads bigint;
  logs bigint;
  max_position integer;
BEGIN
  SELECT count(*), max(position) INTO heads, max_position FROM tlog_org_heads WHERE epoch = NEW.epoch;
  SELECT count(*) INTO logs FROM tlog_logs;
  IF heads <> NEW.org_count OR heads <> logs OR coalesce(max_position, -1) <> heads - 1 THEN
    RAISE EXCEPTION 'tlog_epochs: 에폭 %는 모든 조직 로그를 담아야 한다 (헤드 %, 로그 %)', NEW.epoch, heads, logs USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER tlog_epochs_complete AFTER INSERT ON tlog_epochs DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION tlog_epochs_complete();

-- 헤드: 조직 로그는 줄지 않는다(직전 에폭 헤드 크기 이상) · 크기는 실제 잎 수 이하.
CREATE OR REPLACE FUNCTION tlog_org_heads_append() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  previous bigint;
  available bigint;
BEGIN
  SELECT tree_size INTO previous FROM tlog_org_heads WHERE org_log_id = NEW.org_log_id AND epoch < NEW.epoch ORDER BY epoch DESC LIMIT 1;
  IF previous IS NOT NULL AND NEW.tree_size < previous THEN
    RAISE EXCEPTION 'tlog_org_heads: 조직 로그가 줄었다 (% → %)', previous, NEW.tree_size USING ERRCODE = '23514';
  END IF;
  SELECT count(*) INTO available FROM tlog_leaves WHERE org_log_id = NEW.org_log_id;
  IF NEW.tree_size > available THEN
    RAISE EXCEPTION 'tlog_org_heads: 헤드 크기가 잎 수보다 크다' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER tlog_org_heads_append BEFORE INSERT ON tlog_org_heads FOR EACH ROW EXECUTE FUNCTION tlog_org_heads_append();
CREATE TRIGGER tlog_org_heads_no_update BEFORE UPDATE ON tlog_org_heads FOR EACH ROW EXECUTE FUNCTION reject_row_update();
CREATE TRIGGER tlog_org_heads_no_delete BEFORE DELETE ON tlog_org_heads FOR EACH ROW EXECUTE FUNCTION reject_row_delete();
CREATE TRIGGER tlog_org_heads_no_truncate AFTER TRUNCATE ON tlog_org_heads FOR EACH STATEMENT EXECUTE FUNCTION reject_truncate();

-- ---------------------------------------------------------------------------
-- ⑤ 앵커 (Phase B)
-- ---------------------------------------------------------------------------

CREATE TABLE tlog_anchors (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  epoch            bigint NOT NULL REFERENCES tlog_epochs (epoch) ON DELETE RESTRICT,
  target           text NOT NULL CHECK (target IN ('opentimestamps', 'rekor')),
  endpoint         text NOT NULL CHECK (endpoint ~ '^https://[a-z0-9.-]+$'),
  digest           bytea NOT NULL CHECK (length(digest) = 32),
  state            text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'submitted', 'confirmed', 'failed')),
  attempt_count    integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  next_attempt_at  timestamptz NOT NULL DEFAULT now(),
  last_error       text CHECK (last_error IS NULL OR last_error ~ '^[a-z0-9_:.-]{1,120}$'),
  receipt          bytea CHECK (receipt IS NULL OR octet_length(receipt) BETWEEN 1 AND 1048576),
  receipt_at       timestamptz,
  upgraded         bytea CHECK (upgraded IS NULL OR octet_length(upgraded) BETWEEN 1 AND 1048576),
  confirmed_at     timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT tlog_anchors_target_key UNIQUE (epoch, target, endpoint),
  CONSTRAINT tlog_anchors_state_shape CHECK (
    CASE state
      WHEN 'pending' THEN receipt IS NULL AND upgraded IS NULL AND confirmed_at IS NULL
      WHEN 'failed' THEN receipt IS NULL AND upgraded IS NULL AND confirmed_at IS NULL
      WHEN 'submitted' THEN receipt IS NOT NULL AND receipt_at IS NOT NULL AND upgraded IS NULL AND confirmed_at IS NULL
      WHEN 'confirmed' THEN receipt IS NOT NULL AND receipt_at IS NOT NULL AND confirmed_at IS NOT NULL
                            AND (target <> 'opentimestamps' OR upgraded IS NOT NULL)
    END)
);
CREATE INDEX tlog_anchors_due_idx ON tlog_anchors (next_attempt_at) WHERE state IN ('pending', 'submitted');

-- 새 앵커: 대기 상태로만 · digest = SHA-256(그 에폭의 체크포인트 전문). 다른 바이트를 앵커했다고 적을 수 없다.
CREATE OR REPLACE FUNCTION tlog_anchors_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  expected bytea;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT sha256(convert_to(checkpoint, 'UTF8')) INTO expected FROM tlog_epochs WHERE epoch = NEW.epoch;
    IF expected IS NULL OR NEW.digest <> expected THEN
      RAISE EXCEPTION 'tlog_anchors: digest 는 그 에폭 체크포인트의 SHA-256 이어야 한다' USING ERRCODE = '23514';
    END IF;
    IF NEW.state <> 'pending' OR NEW.attempt_count <> 0 OR NEW.receipt IS NOT NULL THEN
      RAISE EXCEPTION 'tlog_anchors: 새 앵커는 대기 상태다' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.epoch IS DISTINCT FROM OLD.epoch OR NEW.target IS DISTINCT FROM OLD.target
     OR NEW.endpoint IS DISTINCT FROM OLD.endpoint OR NEW.digest IS DISTINCT FROM OLD.digest OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'tlog_anchors: 앵커의 대상은 바뀌지 않는다' USING ERRCODE = '23514';
  END IF;
  IF (OLD.receipt IS NOT NULL AND NEW.receipt IS DISTINCT FROM OLD.receipt)
     OR (OLD.receipt_at IS NOT NULL AND NEW.receipt_at IS DISTINCT FROM OLD.receipt_at)
     OR (OLD.upgraded IS NOT NULL AND NEW.upgraded IS DISTINCT FROM OLD.upgraded) THEN
    RAISE EXCEPTION 'tlog_anchors: 영수증은 한 번만 쓴다' USING ERRCODE = '23514';
  END IF;
  IF OLD.state IN ('confirmed', 'failed')
     OR NOT ((OLD.state, NEW.state) IN (('pending', 'pending'), ('pending', 'submitted'), ('pending', 'confirmed'), ('pending', 'failed'),
                                        ('submitted', 'submitted'), ('submitted', 'confirmed'))) THEN
    RAISE EXCEPTION 'tlog_anchors: 상태 전이 % → % 는 허용되지 않는다', OLD.state, NEW.state USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER tlog_anchors_guard BEFORE INSERT OR UPDATE ON tlog_anchors FOR EACH ROW EXECUTE FUNCTION tlog_anchors_guard();
CREATE TRIGGER tlog_anchors_no_delete BEFORE DELETE ON tlog_anchors FOR EACH ROW EXECUTE FUNCTION reject_row_delete();
CREATE TRIGGER tlog_anchors_no_truncate AFTER TRUNCATE ON tlog_anchors FOR EACH STATEMENT EXECUTE FUNCTION reject_truncate();

-- ---------------------------------------------------------------------------
-- ⑦ 권한
-- ---------------------------------------------------------------------------

-- ---- atmark_tlog — 서열기·에폭·게시(Lambda `atmark-transparency-logger`). 아무것도 소유하지 않는다. ----
GRANT USAGE ON SCHEMA public TO atmark_tlog;
GRANT SELECT ON tlog_outbox TO atmark_tlog;
GRANT UPDATE (processed_at, snapshot) ON tlog_outbox TO atmark_tlog;
GRANT SELECT, INSERT ON tlog_logs TO atmark_tlog;
GRANT SELECT ON tlog_salt_keys TO atmark_tlog;
GRANT INSERT (org_log_id, salt_key) ON tlog_salt_keys TO atmark_tlog;
GRANT SELECT ON tlog_leaves TO atmark_tlog;
GRANT INSERT (org_log_id, seq, kind, source_table, source_id, event, rev, outbox_id, leaf_json, leaf_hash) ON tlog_leaves TO atmark_tlog;
GRANT SELECT ON tlog_keys TO atmark_tlog;
GRANT INSERT (key_id, purpose, public_key) ON tlog_keys TO atmark_tlog;
GRANT SELECT ON tlog_epochs TO atmark_tlog;
GRANT INSERT (epoch, closed_at, epoch_root, org_count, global_leaf, global_leaf_hash, global_root, checkpoint, key_id) ON tlog_epochs TO atmark_tlog;
GRANT UPDATE (published_at) ON tlog_epochs TO atmark_tlog;
GRANT SELECT, INSERT ON tlog_org_heads TO atmark_tlog;
-- 원천 — 잎에 필요한 칸만. 본문·제목·원문 위치·토큰은 없다(주소·Message-ID·세션·스냅샷은 커밋으로만 잎에 간다).
GRANT SELECT (id, agent_id, message_id, reasons, policy_version, approval_id, evaluated_at) ON audit_logs TO atmark_tlog;
GRANT SELECT (id, message_id_header) ON messages TO atmark_tlog;
GRANT SELECT (message_id, address) ON outbound_recipients TO atmark_tlog;
GRANT SELECT (id, session_id, action, target_id, created_at) ON owner_actions TO atmark_tlog;
GRANT SELECT (id, agent_id, version, outbound_mode, inbound_mode, snapshot, created_at) ON policy_versions TO atmark_tlog;
GRANT SELECT (id, agent_id, quarantined, quarantine_reason, policy_reason, from_authenticated, from_address, message_id_header, received_at)
  ON inbound_messages TO atmark_tlog;

-- ---- atmark_tlog_anchor — 외부 앵커(Lambda `atmark-transparency-anchor`). 잎·원천·솔트는 못 읽는다. ----
GRANT USAGE ON SCHEMA public TO atmark_tlog_anchor;
GRANT SELECT (epoch, closed_at, checkpoint, published_at) ON tlog_epochs TO atmark_tlog_anchor;
GRANT SELECT ON tlog_anchors TO atmark_tlog_anchor;
GRANT INSERT (epoch, target, endpoint, digest) ON tlog_anchors TO atmark_tlog_anchor;
GRANT UPDATE (state, attempt_count, next_attempt_at, last_error, receipt, receipt_at, upgraded, confirmed_at) ON tlog_anchors TO atmark_tlog_anchor;
GRANT SELECT ON tlog_keys TO atmark_tlog_anchor;
GRANT INSERT (key_id, purpose, public_key) ON tlog_keys TO atmark_tlog_anchor;

-- ---- atmark_admin — 소유자 콘솔의 무결성 패널·증명·번들(조직 범위는 코드가 SQL 에 박는다). 쓰기 0. ----
GRANT SELECT ON tlog_logs, tlog_leaves, tlog_epochs, tlog_org_heads, tlog_anchors, tlog_keys TO atmark_admin;
GRANT SELECT (org_log_id, salt_key, shredded_at) ON tlog_salt_keys TO atmark_admin;
-- 번들의 원천 대조 — 조직 범위로 감사 행을 고르는 칸(Stage 0 거부처럼 메시지 행이 없는 시도도 조직으로 고른다).
GRANT SELECT (agent_id) ON audit_logs TO atmark_admin;

COMMENT ON TABLE tlog_outbox IS
  '투명성 로그 수집 outbox — 원천 트리거(SECURITY DEFINER)만 INSERT. 처리 표시 한 번(+스냅샷 지우기)만 바뀐다. 앱·admin 권한 0 (ADR-0008 §2.3).';
COMMENT ON TABLE tlog_leaves IS
  '조직별 RFC 9162 머클 로그의 잎 — JCS 문자열 그대로, leaf_hash 는 DB 가 대조. 연속 seq · append-only. 평문에는 모양이 정해진 칸만(ADR-0008 §2.2).';
COMMENT ON TABLE tlog_epochs IS
  '매시 에폭 — 모든 조직 헤드의 에폭 트리 + 전역 공개 로그의 잎 하나 + C2SP 체크포인트(KMS Ed25519). published_at 한 번만.';
COMMENT ON TABLE tlog_anchors IS
  'Phase B 외부 앵커 — OpenTimestamps · Sigstore Rekor v2 영수증. digest = SHA-256(체크포인트). 영수증 한 번만 · 상태 한 방향.';
