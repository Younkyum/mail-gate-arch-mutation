-- 202610041001_injection_signals_validate.sql
-- 202610041000 이 `NOT VALID` 로 더한 CHECK 둘의 기존 행 검증. `VALIDATE CONSTRAINT` 는 SHARE UPDATE EXCLUSIVE 라 발송·승인 쓰기를 막지 않는다.
--   · `messages_outbound_dlp_check` — 기존 행은 전부 NULL 이라 통과한다.
--   · `approval_requests_granted_scope_check` — 기존 행은 recipient·thread·domain·NULL 뿐이라 통과한다.
-- 실패하면 이 트랜잭션만 되돌아가고 제약은 NOT VALID 로 남는다(새 행·UPDATE 에는 여전히 선다 — migrate status 의 `unvalidatedGuards` 가 이름으로 알린다).

SET LOCAL lock_timeout = '5s';

ALTER TABLE messages VALIDATE CONSTRAINT messages_outbound_dlp_check;
ALTER TABLE approval_requests VALIDATE CONSTRAINT approval_requests_granted_scope_check;
