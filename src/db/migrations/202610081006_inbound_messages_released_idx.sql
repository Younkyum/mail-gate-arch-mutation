-- atmark:no-transaction
-- 202610081006_inbound_messages_released_idx.sql
-- 풀린 메일의 `since` 겹침(적대적 검증 S-I19 · S-H19 — `inbound-read-store.ts` 목록의 셋째 가지): 풀린 메일은 `received_at` 이 과거라, 마지막으로 본 시각을 `since` 로
-- 쓰는 에이전트는 풀린 행을 건너뛴다. 셋째 가지가 `released_at >= since` 인 행을 에이전트마다 이 부분 색인으로 찾는다(풀린 행은 소수).
--
-- **비트랜잭션 파일이다** — 쓰기를 막지 않고 만든다. INVALID 로 남으면 러너가 `DROP INDEX CONCURRENTLY IF EXISTS` 로 치우고 다시 만든다.

CREATE INDEX CONCURRENTLY IF NOT EXISTS inbound_messages_released_idx ON inbound_messages (agent_id, released_at) WHERE released_at IS NOT NULL;
