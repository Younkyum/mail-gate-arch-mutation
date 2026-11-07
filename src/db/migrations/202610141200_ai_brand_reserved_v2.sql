-- 202610141200_ai_brand_reserved_v2.sql
-- 진윤겸 결정 2026-10-14 두 가지.
--   A. "예약 주소에 grok, codex 등의 AI 기업들 이름도 포함해줘." — 브랜드 예약(202609301200)을 AI 회사·제품·모델 이름과 흔한 에이전트 이름
--      변형 91개로 넓힌다(`grok` 은 막혔지만 `grokbot@` 은 발급됐다). 그리고 브랜드 이름은 **구분자(`.` `_` `-`)를 뺀 키**로 비교한다(PR #98 리뷰 L2 —
--      `claude.code`·`chat-gpt`·`open_ai`·`gpt_5`·`hyperclova_x` 가 정확 일치를 빠져나갔다). 키가 정확히 같을 때만 막는다 — 접두·접미가 붙은
--      `grok-fan`·`naver-blog-helper` 는 된다. 운영 예약(`no-reply` 등)은 정확 일치 그대로다. 흔한 낱말·사람 이름에 가까운 것은 넣지 않았다
--      (TS `AGENT_BRAND_RESERVED_LOCAL_PARTS` 주석 — 이유와 함께).
--   B. "claude는 없애주렴." — Chronostasis 의 `claude-code` 에이전트(`claude@atmark.ai`)를 지울 수 있게 `claude@atmark.ai` 를 **운영자 발급 가능
--      목록에서 뺀다**. 삭제 가드(트리거 `agents_disabled_terminal` · 앱 `deleteAgentOp` 409 `operator_reserved`) · 정책 변경 요청 제외(M-1) ·
--      대표 변경 가드 · 토큰 함의 제외는 모두 `atmark_operator_assignable_addresses()` 를 읽으므로 함수 하나로 같이 바뀐다. `claude` 는 브랜드 예약에
--      **남는다** — 지운 뒤(같은 조직 곧바로 · 다른 조직 30일 보류가 끝난 뒤에도) 누구도 `claude@atmark.ai` 를 다시 받지 못한다(아래 ⑤).
--
--   ① `atmark_brand_reserved_keys()` — 브랜드 목록의 비교 키(구분자를 뺀 값, 중복은 처음 자리만). TS `AGENT_BRAND_RESERVED_KEYS` 와 같은 값·순서.
--      `atmark.ai` 전용이다 — 고객 도메인(`codex@agents.customer.com` 은 그 조직의 정당한 이름)에는 걸지 않는다.
--   ② `atmark_reserved_grandfathered_address_keys()` — **이 파일이 적용되는 순간 이미 있던** 행 중 옛 CHECK 는 통과하고 새 CHECK 에는 걸리는 행
--      (새 이름 · 구분자 변형 · `claude@atmark.ai`)을 `'<id> <address>'` 쌍으로 굳힌 IMMUTABLE 함수. CHECK 가 그 쌍을 통과시킨다:
--        - CHECK 는 UPDATE 에도 선다. 걸리는 행을 그대로 두면 그 행의 폐기(`retired_at`)·대표 변경이 23514 로 막혀 **에이전트를 지울 수도 없다**
--          (`claude@` 를 지우려는 B 가 정확히 그 경우다). 그래서 "이미 있는 행은 그대로 쓴다 · 새로 만드는 행만 막는다" 를 쌍으로 말한다.
--        - id 만이 아니라 **(id, 주소) 쌍**이다(리뷰 L1) — 굳힌 행을 지우고 같은 id 로 다른 예약 이름을 넣어도 통과하지 못한다. 그 행 자체도 지울 수
--          없다(⑥). 주소는 `agent_addresses_identity_immutable` 이 바꾸지 못하게 하고, 같은 쌍의 새 INSERT 는 그 행이 있는 한 PK 23505 다.
--          (시각 경계 `created_at < …` 는 쓰지 않는다 — 적용 시각과 커밋 사이에 시작한 트랜잭션이 경계 안의 created_at 으로 끼어들 수 있다.)
--        - 행은 CHECK 를 지우는 ACCESS EXCLUSIVE 를 쥔 **뒤에**, 함수를 바꾸기 **전에**(옛 목록으로 "옛 CHECK 통과" 를 판정) 모은다. 그 앞에 INSERT 하던
--          트랜잭션은 커밋을 마쳤고(ROW EXCLUSIVE 와 충돌), 그 뒤의 INSERT 는 커밋까지 줄을 선 다음 새 CHECK 로 검사된다.
--        - 옛 CHECK 에도 걸리던 행(1201·1501 이 WARNING 으로 남긴 목록 밖 예약 주소)은 넣지 않는다 — 그 표시는 그대로 남는다(1201 이 판정).
--      나중에 예약을 다시 넓히는 마이그레이션은 이 함수에 쌍을 **더한다**(빼지 않는다 — 빼면 그 행의 UPDATE 가 막힌다).
--   ③ `atmark_reserved_local_parts()` — 기존 100개 그대로 + 끝에 새 91개. TS `RESERVED_LOCAL_PARTS` 와 같은 순서·같은 값(통합 테스트가 대조).
--   ④ `atmark_operator_assignable_addresses()` — `claude@atmark.ai` 를 뺀다(TS `OPERATOR_ASSIGNABLE_ADDRESSES` 와 같은 값·순서).
--   ⑤ CHECK `agent_addresses_not_reserved_local_part` 를 `NOT VALID` 로 다시 세운다(202609301200 · 1500 과 같은 이유):
--        `address ∈ 운영자 목록 OR (id, address) ∈ ② OR NOT (로컬파트 ∈ 예약 OR (atmark.ai AND 구분자 뺀 로컬파트 ∈ ①))`
--      `claude@atmark.ai` 행은 ② 로 통과(폐기도 된다). **새** `claude@atmark.ai` INSERT 는 어느 조직 · 어느 롤이든 23514 다 — 30일 재발급 보류
--      (`agent_addresses_reissue_hold`)가 끝난 뒤에도 CHECK 는 남는다. 운영자 허가로도 안 된다(허가 표의 모양 CHECK 가 운영자 목록 안의 주소만 받는다)
--      — 다시 주려면 `claude@atmark.ai` 를 운영자 목록에 되돌리는 마이그레이션이 따로 필요하다.
--   ⑥ 트리거 `agent_addresses_no_delete`(BEFORE DELETE) · `agent_addresses_no_truncate` — 주소 행은 지우지 않는다(모든 롤 — 소유자 롤도. 폐기는
--      `retired_at`). 지금까지는 FK `ON DELETE RESTRICT` 와 런타임 롤 권한(DELETE 없음)만 막았다 — ② 의 쌍을 지우고 다시 넣는 길(리뷰 L1)을 닫는다.
--      기존 함수 `reject_row_delete()` · `reject_truncate()` 를 쓴다. `REQUIRED_GUARDS` 에 든다.
--   ⑦ `operator_address_grants` 의 `claude@atmark.ai` 행을 지운다(있으면 — 허가 표는 소유자 전용 운영 설정이고 사용자 데이터가 아니다). 그 표의
--      모양 CHECK(`address = ANY (atmark_operator_assignable_addresses())`, VALIDATED)가 ④ 뒤로는 그 행에 거짓이다. 지우는 행은 NOTICE 로 남긴다.
--
-- **사전 질의(운영 적용 전 필수 — 결과를 기록한다)**, 소유자 셸: docs/runbooks/deploy.md §55 ①②③(② 와 같은 정규화). 걸리는 행은 회수하지 않는다
-- (202609301200 과 같은 판단 — 진윤겸에게 보고한다).
--
-- **순서**: `AtmarkCompute`(새 TS 판정 — 앱이 먼저 새 이름 · 구분자 변형을 `reserved_local_part` 로 거부 · 운영자 CLI 가 `claude@` 를 받지 않는다) →
--   `migrate`(이 파일 · 1201) → **곧바로** `pnpm admin:agent-delete --agent 214bf71ed6b729a5d3133df3fd0ccd49 --reason …` → `status`.
--   docs/runbooks/deploy.md §55.
--
-- 잠금: CHECK 교체(NOT VALID — 짧은 ACCESS EXCLUSIVE, 표를 훑지 않는다 · ② 의 읽기는 표를 한 번 훑는다 — 그동안 쓰기는 줄을 선다, 주소 표는 작다) ·
-- 함수 넷 교체·추가 · 트리거 둘 · 허가 표 한 행 DELETE. 5초 안에 못 잡으면 실패한다(다시 돌리면 된다).
-- 롤백 호환: 옛 코드는 TS 목록이 좁을 뿐이다 — 새 이름을 받으면 DB 가 23514 로 막는다(그래서 compute 먼저). 옛 코드의 `claude@` 운영자 발급은
-- 허가 표 모양 CHECK 가 23514 로 막는다. 옛 코드는 주소 행을 지우지 않는다.

