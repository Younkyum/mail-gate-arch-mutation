-- atmark:no-transaction
-- 202609291122_messages_custom_from_domain_created_idx.sql
-- 고객 도메인(ADR-0014 · 계획 §3.2 L7) — 발신 도메인 24시간 수신자 수(Stage 4 도메인 캡 `domainRecipientsLastDay`, `policy-source.ts`)와 도메인 평판
-- 집계가 쓰는 **부분** 색인. 고객 도메인 메일만 담아 작다(지금은 0행). `from_domain` 만으로 거르면 색인이 없어 메시지 전체를 훑는다.
--
-- **비트랜잭션 파일이다**(202609260117 머리말과 같다) — 발신 표에 쓰기를 막지 않고 만든다.

CREATE INDEX CONCURRENTLY IF NOT EXISTS messages_custom_from_domain_created_idx ON messages (from_domain, created_at) WHERE from_domain <> 'atmark.ai';
