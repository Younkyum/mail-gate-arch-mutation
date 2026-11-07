-- atmark:no-transaction
-- 202610131614_ses_events_complaint_hash_idx.sql
-- 신고자 해시 보존 스윕(202610131612 `atmark_purge_complaint_hashes` · 재검증 I-1)의 **부분** 색인 — 해시가 남은 complaint 행만 담아 작다(신고는 드물다).
-- 없으면 스윕이 5분마다 8일 넘은 SES 이벤트 전체를 훑는다.
--
-- **비트랜잭션 파일이다**(202609260117 머리말과 같다) — SES 이벤트 소비자의 쓰기를 막지 않고 만든다.

CREATE INDEX CONCURRENTLY IF NOT EXISTS ses_events_complaint_hashes_received_idx ON ses_events (received_at) WHERE complaint_recipient_hashes IS NOT NULL;