SET LOCAL lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- 잠금 먼저 — CHECK 를 지운다(ACCESS EXCLUSIVE). ② 는 이 잠금 아래에서 모은다.
-- ---------------------------------------------------------------------------

ALTER TABLE agent_addresses DROP CONSTRAINT agent_addresses_not_reserved_local_part;

-- ---------------------------------------------------------------------------
-- ① 브랜드 비교 키(구분자를 뺀 값)
-- ---------------------------------------------------------------------------

CREATE FUNCTION atmark_brand_reserved_keys() RETURNS text[]
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT ARRAY[
    'claude', 'claudecode', 'codex', 'openaicodex', 'hermes', 'openclaw', 'openai', 'anthropic', 'chatgpt', 'gpt',
    'gemini', 'geminicli', 'copilot', 'githubcopilot', 'cursor', 'devin', 'manus', 'openhands', 'aider', 'cline',
    'roocode', 'kilocode', 'opencode', 'goose', 'windsurf', 'jules', 'amp', 'kiro', 'qwen', 'grok',
    'llama', 'metaai', 'mistral', 'deepseek', 'kimi', 'perplexity', 'replit', 'lovable', 'v0', 'xai',
    'grokbot', 'groq', 'googleai', 'deepmind', 'gemma', 'openaiagent', 'gpt4', 'gpt4o', 'gpt5', 'sora',
    'dalle', 'chatgptbot', 'codexcli', 'anthropicai', 'claudeai', 'claudebot', 'copilotagent', 'microsoftcopilot', 'bing', 'amazonq',
    'alexa', 'siri', 'appleintelligence', 'metallama', 'llamaagent', 'nousresearch', 'hermesagent', 'cohere', 'commandr', 'huggingface',
    'midjourney', 'stabilityai', 'stablediffusion', 'runwayml', 'inflectionai', 'characterai', 'phind', 'tabnine', 'codeium', 'sourcegraph',
    'lindyai', 'adeptai', 'cerebras', 'togetherai', 'fireworksai', 'mistralai', 'mixtral', 'deepseekai', 'qwenagent', 'tongyi',
    'kimiai', 'moonshotai', 'minimaxai', 'zhipu', 'chatglm', 'baichuan', 'doubao', 'erniebot', 'wenxin', 'manusai',
    'devinai', 'cognitionai', 'openhandsai', 'clinebot', 'gooseai', 'julesai', 'naver', 'hyperclova', 'hyperclovax', 'clova',
    'kakao', 'kanana', 'upstageai', 'exaone', 'lgai', 'wrtn', 'skt', 'adot', 'samsunggauss'
  ]::text[]
