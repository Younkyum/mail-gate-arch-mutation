-- 202609260105_scheduled_send_cancel.sql
-- 메일 기본기 1차 A3 — 예약 발송 **취소**(`.omc/plans/mail-basics.md` §4 A3 · §5, 결정 D2: MCP 조회·취소 확대 + 완화 네 겹).
-- 202609260100 이 enum 에 `cancelled` 를 더했다(그 값은 이 파일에서 처음 쓴다 — 파일을 나눈 이유).
--
--   ① 칼럼 다섯 — 취소 넷(`cancelled_at` · `cancel_reason_code` · `cancel_note` · `cancelled_via`)과 `agent_cancellable`.
--      **예약 행 자체가 감사 기록이다**(완화 ①): 사유 코드는 필수이고 취소 칼럼은 **쓰기 1회**다. 누가(어느 토큰) 취소했는지는 적지 않고
--      경로(`http`|`mcp`)만 적는다 — `AgentPrincipal` 에 토큰 id 가 없다(계획 F4). 경로는 라우터가 **리터럴로** 넘긴다(헤더가 아니다).
--      `agent_cancellable` 은 **생성 때만** 정한다(기본 true). false 면 에이전트 토큰(HTTP·MCP 모두)으로는 취소할 수 없다 — 소유자 콘솔만(완화 ④,
--      1차 수정 리드 결정 — 보안 M1).
--   ② CHECK 넷 — 칼럼 값 셋(사유 7 · 메모 모양 · 경로 2)과 모양(`cancelled` 이면 시각·사유·경로가 모두 있고, 아니면 취소 칼럼 넷이 모두
--      NULL 이다 — 예약 중인 행에 취소 흔적만 미리 적어 두는 길이 없다). 넷 다 **`NOT VALID`** 로 더한다(아래 "잠금").
--   ③ allow-list 트리거(`scheduled_sends_immutable_core`)를 새 칼럼으로 다시 만든다 — 바꿀 수 있는 칸에 취소 넷을 더하고
--      `agent_cancellable`·`send_at`·수신자·본문 키는 여전히 불변이다. 종단 가드(`scheduled_sends_terminal_guard`, 202609230310)는
--      `OLD.status <> 'scheduled'` 를 거부하므로 `cancelled → scheduled` · `cancelled → dispatched` 도 이미 막힌다. 그 위에 취소 칼럼
--      쓰기 1회 트리거를 **따로** 둔다 — 종단 가드가 언젠가 느슨해져도 감사 기록은 고쳐 쓸 수 없다(방어를 한 겹으로 두지 않는다).
--   ④ 앱 롤 UPDATE — 취소 칼럼 넷만(컬럼 단위, 202609230750 규율). `agent_cancellable` 은 INSERT 로만 들어간다(표 단위 INSERT 는 이미 있다).
--      허용 목록은 `src/runtime/role-bootstrap.ts` `RESTRICTED_ROLE_GRANTS`, 가드 목록은 `src/runtime/handlers/migrate.ts` `REQUIRED_GUARDS`.
--
-- CHECK 의 집합은 `src/db/schema.ts` 와 같다 — `CANCEL_REASON_CODES`(사유 7) · `SCHEDULED_CANCEL_CHANNELS`(경로 2) · `MAX_CANCEL_NOTE_LENGTH`(200).
-- 워커 코드는 바뀌지 않는다 — `claimDue`·`markDispatched` 둘 다 `status = 'scheduled'` 만 본다(취소된 행은 집히지도, 기록되지도 않는다).
--
-- 잠금(코드 리뷰 L10 — 0115 H1 과 같은 규율): 이 파일은 ACCESS EXCLUSIVE 아래에서 **표를 읽지 않는다.** 칼럼 추가는 기본값이 상수라
--   재작성이 없고, CHECK 넷은 `NOT VALID` 라 기존 행을 훑지 않는다(새 행·UPDATE 에는 바로 선다). 기존 행 검증은 202609260106 의
--   `VALIDATE CONSTRAINT`(SHARE UPDATE EXCLUSIVE — 쓰기를 막지 않는다)가 하고, 색인 둘은 202609260107·0108 이 `CONCURRENTLY` 로 만든다
--   (러너의 비트랜잭션 지시자, `src/db/migrate.ts`). 5초 안에 잠금을 못 잡으면 실패하고 아무것도 바뀌지 않는다.
-- 롤백 호환: 옛 코드는 새 칼럼을 읽지 않고, `status = 'cancelled'` 행은 옛 워커가 집지 않는다.

SET LOCAL lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- ① 칼럼
-- ---------------------------------------------------------------------------

ALTER TABLE scheduled_sends
  ADD COLUMN cancelled_at       timestamptz,
  ADD COLUMN cancel_reason_code text,
  -- 소유자에게 보일 짧은 메모. 제어문자(개행 포함) 없음 — 콘솔은 표시 전에 `sanitizeDisplayText` 를 한 번 더 거친다. 구조화 로그에는 싣지 않는다.
  ADD COLUMN cancel_note        text,
  ADD COLUMN cancelled_via      text,
  ADD COLUMN agent_cancellable  boolean NOT NULL DEFAULT true;

