-- 202609301411_webhook_secret_rotation_validate.sql
-- 202609301410 이 `NOT VALID` 로 더한 CHECK 둘(회전 칸 모양 · 등록 표면)의 기존 행 검증. `VALIDATE CONSTRAINT` 는 SHARE UPDATE EXCLUSIVE 라 쓰기
-- (등록·삭제)를 막지 않는다. 기존 행은 회전 칸 넷이 모두 NULL(회전한 적 없음)이고 `created_via` 는 기본값 'api' 라 통과한다. 실패하면 이 트랜잭션만
-- 되돌아가고 제약은 NOT VALID 로 남는다(새 행·UPDATE 에는 여전히 선다).

SET LOCAL lock_timeout = '5s';

ALTER TABLE webhook_endpoints VALIDATE CONSTRAINT webhook_endpoints_secret_rotation_shape;
ALTER TABLE webhook_endpoints VALIDATE CONSTRAINT webhook_endpoints_created_via_check;
