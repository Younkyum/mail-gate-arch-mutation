-- 202609301400_agent_token_capability_webhooks_manage.sql
-- 웹훅 관리 전용 권한 `webhooks:manage`(진윤겸 2026-09-30 승인 — ADR-0013 2026-09-30 개정). 에이전트 토큰 권한 열거형에 값 하나를 더한다.
--
-- 왜 새 권한인가: 웹훅 등록은 **외부로 나가는 데이터 경로를 새로 만든다**(이벤트가 등록된 URL 로 푸시된다). 그것을 읽기 토큰(`messages:read`)이
--   할 수 있으면 읽기만 주려던 토큰이 바깥 수신지를 연다. 등록·삭제·시크릿 회전·재전송은 이 권한을 요구하고, 목록·전달 목록은 `messages:read` 다.
--   옛 토큰은 이 값을 갖지 않는다 — 2026-12-31 까지 `messages:send` 도 받는다(전환 경로 · 구조화 로그, `src/webhooks/management.ts`).
--
-- **이 파일은 이 한 줄뿐이다.** `ALTER TYPE … ADD VALUE` 로 더한 값은 그 트랜잭션이 커밋되기 전에는 쓸 수 없고(Postgres 제약), 러너는 파일 하나 =
-- 트랜잭션 하나다. 열거형 값 추가는 되돌릴 수 없다(append-only) — `IF NOT EXISTS` 라 재실행해도 같다. 목록은
-- `src/identity/agent-token.ts` `AGENT_TOKEN_CAPABILITIES` 와 같아야 한다(`test/integration/db/schema-shape.test.ts` 가 순서까지 대조한다).

SET LOCAL lock_timeout = '5s';

ALTER TYPE agent_token_capability ADD VALUE IF NOT EXISTS 'webhooks:manage';
