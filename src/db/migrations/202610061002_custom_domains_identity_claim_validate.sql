-- 202610061002_custom_domains_identity_claim_validate.sql
-- 202610061000 이 `NOT VALID` 로 더한 CHECK 둘 · FK 하나의 기존 행 검증(SHARE UPDATE EXCLUSIVE — 쓰기를 막지 않는다). 백필이 verifying+ 행을 전부
-- 관리자로 만들었으므로 steward_shape 는 통과한다(통과하지 못하면 백필 밖의 행이다 — 멈추고 본다).

SET LOCAL lock_timeout = '5s';

ALTER TABLE custom_domains VALIDATE CONSTRAINT custom_domains_steward_shape;
ALTER TABLE custom_domains VALIDATE CONSTRAINT custom_domains_identity_claim_shape;
ALTER TABLE custom_domains VALIDATE CONSTRAINT custom_domains_identity_handover_to_fkey;
