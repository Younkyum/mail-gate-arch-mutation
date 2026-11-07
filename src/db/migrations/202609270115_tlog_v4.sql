-- 202609270115_tlog_v4.sql
-- 메일 기본기 2차 — 투명성 로그(ADR-0008) **v4**: 잎 모양 변경 둘을 한 파일·한 번의 `tlog_enqueue()` 재정의로 묶는다
-- (`.omc/plans/mail-basics.md` §4 D6 · §5 · §6 2차, 위험 R15·R17). 검증기 판은 한 번만 올린다(3 → 4).
--
--   ① `billing.entitlement` 스냅샷에 두 칸(`aliases_per_agent_max` · `attachment_bytes_total_max`, 202609270105)을 싣는다 — 잎이 11칸이 된다.
--      **서열기는 스냅샷에 있는 키만 잎에 옮기고**(`src/tlog/sequencer.ts`), 새 빌더는 새 두 칸을 "둘 다 있거나 둘 다 없음" 으로 받는다
--      (`src/tlog/leaf.ts`) — 이 파일 앞에 outbox 에 남은 9칸 스냅샷은 9칸 잎이 된다(`source.missing` 이 아니다, 계획 F18). 과거 9칸 잎의 해시는
--      그대로다(JCS 는 있는 키만 정렬한다). 모든 조직의 11칸 잎은 202609270120 백필 UPDATE 가 만든다.
--   ② 새 잎 `identity.address_retired` — 원천 `agent_addresses` 의 **UPDATE**(폐기, 202609270110). 스냅샷 없음(폐기 칸은 쓰기 1회 — 서열 시점의
--      행이 그때 값이다). 잎 평문 = 에이전트 id, 주소는 커밋으로만(추가 잎 `identity.address_assigned` 와 같은 규율 — 평문 `@` 0).
--
-- `tlog_enqueue()` 는 202609250300 의 정의를 **글자 그대로** 옮기고 두 곳만 더했다(org_entitlements 스냅샷 두 줄 · agent_addresses 갱신 분기).
-- 단위 테스트 `test/unit/tlog/tlog-v4-sql.test.ts` 가 0300 정의의 모든 줄이 이 파일의 정의에 있는지 본다(R17).
--
-- **배포 순서**(런북 deploy §23): 새 서열기(`AtmarkTransparency`)가 먼저다 — 옛 서열기는 `agent_addresses` 의 update 사건을 주소 추가 잎으로
-- 만들다가 잎 CHECK(`tlog_leaves_identity_source`)에 막혀 배치째 되돌아간다(되돌릴 수 없는 잎은 생기지 않지만 서열이 멈춘다). 스케줄을 멈추고
-- outbox 잔량 0 을 확인한 뒤 이 파일을 적용한다.
--
-- 잠금: 잎 CHECK 둘을 바꾼다 — **`NOT VALID`** 로 다시 더하고 기존 잎 검증은 202609270116 이 한다(SHARE UPDATE EXCLUSIVE). 함수 교체와 트리거
-- 하나는 짧은 잠금이다. 5초 안에 못 잡으면 실패하고 아무것도 바뀌지 않는다.

SET LOCAL lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- ① 잎 종류 · 원천 CHECK (NOT VALID — 검증은 0116)
-- ---------------------------------------------------------------------------

ALTER TABLE tlog_leaves DROP CONSTRAINT tlog_leaves_kind_check;
ALTER TABLE tlog_leaves ADD CONSTRAINT tlog_leaves_kind_check CHECK (kind IN (
  'org.genesis', 'audit.evaluated', 'audit.updated', 'owner.action', 'policy.version', 'inbound.verdict', 'source.missing',
  'identity.agent_created', 'identity.agent_updated', 'identity.address_assigned', 'identity.key_bound', 'identity.passport_version',
  'billing.entitlement', 'identity.address_retired')) NOT VALID;

ALTER TABLE tlog_leaves DROP CONSTRAINT tlog_leaves_identity_source;
ALTER TABLE tlog_leaves ADD CONSTRAINT tlog_leaves_identity_source CHECK (
  CASE
    WHEN kind IN ('org.genesis', 'source.missing') THEN true
    WHEN kind = 'identity.agent_created' THEN source_table = 'agents' AND event = 'insert'
    WHEN kind = 'identity.agent_updated' THEN source_table = 'agents' AND event = 'update'
    WHEN kind = 'identity.address_assigned' THEN source_table = 'agent_addresses' AND event = 'insert'
    WHEN kind = 'identity.address_retired' THEN source_table = 'agent_addresses' AND event = 'update'
    WHEN kind = 'identity.key_bound' THEN source_table = 'agent_keypairs' AND event = 'insert'
    WHEN kind = 'identity.passport_version' THEN source_table = 'passport_documents' AND event = 'insert'
    ELSE source_table NOT IN ('agents', 'agent_addresses', 'agent_keypairs', 'passport_documents')
  END) NOT VALID;

