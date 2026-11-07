-- ---------------------------------------------------------------------------
-- 'denied' 를 상태기계에 편입한다 (앞 파일 202609221500 과 한 쌍)
-- ---------------------------------------------------------------------------
--
-- 앞 파일이 enum 값을 추가했고, 여기서 **그 값이 존재할 수 있는 조건**을 정한다.
-- 둘을 나눈 이유는 앞 파일 머리말에 있다(같은 트랜잭션에서 새 enum 값을 쓸 수 없다).
--
-- 'denied' 행의 뜻: **정책이 막았다.** lease 를 한 번도 잡지 않았고, SES 는 호출되지
-- 않았으며, 나갈 일도 없다. 종단이다.
--
-- 왜 failure_reason 을 NULL 로 두는가:
--   거부 사유는 `audit_logs.reasons` 에 있고(§4.3 "시도당 정확히 1행", AC-9), 그것이
--   판정의 단일 출처다. 여기에 복사해 두면 두 곳이 갈라질 수 있고, 갈라진 날 어느 쪽이
--   진짜인지 아무도 모른다. 그리고 `failure_reason IS NOT NULL` 은 지금 **"전송이
--   실패했다"** 와 정확히 동치다 — 그 동치를 깨면 운영 조회가 조용히 뜻을 잃는다.

-- ---------------------------------------------------------------------------
-- 1. 행 내부 불변식 — 'denied' 는 아무 결과 컬럼도 갖지 않는다
-- ---------------------------------------------------------------------------
-- 앞 CHECK 의 `ELSE false` 가 지금은 'denied' 행을 **전부 거부**한다. 그 fail-closed 가
-- 의도대로 작동했다는 증거이며(원본 주석의 "새 상태는 여기 WHEN 을 추가해야만 존재할 수
-- 있다"), 그래서 제약을 통째로 다시 건다.
ALTER TABLE messages DROP CONSTRAINT messages_state_machine;

ALTER TABLE messages ADD CONSTRAINT messages_state_machine CHECK (
  CASE status
    WHEN 'pending' THEN
      lease_id IS NULL AND lease_expires_at IS NULL
      AND ses_message_id IS NULL AND failure_reason IS NULL
      AND sent_at IS NULL AND failed_at IS NULL
    WHEN 'dispatching' THEN
      lease_id IS NOT NULL AND lease_expires_at IS NOT NULL
      AND ses_message_id IS NULL AND failure_reason IS NULL
      AND sent_at IS NULL AND failed_at IS NULL
    WHEN 'sent' THEN
      ses_message_id IS NOT NULL AND failure_reason IS NULL
      AND sent_at IS NOT NULL AND failed_at IS NULL
    WHEN 'failed' THEN
      failure_reason IS NOT NULL AND ses_message_id IS NULL
      AND failed_at IS NOT NULL AND sent_at IS NULL
    WHEN 'denied' THEN
      -- lease 를 잡은 적이 없다. SES 도 부르지 않았다. 사유는 audit_logs 에 있다.
      lease_id IS NULL AND lease_expires_at IS NULL
      AND ses_message_id IS NULL AND failure_reason IS NULL
      AND sent_at IS NULL AND failed_at IS NULL
    WHEN 'received' THEN
      lease_id IS NULL AND lease_expires_at IS NULL
      AND ses_message_id IS NULL AND failure_reason IS NULL
      AND sent_at IS NULL AND failed_at IS NULL
    -- ELSE 가 없으면 CASE 가 NULL 을 반환하고 CHECK 는 NULL 을 통과로 취급한다 —
    -- 새 상태의 행이 어떤 컬럼 조합이든 합법이 된다. 원본 주석과 같은 이유로 유지한다.
    ELSE false
  END
);

-- ---------------------------------------------------------------------------
-- 2. inbound 는 여전히 'received' 하나뿐이다
-- ---------------------------------------------------------------------------
-- 원본 CHECK 는 `direction='outbound' AND status <> 'received'` 라 'denied' 를 이미
-- 허용한다. 손대지 않는다 — 손대면 체크섬만 달라지고 명제는 같다.

-- ---------------------------------------------------------------------------
-- 3. 전이 가드 — pending → denied 를 허용하고, denied 를 종단으로 얼린다
-- ---------------------------------------------------------------------------
--   pending     → dispatching            (lease 취득)
--   pending     → denied                 (정책이 막았다 — **이번에 추가**)
--   dispatching → dispatching            (만료 후 재취득)
--   dispatching → sent | failed          (전송 결과 확정)
--   sent | failed | denied | received → 없음   **종단이다.**
--
-- `dispatching → denied` 는 **허용하지 않는다.** lease 를 잡은 시도는 이미 카운터에
-- 들어갔고 SES 가 불렸을 수도 있다. 그 행을 "정책이 막았다" 로 되돌리면 나간 메일이
-- 거부로 기록된다 — BLOCKER 였던 "나간 메일을 failed 로 기록" 과 같은 종류의 거짓말이다.
CREATE OR REPLACE FUNCTION messages_reject_invalid_transition() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status
     AND NOT (
       (OLD.status = 'pending' AND NEW.status IN ('dispatching', 'denied'))
       OR (OLD.status = 'dispatching' AND NEW.status IN ('sent', 'failed'))
     )
  THEN
    RAISE EXCEPTION
      'illegal messages.status transition % -> % (id=%)',
      OLD.status, NEW.status, OLD.id
      USING ERRCODE = '23514';
  END IF;

  -- 종단 행의 결과 컬럼을 얼린다. 'denied' 는 결과 컬럼이 전부 NULL 이므로, 이 가드는
  -- "거부된 행에 사후에 ses_message_id 를 끼워 넣는" 경로를 막는 뜻이 된다.
  IF OLD.status IN ('sent', 'failed', 'denied')
     AND (
       NEW.ses_message_id IS DISTINCT FROM OLD.ses_message_id
       OR NEW.failure_reason IS DISTINCT FROM OLD.failure_reason
       OR NEW.sent_at IS DISTINCT FROM OLD.sent_at
       OR NEW.failed_at IS DISTINCT FROM OLD.failed_at
     )
  THEN
    RAISE EXCEPTION
      'messages row % is terminal (%): dispatch outcome columns are frozen',
      OLD.id, OLD.status
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;
