-- atmark:no-transaction
-- 202609260121_inbound_messages_visible_from_domain_idx.sql
-- 메일 기본기 1차 A5 — 에이전트 수신 목록(`GET /v1/messages/inbound?from_domain=`, MCP `list_inbox`)의 발신 도메인 필터 부분 색인.
--
-- 술어는 `inbound-read-store.ts` 의 `visibleToAgent('m')`(`NOT quarantined AND injection_risk IS NOT NULL`)와 **글자 그대로 같다** — 그래서
-- 플래너가 에이전트 조회에 이 색인을 쓴다(AC-A5-4 가 EXPLAIN 으로 본다). 정렬 칸은 목록 커서 `(received_at DESC, id DESC)` 와 같다.
-- 격리 행은 색인에 없다(에이전트 표면은 격리를 보지 않는다 — 소유자 콘솔은 202609241100 의 `inbound_messages_agent_log_idx` 를 쓴다).
-- `from`(주소) 필터에는 따로 색인을 두지 않는다 — 기존 `inbound_messages_agent_from_idx` 가 덮는다(202609260120 머리말, 코드 리뷰 M2).
--
-- **비트랜잭션 파일이다**(첫 줄 지시자 — `src/db/migrate.ts`). 빌드 동안 수신 소비자의 INSERT·격리 해제 UPDATE 를 막지 않는다(코드 리뷰 M2 —
-- 비동시 빌드의 SHARE 잠금은 그 쓰기를 막아 소비자 재시도로 번졌다). 실패가 남긴 INVALID 색인은 다음 실행에서 러너가 치우고 다시 만든다.

CREATE INDEX CONCURRENTLY IF NOT EXISTS inbound_messages_visible_from_domain_idx ON inbound_messages (agent_id, from_domain, received_at DESC, id DESC) WHERE NOT quarantined AND injection_risk IS NOT NULL;
