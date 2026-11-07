-- 202609280101_login_codes_validate.sql
-- 로그인·가입 코드 — 202609280100 이 `NOT VALID` 로 더한 CHECK 의 기존 행 검증(SHARE UPDATE EXCLUSIVE — 쓰기를 막지 않는다).
-- 기존 행은 `code_failures` 가 전부 기본값 0 이라 걸릴 행이 없다.

SET LOCAL lock_timeout = '5s';

ALTER TABLE owner_login_links VALIDATE CONSTRAINT owner_login_links_code_failures_range;
ALTER TABLE signup_links VALIDATE CONSTRAINT signup_links_code_failures_range;
