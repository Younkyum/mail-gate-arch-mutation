-- 202609301531_waitlist_intake_validate.sql
-- 202609301530 이 `NOT VALID` 로 더한 모양 CHECK 일곱의 기존 행 검증. `VALIDATE CONSTRAINT` 는 SHARE UPDATE EXCLUSIVE 라 대기 등록 · 가입 확정 ·
-- 조직 쓰기(INSERT·UPDATE)를 막지 않는다. 기존 행은 새 칸이 전부 NULL 이라 통과한다. 실패하면 이 트랜잭션만 되돌아가고 제약은 NOT VALID 로 남는다
-- (새 행·UPDATE 에는 여전히 선다 — migrate status 의 `unvalidatedGuards` 가 이름으로 알린다).

SET LOCAL lock_timeout = '5s';

ALTER TABLE waitlist_entries VALIDATE CONSTRAINT waitlist_entries_use_case_check;
ALTER TABLE waitlist_entries VALIDATE CONSTRAINT waitlist_entries_heard_from_check;
ALTER TABLE waitlist_entries VALIDATE CONSTRAINT waitlist_entries_ref_check;
ALTER TABLE organizations VALIDATE CONSTRAINT organizations_signup_ref_check;
ALTER TABLE organizations VALIDATE CONSTRAINT organizations_signup_heard_from_check;
ALTER TABLE organizations VALIDATE CONSTRAINT organizations_signup_use_case_check;
ALTER TABLE organizations VALIDATE CONSTRAINT organizations_signup_invite_week_check;
