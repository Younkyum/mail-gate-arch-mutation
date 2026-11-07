-- 202609242200_tlog_identity_leaves.sql
-- US-013 — 에이전트 **신원 사건**을 투명성 로그(ADR-0008)에 담는다. 202609241600·1800 을 고치지 않고 위에 얹는다(적용 이력의 체크섬을 지킨다).
--
--   ① 원천 넷 — `agents`(생성 · 이름/상태/정지 주체 변경) · `agent_addresses`(주소 연결) · `agent_keypairs`(키 연결) ·
--      `passport_documents`(서명된 passport 버전 — draft 는 문서가 없으므로 잎도 없다, ADR-0002 B5). 같은 outbox 트리거 함수
--      `tlog_enqueue()`(SECURITY DEFINER)를 넓힌다 — 트리거는 경로 수와 무관하다(ADR-0008 §2.3).
--   ② 잎 종류 다섯 — `identity.agent_created` · `identity.agent_updated` · `identity.address_assigned` · `identity.key_bound` ·
--      `identity.passport_version`. 봉투(v1)·해시 규칙은 그대로다 — 기존 잎·검증기 형식과 호환(append-only).
--      평문은 모양이 정해진 값뿐(에이전트 id · 상태 코드 · 정수 · 불리언 · hex64 지문). **이름과 주소는 조직 솔트 커밋으로만**(§2.2).
--      공개키는 평문이 아니라 지문 `key_fp = hex(SHA-256(원시 32바이트 공개키))` — ADR-0008 Q8 이 공개 값으로 본 것의 해시다.
--   ③ `agents` 는 변경 가능한 행이다 — 갱신 사건(rev 1,2,…)마다 **그때 값**(이름 · 상태 · 정지 주체 · 바뀐 칸 목록)을 outbox 스냅샷에
--      싣는다(서열 뒤 NULL 로 지운다 — audit_logs 와 같은 규율). 서열 시점의 행을 읽으면 두 번 바뀐 행의 중간 상태가 사라진다.
--   ④ 잎 종류 ↔ 원천 테이블 대응을 DB 가 본다(CHECK) — identity 잎은 제 원천에서만, 다른 잎은 identity 원천을 가리키지 않는다
--      (`source.missing` 은 어느 원천이든 — 서열 시점에 행이 없었다는 사실).
--   ⑤ 권한 — 서열 롤(`atmark_tlog`)에 잎에 필요한 칸만 SELECT(이름은 스냅샷으로 오므로 `agents.name` 은 주지 않는다). admin 은 이미
--      네 테이블을 읽는다(202609230720 · 202609241200) — 콘솔 블록 API 가 표시 값을 DB 에서 고르고 잎의 커밋과 대조한다.
--
-- 도입 전 행은 채우지 않는다(backfill 없음) — 과거 시각의 잎을 지금 끼워 넣으면 "그 시각에 기록됐다" 로 읽힌다(ADR-0008 T3).
-- 도입 전 에이전트의 블록은 다음 신원 사건부터 생긴다.
--
-- 잠금(적대적 검증 L2): 트리거 생성·CHECK 교체는 원천 넷과 tlog 테이블에 강한 잠금을 잡는다. 긴 트랜잭션 뒤에서 줄을 서면 그 뒤의 모든
-- 발신·로그인 쓰기가 막힌다 — 5초 안에 못 잡으면 실패하고 다시 돌린다. `SET LOCAL` 은 이 파일의 트랜잭션에만 걸린다(러너 = 파일 하나당
-- BEGIN/COMMIT, `src/db/migrate.ts`). 배포 순서는 런북 deploy §19(새 서열기 먼저).

SET LOCAL lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- ① outbox · 잎 CHECK 넓히기
-- ---------------------------------------------------------------------------

ALTER TABLE tlog_outbox DROP CONSTRAINT tlog_outbox_source_table_check;
ALTER TABLE tlog_outbox ADD CONSTRAINT tlog_outbox_source_table_check CHECK (source_table IN (
  'audit_logs', 'owner_actions', 'policy_versions', 'inbound_messages',
  'agents', 'agent_addresses', 'agent_keypairs', 'passport_documents'));

-- 스냅샷은 변경 가능한 원천(audit_logs · agents)만.
ALTER TABLE tlog_outbox DROP CONSTRAINT tlog_outbox_snapshot_shape;
ALTER TABLE tlog_outbox ADD CONSTRAINT tlog_outbox_snapshot_shape CHECK (source_table IN ('audit_logs', 'agents') OR snapshot IS NULL);

ALTER TABLE tlog_leaves DROP CONSTRAINT tlog_leaves_kind_check;
ALTER TABLE tlog_leaves ADD CONSTRAINT tlog_leaves_kind_check CHECK (kind IN (
  'org.genesis', 'audit.evaluated', 'audit.updated', 'owner.action', 'policy.version', 'inbound.verdict', 'source.missing',
  'identity.agent_created', 'identity.agent_updated', 'identity.address_assigned', 'identity.key_bound', 'identity.passport_version'));

