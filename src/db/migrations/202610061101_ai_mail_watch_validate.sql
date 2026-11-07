-- 202610061101_ai_mail_watch_validate.sql
-- 202610061100 이 `NOT VALID` 로 더한 CHECK 둘 · FK 하나의 기존 행 검증(SHARE UPDATE EXCLUSIVE — 쓰기를 막지 않는다). 기존 행은 새 칸이 전부 NULL 이고
-- `org_features` 는 `custom_domains` 행뿐이라 통과한다(통과하지 못하면 1100 밖에서 쓴 행이다 — 멈추고 본다).

SET LOCAL lock_timeout = '5s';

ALTER TABLE org_features VALIDATE CONSTRAINT org_features_feature_check;
ALTER TABLE inbound_messages VALIDATE CONSTRAINT inbound_messages_ai_hold_max_30s;
ALTER TABLE inbound_messages VALIDATE CONSTRAINT inbound_messages_ai_watch_job_fkey;
