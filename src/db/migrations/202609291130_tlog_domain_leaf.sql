-- 202609291130_tlog_domain_leaf.sql
-- 고객 도메인 — 투명성 로그(ADR-0008) 잎 `domain.status`(ADR-0014 · 계획 §3.2 M5 · §3.10).
--
--   ① 잎 종류 CHECK 교체 — **적용 시점 DB 의 현재 목록**(202609270115 tlog v4 — `identity.address_retired` 포함) + `domain.status`.
--      교체형 CHECK 라 목록을 빠뜨리면 그 종류의 과거 잎 INSERT 경로가 죽는다 — arch `test/arch/tlog-kind-check.arch.test.ts` 가 "각 교체는 앞 정의의
--      상위 집합" 과 "마지막 정의 = `ORG_LEAF_KINDS`" 를 본다.
--   ② outbox 원천 CHECK · 스냅샷 CHECK 교체 — 현재 목록 + `custom_domains`(스냅샷을 싣는 변경 가능 원천).
--   ③ 새 CHECK `tlog_leaves_domain_source` — `domain.status` 잎은 `custom_domains` 에서만, 다른 잎은 `custom_domains` 를 가리키지 않는다.
--   ④ `tlog_enqueue()` 재정의 — 202609270115 의 정의를 **줄마다 그대로** 담고 두 곳만 더한다(조직·원천 id 분기 · 스냅샷 분기). 스냅샷 = 상태 ·
--      정지 사유 · 수신 MX 판정 · 행의 updated_at. 도메인 이름은 스냅샷에도 잎 평문에도 없다 — 서열기가 행에서 읽어 **커밋**으로만(잎은
--      append-only 라 지울 수 없다 — `identity.address_assigned` 와 같은 규율, N7).
--   ⑤ 트리거 — `custom_domains` AFTER INSERT · AFTER UPDATE(상태 · 정지 사유 · 수신 MX 가 실제로 바뀔 때만 — `WHEN`). 칼럼 목록(`UPDATE OF`)을
--      쓰지 않는 이유: admin 의 제거 요청은 `removal_requested_at` 만 SET 하고 **트리거가** 상태를 removed 로 바꾼다 — `UPDATE OF status` 는 SET
--      목록으로만 불려 그 전이를 놓친다.
--   ⑥ `atmark_tlog` 에 `custom_domains (id, domain)` SELECT — 서열기가 도메인 이름(커밋 재료)과 행의 존재만 본다.
--
-- **운영 무변화(단계 0).** `custom_domains` 에 행을 만드는 코드 경로가 아직 없다(기능 허용 목록 비어 있음 · 연산은 단계 4). 서열기
-- (`src/tlog/sequencer.ts`)는 이 커밋에서 `custom_domains` 원천을 이미 안다 — 새 원천을 모르는 옛 서열기는 `UnknownSourceTableError` 로 배치를
-- 되돌리므로, 배포 순서는 202609270115 와 같다(새 서열기 `AtmarkTransparency` 먼저 — 계획 §6). 검증기 판 5(`domain.status` 를 아는 판)는 단계 3.
--
-- **잠금 순서(재리뷰 M2c)**: 서열기(`src/tlog/sequencer.ts`)는 배치마다 outbox 를 먼저 읽고 잎을 쓴다 — 이 파일도 outbox CHECK 둘을 먼저, 잎 CHECK 둘을
-- 뒤에 바꾼다(같은 순서라 서로 기다리다 교착하지 않는다). 그래도 운영에서는 **서열 스케줄을 멈추고** 이 파일을 적용한다(런북 deploy §26 ·
-- custom-domains §1 — 202609270115 와 같은 절차). 잎 CHECK 교체의 ACCESS EXCLUSIVE 가 서열 배치 뒤에 줄을 서면 5초 안에 못 잡고 실패한다.
-- 잠금: outbox → 잎 CHECK 넷을 `NOT VALID` 로 다시 더한다(표를 훑지 않는다 — 검증은 202609291131) · 함수 교체 · 트리거 둘 · GRANT.
-- 5초 안에 못 잡으면 실패하고 아무것도 바뀌지 않는다.

SET LOCAL lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- ② outbox 원천 · 스냅샷 CHECK — 현재 목록 + custom_domains
-- ---------------------------------------------------------------------------

