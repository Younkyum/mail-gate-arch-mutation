-- 202609270116_tlog_v4_validate.sql
-- 메일 기본기 2차 — 202609270115(tlog v4)가 `NOT VALID` 로 다시 더한 잎 CHECK 둘의 기존 잎 검증.
--
-- `tlog_leaves` 는 계속 자라는 표다 — 0115 가 ACCESS EXCLUSIVE 아래에서 훑지 않게 NOT VALID 로 두고, 여기서 SHARE UPDATE EXCLUSIVE 로
-- 검증한다(서열기의 INSERT 를 막지 않는다). 기존 잎은 옛 CHECK 를 통과한 것이고 새 CHECK 는 종류 하나를 더한 것뿐이라 통과한다.
-- 이 파일이 끝나야 `REQUIRED_GUARDS` 의 `constraint:tlog_leaves.tlog_leaves_identity_source` 가 `convalidated` 다.

SET LOCAL lock_timeout = '5s';

ALTER TABLE tlog_leaves VALIDATE CONSTRAINT tlog_leaves_kind_check;
ALTER TABLE tlog_leaves VALIDATE CONSTRAINT tlog_leaves_identity_source;
