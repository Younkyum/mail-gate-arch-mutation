-- 202609260120_scheduled_admin_read.sql
-- 메일 기본기 1차 W1(`.omc/plans/mail-basics.md` AC-A3-7) — 콘솔 예약 로그의 admin 읽기.
--
--   `atmark_admin` 의 `scheduled_sends` 칼럼 SELECT — 콘솔 로그 `GET /api/logs?type=scheduled`(`src/admin/routes/logs.ts`)가 보여 주는
--   칸만. 멱등 키·요청 해시·본문 키·추적 id·비용·임대·시도 수는 주지 않는다. 취소 칼럼(202609260105)이 이 파일보다 앞이다.
--   허용 목록은 `src/runtime/role-bootstrap.ts` `RESTRICTED_ROLE_GRANTS`(admin, W1 표지) — migrate `status` 가 실제 ACL 과 대조한다.
--
-- 수신함 발신자 필터 색인(A5)은 이 파일에 없다(1차 수정 — 코드 리뷰 M2): `from_domain` 색인은 202609260121 이 `CONCURRENTLY` 로 만들고,
-- `from` 필터는 기존 `inbound_messages_agent_from_idx (agent_id, from_address)`(202609222410)를 쓴다 — 같은 앞머리의 부분 색인을 하나 더
-- 두면 가장 바쁜 수신 표의 쓰기마다 색인 갱신만 늘고, 한 발신자의 행은 적어 정렬이 싸다.

SET LOCAL lock_timeout = '5s';

GRANT SELECT (
  id, agent_id, status, send_at, recipients, from_address, created_at, dispatched_at, dispatch_outcome, message_id,
  cancelled_at, cancel_reason_code, cancel_note, cancelled_via, agent_cancellable
) ON scheduled_sends TO atmark_admin;
