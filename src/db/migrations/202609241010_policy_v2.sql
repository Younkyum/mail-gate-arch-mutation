-- 202609241010_policy_v2.sql
-- 정책 v2 — 수신·발신 방향별 4모드 + 연락처 목록 (계약 `.omc/handoffs/v2-contract.md` §1 · ADR-0007, 진윤겸 결정 2026-09-24).
--
-- 무엇이 바뀌나:
--   ① `inbound_mode` 열거형 + `agent_policies.inbound_mode`·`policy_versions.inbound_mode`(기본 `all`). 수신 소비자가 저장 때 판정해
--      막힌 메일을 **격리**한다(에이전트 API·MCP 에 안 보임 · 반송 없음).
--   ② `inbound_messages.quarantine_reason`(`injection_risk`·`scanner_error`·`policy_blocked`) · `policy_reason`(수신 정책 판정 사유).
--      injection 격리와 정책 격리를 한 불리언(`quarantined`)에 섞지 않는다 — 로그(T3)가 "왜 안 보이나" 에 답해야 한다.
--   ③ `agent_contact_rules` — 방향(`inbound`·`outbound`) × 목록(`allow`·`block`) × 종류(`address`·`domain`). 정책의 목록은 이제
--      여기만 있다(`config_json.allowlist/blocklist` 는 이 파일이 옮기고 지운다). **목록 변경 = 새 정책 버전**이고 버전 스냅샷
--      (`policy_versions.snapshot.contact_rules`)이 그 시점의 목록 전문을 담는다(AC-9 "왜 나갔나").
--   ④ 이전: 레거시 모드(`approval_required`·`reply_only`) 에이전트 → `allowlist_only`, 그 에이전트의 seed·approved 관계(주소·도메인
--      스코프)와 `auto_approve_domains` 를 발신 allow 목록으로. 모든 에이전트에 새 버전 한 행(created_by `migration:202609241010`).
--   ⑤ DB 기본값: `outbound_mode = 'allowlist_only'`(빈 목록 = 아무에게도 못 보냄 — 진윤겸 결정 ②), `inbound_mode = 'all'`.
--   ⑥ 권한: 앱 롤은 목록 SELECT 만(관문·수신 소비자가 읽는다). `atmark_admin` 은 목록 SELECT·INSERT(칸 단위)·DELETE +
--      `agent_policies.inbound_mode` UPDATE. `RESTRICTED_ROLE_GRANTS` 와 migrate `status` 가 같은 변경에서 늘었다.
--
-- ## 매칭 규칙 (정본 — `src/policy/contact-rules.ts` 가 같은 규칙을 코드로 적는다)
--   - 값에 `@` 가 있으면 **주소**, 없으면 **도메인**(`kind` 는 값에서 정해지고 CHECK 가 둘의 일치를 본다).
--   - 주소는 소문자 **정확 일치**, `+tag` 보존 — 허용 목록의 `sales+eu@corp.com` 은 `sales@corp.com` 을 열지 않는다(허용은 좁게).
--     **차단 목록의 주소만은 양쪽 `+tag` 를 자르고 비교한다**(거부는 넓게 — `victim+x@` 로 차단을 비껴가지 못하게).
--   - 도메인 `example.com` 은 **그 도메인만**. 하위 도메인은 `*.example.com` 으로 따로 적는다(그것은 하위 도메인만 — 정점은 아님).
--     계약의 권장안이다: "example.com" 이 `mail.example.com` 까지 여는 것은 소유자가 본 문자열보다 넓다.
--     그래서 옛 blocklist 의 `@example.com`(하위 도메인까지 막았다)은 **두 행**(`example.com` · `*.example.com`)으로 옮긴다.
--   - 값은 ASCII 인쇄 문자·소문자만(국제화 주소는 받지 않는다 — JS `toLowerCase` 와 DB `lower()` 가 갈라지는 문자(V2)를 목록
--     키로 쓰지 않는다).
--
-- ## 모드와 목록 (엔진 `src/policy/rules/*.ts` · 수신 `src/policy/inbound-policy.ts`)
--   | 발신 모드 | allow 목록 | block 목록 |      | 수신 모드 | allow | block |
--   |---|---|---|---|---|---|---|
--   | `unrestricted`(전체)   | 안 씀 | 안 씀 |  | `all`            | 안 씀 | 안 씀 |
--   | `allowlist_only`       | 씀(밖 = 거부) | **씀(이긴다)** |  | `allowlist_only` | 씀(인증된 발신자만) | **씀(이긴다)** |
--   | `blocklist_only`       | 안 씀 | 씀 |  | `blocklist_only` | 안 씀 | 씀 |
--   | `disabled`(전부 X)     | — | — |  | `disabled`       | — | — |
--   | 레거시 두 모드         | 안 씀 | 씀 |
--   화이트리스트 모드에서도 차단 목록이 이기는 이유: §4.2 "blocklist 는 항상 allowlist·관계·승인을 이긴다" 를 v2 에서도 유지한다
--   (같은 주소가 두 목록에 있을 때 차단이 이긴다 — 좁은 쪽). "전체" 는 목록을 읽지 않는다 — 그 위험은 콘솔 경고와 ADR-0007.
--
-- ## 망가진 옛 정책은 `disabled` 로 옮긴다 (fail-closed 보존)
--   옛 로더는 `config_json.allowlist/blocklist` 가 없거나 문자열 배열이 아니면 **모든 발송을 `evaluation_error` 로 막았다**. 그 키를
--   지우고 새 테이블을 읽게 되면 그 에이전트가 갑자기 보낼 수 있게 된다(넓어지는 이전). 그래서 그런 정책과, 옮길 수 없는 차단 항목
--   (주소 모양이 아닌데 `@` 가 있는 값 — 옛 판정에서는 무언가를 막았을 수 있다)을 가진 정책은 새 버전에서 `disabled` 다.
--   허용 쪽의 옮길 수 없는 항목(모양이 아닌 주소)은 버린다 — 좁아지는 방향이다.
--
-- 마이그레이션은 append-only 다. 기존 파일은 건드리지 않았다.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'atmark_admin') THEN
    RAISE EXCEPTION 'role atmark_admin does not exist — migrate 핸들러의 bootstrap-roles 를 먼저 돌려라(로컬: docs/runbooks/admin.md §8)';
  END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- ① 수신 모드
