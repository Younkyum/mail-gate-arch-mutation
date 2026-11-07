-- 202609301200_agent_brand_reserved_local_parts.sql
-- AI 에이전트·모델·회사 이름 예약(진윤겸 2026-09-30) — 홈 히어로가 `claude-code@atmark.ai`·`codex@atmark.ai`·`hermes@atmark.ai`·`openclaw@atmark.ai`
-- 같은 잘 알려진 에이전트 이름을 예시 주소로 보여 준다. 그 주소를 아무도 발급받을 수 없게 한다(사칭 방지).
--
-- `atmark_reserved_local_parts()` 는 `src/identity/address.ts` `RESERVED_LOCAL_PARTS` 와 **같은 순서·같은 값**(통합 테스트가 대조).
-- 앞 59개는 202609290600 그대로, 뒤 40개가 새 이름이다(TS `AGENT_BRAND_RESERVED_LOCAL_PARTS` — 기존 목록과 겹치는 이름 없음).
-- **atmark.ai 전용**: `atmark_reserved_local_parts_for(domain)`(202609291120)의 고객 도메인 분기(= TS `GLOBAL_RESERVED_LOCAL_PARTS`)는 그대로다.
-- 고객 서브도메인은 그 조직이 소유를 증명한 도메인이라 `codex@agents.customer.com` 은 정당한 이름이다(address.ts 주석).
--
-- **CHECK 를 `NOT VALID` 로 다시 세운다.** 함수 몸체만 바꾸면 `convalidated = true` 가 그대로 남는데, 기존 행 중 새 이름이 있으면 그 표시는
-- 거짓이다. 그래서 같은 식의 CHECK 를 NOT VALID 로 다시 세우고(ACCESS EXCLUSIVE — 표를 훑지 않는다, 몇 ms), 기존 행 검증은
-- 202609301201 이 한다(위반이 없을 때만 VALIDATE — 202609290600 · 202609291121 과 같은 판정). CHECK 교체의 ACCESS EXCLUSIVE 를 먼저 잡으므로
-- 이 트랜잭션이 커밋될 때까지 새 주소 INSERT 는 줄을 서고, 커밋 뒤에는 새 함수로 검사된다 — 옛 목록으로 통과한 행이 끼어들 틈이 없다.
--
-- **사전 질의(운영 적용 전 필수 — 결과를 기록한다)**, 소유자 셸:
--   SELECT count(*) AS offenders,
--          count(*) FILTER (WHERE retired_at IS NULL) AS live,
--          string_agg(address, ', ' ORDER BY address) AS addresses
--     FROM agent_addresses
--    WHERE split_part(address, '@', 2) = 'atmark.ai'
--      AND split_part(address, '@', 1) = ANY (ARRAY[
--        'claude', 'claude-code', 'claudecode', 'codex', 'openai-codex', 'hermes', 'openclaw', 'openai', 'anthropic', 'chatgpt',
--        'gpt', 'gemini', 'gemini-cli', 'copilot', 'github-copilot', 'cursor', 'devin', 'manus', 'openhands', 'aider',
--        'cline', 'roo-code', 'kilo-code', 'opencode', 'goose', 'windsurf', 'jules', 'amp', 'kiro', 'qwen',
--        'grok', 'llama', 'meta-ai', 'mistral', 'deepseek', 'kimi', 'perplexity', 'replit', 'lovable', 'v0']);
--   → 기대 offenders = 0. 1 이상이면 적용은 되지만 CHECK 는 NOT VALID 로 남는다(202609301201 이 WARNING, `status` 의
--     `reservedLocalPartCheckValidated:false`). 폐기된 행(`retired_at`)도 CHECK 대상이다. 그 주소는 회수하지 않는다 — 진윤겸에게 보고한다.
--
-- **순서**: `AtmarkCompute` 배포(새 TS 목록 — 앱이 먼저 새 이름을 `reserved_local_part` 로 거부) → `migrate`(이 파일 · 1201) → `status`.
--   docs/runbooks/deploy.md §27.
--
-- 잠금: CHECK 교체(NOT VALID — 짧은 ACCESS EXCLUSIVE) · 함수 교체. 5초 안에 못 잡으면 실패한다(다시 돌리면 된다).

SET LOCAL lock_timeout = '5s';

ALTER TABLE agent_addresses DROP CONSTRAINT agent_addresses_not_reserved_local_part;
ALTER TABLE agent_addresses ADD CONSTRAINT agent_addresses_not_reserved_local_part
  CHECK (NOT (split_part(address, '@', 1) = ANY (atmark_reserved_local_parts_for(split_part(address, '@', 2))))) NOT VALID;

CREATE OR REPLACE FUNCTION atmark_reserved_local_parts() RETURNS text[]
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT ARRAY[
    'postmaster', 'abuse', 'hostmaster', 'webmaster', 'noc', 'security',
    'dmarc', 'noreply', 'no-reply', 'bounce', 'mailer-daemon', 'notify',
    'blocked-test',
    'admin', 'support', 'billing', 'help', 'info', 'login', 'console', 'atmark', 'team', 'sales', 'hello', 'root',
    'system', 'approve', 'api', 'mail', 'www',
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
