-- atmark:no-transaction
-- 202610081104_agent_enrollments_request_id_idx.sql
-- 자가 등록 요청 id 는 한 번만(202610081103 ① — 동시 재생의 마지막 선). 옛 행(NULL)은 색인에 없다.
--
-- **비트랜잭션 파일이다** — 쓰기를 막지 않고 만든다. INVALID 로 남으면 `DROP INDEX CONCURRENTLY agent_enrollments_request_id_key` 뒤 다시 적용한다.

CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS agent_enrollments_request_id_key ON agent_enrollments (request_id)
  WHERE request_id IS NOT NULL;
