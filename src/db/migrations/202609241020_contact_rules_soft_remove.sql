-- 202609241020_contact_rules_soft_remove.sql
-- 정책 v2 연락처 목록의 **지우기를 표시로** 바꾼다 (202609241010 보정 — ADR-0006 "atmark_admin 은 DELETE·TRUNCATE 0" 불변식).
--
-- 무엇이 틀렸나: 202609241010 은 콘솔의 목록 지우기(`DELETE /api/agents/{id}/rules/{ruleId}`)를 위해 `atmark_admin` 에 테이블 DELETE 를
-- 줬다. 그러나 ADR-0006 의 admin 롤 규율은 **DELETE/TRUNCATE/TRIGGER 0** 이다(`test/integration/runtime/restricted-roles.test.ts` 가
-- 고정) — 콘솔 탈취가 행을 **흔적 없이** 지우는 길을 두지 않는다. 목록의 지난 상태는 정책 버전 스냅샷에도 남지만, 행 자체도 남겨
-- "누가 언제 뺐나" 를 행에서 답한다.
--
-- 바꾸는 것:
--   ① `removed_at`·`removed_by` — 지우기 = 두 칸을 **한 번** 채우는 UPDATE. 되살리기·다시 지우기·값 바꾸기는 트리거가 거부한다
--      (다시 넣으려면 새 행 — 새 버전).
--   ② 중복 금지는 **살아 있는 행만**(부분 유니크) — 지운 값을 다시 넣을 수 있다.
--   ③ 상한(1000)도 살아 있는 행만 센다.
--   ④ 권한: `atmark_admin` 의 DELETE 를 거두고 `UPDATE (removed_at, removed_by)` 만. DELETE 는 모든 롤에 트리거로 막는다.
--   ⑤ 읽는 쪽(관문·수신 소비자·신뢰 사실·관리 연산·스냅샷)은 전부 `removed_at IS NULL` 만 본다.

ALTER TABLE agent_contact_rules
  ADD COLUMN removed_at timestamptz,
  ADD COLUMN removed_by text CONSTRAINT agent_contact_rules_removed_by_check
    CHECK (removed_by IS NULL OR length(removed_by) BETWEEN 1 AND 200),
  -- 둘은 함께 채워지거나 함께 비어 있다 — 누가 뺐는지 모르는 지우기가 없다.
  ADD CONSTRAINT agent_contact_rules_removed_shape CHECK ((removed_at IS NULL) = (removed_by IS NULL));

COMMENT ON COLUMN agent_contact_rules.removed_at IS
  '지운 시각(202609241020). NULL = 살아 있는 규칙. 한 번만 채워진다(트리거 agent_contact_rules_remove_once).';

DROP INDEX agent_contact_rules_unique;
CREATE UNIQUE INDEX agent_contact_rules_active_unique
  ON agent_contact_rules (agent_id, direction, list, value) WHERE removed_at IS NULL;

-- 고치기 금지(202609241010 의 `agent_contact_rules_no_update`)를 "지우기 표시 한 번만 허용" 으로 좁혀 바꾼다.
DROP TRIGGER agent_contact_rules_no_update ON agent_contact_rules;

CREATE FUNCTION agent_contact_rules_remove_once() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = public, pg_temp
  AS $fn$
  BEGIN
    IF OLD.removed_at IS NOT NULL THEN
      RAISE EXCEPTION 'agent_contact_rules: 이미 지운 규칙은 바꿀 수 없다 (id=%)', OLD.id USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.removed_at IS NULL
       OR (NEW.id, NEW.agent_id, NEW.direction, NEW.list, NEW.kind, NEW.value, NEW.created_at, NEW.created_by)
          IS DISTINCT FROM (OLD.id, OLD.agent_id, OLD.direction, OLD.list, OLD.kind, OLD.value, OLD.created_at, OLD.created_by) THEN
      RAISE EXCEPTION 'agent_contact_rules: 규칙은 고칠 수 없다 — 지우기 표시(removed_at·removed_by)만 한 번 (id=%)', OLD.id
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END
  $fn$;

CREATE TRIGGER agent_contact_rules_remove_once
  BEFORE UPDATE ON agent_contact_rules
  FOR EACH ROW EXECUTE FUNCTION agent_contact_rules_remove_once();

CREATE TRIGGER agent_contact_rules_no_delete
  BEFORE DELETE ON agent_contact_rules
  FOR EACH ROW EXECUTE FUNCTION reject_row_delete();

-- 상한은 살아 있는 행만.
CREATE OR REPLACE FUNCTION agent_contact_rules_limit() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = public, pg_temp
  AS $fn$
  BEGIN
    IF (SELECT count(*) FROM agent_contact_rules
         WHERE agent_id = NEW.agent_id AND direction = NEW.direction AND list = NEW.list AND removed_at IS NULL) >= 1000 THEN
      RAISE EXCEPTION 'agent_contact_rules_limit' USING ERRCODE = 'check_violation', DETAIL = '에이전트·방향·목록마다 1000';
    END IF;
    RETURN NEW;
  END
  $fn$;

REVOKE DELETE ON agent_contact_rules FROM atmark_admin;
GRANT UPDATE (removed_at, removed_by) ON agent_contact_rules TO atmark_admin;
