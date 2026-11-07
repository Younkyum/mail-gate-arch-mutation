-- 202609241040_policy_v2_corrections.sql
-- 정책 v2 이전(202609241010)·목록 규칙의 **보정** — 검증(POLICY V2 리뷰) M1·M2·M3·M4·L1 (ADR-0007 "이전 보정" 절).
--
-- 1000~1030 은 운영에 아직 적용되지 않았지만, 이미 적용된 파일은 고치지 않는다(append-only) — 이 파일이 그 뒤에서 바로잡는다.
-- 운영에서는 1010 과 같은 배포에서 연달아 돈다(파일 하나 = 트랜잭션 하나).
--
-- 무엇이 틀렸나 → 무엇을 하나:
--   M1  옛 `unrestricted` + 비어 있지 않은 옛 blocklist → 1010 이 `unrestricted` 로 두고 block 행을 만들었다. 그런데 v2 의 "전체" 는
--       차단 목록을 **읽지 않는다** — 예전에 막히던 상대가 열렸다(넓어지는 이전). → 그런 에이전트는 `blocklist_only` 로(새 버전).
--   M4  1010 이 발신 허용을 넓혔다 — 세 갈래를 되돌린다(1010 이 만든 행만, `created_by = 'migration:202609241010'`):
--       (a) `@` 없는 옛 allowlist 항목 → 도메인 규칙이 됐다. 옛 엔진은 allowlist 를 **주소 정확 일치**로만 봤다(수신자는 늘 `@` 가
--           있다) — 그 항목은 아무것도 열지 않았는데 v2 에서는 도메인 전체를 연다.
--       (b) 레거시(`approval_required`·`reply_only`) 에이전트의 옛 allowlist 항목 → allow 가 됐다. 옛 엔진의 두 모드는 allowlist 를
--           읽지 않았다(승인·스레드가 문이었다) — 쓰이지 않던 목록이 발송 허가가 됐다.
--       (c) `reply_only` 의 `auto_approve_domains` → allow 가 됐다. 옛 `reply_only` 에서 그 목록은 bootstrap grace(첫 몇 통) 동안만
--           승인 대신 문이었다 — 영구 발송 허가가 됐다.
--       남기는 것: 레거시 에이전트의 seed·approved 관계(주소·도메인 스코프 — 사람이 이름으로 적었거나 승인한 상대)와
--       `approval_required` 의 `auto_approve_domains`(옛 엔진에서도 사람 없이 나가던 도메인, 정확 일치 = v2 도메인 규칙과 같다).
--       옛 `allowlist_only`·`unrestricted`·`disabled` 의 주소 항목은 그대로다(옛 의미 = 새 의미).
--   L1  발신 allow 의 `atmark.ai`·`*.atmark.ai` 도메인 규칙 → 지운다(누가 만들었든). 한 줄이 이 플랫폼의 모든 에이전트를 연다.
--       다른 에이전트는 정확한 주소로만(콘솔 `rule_platform_domain`, 관문 `resolveOutboundRules` 도 버린다).
--   M2  규칙 값의 주소 모양을 **dot-atom** 으로 좁힌다(`atmark_contact_rule_kind` 교체 — `contact-rules.ts` 와 같은 정규식).
--       앞·뒤·연속 점 로컬파트를 받지 않는다(따옴표·역슬래시·끝 점 도메인은 원래 받지 않았다). 기존 행은 다시 검증하지 않는다 —
--       로컬 DB 에 해당 행 0(작성 시 확인); 있어도 dot-atom 수신자와는 맞지 않는 무해한 행이다(관문은 모양 밖 수신자를 받지 않는다).
--   M3  목록 변경이 새 정책 버전 없이 커밋될 수 있었다(atmark_admin·소유자 롤의 직접 INSERT·지우기 표시) — 관문이 살아 있는
--       테이블을 읽어, 판정이 스탬프된 버전의 목록과 갈라졌다(AC-9). 관문은 이제 버전 스냅샷을 읽고(`policy-loader.ts`
--       `snapshotContactRules`), DB 는 **커밋마다 "현재 버전 스냅샷의 목록 = 살아 있는 목록"** 을 본다(아래 제약 트리거 셋,
--       DEFERRABLE INITIALLY DEFERRED — 규칙 쓰기와 버전 추가의 순서는 한 트랜잭션 안에서 자유롭다).
--
-- 바로잡은 에이전트마다 새 버전 한 행(`created_by = 'migration:202609241040'`, 스냅샷 = 바로잡은 뒤의 목록 전문). 지운 규칙은 행이
-- 남는다(`removed_by = 'migration:202609241040'`) — "무엇을 왜 뺐나" 는 이 머리말과 그 표시로 답한다.

