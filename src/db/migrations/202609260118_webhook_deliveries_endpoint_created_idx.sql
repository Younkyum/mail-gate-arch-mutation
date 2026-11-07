-- atmark:no-transaction
-- 202609260118_webhook_deliveries_endpoint_created_idx.sql
-- 메일 기본기 1차 A4 — 전달 목록(`GET /v1/agents/{id}/webhook-deliveries`): 에이전트의 엔드포인트마다 최신순 `(created_at, id)` 커서.
--
-- **비트랜잭션 파일이다**(202609260117 머리말과 같다). `webhook_deliveries` 는 지우지 않아 계속 자라므로 이 빌드가 가장 길다 — 그동안
-- outbox 쓰기는 막히지 않는다(코드 리뷰 H1).

CREATE INDEX CONCURRENTLY IF NOT EXISTS webhook_deliveries_endpoint_created_idx ON webhook_deliveries (endpoint_id, created_at DESC, id DESC);
