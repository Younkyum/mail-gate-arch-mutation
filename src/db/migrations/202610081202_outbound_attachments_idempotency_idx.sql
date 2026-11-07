-- atmark:no-transaction
-- 202610081202_outbound_attachments_idempotency_idx.sql
-- `POST /v1/attachments` 의 `Idempotency-Key`(202610081200 ③) — 에이전트별로 한 키는 한 첨부다. 앱은 에이전트 잠금 아래 먼저 찾고(같은 요청이면
-- 같은 첨부), 이 UNIQUE 가 경합의 마지막 선이다. 키가 있는 행만(부분 색인 — 옛 행 · 키 없는 업로드는 색인에 없다).
--
-- **비트랜잭션 파일이다** — 쓰기를 막지 않고 만든다. INVALID 로 남으면 `DROP INDEX CONCURRENTLY outbound_attachments_agent_idempotency_key` 뒤 다시 적용한다.

CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS outbound_attachments_agent_idempotency_key ON outbound_attachments (agent_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
