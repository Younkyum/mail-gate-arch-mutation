-- atmark:no-transaction
-- 202610071001_inbound_messages_quarantine_created_idx.sql
-- 격리 알림 대조(보안 리뷰 L1 — `workers/quarantine-notifier.ts`): 알림기 틱이 최근 24시간의 격리 메일(스캐너 격리 · 판정 없음) 중 항목 행이 없는 수를 센다.
-- 그 두 사유의 행만(부분 색인 — 격리 메일은 수신의 작은 몫). 매분 도는 조회가 수신 표 전체를 훑지 않게.
--
-- **비트랜잭션 파일이다** — 쓰기를 막지 않고 만든다. INVALID 로 남으면 `DROP INDEX CONCURRENTLY inbound_messages_quarantine_created_idx` 뒤 다시 적용한다.

CREATE INDEX CONCURRENTLY IF NOT EXISTS inbound_messages_quarantine_created_idx ON inbound_messages (created_at)
  WHERE quarantine_reason IN ('injection_risk', 'scanner_error');
