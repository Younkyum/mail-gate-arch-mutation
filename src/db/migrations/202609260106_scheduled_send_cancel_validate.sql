-- 202609260106_scheduled_send_cancel_validate.sql
-- 메일 기본기 1차 A3 — 202609260105 가 `NOT VALID` 로 더한 `scheduled_sends` CHECK 넷의 기존 행 검증(코드 리뷰 L10 · 0115 H1 과 같은 규율).
--
-- `VALIDATE CONSTRAINT` 는 SHARE UPDATE EXCLUSIVE 만 잡는다 — 표를 훑는 동안 워커의 `claimDue`·`markDispatched`, 생성·취소 라우트의
-- INSERT·UPDATE 가 그대로 돈다(막히는 것은 다른 DDL·VACUUM 뿐). 기존 행은 새 칼럼이 모두 NULL 이고 `status = 'cancelled'` 가 없으므로
-- (enum 값이 202609260100 에서 처음 생겼다) 넷 다 통과한다. 실패하면 이 트랜잭션만 되돌아가고 제약은 NOT VALID 로 남는다 — 새 행에는
-- 여전히 선다. 원인 행을 고친 뒤 다시 돌린다.
--
-- 이 파일이 끝나야 `pg_constraint.convalidated` 가 참이 된다. `REQUIRED_GUARDS`(`src/runtime/handlers/migrate.ts`)는 제약의 존재를 보고,
-- 이 파일이 적용됐는지는 `status` 의 `pending` 이 본다.

SET LOCAL lock_timeout = '5s';

ALTER TABLE scheduled_sends VALIDATE CONSTRAINT scheduled_sends_cancel_reason_code_check;
ALTER TABLE scheduled_sends VALIDATE CONSTRAINT scheduled_sends_cancel_note_check;
ALTER TABLE scheduled_sends VALIDATE CONSTRAINT scheduled_sends_cancelled_via_check;
ALTER TABLE scheduled_sends VALIDATE CONSTRAINT scheduled_sends_cancelled_shape;
