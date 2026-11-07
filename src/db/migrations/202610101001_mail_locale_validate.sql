-- 202610101001_mail_locale_validate.sql
-- 202610101000 의 `users.mail_locale` FK 를 검증한다(NOT VALID → VALIDATE 규칙 — 검증은 SHARE UPDATE EXCLUSIVE 만 잡아 읽기 · 쓰기를 막지 않는다).
-- 기존 행은 모두 NULL 이라 어긋나는 행이 없다.

SET LOCAL lock_timeout = '5s';

ALTER TABLE users VALIDATE CONSTRAINT users_mail_locale_fkey;