-- ---------------------------------------------------------------------------

CREATE TYPE inbound_mode AS ENUM (
  'all',             -- 전체 · All — 판정하지 않는다(기존 동작).
  'allowlist_only',  -- 화이트리스트 — **인증된**(DMARC pass) 발신자가 allow 목록에 있을 때만. 차단 목록이 이긴다.
  'blocklist_only',  -- 블랙리스트 — 발신자(인증 여부 무관 — 막는 쪽은 사칭돼도 안전)가 block 목록에 있으면 격리.
  'disabled'         -- 전부 X — 전건 격리.
);

ALTER TABLE agent_policies ADD COLUMN inbound_mode inbound_mode NOT NULL DEFAULT 'all';
-- 스냅샷 쪽도 열로 둔다(`outbound_mode` 와 같은 자리). 기본값이 있는 이유: 기존 행은 전부 "전체" 였다 — 그 사실 그대로다.
ALTER TABLE policy_versions ADD COLUMN inbound_mode inbound_mode NOT NULL DEFAULT 'all';

-- ---------------------------------------------------------------------------
-- ② 수신 격리 사유
-- ---------------------------------------------------------------------------

ALTER TABLE inbound_messages
  ADD COLUMN quarantine_reason text
    CONSTRAINT inbound_messages_quarantine_reason_check
    CHECK (quarantine_reason IN ('injection_risk', 'scanner_error', 'policy_blocked')),
  ADD COLUMN policy_reason text
    CONSTRAINT inbound_messages_policy_reason_check
    CHECK (policy_reason IN ('sender_not_allowlisted', 'sender_blocklisted', 'inbound_disabled')),
  -- 사유가 있으면 격리다(보이는 메일에 격리 사유가 붙는 상태 없음).
  ADD CONSTRAINT inbound_messages_quarantine_reason_shape CHECK (quarantine_reason IS NULL OR quarantined),
  -- 정책 격리 ⇔ 정책 사유. `coalesce` — NULL 비교가 CHECK 를 공허하게 통과하지 않게.
  ADD CONSTRAINT inbound_messages_policy_reason_shape
    CHECK (coalesce(quarantine_reason = 'policy_blocked', false) = (policy_reason IS NOT NULL));

COMMENT ON COLUMN inbound_messages.quarantine_reason IS
  '격리 사유(v2, 202609241010). NULL = 보이는 메일 또는 v2 이전 행(그때는 injection_risk NULL → scanner_error, 아니면 injection_risk).';
