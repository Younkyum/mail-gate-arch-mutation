-- 202609270132_outbound_attachments_hardening_validate.sql
-- 메일 기본기 2차 A2 — 202609270131 이 `NOT VALID` 로 더한 CHECK 둘의 기존 행 검증(SHARE UPDATE EXCLUSIVE — 쓰기를 막지 않는다).
-- 두 표는 배포 전이라 운영에는 행이 없다. 개발 DB 의 옛 행이 새 파일명 규칙에 걸리면 이 파일이 실패한다 — 그 행을 보고 개발 DB 를 새로 만든다.

SET LOCAL lock_timeout = '5s';

ALTER TABLE outbound_attachments VALIDATE CONSTRAINT outbound_attachments_filename_extension_check;
ALTER TABLE message_attachments VALIDATE CONSTRAINT message_attachments_permanent_key_check;
