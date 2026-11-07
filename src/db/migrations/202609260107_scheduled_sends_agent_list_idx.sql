-- atmark:no-transaction
-- 202609260107_scheduled_sends_agent_list_idx.sql
-- 메일 기본기 1차 A3 — 예약 목록(`GET /v1/messages/scheduled`, MCP `list_scheduled`)의 커서 `(send_at DESC, id DESC)`.
--
-- **비트랜잭션 파일이다**(첫 줄 지시자 — `src/db/migrate.ts`). `CREATE INDEX CONCURRENTLY` 는 트랜잭션 안에서 돌 수 없고, 러너는 이런
-- 파일에 문장 **하나**만 허용한다: `CREATE [UNIQUE] INDEX CONCURRENTLY IF NOT EXISTS <이름> ON <표> …`. 빌드 동안 쓰기를 막지 않는다
-- (SHARE UPDATE EXCLUSIVE). 잠금 대기 상한은 러너가 세션에 건다(`SET LOCAL` 은 트랜잭션 밖에서 뜻이 없다).
-- 중간에 실패해 INVALID 색인이 남으면 다음 실행에서 러너가 `DROP INDEX CONCURRENTLY IF EXISTS` 로 치우고 다시 만든다.

CREATE INDEX CONCURRENTLY IF NOT EXISTS scheduled_sends_agent_list_idx ON scheduled_sends (agent_id, send_at DESC, id DESC);
