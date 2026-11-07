-- 202609301500_operator_reserved_addresses.sql
-- **운영자 전용 예약 주소**(2026-09-30) — `support@atmark.ai` 를 Atmark 지원 에이전트(조직 Chronostasis)의 대표 주소로, `onve@atmark.ai` 를 그
-- 별칭으로 만든다. 진윤겸이 Atmark 에이전트 MCP 로 문의를 읽고 회신한다. `claude@atmark.ai`(진윤겸 본인 에이전트 — 202609301200 이전에 발급)도
-- 같은 목록에 올린다: 그 행 때문에 202609301201 이 예약 CHECK 를 `NOT VALID` 로 남겼다.
--
-- 예약 로컬파트는 **모든 롤**에서 막힌다(CHECK `agent_addresses_not_reserved_local_part`, 202609301200:36-38). 셀프서브(콘솔·API·MCP)는 그대로
-- 막고, 운영자 CLI(`pnpm admin:reserved-address`, 소유자 롤)만 **지정한 조직**에 발급할 수 있게 한다:
--
--   ① `operator_address_grants(address PK, organization_id, granted_by, reason, created_at)` — "이 예약 주소는 이 조직의 것" 이라는 운영자 허가.
--      **소유자 전용**(어떤 런타임 롤도 권한 0 — `status` 의 제한 롤 ACL 대조가 넘침을 잡는다). 주소는 소문자 `@atmark.ai` 이고 목록 안이어야 한다.
--      조직 FK 는 `ON DELETE RESTRICT`(허가를 쥔 조직은 지워지지 않는다).
--   ② `atmark_operator_assignable_addresses()` — IMMUTABLE. TS `OPERATOR_ASSIGNABLE_ADDRESSES`(`src/identity/address.ts`)와 같은 값·같은 순서(통합 테스트).
--   ③ `atmark_reserved_local_parts()` 에 `onve` 를 더한다 — TS `SERVICE_RESERVED_LOCAL_PARTS` 끝(`www` 다음)과 같은 자리(통합 테스트가 순서까지 대조).
--   ④ CHECK 를 `NOT VALID` 로 다시 세운다: 목록 안의 주소는 통과, 나머지는 예전 식 그대로. 기존 행 검증은 202609301501(1200/1201 과 같은 쌍).
--      `claude@atmark.ai` 는 목록 안이라 이제 통과한다 — 다른 위반 행이 없으면 1501 이 VALIDATE 한다.
--   ④-b `support@`·`onve@` 를 이미 쥔 행(활성 · 30일 안 퇴역)이 있으면 DO 블록이 55000 으로 멈춘다(닫힌 채로 실패). `claude@` 는 검사하지 않는다.
--   ⑤ BEFORE INSERT 트리거 `agent_addresses_operator_grant_guard` — 목록 안의 주소는 **그 에이전트의 조직에 대한 허가 행**이 있어야 한다(없으면
--      42501). SECURITY DEFINER(소유자 전용 표를 읽는다) · search_path 고정 · PUBLIC EXECUTE 없음. 이름이 `…_operator_…` 라 `…_reissue_hold`
--      (주소 잠금 · 23505 "address is not available")보다 **먼저** 돈다(같은 시점의 트리거는 이름 순) — 허가 없는 조직은 주소의 사용 여부를 탐침하기
--      전에 거부된다. `…_alias_ceiling`·`…_created_at_stamp` 는 그 앞이다(조직 잠금·시각 — 판정과 무관).
--
-- 잠금: 새 표 · 함수 둘 교체·추가 · CHECK 교체(NOT VALID — 짧은 ACCESS EXCLUSIVE, 표를 훑지 않는다) · 트리거 하나(SHARE ROW EXCLUSIVE).
-- 5초 안에 못 잡으면 실패한다(다시 돌리면 된다). CHECK 교체의 ACCESS EXCLUSIVE 를 먼저 잡으므로 이 트랜잭션이 커밋될 때까지 새 주소 INSERT 는
-- 줄을 선다 — 1200 머리말과 같은 판단.
--
-- **순서**: `AtmarkCompute`(새 TS 목록 — 앱이 `onve` 를 먼저 `reserved_local_part` 로 거부) → `migrate`(이 파일 · 1501) → `status`.
--   docs/runbooks/deploy.md §29.

SET LOCAL lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- ② 운영자 발급 가능 주소
-- ---------------------------------------------------------------------------

CREATE FUNCTION atmark_operator_assignable_addresses() RETURNS text[]
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT ARRAY['support@atmark.ai', 'onve@atmark.ai', 'claude@atmark.ai']::text[]
$$;

-- ---------------------------------------------------------------------------
-- ① 허가 표(소유자 전용)
-- ---------------------------------------------------------------------------

CREATE TABLE operator_address_grants (
  address         text PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations (id) ON DELETE RESTRICT,
  granted_by      text NOT NULL CHECK (length(granted_by) BETWEEN 1 AND 200),
  reason          text NOT NULL CHECK (length(reason) BETWEEN 1 AND 500),
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT operator_address_grants_address_shape CHECK (
    address = lower(address)
    AND split_part(address, '@', 2) = 'atmark.ai'
    AND address = ANY (atmark_operator_assignable_addresses()))
);

CREATE INDEX operator_address_grants_organization_idx ON operator_address_grants (organization_id);

