-- atmark:no-transaction
-- 202610081002_quarantine_notices_open_kind_idx.sql
-- 격리 알림의 열린 창 — **에이전트 · 종류(block | risk)마다** 하나(202610081000 ④). 옛 색인 `quarantine_notices_open_key (agent_id)` 는 1003 이 지운다
-- (그 사이 위험 창은 옛 색인에 막혀 계수를 건너뛴다 — 트리거 함수가 바뀌는 것도 1003 이라 실제로는 생기지 않는다).
--
-- **비트랜잭션 파일이다** — 쓰기를 막지 않고 만든다. INVALID 로 남으면 러너가 `DROP INDEX CONCURRENTLY IF EXISTS` 로 치우고 다시 만든다.

CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS quarantine_notices_open_kind_key ON quarantine_notices (agent_id, kind)
  WHERE status = 'pending' AND claimed_at IS NULL;