COMMENT ON COLUMN inbound_messages.policy_reason IS
  '수신 정책 판정 사유 — quarantine_reason = policy_blocked 일 때만.';

-- ---------------------------------------------------------------------------
-- ③ agent_contact_rules
-- ---------------------------------------------------------------------------

-- 값의 종류를 정하는 **유일한** DB 함수. `src/policy/contact-rules.ts` `contactRuleKindOf` 와 같은 정규식이다(통합 테스트가 대조).
-- NULL = 목록에 넣을 수 없는 값.
CREATE FUNCTION atmark_contact_rule_kind(v text) RETURNS text
  LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
  AS $fn$
    SELECT CASE
      WHEN length(v) <= 254
       AND v ~ '^[a-z0-9.!#$%&''*+/=?^_`{|}~-]{1,64}@[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$'
        THEN 'address'
      WHEN length(v) <= 255
       AND v ~ '^(\*\.)?[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$'
        THEN 'domain'
    END
  $fn$;

CREATE TABLE agent_contact_rules (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id    char(32) NOT NULL REFERENCES agents (id) ON DELETE RESTRICT,
  direction   text NOT NULL CONSTRAINT agent_contact_rules_direction_check CHECK (direction IN ('inbound', 'outbound')),
  list        text NOT NULL CONSTRAINT agent_contact_rules_list_check CHECK (list IN ('allow', 'block')),
  kind        text NOT NULL CONSTRAINT agent_contact_rules_kind_check CHECK (kind IN ('address', 'domain')),
  value       text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  -- 누가 — 콘솔은 `owner:<세션 주체>`, CLI 는 `admin:rules:<운영자>`, 이전은 `migration:202609241010`. 비밀 금지.
  created_by  text CONSTRAINT agent_contact_rules_created_by_check CHECK (created_by IS NULL OR length(created_by) BETWEEN 1 AND 200),
  -- 값 모양과 종류가 함께 맞아야 한다 — "주소처럼 생긴 도메인 행" 이 없다.
  CONSTRAINT agent_contact_rules_value_kind CHECK (atmark_contact_rule_kind(value) = kind)
);

-- 중복 금지 — 같은 방향·목록의 같은 값은 한 행(값이 곧 종류를 정하므로 kind 는 키에 없다).
CREATE UNIQUE INDEX agent_contact_rules_unique ON agent_contact_rules (agent_id, direction, list, value);

-- 규칙은 **더하고 지울 뿐 고치지 않는다.** 고치기 = 지우고 더하기(각각 새 정책 버전). UPDATE 가 열려 있으면 값이 버전 없이 바뀐다.
CREATE TRIGGER agent_contact_rules_no_update
  BEFORE UPDATE ON agent_contact_rules
  FOR EACH ROW EXECUTE FUNCTION reject_row_update();
CREATE TRIGGER agent_contact_rules_no_truncate
  AFTER TRUNCATE ON agent_contact_rules
  FOR EACH STATEMENT EXECUTE FUNCTION reject_truncate();

COMMENT ON TABLE agent_contact_rules IS
  '정책 v2 연락처 목록(202609241010). 변경 = 새 policy_versions 행(스냅샷 contact_rules). 매칭 규칙은 마이그레이션 머리말.';

-- ---------------------------------------------------------------------------
-- ④ 이전 — 옛 목록·레거시 모드
-- ---------------------------------------------------------------------------

-- 옛 정책의 목록이 망가졌는가 — 옛 로더가 모든 발송을 막던 모양(키 없음·배열 아님·문자열 아닌 원소) 또는 옮길 수 없는 차단 항목.
-- 이 파일 안에서만 쓰고 끝에서 지운다.
CREATE FUNCTION atmark_v2_legacy_lists_broken(config jsonb) RETURNS boolean
  LANGUAGE sql IMMUTABLE
  AS $fn$
    SELECT
      NOT (config ? 'allowlist') OR NOT (config ? 'blocklist')
      OR jsonb_typeof(config -> 'allowlist') <> 'array' OR jsonb_typeof(config -> 'blocklist') <> 'array'
      -- 원소 검사는 배열일 때만 편다(스칼라를 펴면 던진다 — OR 는 단락 평가를 약속하지 않는다).
      OR EXISTS (SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(config -> 'allowlist') = 'array'
                                                         THEN config -> 'allowlist' ELSE '[]'::jsonb END) e
                  WHERE jsonb_typeof(e) <> 'string')
      OR EXISTS (SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(config -> 'blocklist') = 'array'
                                                         THEN config -> 'blocklist' ELSE '[]'::jsonb END) e
                  WHERE jsonb_typeof(e) <> 'string')
      OR EXISTS (
        SELECT 1
          FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(config -> 'blocklist') = 'array'
                                              THEN config -> 'blocklist' ELSE '[]'::jsonb END) raw,
               LATERAL (SELECT lower(btrim(raw)) AS e) n
         WHERE CASE
                 -- `@domain` — 하위 도메인까지 막던 항목. 도메인 모양이어야 옮긴다.
                 WHEN left(n.e, 1) = '@' THEN atmark_contact_rule_kind(substr(n.e, 2)) IS DISTINCT FROM 'domain'
                 -- 주소 항목. `@` 가 없는 값은 옛 판정에서도 아무것도 막지 않았다(수신자는 늘 `@` 가 있다) — 버려도 같다.
                 WHEN position('@' IN n.e) > 0 THEN atmark_contact_rule_kind(n.e) IS DISTINCT FROM 'address'
                 ELSE false
               END
      )
  $fn$;

