-- atmark:no-transaction
-- 202609291123_inbound_rejections_unknown_created_idx.sql
-- 고객 도메인(ADR-0014 · 계획 §3.6 L10) — 시끄러운 수신(모르는 수신자) 집계가 **최근 70분 창만** 읽게 하는 부분 색인. 봉투 수신자 전체를 unnest 로
-- 훑지 않는다. 같은 이름·모양의 색인은 이전에 없었다(2026-09-29 확인 — 봉투 GIN · (ses_message_id, reason) 유니크뿐).
--
-- **비트랜잭션 파일이다**(202609260117 머리말과 같다) — 수신 거부 표에 쓰기를 막지 않고 만든다.

CREATE INDEX CONCURRENTLY IF NOT EXISTS inbound_rejections_unknown_created_idx ON inbound_rejections (created_at) WHERE reason = 'unknown_recipient';