-- ---------------------------------------------------------------------------
-- ② CHECK — 전부 NOT VALID(검증은 202609260106)
-- ---------------------------------------------------------------------------

-- 칼럼 CHECK 는 칼럼 정의 안에 `NOT VALID` 를 적을 수 없어서 표 제약으로 따로 더한다(이름은 칼럼 제약의 자동 이름과 같다).
ALTER TABLE scheduled_sends
  ADD CONSTRAINT scheduled_sends_cancel_reason_code_check CHECK (
    cancel_reason_code IS NULL OR cancel_reason_code IN (
      'no_longer_needed', 'wrong_recipient', 'wrong_content', 'wrong_time', 'duplicate', 'owner_request', 'other')) NOT VALID,
  ADD CONSTRAINT scheduled_sends_cancel_note_check CHECK (
    cancel_note IS NULL OR (char_length(cancel_note) BETWEEN 1 AND 200 AND cancel_note !~ '[[:cntrl:]]')) NOT VALID,
  ADD CONSTRAINT scheduled_sends_cancelled_via_check CHECK (
    cancelled_via IS NULL OR cancelled_via IN ('http', 'mcp')) NOT VALID,
  ADD CONSTRAINT scheduled_sends_cancelled_shape CHECK (
    CASE WHEN status = 'cancelled'
      THEN cancelled_at IS NOT NULL AND cancel_reason_code IS NOT NULL AND cancelled_via IS NOT NULL
      ELSE cancelled_at IS NULL AND cancel_reason_code IS NULL AND cancel_note IS NULL AND cancelled_via IS NULL
    END) NOT VALID;

-- ---------------------------------------------------------------------------
-- ③ 불변 핵심(allow-list 재정의) · 취소 칼럼 쓰기 1회
-- ---------------------------------------------------------------------------

DROP TRIGGER scheduled_sends_immutable_core ON scheduled_sends;

-- 왜 allow-list 인가(202609230310 과 같다): 무엇을·누구에게·언제 보낼지는 예약의 정체다. `agent_cancellable` 도 여기 든다 — 에이전트가
--   "에이전트가 취소 가능" 으로 바꿀 수 있으면 완화 ④ 가 사라진다. 진행 상태와 취소 칼럼만 연다.
CREATE TRIGGER scheduled_sends_immutable_core
  BEFORE UPDATE ON scheduled_sends
  FOR EACH ROW EXECUTE FUNCTION reject_column_update_except(
    'status', 'attempt_count', 'lease_expires_at', 'dispatched_at', 'dispatch_outcome', 'message_id',
    'cancelled_at', 'cancel_reason_code', 'cancel_note', 'cancelled_via');

-- 왜: 취소 기록은 주입 메일이 유도한 취소를 소유자가 나중에 알아보는 근거다(완화 ①). 한 번 적힌 사유·경로·시각·메모를 고쳐 쓰면
--   그 근거가 사라진다. 모든 롤에 선다(소유자 롤 포함).
CREATE OR REPLACE FUNCTION scheduled_sends_reject_cancel_rewrite() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  -- 취소 칼럼 중 하나라도 적혔으면 넷 모두 그대로여야 한다(메모를 뒤늦게 채우는 것도 고쳐 쓰기다).
  IF (OLD.cancelled_at IS NOT NULL OR OLD.cancel_reason_code IS NOT NULL OR OLD.cancel_note IS NOT NULL OR OLD.cancelled_via IS NOT NULL)
     AND ROW(NEW.cancelled_at, NEW.cancel_reason_code, NEW.cancel_note, NEW.cancelled_via)
         IS DISTINCT FROM ROW(OLD.cancelled_at, OLD.cancel_reason_code, OLD.cancel_note, OLD.cancelled_via) THEN
    RAISE EXCEPTION 'scheduled send % cancellation is write-once', OLD.id
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER scheduled_sends_cancel_write_once
  BEFORE UPDATE ON scheduled_sends
  FOR EACH ROW EXECUTE FUNCTION scheduled_sends_reject_cancel_rewrite();

-- ---------------------------------------------------------------------------
-- ④ 앱 롤 — 취소 칼럼 넷의 UPDATE 만
-- ---------------------------------------------------------------------------

GRANT UPDATE (cancelled_at, cancel_reason_code, cancel_note, cancelled_via) ON scheduled_sends TO atmark_app;

COMMENT ON COLUMN scheduled_sends.agent_cancellable IS
  '생성 때만 정한다(불변). false 면 에이전트 토큰(HTTP·MCP)으로 취소할 수 없다 — 소유자 콘솔만. 메일 기본기 A3 완화 ④.';
COMMENT ON COLUMN scheduled_sends.cancelled_via IS
  '취소 경로(http|mcp) — 라우터가 리터럴로 정한다. 누가(토큰) 취소했는지는 적지 않는다.';