$$;

-- ---------------------------------------------------------------------------
-- ② 이미 있던 행 — (id, 주소) 쌍을 굳힌다(이 잠금 아래에서 · 함수를 바꾸기 전에)
-- ---------------------------------------------------------------------------
-- 옛 CHECK 통과 = 옛 운영자 목록 안이거나 옛 예약 밖. 새 CHECK 위반 = 새 운영자 목록 밖이고(옛 예약 안이거나 atmark.ai 의 브랜드 키 일치).
-- 새 91개 이름은 전부 브랜드 키 안이다(①) — 따로 적지 않는다.

DO $do$
DECLARE
  keys text[];
BEGIN
  SELECT coalesce(array_agg(a.id::text || ' ' || a.address ORDER BY a.id), '{}'::text[]) INTO keys
    FROM agent_addresses a
   WHERE (a.address = ANY (atmark_operator_assignable_addresses())
          OR NOT (split_part(a.address, '@', 1) = ANY (atmark_reserved_local_parts_for(split_part(a.address, '@', 2)))))
     AND NOT (a.address = ANY (ARRAY['support@atmark.ai', 'onve@atmark.ai', 'abuse@atmark.ai', 'postmaster@atmark.ai']::text[]))
     AND (split_part(a.address, '@', 1) = ANY (atmark_reserved_local_parts_for(split_part(a.address, '@', 2)))
          OR (split_part(a.address, '@', 2) = 'atmark.ai'
              AND regexp_replace(split_part(a.address, '@', 1), '[._-]', '', 'g') = ANY (atmark_brand_reserved_keys())));
  RAISE NOTICE '202610141200: 예약 이전 행 % 개를 그대로 둔다(atmark_reserved_grandfathered_address_keys)', cardinality(keys);
  EXECUTE format(
    $f$CREATE FUNCTION atmark_reserved_grandfathered_address_keys() RETURNS text[]
       LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $body$ SELECT %L::text[] $body$ $f$,
    keys::text);
END
$do$;

COMMENT ON FUNCTION atmark_reserved_grandfathered_address_keys() IS
  '예약 로컬파트 CHECK 의 예외(202610141200) — 그 이름이 예약되기 전에 이미 있던 agent_addresses 행의 ''<id> <address>'' 쌍(상수). 그 행만 그대로 쓴다(폐기·대표 변경). 주소 행은 지울 수 없고(agent_addresses_no_delete) 주소는 바뀌지 않는다. 나중의 확장은 쌍을 더하기만 한다.';

