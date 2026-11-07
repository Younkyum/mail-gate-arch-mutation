-- 202609221700_ses_events.sql
-- P1c B9 — SES 이벤트를 **우리 `message_id` 로** 기록한다 (ADR-0004, 계획 §4.5-4 · §11B B9).
--
-- 왜 이 테이블이 필요한가 (ADR-0004 맥락 요약):
--   SES 가 `Message-ID` 헤더를 덮어쓴다(2026-09-22 실발송으로 확정). 그래서 §4.5-4 의
--   2차 방어선은 작동하지 않고, **전송 성공 직후 프로세스가 죽으면 "그 메일은 나갔는가"
--   에 답할 방법이 하나도 없다** — `ses_message_id` 는 정의상 비어 있고(그걸 기록하기
--   전에 죽은 경우다), `Message-ID` 로는 SES 에 물을 수 없다.
--   남은 것은 **보내기 전에 정한 값**뿐이고, 그것이 `messages.id` 다. 그 값을 SES 이메일
--   태그로 실어 보내면 configuration set 이 발행하는 이벤트의 `mail.tags` 에 그대로
--   돌아온다. 이 테이블이 그 되돌아온 것을 담는다.
--
-- 마이그레이션은 append-only 다. 기존 9장은 한 글자도 건드리지 않았다 — 러너가 sha256 을
-- 대조한다(`src/db/migrate.ts`).

-- ---------------------------------------------------------------------------
-- 열거형
-- ---------------------------------------------------------------------------

-- 왜 ENUM 인가: 값의 출처가 셋(이 ENUM · `src/mail/events/ses-event.ts` 의 유니온 ·
--   `infra/cdk/stacks/ses-stack.ts` 의 `EmailSendingEvent` 목록)인데, 그 셋이 갈라지면
--   증상이 **INSERT 실패**로 나타난다 — 소비자가 죽고, 조회가 비고, 우리는 그것을
--   "안 나갔다" 로 읽는다. text 로 두면 갈라짐이 조용히 통과하므로 더 나쁘다.
--
--   `open`·`click`·`subscription` 이 없는 것은 누락이 아니다. ses-stack 이 그 셋을
--   의도적으로 구독하지 않는다(추적 픽셀·링크 래핑은 발신 도메인의 스팸 신호를 키운다).
CREATE TYPE ses_event_type AS ENUM (
  'send',
  'delivery',
  'bounce',
  'complaint',
  'reject',
  'rendering_failure',
  'delivery_delay'
);

-- ---------------------------------------------------------------------------
-- ses_events
-- ---------------------------------------------------------------------------

-- ★ 컬럼 집합의 규율 — **주소도 본문도 담지 않는다.**
--
--   bounce 이벤트의 `bouncedRecipients` 에는 수신자 주소가 실려 온다. 그것을 그대로
--   저장하면 PRD 제약("raw email 을 Postgres 에 저장하지 않는다")의 **이유**를 위반한다 —
--   제약의 이유는 저장소가 Postgres 라는 데 있지 않고, 제3자 PII 가 우리 운영 평면에
--   눌러앉으면 안 된다는 것이다(`src/observability/logger.ts` 경계 ②와 같은 논지).
--   억제 목록이 필요한 주소는 `suppression_entries` 가 이미 자기 규율로 들고 있다.
--
--   그래서 이 테이블은 **조인 키와 시각만** 안다. "몇 번 일어났는가" 와 "언제" 에
--   답하고, "누구에게" 에는 답하지 않는다.
CREATE TABLE ses_events (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- 왜 nullable 인가: 태그가 없거나 되돌릴 수 없는 이벤트도 **기록한다**. 버리면
  --   `EmailTags` 배선이 끊겼다는 신호가 함께 사라지고, 그 신호가 사라지는 것이
  --   ADR-0004 전체가 무의미해지는 경로다. FK 를 그대로 거는 이유는 그 반대쪽 —
  --   존재하지 않는 uuid 를 조인 키로 받아들이면 조회가 영원히 빈다.
  message_id      uuid REFERENCES messages (id) ON DELETE RESTRICT,

  event_type      ses_event_type NOT NULL,

  -- SES 가 부여한 id. **우리 것이 아니다.** `messages.ses_message_id` 와 같은 값이지만
  --   FK 를 걸지 않는다 — 이 테이블이 채워지는 시점에 그 컬럼은 비어 있을 수 있고
  --   (그게 바로 AC-i3 의 시나리오다), FK 를 걸면 그 순간 INSERT 가 죽는다.
  ses_message_id  text,

  -- 이벤트가 **일어난** 시각(SES 가 찍는다). bounce 는 며칠 뒤일 수 있다.
  event_at        timestamptz NOT NULL,
  -- 이벤트를 **우리가 받은** 시각. 소비자 정지 감지가 읽는 것은 이쪽이다 —
  --   `event_at` 은 소비자가 죽어 있어도 과거 값으로 채워질 수 있다.
  received_at     timestamptz NOT NULL DEFAULT now(),

  -- 왜 이 컬럼이 이 테이블의 멱등성 전부인가:
  --   SNS/SQS 는 at-least-once 다. 같은 이벤트를 세 번 받아도 기록은 한 벌이어야 하고,
  --   그 집행은 애플리케이션 선조회가 아니라 **유니크 인덱스**여야 한다(§4.5-1 이
  --   `messages_agent_idempotency_key` 에 대해 쓴 것과 같은 이유 — 선조회는 경합에서 진다).
  --   값은 **이벤트 본문 문자열의 sha256** 이다. 재전달은 같은 바이트를 가져오므로
  --   같은 해시가 되고, 수신자가 여럿이라 진짜로 여러 건인 bounce 는 본문이 달라
  --   서로 접히지 않는다.
  dedupe_key      text NOT NULL CHECK (dedupe_key ~ '^[0-9a-f]{64}$')
);