ALTER TABLE tlog_leaves ADD CONSTRAINT tlog_leaves_identity_source CHECK (
  CASE
    WHEN kind IN ('org.genesis', 'source.missing') THEN true
    WHEN kind = 'identity.agent_created' THEN source_table = 'agents' AND event = 'insert'
    WHEN kind = 'identity.agent_updated' THEN source_table = 'agents' AND event = 'update'
    WHEN kind = 'identity.address_assigned' THEN source_table = 'agent_addresses' AND event = 'insert'
    WHEN kind = 'identity.key_bound' THEN source_table = 'agent_keypairs' AND event = 'insert'
    WHEN kind = 'identity.passport_version' THEN source_table = 'passport_documents' AND event = 'insert'
    ELSE source_table NOT IN ('agents', 'agent_addresses', 'agent_keypairs', 'passport_documents')
  END);

-- ---------------------------------------------------------------------------
-- ② 원천 → outbox (202609241600 의 함수를 넓힌다 — 기존 넷의 동작은 한 글자도 다르지 않다)
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION tlog_enqueue() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  org uuid;
  event text := CASE TG_OP WHEN 'INSERT' THEN 'insert' ELSE 'update' END;
  next_rev integer := 0;
  snap jsonb := NULL;
  src_id text;
  changed text[] := ARRAY[]::text[];
BEGIN
  IF TG_TABLE_NAME IN ('owner_actions', 'agents') THEN
    org := NEW.organization_id;
    src_id := NEW.id::text;
  ELSIF TG_TABLE_NAME = 'agent_keypairs' THEN
    SELECT a.organization_id INTO org FROM agents a WHERE a.id = NEW.agent_id;
    src_id := NEW.agent_id::text;
  ELSIF TG_TABLE_NAME = 'passport_documents' THEN
    SELECT a.organization_id INTO org FROM passports p JOIN agents a ON a.id = p.agent_id WHERE p.id = NEW.passport_id;
    src_id := NEW.passport_id::text;
  ELSE
    SELECT a.organization_id INTO org FROM agents a WHERE a.id = NEW.agent_id;
    src_id := NEW.id::text;
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
       WHERE o.source_table = 'audit_logs' AND o.source_id = src_id AND o.event = 'update';
    END IF;
  ELSIF TG_TABLE_NAME = 'agents' THEN
    IF event = 'update' THEN
      IF OLD.name IS DISTINCT FROM NEW.name THEN changed := array_append(changed, 'name'); END IF;
      IF OLD.status IS DISTINCT FROM NEW.status THEN changed := array_append(changed, 'status'); END IF;
      IF OLD.suspended_by IS DISTINCT FROM NEW.suspended_by THEN changed := array_append(changed, 'suspended_by'); END IF;
      SELECT coalesce(max(o.rev), 0) + 1 INTO next_rev
        FROM tlog_outbox o
       WHERE o.source_table = 'agents' AND o.source_id = src_id AND o.event = 'update';
    END IF;
    snap := jsonb_build_object(
      'name', NEW.name,
      'status', NEW.status::text,
      'suspended_by', NEW.suspended_by,
      'changed', to_jsonb(changed));
  END IF;
  INSERT INTO tlog_outbox (source_table, source_id, event, rev, organization_id, snapshot)
  VALUES (TG_TABLE_NAME, src_id, event, next_rev, org, snap);
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION tlog_enqueue() FROM PUBLIC;

CREATE TRIGGER agents_tlog_enqueue_insert AFTER INSERT ON agents FOR EACH ROW EXECUTE FUNCTION tlog_enqueue();
CREATE TRIGGER agents_tlog_enqueue_update AFTER UPDATE ON agents FOR EACH ROW
  WHEN (OLD.name IS DISTINCT FROM NEW.name OR OLD.status IS DISTINCT FROM NEW.status OR OLD.suspended_by IS DISTINCT FROM NEW.suspended_by)
  EXECUTE FUNCTION tlog_enqueue();
CREATE TRIGGER agent_addresses_tlog_enqueue AFTER INSERT ON agent_addresses FOR EACH ROW EXECUTE FUNCTION tlog_enqueue();
CREATE TRIGGER agent_keypairs_tlog_enqueue AFTER INSERT ON agent_keypairs FOR EACH ROW EXECUTE FUNCTION tlog_enqueue();
CREATE TRIGGER passport_documents_tlog_enqueue AFTER INSERT ON passport_documents FOR EACH ROW EXECUTE FUNCTION tlog_enqueue();

-- ---------------------------------------------------------------------------
-- ③ 권한 — 서열 롤은 잎에 필요한 칸만(이름은 스냅샷으로 온다)
-- ---------------------------------------------------------------------------

GRANT SELECT (id, created_at) ON agents TO atmark_tlog;
GRANT SELECT (id, agent_id, address, is_primary, created_at) ON agent_addresses TO atmark_tlog;
GRANT SELECT (agent_id, public_key, algorithm, created_at) ON agent_keypairs TO atmark_tlog;
GRANT SELECT (passport_id, created_at) ON passport_documents TO atmark_tlog;
GRANT SELECT (id, agent_id, version, status, content_hash) ON passports TO atmark_tlog;

COMMENT ON CONSTRAINT tlog_leaves_identity_source ON tlog_leaves IS
  'identity.* 잎은 제 원천(agents · agent_addresses · agent_keypairs · passport_documents)에서만 — US-013, ADR-0008 §2.2.';
