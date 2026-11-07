-- 202609301511_signup_lang_welcome_mails_validate.sql
-- 202609301510 이 `NOT VALID` 로 더한 `signup_links_lang_check` 의 기존 행 검증. `VALIDATE CONSTRAINT` 는 SHARE UPDATE EXCLUSIVE 라 가입 요청·확정
-- (INSERT·UPDATE)를 막지 않는다. 기존 행은 새 칸이 전부 NULL 이라 통과한다. 실패하면 이 트랜잭션만 되돌아가고 제약은 NOT VALID 로 남는다(새 행·
-- UPDATE 에는 여전히 선다).

SET LOCAL lock_timeout = '5s';

ALTER TABLE signup_links VALIDATE CONSTRAINT signup_links_lang_check;
