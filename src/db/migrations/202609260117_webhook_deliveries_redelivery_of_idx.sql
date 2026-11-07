-- atmark:no-transaction
-- 202609260117_webhook_deliveries_redelivery_of_idx.sql
-- 메일 기본기 1차 A4 — 재전송 가족 세기(`webhook_deliveries_redelivery_guard` 의 천장 3 · 목적지 거부류 검사, 앱의 재전송 라우트). 부분 색인 —
-- 재전송 행만 든다(원래 전달 행은 `redelivery_of IS NULL`).
--
-- **비트랜잭션 파일이다**(첫 줄 지시자 — `src/db/migrate.ts`). 러너는 이런 파일에 `CREATE [UNIQUE] INDEX CONCURRENTLY IF NOT EXISTS …`
-- 문장 하나만 허용하고, 잠금 대기 상한을 세션에 걸며, 앞선 실패가 남긴 INVALID 색인은 `DROP INDEX CONCURRENTLY IF EXISTS` 뒤에 다시
-- 만든다. 빌드 동안 outbox 쓰기를 막지 않는다(코드 리뷰 H1).

CREATE INDEX CONCURRENTLY IF NOT EXISTS webhook_deliveries_redelivery_of_idx ON webhook_deliveries (redelivery_of) WHERE redelivery_of IS NOT NULL;