-- ---------------------------------------------------------------------------
-- M2 — 값 모양(dot-atom). `src/policy/contact-rules.ts` `CONTACT_RULE_ADDRESS_SHAPE` 와 같은 정규식(통합 테스트가 대조한다).
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION atmark_contact_rule_kind(v text) RETURNS text
  LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
  AS $fn$
    SELECT CASE
      WHEN length(v) <= 254
       AND v ~ '^(?=[^@]{1,64}@)[a-z0-9!#$%&''*+/=?^_`{|}~-]+(\.[a-z0-9!#$%&''*+/=?^_`{|}~-]+)*@[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$'
        THEN 'address'
      WHEN length(v) <= 255
       AND v ~ '^(\*\.)?[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$'
        THEN 'domain'
    END
  $fn$;

-- ---------------------------------------------------------------------------
-- M3 — "현재 버전 스냅샷의 목록 = 살아 있는 목록" (커밋 시점)
-- ---------------------------------------------------------------------------

-- 참 = 일치(또는 판정할 현재 버전이 없다 — 그때 관문·수신 판정은 이미 fail-closed 다). 스냅샷에 `contact_rules` 가 없으면 빈 목록
-- (정책 v2 이전 모양 — `snapshotContactRules` 와 같은 해석). 비교는 (id, 방향, 목록, 종류, 값) 집합 + 개수(스냅샷 안의 중복도 불일치).
-- **전체 비교** — 현재 버전 포인터가 움직일 때(정책 행·버전 행 트리거) 부른다.
CREATE FUNCTION atmark_contact_rules_match_current_version(p_agent_id char(32)) RETURNS boolean
  LANGUAGE sql STABLE
  SET search_path = public, pg_temp
  AS $fn$
    WITH cur AS (
      SELECT coalesce(v.snapshot -> 'contact_rules', '[]'::jsonb) AS rules
        FROM agent_policies p
        JOIN policy_versions v ON v.agent_id = p.agent_id AND v.version = p.current_version
       WHERE p.agent_id = p_agent_id
    ),
    snap AS (
      SELECT e ->> 'id' AS id, e ->> 'direction' AS direction, e ->> 'list' AS list, e ->> 'kind' AS kind, e ->> 'value' AS value
        FROM cur,
             -- 배열이 아니면 모양 틀림 — 맞지 않는 한 원소로 바꿔 불일치로 떨어뜨린다.
             jsonb_array_elements(CASE WHEN jsonb_typeof(cur.rules) = 'array' THEN cur.rules ELSE '[null]'::jsonb END) e
    ),
    live AS (
      SELECT r.id::text AS id, r.direction, r.list, r.kind, r.value
        FROM agent_contact_rules r
       WHERE r.agent_id = p_agent_id AND r.removed_at IS NULL
    )
    SELECT NOT EXISTS (SELECT 1 FROM cur)
        OR (NOT EXISTS (SELECT * FROM snap EXCEPT SELECT * FROM live)
            AND NOT EXISTS (SELECT * FROM live EXCEPT SELECT * FROM snap)
            AND (SELECT count(*) FROM snap) = (SELECT count(*) FROM live))
  $fn$;

COMMENT ON FUNCTION atmark_contact_rules_match_current_version(char) IS
  '정책 v2(202609241040): 현재 버전 스냅샷의 contact_rules(없으면 []) = 살아 있는 agent_contact_rules 인가. 버전 포인터 트리거가 커밋 때 부른다.';

-- 버전 포인터가 움직였다(정책 행 INSERT·current_version UPDATE, 버전 행 INSERT) → 전체 비교.
CREATE FUNCTION atmark_policy_version_rules_check() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = public, pg_temp
  AS $fn$
  BEGIN
    IF NOT atmark_contact_rules_match_current_version(NEW.agent_id) THEN
      RAISE EXCEPTION '연락처 목록 변경은 같은 트랜잭션의 새 정책 버전(스냅샷 contact_rules = 살아 있는 목록)과 함께여야 한다 (agent=%, table=%)',
        NEW.agent_id, TG_TABLE_NAME
        USING ERRCODE = 'check_violation',
              HINT = '관리 연산(admin/ops/rules.ts·policy.ts)은 규칙 쓰기와 appendPolicyVersion 을 한 트랜잭션으로 한다.';
    END IF;
    RETURN NULL;
  END
  $fn$;

