-- 202609270106_entitlements_aliases_attachments_validate.sql
-- 메일 기본기 2차 D6 — 202609270105 가 `NOT VALID` 로 더한 `org_entitlements` CHECK 셋의 기존 행 검증(202609260106 과 같은 규율).
--
-- `VALIDATE CONSTRAINT` 는 SHARE UPDATE EXCLUSIVE 만 잡는다 — 검증 동안 결제 동기화·운영자 CLI 의 쓰기가 그대로 돈다. 기존 행은 새 두 칸이
-- NULL 이고(칸 CHECK 통과), 출처↔원인은 옛 CHECK 보다 넓은 새 CHECK 라 셋 다 통과한다. 실패하면 이 트랜잭션만 되돌아가고 제약은 NOT VALID 로
-- 남는다 — 새 행에는 여전히 선다. 이 파일이 끝나야 `REQUIRED_GUARDS` 의 `convalidated` 검사가 초록이다.

SET LOCAL lock_timeout = '5s';

ALTER TABLE org_entitlements VALIDATE CONSTRAINT org_entitlements_aliases_per_agent_max_check;
ALTER TABLE org_entitlements VALIDATE CONSTRAINT org_entitlements_attachment_bytes_total_max_check;
ALTER TABLE org_entitlements VALIDATE CONSTRAINT org_entitlements_source_cause;