-- ---------------------------------------------------------------------------
-- ③ 예약 로컬파트 — 끝에 새 91개
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
    'grok', 'llama', 'meta-ai', 'mistral', 'deepseek', 'kimi', 'perplexity', 'replit', 'lovable', 'v0',
    'xai', 'grokbot', 'grok-bot', 'groq', 'google-ai', 'deepmind', 'gemma', 'openai-agent', 'gpt-4', 'gpt4',
    'gpt-4o', 'gpt4o', 'gpt-5', 'gpt5', 'sora', 'dall-e', 'dalle', 'chatgpt-bot', 'codex-cli', 'anthropic-ai',
    'claude-ai', 'claudebot', 'claude-bot', 'copilot-agent', 'microsoft-copilot', 'bing', 'amazon-q', 'alexa', 'siri', 'apple-intelligence',
    'meta-llama', 'llama-agent', 'nousresearch', 'nous-research', 'hermes-agent', 'cohere', 'command-r', 'huggingface', 'hugging-face', 'midjourney',
    'stability-ai', 'stabilityai', 'stable-diffusion', 'runwayml', 'inflection-ai', 'character-ai', 'phind', 'tabnine', 'codeium', 'sourcegraph',
    'lindy-ai', 'adept-ai', 'cerebras', 'together-ai', 'fireworks-ai', 'mistral-ai', 'mixtral', 'deepseek-ai', 'qwen-agent', 'tongyi',
    'kimi-ai', 'moonshot-ai', 'minimax-ai', 'zhipu', 'chatglm', 'baichuan', 'doubao', 'ernie-bot', 'wenxin', 'manus-ai',
    'devin-ai', 'cognition-ai', 'openhands-ai', 'cline-bot', 'goose-ai', 'jules-ai', 'naver', 'hyperclova', 'hyperclova-x', 'hyperclovax',
    'clova', 'kakao', 'kanana', 'upstage-ai', 'exaone', 'lg-ai', 'wrtn', 'skt', 'adot', 'a-dot',
    'samsung-gauss'
  ]::text[]
$$;

-- ---------------------------------------------------------------------------
-- ④ 운영자 발급 가능 주소 — claude@ 를 뺀다
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION atmark_operator_assignable_addresses() RETURNS text[]
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT ARRAY['support@atmark.ai', 'onve@atmark.ai', 'abuse@atmark.ai', 'postmaster@atmark.ai']::text[]
$$;

-- ---------------------------------------------------------------------------
-- ⑤ CHECK — 운영자 목록 · 예약 이전 행은 통과, 나머지는 예약 판정 + atmark.ai 브랜드 키(NOT VALID — 검증은 1201)
-- ---------------------------------------------------------------------------

ALTER TABLE agent_addresses ADD CONSTRAINT agent_addresses_not_reserved_local_part
  CHECK (
    address = ANY (atmark_operator_assignable_addresses())
    OR (id::text || ' ' || address) = ANY (atmark_reserved_grandfathered_address_keys())
    OR NOT (
      split_part(address, '@', 1) = ANY (atmark_reserved_local_parts_for(split_part(address, '@', 2)))
      OR (split_part(address, '@', 2) = 'atmark.ai'
          AND regexp_replace(split_part(address, '@', 1), '[._-]', '', 'g') = ANY (atmark_brand_reserved_keys()))
    )
  ) NOT VALID;

-- ---------------------------------------------------------------------------
-- ⑥ 주소 행은 지우지 않는다(모든 롤)
-- ---------------------------------------------------------------------------

CREATE TRIGGER agent_addresses_no_delete BEFORE DELETE ON agent_addresses
  FOR EACH ROW EXECUTE FUNCTION reject_row_delete();
CREATE TRIGGER agent_addresses_no_truncate AFTER TRUNCATE ON agent_addresses
  FOR EACH STATEMENT EXECUTE FUNCTION reject_truncate();

-- ---------------------------------------------------------------------------
-- ⑦ claude@ 허가 행 — 지운다(있으면)
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  g record;
BEGIN
  FOR g IN DELETE FROM operator_address_grants WHERE address = 'claude@atmark.ai'
           RETURNING organization_id, granted_by, reason, created_at LOOP
    RAISE NOTICE '202610141200: operator_address_grants claude@atmark.ai 행을 지웠다 — 조직 % · 허가자 % · 사유 % · 시각 %',
      g.organization_id, g.granted_by, g.reason, g.created_at;
  END LOOP;
END
$$;
