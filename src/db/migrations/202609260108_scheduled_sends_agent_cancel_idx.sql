-- atmark:no-transaction
-- 202609260108_scheduled_sends_agent_cancel_idx.sql
-- 메일 기본기 1차 A3 — 에이전트 취소 시간당 상한(`AGENT_SCHEDULED_CANCEL_HOURLY_LIMIT`, `scheduled-send-store.ts` `cancel`)을 세는 부분 색인.
--
-- 상한은 **에이전트 토큰의 모든 경로**(`http`·`mcp`)에 선다(1차 수정 리드 결정 — 보안 M1). 술어 `cancelled_via IN ('http', 'mcp')` 는
-- 저장소의 세기 쿼리와 글자 그대로 같다 — 그래서 플래너가 이 색인을 쓴다. 나중에 소유자 콘솔 취소 경로가 생겨 `cancelled_via` 에 새 값이
-- 들면 그 행은 이 색인에 들지 않는다(소유자 취소는 에이전트 상한에 세지 않는다). 예약 중인 행(`cancelled_via IS NULL`)도 들지 않는다.
--
-- **비트랜잭션 파일이다**(202609260107 머리말과 같다).

CREATE INDEX CONCURRENTLY IF NOT EXISTS scheduled_sends_agent_cancel_idx ON scheduled_sends (agent_id, cancelled_at) WHERE cancelled_via IN ('http', 'mcp');
