-- atmark:no-transaction
-- 202610061103_inbound_messages_ai_watch_created_idx.sql
-- 수신 목록 `since` 의 겹침 가지(재검증 M3 — `inbound-read-store.ts` `LIST_VISIBLE_SQL` ②): AI 감시 작업이 이어진 행을 에이전트 · 기록 시각으로 찾는다.
-- 연결된 행만(부분 색인 — 감시를 켠 조직의 승격 메일뿐이라 작다). 본 가지는 기존 `inbound_messages_agent_received_idx` 그대로.
--
-- **비트랜잭션 파일이다** — 쓰기를 막지 않고 만든다. INVALID 로 남으면 `DROP INDEX CONCURRENTLY inbound_messages_ai_watch_created_idx` 뒤 다시 적용한다.

CREATE INDEX CONCURRENTLY IF NOT EXISTS inbound_messages_ai_watch_created_idx ON inbound_messages (agent_id, created_at)
  WHERE ai_watch_job_id IS NOT NULL;