-- 규칙 한 행이 바뀌었다 → **그 행의 지금 상태**가 현재 버전 스냅샷과 맞는가(살아 있으면 스냅샷에 그대로 있고, 지웠으면 없다).
-- 행마다 전체 비교를 하면 한 트랜잭션의 대량 쓰기가 제곱이 된다. 이 행 비교 + 포인터가 움직일 때의 전체 비교가 함께 "테이블 =
-- 스냅샷" 을 세운다: 버전이 그대로면 바뀌지 않은 행은 이미 그 스냅샷과 맞았고, 버전이 바뀌면 전체 비교가 돈다.
-- 이벤트가 실은 NEW(쓰던 때의 모습)가 아니라 **커밋 때의 행**을 다시 읽는다 — 같은 트랜잭션에서 더하고 지운 행을 잘못 보지 않게.
CREATE FUNCTION atmark_contact_rule_version_check() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = public, pg_temp
  AS $fn$
  DECLARE
    rule agent_contact_rules%ROWTYPE;
    rules jsonb;
    in_snapshot boolean;
  BEGIN
    SELECT * INTO rule FROM agent_contact_rules WHERE id = NEW.id;
    SELECT coalesce(v.snapshot -> 'contact_rules', '[]'::jsonb) INTO rules
      FROM agent_policies p
      JOIN policy_versions v ON v.agent_id = p.agent_id AND v.version = p.current_version
     WHERE p.agent_id = NEW.agent_id;
    -- 판정할 현재 버전이 없다 — 관문·수신 판정이 이미 fail-closed 다.
    IF NOT FOUND THEN
      RETURN NULL;
    END IF;
    in_snapshot := jsonb_typeof(rules) = 'array'
      AND rules @> jsonb_build_array(jsonb_build_object(
            'id', rule.id, 'direction', rule.direction, 'list', rule.list, 'kind', rule.kind, 'value', rule.value));
    IF (rule.removed_at IS NULL) IS DISTINCT FROM in_snapshot THEN
      RAISE EXCEPTION '연락처 목록 변경은 같은 트랜잭션의 새 정책 버전(스냅샷 contact_rules = 살아 있는 목록)과 함께여야 한다 (agent=%, rule=%)',
        NEW.agent_id, NEW.id
        USING ERRCODE = 'check_violation',
              HINT = '관리 연산(admin/ops/rules.ts·policy.ts)은 규칙 쓰기와 appendPolicyVersion 을 한 트랜잭션으로 한다.';
    END IF;
    RETURN NULL;
  END
  $fn$;

-- 규칙 쓰기(더하기·지우기 표시) — 같은 트랜잭션에 새 버전이 없으면 커밋이 실패한다.
CREATE CONSTRAINT TRIGGER agent_contact_rules_version_check
  AFTER INSERT OR UPDATE ON agent_contact_rules
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION atmark_contact_rule_version_check();

-- 현재 버전 포인터를 옮기는 쪽 — 목록을 싣지 않은(또는 다른 목록을 실은) 버전으로 옮기지 못한다.
CREATE CONSTRAINT TRIGGER agent_policies_rules_version_check
  AFTER INSERT OR UPDATE OF current_version ON agent_policies
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION atmark_policy_version_rules_check();

-- 버전 행을 쓰는 쪽 — 포인터가 이미 그 번호를 가리키는 경우(정책 행을 먼저 쓰는 프로비저닝)도 본다.
CREATE CONSTRAINT TRIGGER policy_versions_rules_version_check
  AFTER INSERT ON policy_versions
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION atmark_policy_version_rules_check();

-- ---------------------------------------------------------------------------
-- 보정 대상 — 1010 이 새 버전을 쓴 에이전트와 그 **직전** 버전의 모드(= 이전 전 모드)
-- ---------------------------------------------------------------------------

CREATE TEMP TABLE atmark_v2fix_agents ON COMMIT DROP AS
SELECT m.agent_id, prev.outbound_mode AS old_mode
  FROM policy_versions m
  JOIN policy_versions prev ON prev.agent_id = m.agent_id AND prev.version = m.version - 1
 WHERE m.created_by = 'migration:202609241010';

CREATE TEMP TABLE atmark_v2fix_touched (agent_id char(32) PRIMARY KEY) ON COMMIT DROP;

