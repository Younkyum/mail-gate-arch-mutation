-- 202610081201_drafts_labels_validate.sql
-- 202610081200 이 `NOT VALID` 로 더한 CHECK 의 기존 행 검증. `VALIDATE CONSTRAINT` 는 SHARE UPDATE EXCLUSIVE 라 업로드 생성을 막지 않는다.
--   · `outbound_attachments_idempotency_shape` — 기존 행은 두 칸 다 NULL 이라 통과한다.
-- 실패하면 이 트랜잭션만 되돌아가고 제약은 NOT VALID 로 남는다(새 행에는 여전히 선다 — migrate status 의 `unvalidatedGuards` 가 이름으로 알린다).

SET LOCAL lock_timeout = '5s';

ALTER TABLE outbound_attachments VALIDATE CONSTRAINT outbound_attachments_idempotency_shape;
