-- 202609260126_scheduled_send_console_cancel_validate.sql
-- 메일 기본기 1차 2회차 Y2 — 202609260125 가 `NOT VALID` 로 다시 더한 `scheduled_sends_cancelled_via_check`(http·mcp·console)의 기존 행 검증
-- (0106 과 같은 규율).
--
-- `VALIDATE CONSTRAINT` 는 SHARE UPDATE EXCLUSIVE 만 잡는다 — 워커·생성·취소의 쓰기가 그대로 돈다. 기존 행의 경로는 NULL·http·mcp 뿐이라
-- 통과한다. 실패하면 이 트랜잭션만 되돌아가고 제약은 NOT VALID 로 남는다(새 행에는 여전히 선다). 이 파일이 끝나야 `convalidated` 가 참이다.

SET LOCAL lock_timeout = '5s';

ALTER TABLE scheduled_sends VALIDATE CONSTRAINT scheduled_sends_cancelled_via_check;
