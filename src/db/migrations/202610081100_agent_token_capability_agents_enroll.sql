-- 202610081100_agent_token_capability_agents_enroll.sql
-- 자가 등록 전용 권한 `agents:enroll`(진윤겸 2026-10-08 — 계획 docs/internal/plans/watch-and-dev-surface.md 묶음 D 항목 2a · ADR-0016 2026-10-08 개정 "자가 등록").
-- 에이전트 토큰 권한 열거형에 값 하나를 더한다.
--
-- 왜 `agents:create` 가 아닌가: `agents:create`(조직 키)는 무엇이든 만들 수 있다 — 모드 · 토큰 권한 · 이름 · 도메인. `agents:enroll` 은 **안전 기본값 고정**의
--   형제 에이전트 하나(발신 allowlist_only 빈 목록 · 발신 승인 always · 위험 보류 hold · 토큰은 messages:read/send · agent:read_self 뿐)를 조직 설정이 켜졌을 때만,
--   하루 상한 안에서 만든다. "에이전트 토큰은 agents:create 를 갖지 않는다" 는 그대로다(`FORBIDDEN_TO_AGENT_TOKENS`).
--
-- **이 파일은 이 한 줄뿐이다**(`ALTER TYPE … ADD VALUE` 는 커밋 전에 쓸 수 없다 — 러너는 파일 하나 = 트랜잭션 하나). append-only · `IF NOT EXISTS`.
-- 목록은 `src/identity/agent-token.ts` `AGENT_TOKEN_CAPABILITIES` 와 같은 순서다(`test/integration/db/schema-shape.test.ts`).

SET LOCAL lock_timeout = '5s';

ALTER TYPE agent_token_capability ADD VALUE IF NOT EXISTS 'agents:enroll';