INSERT INTO agent_contact_rules (agent_id, direction, list, kind, value, created_by)
SELECT DISTINCT s.agent_id, 'outbound', s.list, atmark_contact_rule_kind(s.value), s.value, 'migration:202609241010'
  FROM (
    -- 옛 allowlist(허용 비교형 — 소문자, +tag 보존) → allow.
    SELECT p.agent_id, 'allow' AS list, lower(btrim(e)) AS value
      FROM agent_policies p,
           jsonb_array_elements_text(CASE WHEN jsonb_typeof(p.config_json -> 'allowlist') = 'array'
                                           AND NOT atmark_v2_legacy_lists_broken(p.config_json)
                                          THEN p.config_json -> 'allowlist' ELSE '[]'::jsonb END) e
    UNION ALL
    -- 옛 blocklist 주소 → block.
    SELECT p.agent_id, 'block', lower(btrim(e))
      FROM agent_policies p,
           jsonb_array_elements_text(CASE WHEN jsonb_typeof(p.config_json -> 'blocklist') = 'array'
                                           AND NOT atmark_v2_legacy_lists_broken(p.config_json)
                                          THEN p.config_json -> 'blocklist' ELSE '[]'::jsonb END) e
     WHERE left(lower(btrim(e)), 1) <> '@'
    UNION ALL
    -- 옛 blocklist `@domain` → block `domain` + `*.domain`(옛 의미 = 그 도메인과 하위 도메인).
    SELECT p.agent_id, 'block', d.value
      FROM agent_policies p,
           jsonb_array_elements_text(CASE WHEN jsonb_typeof(p.config_json -> 'blocklist') = 'array'
                                           AND NOT atmark_v2_legacy_lists_broken(p.config_json)
                                          THEN p.config_json -> 'blocklist' ELSE '[]'::jsonb END) e,
           LATERAL (VALUES (substr(lower(btrim(e)), 2)), ('*.' || substr(lower(btrim(e)), 2))) d(value)
     WHERE left(lower(btrim(e)), 1) = '@'
    UNION ALL
    -- 레거시 모드의 seed·approved 관계(주소·도메인 스코프) → allow. 스레드 스코프는 목록으로 옮길 수 없다(버린다 — 좁아진다).
    SELECT r.agent_id, 'allow', lower(CASE r.scope WHEN 'recipient' THEN r.address ELSE r.domain END)
      FROM sender_relationships r
      JOIN agent_policies p ON p.agent_id = r.agent_id
     WHERE p.outbound_mode IN ('approval_required', 'reply_only')
       AND r.trust_category IN ('seed', 'approved')
       AND r.scope IN ('recipient', 'domain')
    UNION ALL
    -- 레거시 모드의 `auto_approve_domains`(승인 없이 나가던 도메인, 정확 일치) → allow.
    SELECT p.agent_id, 'allow', lower(btrim(d))
      FROM agent_policies p,
           jsonb_array_elements_text(CASE WHEN jsonb_typeof(p.config_json -> 'auto_approve_domains') = 'array'
                                          THEN p.config_json -> 'auto_approve_domains' ELSE '[]'::jsonb END) d
     WHERE p.outbound_mode IN ('approval_required', 'reply_only')
  ) s
 WHERE s.value IS NOT NULL
   AND atmark_contact_rule_kind(s.value) IS NOT NULL;

