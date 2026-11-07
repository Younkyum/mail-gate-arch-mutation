-- 202609290701_login_code_attempts_pair_validate.sql
-- 코드 verify 시도 원장의 쌍 키 — 202609290700 이 `NOT VALID` 로 더한 CHECK 의 기존 행 검증(SHARE UPDATE EXCLUSIVE — 쓰기를 막지 않는다).
-- 기존 행은 `pair_key` 가 전부 NULL 이라(CHECK 는 NULL 을 통과시킨다) 걸릴 행이 없다. 이 파일이 끝나야 `REQUIRED_GUARDS` 의
-- `constraint:login_code_attempts.login_code_attempts_pair_key_shape` 가 `convalidated` 다.

SET LOCAL lock_timeout = '5s';

ALTER TABLE login_code_attempts VALIDATE CONSTRAINT login_code_attempts_pair_key_shape;
