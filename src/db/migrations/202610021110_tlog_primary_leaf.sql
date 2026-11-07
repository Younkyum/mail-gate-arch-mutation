-- 202610021110_tlog_primary_leaf.sql
-- 대표 주소 선택 — 투명성 로그(ADR-0008) 잎 `identity.primary_set`(ADR-0014 2026-10 개정 · 포인터 모델). 잎 모양 · 빌더 · 서열 분기 · 검증기 판 5 는
-- 단계 3(M2)이 먼저 넣었고(`STAGED_*` — DB 보다 먼저 코드가 아는 종류), 이 파일이 DB 쪽을 연다. 같은 커밋에서 코드의 `STAGED_*` 값을
-- `ORG_LEAF_KINDS` · `IDENTITY_LEAF_KINDS` · `TLOG_SOURCE_TABLES` 로 옮긴다(arch `tlog-kind-check` — "마지막 CHECK = 코드 목록").
--
--   ① outbox 원천 CHECK 교체 — **적용 시점 DB 의 현재 목록**(202609291130) + `agent_primary_changes`. 스냅샷 CHECK 는 그대로(append-only 원천이라 서열
--      시점의 행이 그때 값이다 — `agent_addresses` insert 와 같다).
--   ② 잎 종류 CHECK 교체 — 현재 목록(202609291130) + `identity.primary_set`.
--   ③ 신원 원천 CHECK 교체(202609270115 의 상위 집합) — `identity.primary_set` 은 `agent_primary_changes` 의 insert 에서만, 다른 잎은 그 원천을 가리키지
--      않는다.
--   ④ `tlog_enqueue()` 재정의 — 202609291130 의 정의를 **줄마다 그대로** 담고 조직·원천 id 분기 하나만 더한다(조직 = 에이전트의 조직, 원천 id = 선택 행
--      id, 스냅샷 없음). 그 전에도 마지막 ELSE 가 같은 값을 냈지만 원천을 이름으로 적어 둔다(1130 의 custom_domains 와 같은 규율).
--   ⑤ 트리거 `agent_primary_changes_tlog_enqueue`(AFTER INSERT) · ⑥ `atmark_tlog` 에 서열기가 읽는 칸 SELECT.
--   평문은 에이전트 id · 원인 코드뿐이고 주소는 커밋으로만(평문 `@` 0 — `identity.address_assigned` 와 같은 규율).
--
-- **검증기:** 판 5(M2)는 번들에 `domain.status` 또는 이 잎이 있을 때만 min 5 를 요구한다 — 이 잎은 M2 배포 뒤에만 생긴다(행을 만드는 경로가 M3b ·
-- 기능 허용 목록 비어 있음).
-- **잠금 순서(202609291130 과 같다)**: 서열기는 outbox 를 먼저 읽고 잎을 쓴다 — outbox CHECK 를 먼저, 잎 CHECK 둘을 뒤에. 운영에서는 **서열 스케줄을
-- 멈추고** 적용한다(deploy §26 · 1130 과 같은 절차). 잠금: CHECK 셋을 `NOT VALID` 로(표를 훑지 않는다 — 검증은 202610021111) · 함수 교체 · 트리거 ·
-- GRANT. 5초 안에 못 잡으면 실패하고 아무것도 바뀌지 않는다.

SET LOCAL lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- ① outbox 원천 CHECK — 현재 목록 + agent_primary_changes
-- ---------------------------------------------------------------------------

ALTER TABLE tlog_outbox DROP CONSTRAINT tlog_outbox_source_table_check;
ALTER TABLE tlog_outbox ADD CONSTRAINT tlog_outbox_source_table_check CHECK (source_table IN (
  'audit_logs', 'owner_actions', 'policy_versions', 'inbound_messages',
  'agents', 'agent_addresses', 'agent_keypairs', 'passport_documents', 'org_entitlements', 'custom_domains', 'agent_primary_changes')) NOT VALID;

-- ---------------------------------------------------------------------------
-- ② 잎 종류 CHECK — 현재 목록 + identity.primary_set
-- ---------------------------------------------------------------------------

ALTER TABLE tlog_leaves DROP CONSTRAINT tlog_leaves_kind_check;
ALTER TABLE tlog_leaves ADD CONSTRAINT tlog_leaves_kind_check CHECK (kind IN (
  'org.genesis', 'audit.evaluated', 'audit.updated', 'owner.action', 'policy.version', 'inbound.verdict', 'source.missing',
  'identity.agent_created', 'identity.agent_updated', 'identity.address_assigned', 'identity.key_bound', 'identity.passport_version',
  'billing.entitlement', 'identity.address_retired', 'domain.status', 'identity.primary_set')) NOT VALID;

-- ---------------------------------------------------------------------------
-- ③ 신원 원천 CHECK — 202609270115 + primary_set
-- ---------------------------------------------------------------------------

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
    WHEN kind = 'identity.primary_set' THEN source_table = 'agent_primary_changes' AND event = 'insert'
    ELSE source_table NOT IN ('agents', 'agent_addresses', 'agent_keypairs', 'passport_documents', 'agent_primary_changes')
  END) NOT VALID;

COMMENT ON CONSTRAINT tlog_leaves_identity_source ON tlog_leaves IS
  'identity.* 잎은 제 원천에서만 — US-013, ADR-0008 §2.2. address_retired = agent_addresses update(tlog v4) · primary_set = agent_primary_changes insert(ADR-0014 2026-10).';

-- ---------------------------------------------------------------------------
-- ④ tlog_enqueue() — 202609291130 정의 그대로 + agent_primary_changes 분기
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
  ELSIF TG_TABLE_NAME = 'agent_primary_changes' THEN
    -- 대표 주소 선택(202610021110, ADR-0014 2026-10 개정) — 조직 = 에이전트의 조직, 원천 id = 선택 행 id. append-only 라 스냅샷 없음.
    SELECT a.organization_id INTO org FROM agents a WHERE a.id = NEW.agent_id;
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

CREATE TRIGGER agent_primary_changes_tlog_enqueue AFTER INSERT ON agent_primary_changes FOR EACH ROW EXECUTE FUNCTION tlog_enqueue();

GRANT SELECT (id, agent_id, address, cause, created_at) ON agent_primary_changes TO atmark_tlog;
