-- atmark:no-transaction
-- 202610061102_inbound_messages_ai_watch_job_idx.sql
-- 작업 → 메일 행 역조회(202610061100 `ai_watch_release` — 보류 풀기 · 웹훅 앞당기기, 그리고 작업 보존 삭제의 FK `ON DELETE SET NULL`).
-- 연결된 행만(부분 색인 — 감시를 켠 조직의 승격 메일뿐이라 작다).
--
-- **비트랜잭션 파일이다** — 쓰기를 막지 않고 만든다. INVALID 로 남으면 `DROP INDEX CONCURRENTLY inbound_messages_ai_watch_job_idx` 뒤 다시 적용한다.

CREATE INDEX CONCURRENTLY IF NOT EXISTS inbound_messages_ai_watch_job_idx ON inbound_messages (ai_watch_job_id)
  WHERE ai_watch_job_id IS NOT NULL;