COMMENT ON CONSTRAINT tlog_leaves_identity_source ON tlog_leaves IS
  'identity.* 잎은 제 원천에서만 — US-013, ADR-0008 §2.2. address_retired = agent_addresses 의 update(tlog v4, ADR-0013 A6).';

-- ---------------------------------------------------------------------------
-- ② 원천 → outbox (202609250300 의 함수를 넓힌다 — 기존 아홉 원천의 동작은 한 글자도 다르지 않다)
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
  ELSIF TG_TABLE_NAME = 'org_entitlements' THEN
    org := NEW.organization_id;
    src_id := NEW.organization_id::text;
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
  ELSIF TG_TABLE_NAME = 'org_entitlements' THEN
    -- 그때 값(서열 시점의 행을 읽으면 두 번 바뀐 행의 중간 버전이 사라진다). 금액·고객 id 는 이 표에 없다.
    IF event = 'update' THEN
      SELECT coalesce(max(o.rev), 0) + 1 INTO next_rev
        FROM tlog_outbox o
       WHERE o.source_table = 'org_entitlements' AND o.source_id = src_id AND o.event = 'update';
    END IF;
    snap := jsonb_build_object(
      'plan_code', NEW.plan_code,
      'cause', NEW.cause,
      'version', NEW.version,
      'max_agents', NEW.max_agents,
      'org_daily_recipients', NEW.org_daily_recipients,
      'agent_per_day_max', NEW.agent_per_day_max,
      'agent_per_minute_max', NEW.agent_per_minute_max,
      'recipients_per_message_max', NEW.recipients_per_message_max,
      'tokens_per_agent_max', NEW.tokens_per_agent_max,
      'webhook_endpoints_per_agent_max', NEW.webhook_endpoints_per_agent_max,
      'org_api_keys_max', NEW.org_api_keys_max,
      'inbound_storage_bytes', NEW.inbound_storage_bytes,
      -- tlog v4(202609270115) — 메일 기본기 2차 두 칸. 202609270105 의 채움 트리거가 있어 이 뒤의 쓰기는 두 칸이 늘 함께 있다.
      'aliases_per_agent_max', NEW.aliases_per_agent_max,
      'attachment_bytes_total_max', NEW.attachment_bytes_total_max,
      'grace_until', to_char(NEW.grace_until AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
      'at', to_char(NEW.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'));
  ELSIF TG_TABLE_NAME = 'agent_addresses' AND event = 'update' THEN
    -- tlog v4 — 별칭 폐기(retired_at NULL → 값, 쓰기 1회 — 202609270110 가드). 스냅샷 없음: 폐기 칸은 다시 바뀌지 않으므로 서열 시점의 행이
    -- 그때 값이다(잎 `identity.address_retired`, at = retired_at).
    SELECT coalesce(max(o.rev), 0) + 1 INTO next_rev
      FROM tlog_outbox o
     WHERE o.source_table = 'agent_addresses' AND o.source_id = src_id AND o.event = 'update';
  END IF;
  INSERT INTO tlog_outbox (source_table, source_id, event, rev, organization_id, snapshot)
  VALUES (TG_TABLE_NAME, src_id, event, next_rev, org, snap);
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION tlog_enqueue() FROM PUBLIC;

-- 폐기(NULL → 값)에만. 다른 칸의 UPDATE(소유자 롤의 운영 복구)는 잎을 만들지 않는다 — 202609242200 의 주소 잎도 INSERT 만이었다.
CREATE TRIGGER agent_addresses_tlog_enqueue_retire AFTER UPDATE OF retired_at ON agent_addresses FOR EACH ROW
  WHEN (OLD.retired_at IS NULL AND NEW.retired_at IS NOT NULL)
  EXECUTE FUNCTION tlog_enqueue();

-- ---------------------------------------------------------------------------
-- ③ 권한 — 서열 롤은 폐기 시각을 읽는다(잎의 at). 허용 목록 `RESTRICTED_ROLE_GRANTS`.
-- ---------------------------------------------------------------------------

GRANT SELECT (retired_at) ON agent_addresses TO atmark_tlog;
