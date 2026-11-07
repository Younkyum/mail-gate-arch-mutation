-- atmark:no-transaction
-- 202609260119_webhook_endpoints_agent_created_idx.sql
-- 메일 기본기 1차 A4 — 재등록 상한(앱 24시간 10회 · 트리거 `webhook_endpoints_registration_ceiling` 바닥 20회)의 분자: 에이전트별 생성 시각.
--
-- **비트랜잭션 파일이다**(202609260117 머리말과 같다). 표는 작지만 규율을 하나로 둔다 — 기존 표에 색인을 더하는 1차 파일은 모두
-- `CONCURRENTLY` 다(0115 H1 · 0105 L10 · 0120 M2).

CREATE INDEX CONCURRENTLY IF NOT EXISTS webhook_endpoints_agent_created_idx ON webhook_endpoints (agent_id, created_at);
