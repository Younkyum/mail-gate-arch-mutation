-- 202610131200_agent_token_capability_policy_request.sql
-- 정책 변경 **요청** 전용 권한 `policy:request`(진윤겸 2026-10-13 — "허용 목록 같은 변경을 에이전트한테 시키는 경우가 있다. 유저의 승인을 받으면 에이전트가
-- 수정할 수 있도록"). 에이전트 토큰 권한 열거형에 값 하나를 더한다.
--
-- 왜 `policy:write` 가 아닌가: `policy:write`(금지 목록 — `FORBIDDEN_TO_AGENT_TOKENS`)는 정책을 **바꾸는** 권한이다. `policy:request` 는 바꾸지 않는다 —
--   소유자에게 요청 한 행(`policy_change_requests`, 202610131201)을 남길 뿐이고, 바뀌는 것은 소유자가 콘솔에서 승인한 뒤 소유자 행위(관리 연산 · 감사 1행 ·
--   새 정책 버전)로서다. "에이전트 토큰은 policy:write 를 갖지 않는다" 는 그대로다.
--
-- **이 파일은 이 한 줄뿐이다**(`ALTER TYPE … ADD VALUE` 는 커밋 전에 쓸 수 없다 — 러너는 파일 하나 = 트랜잭션 하나). append-only · `IF NOT EXISTS`.
-- 목록은 `src/identity/agent-token.ts` `AGENT_TOKEN_CAPABILITIES` 와 같은 순서다(`test/integration/db/schema-shape.test.ts`).

SET LOCAL lock_timeout = '5s';

ALTER TYPE agent_token_capability ADD VALUE IF NOT EXISTS 'policy:request';
