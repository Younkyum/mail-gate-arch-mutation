-- 202610081005_trusted_senders_shape_validate.sql
-- 202610081004 의 NOT VALID 제약 검증(SHARE UPDATE EXCLUSIVE — 쓰기를 막지 않는다).

SET LOCAL lock_timeout = '5s';

ALTER TABLE org_trusted_senders VALIDATE CONSTRAINT org_trusted_senders_value_kind;
ALTER TABLE org_trusted_senders VALIDATE CONSTRAINT org_trusted_senders_not_freemail;