ALTER TABLE tlog_outbox DROP CONSTRAINT tlog_outbox_source_table_check;
ALTER TABLE tlog_outbox ADD CONSTRAINT tlog_outbox_source_table_check CHECK (source_table IN (
  'audit_logs', 'owner_actions', 'policy_versions', 'inbound_messages',
  'agents', 'agent_addresses', 'agent_keypairs', 'passport_documents', 'org_entitlements', 'custom_domains')) NOT VALID;

ALTER TABLE tlog_outbox DROP CONSTRAINT tlog_outbox_snapshot_shape;
ALTER TABLE tlog_outbox ADD CONSTRAINT tlog_outbox_snapshot_shape
  CHECK (source_table IN ('audit_logs', 'agents', 'org_entitlements', 'custom_domains') OR snapshot IS NULL) NOT VALID;

-- ---------------------------------------------------------------------------
-- ① 잎 종류 CHECK — 현재 목록(tlog v4) + domain.status
-- ---------------------------------------------------------------------------

ALTER TABLE tlog_leaves DROP CONSTRAINT tlog_leaves_kind_check;
ALTER TABLE tlog_leaves ADD CONSTRAINT tlog_leaves_kind_check CHECK (kind IN (
  'org.genesis', 'audit.evaluated', 'audit.updated', 'owner.action', 'policy.version', 'inbound.verdict', 'source.missing',
  'identity.agent_created', 'identity.agent_updated', 'identity.address_assigned', 'identity.key_bound', 'identity.passport_version',
  'billing.entitlement', 'identity.address_retired', 'domain.status')) NOT VALID;

-- ---------------------------------------------------------------------------
-- ③ domain.status 잎은 custom_domains 에서만
-- ---------------------------------------------------------------------------

ALTER TABLE tlog_leaves ADD CONSTRAINT tlog_leaves_domain_source CHECK (
  CASE
    WHEN kind IN ('org.genesis', 'source.missing') THEN true
    WHEN kind = 'domain.status' THEN source_table = 'custom_domains'
    ELSE source_table IS DISTINCT FROM 'custom_domains'
  END) NOT VALID;

COMMENT ON CONSTRAINT tlog_leaves_domain_source ON tlog_leaves IS
  'domain.status 잎은 custom_domains 원천에서만(ADR-0014). source.missing 은 어느 원천이든.';

-- ---------------------------------------------------------------------------
-- ④ tlog_enqueue() — 202609270115 정의 그대로 + custom_domains 두 분기
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
  ELSIF TG_TABLE_NAME = 'custom_domains' THEN
    -- 고객 도메인(202609291130, ADR-0014) — 조직 칸이 행에 있다. 원천 id = 도메인 행 id.
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
  ELSIF TG_TABLE_NAME = 'custom_domains' THEN
    -- 고객 도메인(202609291130, ADR-0014) — 그때 값(상태 · 정지 사유 · 수신 MX 판정 · 행의 updated_at = 잎의 at). 도메인 이름은 스냅샷에 싣지 않는다
    -- (불변 칸 — 서열기가 행에서 읽어 커밋으로만 잎에 넣는다).
    IF event = 'update' THEN
      SELECT coalesce(max(o.rev), 0) + 1 INTO next_rev
        FROM tlog_outbox o
       WHERE o.source_table = 'custom_domains' AND o.source_id = src_id AND o.event = 'update';
    END IF;
    snap := jsonb_build_object(
      'status', NEW.status,
      'suspended_reason', NEW.suspended_reason,
      'inbound_mx_status', NEW.inbound_mx_status,
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

-- ---------------------------------------------------------------------------
-- ⑤ 트리거 · ⑥ GRANT
-- ---------------------------------------------------------------------------

CREATE TRIGGER custom_domains_tlog_enqueue_insert AFTER INSERT ON custom_domains FOR EACH ROW EXECUTE FUNCTION tlog_enqueue();
CREATE TRIGGER custom_domains_tlog_enqueue_update AFTER UPDATE ON custom_domains FOR EACH ROW
  WHEN (OLD.status IS DISTINCT FROM NEW.status OR OLD.suspended_reason IS DISTINCT FROM NEW.suspended_reason
        OR OLD.inbound_mx_status IS DISTINCT FROM NEW.inbound_mx_status)
  EXECUTE FUNCTION tlog_enqueue();

GRANT SELECT (id, domain) ON custom_domains TO atmark_tlog;