-- M4 — 1010 이 만든 발신 allow 중 옛 판정에서 아무것도 열지 않던 것.
WITH removed AS (
  UPDATE agent_contact_rules r
     SET removed_at = now(), removed_by = 'migration:202609241040'
    FROM atmark_v2fix_agents a
   WHERE r.agent_id = a.agent_id
     AND r.removed_at IS NULL
     AND r.created_by = 'migration:202609241010'
     AND r.direction = 'outbound'
     AND r.list = 'allow'
     AND CASE
           -- (b)(c) 레거시: 남기는 것은 seed·approved 관계와 approval_required 의 auto_approve_domains 뿐.
           WHEN a.old_mode IN ('approval_required', 'reply_only') THEN
             NOT EXISTS (
               SELECT 1 FROM sender_relationships s
                WHERE s.agent_id = r.agent_id
                  AND s.trust_category IN ('seed', 'approved')
                  AND s.scope IN ('recipient', 'domain')
                  AND lower(CASE s.scope WHEN 'recipient' THEN s.address ELSE s.domain END) = r.value
             )
             AND NOT (
               a.old_mode = 'approval_required'
               AND EXISTS (
                 SELECT 1
                   FROM agent_policies p,
                        jsonb_array_elements_text(CASE WHEN jsonb_typeof(p.config_json -> 'auto_approve_domains') = 'array'
                                                       THEN p.config_json -> 'auto_approve_domains' ELSE '[]'::jsonb END) d
                  WHERE p.agent_id = r.agent_id AND lower(btrim(d)) = r.value
               )
             )
           -- (a) 그 밖의 모드: 1010 이 이 모드들에서 만든 allow 는 옛 allowlist 에서만 왔다 — 도메인 모양이면 `@` 없는 항목이었다.
           ELSE r.kind = 'domain'
         END
  RETURNING r.agent_id
)
INSERT INTO atmark_v2fix_touched SELECT DISTINCT agent_id FROM removed ON CONFLICT DO NOTHING;

-- L1 — 발신 allow 의 플랫폼 도메인 규칙(누가 만들었든).
WITH removed AS (
  UPDATE agent_contact_rules r
     SET removed_at = now(), removed_by = 'migration:202609241040'
   WHERE r.removed_at IS NULL
     AND r.direction = 'outbound'
     AND r.list = 'allow'
     AND r.kind = 'domain'
     AND (regexp_replace(r.value, '^\*\.', '') = 'atmark.ai' OR r.value LIKE '%.atmark.ai')
  RETURNING r.agent_id
)
INSERT INTO atmark_v2fix_touched SELECT DISTINCT agent_id FROM removed ON CONFLICT DO NOTHING;

-- M1 — "전체" 로 남은 옛 blocklist 보유 에이전트 → 블랙리스트 모드(그 목록이 다시 읽힌다).
CREATE TEMP TABLE atmark_v2fix_to_blocklist ON COMMIT DROP AS
SELECT p.agent_id
  FROM agent_policies p
  JOIN policy_versions v ON v.agent_id = p.agent_id AND v.version = p.current_version
 WHERE v.outbound_mode = 'unrestricted'
   AND EXISTS (
     SELECT 1 FROM agent_contact_rules r
      WHERE r.agent_id = p.agent_id
        AND r.removed_at IS NULL
        AND r.direction = 'outbound'
        AND r.list = 'block'
        AND r.created_by = 'migration:202609241010'
   );

INSERT INTO atmark_v2fix_touched SELECT agent_id FROM atmark_v2fix_to_blocklist ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------------
-- 새 버전 — 바로잡은 에이전트마다 한 행(스냅샷 = 바로잡은 뒤의 목록 전문, `policySnapshotOf` 와 같은 모양·순서)
-- ---------------------------------------------------------------------------

INSERT INTO policy_versions (agent_id, version, outbound_mode, inbound_mode, snapshot, created_by)
SELECT p.agent_id,
       p.current_version + 1,
       n.mode,
       v.inbound_mode,
       jsonb_build_object(
         'outbound_mode', n.mode,
         'inbound_mode', v.inbound_mode,
         'limits', p.limits,
         'config_json', p.config_json,
         'contact_rules', coalesce((
           SELECT jsonb_agg(jsonb_build_object('id', r.id, 'direction', r.direction, 'list', r.list, 'kind', r.kind, 'value', r.value)
                            ORDER BY r.direction, r.list, r.value)
             FROM agent_contact_rules r WHERE r.agent_id = p.agent_id AND r.removed_at IS NULL), '[]'::jsonb)
       ),
       'migration:202609241040'
  FROM atmark_v2fix_touched t
  JOIN agent_policies p ON p.agent_id = t.agent_id
  -- 현재 버전 행이 없는(이미 망가진) 정책은 건드리지 않는다 — 관문·수신 판정이 이미 fail-closed 로 막고 있다.
  JOIN policy_versions v ON v.agent_id = p.agent_id AND v.version = p.current_version
 CROSS JOIN LATERAL (
   SELECT CASE WHEN EXISTS (SELECT 1 FROM atmark_v2fix_to_blocklist b WHERE b.agent_id = p.agent_id)
               THEN 'blocklist_only'::outbound_mode
               ELSE v.outbound_mode
          END AS mode
 ) n;

UPDATE agent_policies p
   SET outbound_mode = v.outbound_mode,
       current_version = v.version
  FROM policy_versions v
 WHERE v.agent_id = p.agent_id
   AND v.version = p.current_version + 1
   AND v.created_by = 'migration:202609241040';