COMMENT ON TABLE operator_address_grants IS
  '운영자 예약 주소 허가(2026-09-30) — 이 예약 주소는 이 조직의 에이전트에게만 발급된다(트리거 agent_addresses_operator_grant_guard). 소유자 롤 전용 — 런타임 롤 권한 0. pnpm admin:reserved-address grant.';

REVOKE ALL ON operator_address_grants FROM PUBLIC;
REVOKE ALL ON operator_address_grants FROM atmark_app, atmark_admin, atmark_login_mailer, atmark_ops;

-- ---------------------------------------------------------------------------
-- ③ 예약 로컬파트 — `onve` 추가(서비스 예약 끝, `www` 다음)
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION atmark_reserved_local_parts() RETURNS text[]
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT ARRAY[
    'postmaster', 'abuse', 'hostmaster', 'webmaster', 'noc', 'security',
    'dmarc', 'noreply', 'no-reply', 'bounce', 'mailer-daemon', 'notify',
    'blocked-test',
    'admin', 'support', 'billing', 'help', 'info', 'login', 'console', 'atmark', 'team', 'sales', 'hello', 'root',
    'system', 'approve', 'api', 'mail', 'www', 'onve',
    'administrator', 'ssladmin', 'ssl-admin', 'sslwebmaster',
    'it', 'domains', 'privacy', 'legal', 'contact', 'signup', 'verify', 'trust', 'compliance', 'operator', 'accounts',
    'payments', 'helpdesk', 'help-desk', 'security-team', 'dpo', 'press', 'careers', 'jobs', 'abuse-report',
    'scout', 'invoices', 'recruiting', 'research', 'ops-pager',
    'claude', 'claude-code', 'claudecode', 'codex', 'openai-codex', 'hermes', 'openclaw', 'openai', 'anthropic', 'chatgpt',
    'gpt', 'gemini', 'gemini-cli', 'copilot', 'github-copilot', 'cursor', 'devin', 'manus', 'openhands', 'aider',
    'cline', 'roo-code', 'kilo-code', 'opencode', 'goose', 'windsurf', 'jules', 'amp', 'kiro', 'qwen',
    'grok', 'llama', 'meta-ai', 'mistral', 'deepseek', 'kimi', 'perplexity', 'replit', 'lovable', 'v0'
  ]::text[]
$$;

-- ---------------------------------------------------------------------------
-- ④ CHECK — 운영자 목록은 통과, 나머지는 예전 식(NOT VALID — 검증은 1501)
-- ---------------------------------------------------------------------------

ALTER TABLE agent_addresses DROP CONSTRAINT agent_addresses_not_reserved_local_part;
ALTER TABLE agent_addresses ADD CONSTRAINT agent_addresses_not_reserved_local_part
  CHECK (
    address = ANY (atmark_operator_assignable_addresses())
    OR NOT (split_part(address, '@', 1) = ANY (atmark_reserved_local_parts_for(split_part(address, '@', 2))))
  ) NOT VALID;

-- ---------------------------------------------------------------------------
-- ④-b 닫힌 채로 실패 — 지원 주소(`support@`·`onve@`)를 이미 쥔 행이 있으면 여기서 멈춘다
-- ---------------------------------------------------------------------------
-- 예약 CHECK 가 이 두 주소를 막아 왔으므로 운영 DB 에 행이 없어야 정상이다(`claude@` 는 202609301200 이전에 발급돼 정당하게 있다 — 검사하지 않는다).
-- 행이 있다면 CHECK 를 우회해 만든 것이다(마이그레이션 밖의 쓰기) — 허가 행이 없는 채로 support@ 가 남의 손에 있는 셈이라, 배포를 세우고 사람이 본다.
-- "쥐고 있다" = 활성이거나 30일 안에 퇴역한 행(`agent_addresses_reissue_hold` 의 다른 조직 재발급 보류 기간과 같다).
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM agent_addresses
     WHERE address IN ('support@atmark.ai', 'onve@atmark.ai')
       AND (retired_at IS NULL OR retired_at > now() - interval '30 days')
  ) THEN
    RAISE EXCEPTION 'operator-reserved address already held — run deploy §29 pre-check ③' USING ERRCODE = '55000';
  END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- ⑤ 허가 가드 — 목록 안의 주소는 그 조직의 허가 행이 있어야 한다
-- ---------------------------------------------------------------------------

CREATE FUNCTION agent_addresses_operator_grant_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  org uuid;
BEGIN
  IF NOT (NEW.address = ANY (public.atmark_operator_assignable_addresses())) THEN
    RETURN NEW;
  END IF;
  SELECT a.organization_id INTO org FROM public.agents a WHERE a.id = NEW.agent_id;
  -- 조직을 못 찾으면(FK 가 곧 거부할 행) 여기서도 닫는다 — 허가 판정을 건너뛰는 길을 두지 않는다.
  IF org IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.operator_address_grants g WHERE g.address = NEW.address AND g.organization_id = org
  ) THEN
    -- 값(주소·조직)은 싣지 않는다 — 콘솔 오류 경로로 새지 않게.
    RAISE EXCEPTION 'agent_addresses: operator-reserved address requires an operator grant for this organization'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION agent_addresses_operator_grant_guard() FROM PUBLIC;

CREATE TRIGGER agent_addresses_operator_grant_guard BEFORE INSERT ON agent_addresses
  FOR EACH ROW EXECUTE FUNCTION agent_addresses_operator_grant_guard();