-- 왜 유니크 **인덱스**인가: `ON CONFLICT DO NOTHING` 의 대상이 되려면 인덱스여야 한다.
--   소비자는 그 구문으로 INSERT 하고 `rowCount` 로 "처음 본 이벤트인가" 를 판정한다 —
--   예외를 잡아 문자열을 검사하는 경로를 만들지 않는다.
CREATE UNIQUE INDEX ses_events_dedupe_key ON ses_events (dedupe_key);

-- 왜: lease 만료 재전송 **직전**의 조회가 읽는 유일한 경로다(ADR-0004 결정 2).
--   `WHERE message_id IS NOT NULL` 로 부분 인덱스를 두는 이유는 조인 불가능한 이벤트가
--   이 인덱스를 키우지 않게 하기 위해서다 — 그 행들은 조회 대상이 아니다.
CREATE INDEX ses_events_message_type_idx
  ON ses_events (message_id, event_type) WHERE message_id IS NOT NULL;

-- 왜: 소비자 정지 감지가 `max(received_at)` 을 읽는다. 없으면 전건 스캔이고,
--   그 스캔은 이벤트가 쌓일수록 느려져 **정지 감지 자체가 정지의 피해자**가 된다.
CREATE INDEX ses_events_received_at_idx ON ses_events (received_at DESC);

COMMENT ON TABLE ses_events IS
  'SES 가 Message-ID 를 덮어쓰므로(ADR-0004) 우리 messages.id 를 EmailTags 로 실어 보내고 그 이벤트를 여기 기록한다. 주소·본문은 담지 않는다 — 조인 키와 시각만 안다.';
COMMENT ON COLUMN ses_events.dedupe_key IS
  '이벤트 본문 문자열의 sha256. SNS/SQS 의 at-least-once 재전달을 유니크 인덱스가 죽인다.';
COMMENT ON COLUMN ses_events.received_at IS
  '우리가 받은 시각. 소비자 정지 감지가 읽는다 — event_at 은 소비자가 죽어 있어도 과거 값으로 채워질 수 있다.';

-- ---------------------------------------------------------------------------
-- 권한
-- ---------------------------------------------------------------------------

-- 왜 여기에도 롤 검사가 있는가: 202609221430 보다 뒤에 적용되지만, 새 DB 를 만들 때
--   누군가 파일을 골라 돌리는 경로가 있다. 권한 부여를 조용히 건너뛴 마이그레이션은
--   불변식이 집행되지 않는 DB 를 만들어 놓고 성공을 보고한다 — fail closed.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'atmark_app') THEN
    RAISE EXCEPTION
      'role atmark_app does not exist; provision the app role before running the B9 migration'
      USING ERRCODE = '42704';
  END IF;
END;
$$;

-- 왜 UPDATE 도 DELETE 도 없는가: 이벤트는 **일어난 일**이다. 앱이 그것을 고칠 업무상
--   이유가 0이고, 고칠 수 있으면 "그 메일은 나갔는가" 의 증거가 사후에 바뀐다 —
--   `messages_status_transition_guard` 가 종단 행의 결과 컬럼을 얼리는 것과 같은 이유다.
--   보존 정책이 필요해지는 날은 소유자 롤의 일이지 앱 롤의 일이 아니다.
GRANT SELECT, INSERT ON ses_events TO atmark_app;
