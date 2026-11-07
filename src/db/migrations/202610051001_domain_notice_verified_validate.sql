-- 202610051001_domain_notice_verified_validate.sql
-- 202610051000 이 `NOT VALID` 로 바꾼 `domain_notices_kind_check` 의 기존 행 검증(SHARE UPDATE EXCLUSIVE — 쓰기를 막지 않는다). 옛 행은 더 좁은 옛 규칙을 지났다.

SET LOCAL lock_timeout = '5s';

ALTER TABLE domain_notices VALIDATE CONSTRAINT domain_notices_kind_check;
