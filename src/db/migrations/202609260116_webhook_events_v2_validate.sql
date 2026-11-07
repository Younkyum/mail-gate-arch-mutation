-- 202609260116_webhook_events_v2_validate.sql
-- 메일 기본기 1차 A4 — 202609260115 가 `NOT VALID` 로 더한 제약 셋의 기존 행 검증(코드 리뷰 H1).
--
-- `VALIDATE CONSTRAINT` 는 SHARE UPDATE EXCLUSIVE 만 잡는다(FK 는 참조 표에 ROW SHARE 도 — 여기서는 같은 표다). 수신 기록·승인·
-- 디스패처의 `webhook_deliveries` INSERT·UPDATE 는 검증이 표를 훑는 동안에도 그대로 돈다 — 0115 가 ACCESS EXCLUSIVE 를 쥔 채 훑던 것을
-- 쓰기를 막지 않는 잠금으로 옮긴 것이 이 파일이다.
--
-- 기존 행은 `redelivery_of` · `event_types` 가 모두 NULL 이고 옛 dedupe 키는 `redelivery:` 로 시작하지 않으므로 셋 다 통과한다. 실패하면
-- 이 트랜잭션만 되돌아가고 제약은 NOT VALID 로 남는다(새 행에는 여전히 선다) — 원인 행을 확인하고 다시 돌린다.

SET LOCAL lock_timeout = '5s';

ALTER TABLE webhook_endpoints VALIDATE CONSTRAINT webhook_endpoints_event_types_shape;
ALTER TABLE webhook_deliveries VALIDATE CONSTRAINT webhook_deliveries_redelivery_of_fkey;
ALTER TABLE webhook_deliveries VALIDATE CONSTRAINT webhook_deliveries_redelivery_shape;