-- 새 버전 — 모든 에이전트. 현재 버전 행이 없는(이미 망가진) 정책은 건드리지 않는다(관문이 이미 fail-closed 로 막고 있다).
INSERT INTO policy_versions (agent_id, version, outbound_mode, inbound_mode, snapshot, created_by)
SELECT p.agent_id,
       p.current_version + 1,
       n.mode,
       p.inbound_mode,
       jsonb_build_object(
         'outbound_mode', n.mode,
         'inbound_mode', p.inbound_mode,
         'limits', p.limits,
         'config_json', p.config_json - 'allowlist' - 'blocklist',
         'contact_rules', coalesce((
           SELECT jsonb_agg(jsonb_build_object('id', r.id, 'direction', r.direction, 'list', r.list, 'kind', r.kind, 'value', r.value)
                            ORDER BY r.direction, r.list, r.value)
             FROM agent_contact_rules r WHERE r.agent_id = p.agent_id), '[]'::jsonb)
       ),
       'migration:202609241010'
  FROM agent_policies p
  JOIN policy_versions v ON v.agent_id = p.agent_id AND v.version = p.current_version
  CROSS JOIN LATERAL (
    SELECT CASE
             WHEN atmark_v2_legacy_lists_broken(p.config_json) THEN 'disabled'::outbound_mode
             WHEN v.outbound_mode IN ('approval_required', 'reply_only') THEN 'allowlist_only'::outbound_mode
             ELSE v.outbound_mode
           END AS mode
  ) n;

UPDATE agent_policies p
   SET outbound_mode = v.outbound_mode,
       config_json = p.config_json - 'allowlist' - 'blocklist',
       current_version = v.version
  FROM policy_versions v
 WHERE v.agent_id = p.agent_id
   AND v.version = p.current_version + 1
   AND v.created_by = 'migration:202609241010';

DROP FUNCTION atmark_v2_legacy_lists_broken(jsonb);

-- 상한 — 에이전트·방향·목록마다 1000. 이전 **뒤에** 건다(이전은 옛 상한 20·수동 목록이라 넘지 않지만, 넘는 옛 데이터가 있어도
-- 이전을 멈추지 않는다 — 그 행들은 남고 새 추가만 막힌다). 앱 검사(`src/admin/ops/rules.ts`)가 먼저 `rule_limit` 으로 거부하고,
-- 이것은 그 검사를 우회한 쓰기의 두 번째 벽이다.
CREATE FUNCTION agent_contact_rules_limit() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = public, pg_temp
  AS $fn$
  BEGIN
    IF (SELECT count(*) FROM agent_contact_rules
         WHERE agent_id = NEW.agent_id AND direction = NEW.direction AND list = NEW.list) >= 1000 THEN
      RAISE EXCEPTION 'agent_contact_rules_limit' USING ERRCODE = 'check_violation', DETAIL = '에이전트·방향·목록마다 1000';
    END IF;
    RETURN NEW;
  END
  $fn$;

CREATE TRIGGER agent_contact_rules_limit
  BEFORE INSERT ON agent_contact_rules
  FOR EACH ROW EXECUTE FUNCTION agent_contact_rules_limit();

-- ---------------------------------------------------------------------------
-- ⑤ 기본값 — 새 에이전트는 발신 화이트리스트(빈 목록) · 수신 전체 (진윤겸 결정 ②)
-- ---------------------------------------------------------------------------

ALTER TABLE agent_policies ALTER COLUMN outbound_mode SET DEFAULT 'allowlist_only';

-- ---------------------------------------------------------------------------
-- ⑥ 권한
-- ---------------------------------------------------------------------------

-- 앱 롤(관문 `policy-source.ts` · 수신 소비자 `inbound-policy-store.ts` · 신뢰 사실 `trust-facts-store.ts`)은 **읽기만**.
--   쓰기가 열려 있으면 api 탈취가 자기 allow 목록을 늘린다(202609230750 H-A ② 와 같은 길).
GRANT SELECT ON agent_contact_rules TO atmark_app;

-- 관리 롤 — 콘솔 목록 편집(`src/admin/ops/rules.ts`). INSERT 는 칸 단위(id·created_at 은 DB 가 정한다).
GRANT SELECT, DELETE ON agent_contact_rules TO atmark_admin;
GRANT INSERT (agent_id, direction, list, kind, value, created_by) ON agent_contact_rules TO atmark_admin;
GRANT UPDATE (inbound_mode) ON agent_policies TO atmark_admin;
