-- 202609260100_scheduled_send_cancel_enum.sql
-- 메일 기본기 1차 A3 — 예약 발송 취소(`.omc/plans/mail-basics.md` §4 A3 · §5). 종단 상태 `cancelled` 를 enum 에 더한다.
--
-- **이 파일은 이 한 줄뿐이다.** `ALTER TYPE … ADD VALUE` 로 더한 값은 그 트랜잭션이 커밋되기 전에는 쓸 수 없고(Postgres 제약), 러너는
-- 파일 하나를 트랜잭션 하나로 돌린다. 이 값을 쓰는 칼럼·CHECK·트리거는 다음 파일(202609260105)이다.
--
-- 워커(`scheduled-sender`)는 `status = 'scheduled'` 만 집으므로 이 값이 생겨도 옛 코드의 동작은 같다(롤백 호환).

SET LOCAL lock_timeout = '5s';

ALTER TYPE scheduled_send_status ADD VALUE IF NOT EXISTS 'cancelled';
