-- 202609222100_owner_email_and_approval_notifications.sql
-- P2 — 소유자 승인 알림 (계획 §3.4 5조 "알림 경로", `src/notify/approval-notifier.ts`).
--
-- 두 가지를 세운다:
--   ① `organizations.owner_email` — 승인 알림의 **유일한** 수신자. 지금까지 소유자 이메일은
--      어디에도 저장돼 있지 않았다(알림을 보낼 곳이 없었다).
--   ② `approval_notifications` — 알림 outbox. **approval_requests INSERT 트리거가 같은 트랜잭션에서**
--      1행을 넣는다. "요청은 생겼는데 알림이 없는" 상태를 코드 경로가 아니라 스키마가 불가능하게 만든다.
--
-- 마이그레이션은 append-only 다. 기존 파일은 한 글자도 건드리지 않았다.

-- ---------------------------------------------------------------------------
-- ① organizations.owner_email
-- ---------------------------------------------------------------------------

-- 왜 NULL 을 허용하는가 — **기존 행** 때문이다. 이 컬럼이 생기기 전에 만들어진 조직은 소유자 이메일을
--   준 적이 없고, 우리가 지어낼 수도 없다(지어낸 주소로 승인 링크를 보내는 것이 가장 나쁜 실패다).
--   NOT VALID CHECK(`owner_email IS NOT NULL`)로 신규만 막는 방법은 쓰지 않았다 — NOT VALID 도 UPDATE
--   때는 검사하므로, 기존 조직의 `sending_started_at` 1회 세팅(§3.3 M7)이 그 CHECK 에 걸려 실패한다.
--   그 실패는 삼켜지고(`ses-transport.ts`) 워밍업 램프가 Day 1 에 영구히 멈춘다 — 조용한 사고다.
--
--   대신 **NULL 의 결과를 숨기지 않는다:** 알림 워커는 `owner_email IS NULL` 인 조직의 알림을
--   `undeliverable`(last_error='owner_email_missing')로 닫고 error 로그 + 메트릭을 낸다. 그 요청은
--   TTL 에 만료된다(auto-send 는 없다, §3.4 4조) — 막히는 방향이다. 신규 조직은 프로비저닝이
--   `ownerEmail` 을 **필수로** 받는다(`src/identity/provisioning.ts`).
--
-- ★ 다중 멤버(소유자 여럿·역할)는 P5 다. 그때 이 컬럼은 `organization_members` 로 옮겨 가고,
--   알림 수신자 결정도 그 테이블을 본다. 지금 컬럼 하나인 것은 P2 의 범위이지 설계의 끝이 아니다.
ALTER TABLE organizations ADD COLUMN owner_email text;

-- 형태 CHECK — 앱 검증(`resolveOwnerEmail`)이 빠져도 여기가 바닥이다.
--   · 소문자 정규형 — 앱이 소문자로 정규화한다. 대소문자 변형이 둘 다 들어오면 "같은 소유자" 판정이 흔들린다.
--   · 문자 집합이 좁다 — 공백·제어문자·`<>`·`"`·`,` 가 **표현 불가능**하다. 이 값은 `To:` 헤더에 그대로
--     연결되므로(`mime/build.ts`) CRLF 한 글자가 헤더 인젝션이다. 전송단의 `assertHeaderSafe` 와 이중이다.
--   · `atmark.ai` 와 그 하위 도메인 금지 — **소유자 주소가 에이전트 주소면 에이전트가 자기 요청을 승인한다.**
--     승인 링크가 에이전트의 수신함에 떨어지고(P3 inbound), 에이전트는 링크를 열 수 있다.
ALTER TABLE organizations ADD CONSTRAINT organizations_owner_email_shape CHECK (
  owner_email IS NULL OR (
    length(owner_email) BETWEEN 6 AND 254
    AND owner_email = lower(owner_email)
    AND owner_email ~ '^[a-z0-9._%+-]{1,64}@[a-z0-9-]+(\.[a-z0-9-]+)+$'
    AND split_part(owner_email, '@', 2) !~ '(^|\.)atmark\.ai$'
  )
);

COMMENT ON COLUMN organizations.owner_email IS
  '승인 알림의 유일한 수신자(§3.4 5조). NULL = 이 컬럼 이전의 조직 — 알림이 undeliverable 로 닫히고 요청은 만료된다. 다중 멤버는 P5.';

-- ---------------------------------------------------------------------------
-- ② approval_notifications (outbox)
-- ---------------------------------------------------------------------------

-- 상태:
--   pending       — 아직 끝나지 않았다(첫 시도 전 + 속도 상한 대기 + 임대 중 + 재시도 대기).
--                   임대는 `next_attempt_at` 을 미래로 미는 것으로 표현한다(webhook_deliveries 와 같다).
--   sent          — SES 가 받았다.
--   undeliverable — 보낼 곳이 없다(`owner_email IS NULL`). 막히는 방향으로 닫는다.
--   obsolete      — 보내기 전에 요청이 이미 결정·만료됐다. 결정할 수 없는 링크는 보내지 않는다.
--   dead          — 전송 시도를 다 썼다.
CREATE TYPE approval_notification_status AS ENUM ('pending', 'sent', 'undeliverable', 'obsolete', 'dead');

-- ★ 컬럼 집합의 규율 — **수신자 주소도 제목도 본문도 없다.**
--   수신자는 보내는 순간 `organizations.owner_email` 에서 읽는다(approval → agent → organization).
--   여기 주소 컬럼이 있으면 ① 그 컬럼을 채우는 코드가 곧 "수신자를 고르는 코드" 가 되고 — 알림 경로가
--   에이전트 메일의 우회로가 되는 바로 그 구멍이다 — ② 소유자 이메일이 두 곳에 산다.
--   본문은 보낼 때 고정 템플릿으로 렌더한다(승인 링크 토큰은 평문으로 어디에도 저장하지 않는다).
CREATE TABLE approval_notifications (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  approval_id      uuid NOT NULL REFERENCES approval_requests (id) ON DELETE RESTRICT,
  -- 조직당 속도 상한의 축. approval → agent → organization 을 매 시도 조인하지 않으려 INSERT 때 굳힌다
  --   (에이전트의 조직은 바뀌지 않는다 — 바뀌는 날은 이 컬럼의 의미를 다시 본다).
  organization_id  uuid NOT NULL REFERENCES organizations (id) ON DELETE RESTRICT,
  status           approval_notification_status NOT NULL DEFAULT 'pending',
  attempt_count    integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  next_attempt_at  timestamptz NOT NULL,
  -- 마지막 **집기** 시각. 조직당 속도 상한은 이 값으로 센다(보낸 수가 아니라 **시도한 수** — 보수적인 쪽).
  claimed_at       timestamptz,
  -- 닫힌 어휘. 자유 문자열이면 SES 오류 메시지가 들어오고, 거기에는 주소가 들어 있다.
  last_error       text CHECK (last_error ~ '^[a-z_]{1,40}$'),
  ses_message_id   text,
  sent_at          timestamptz,
  settled_at       timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),

  -- 상태와 종단 시각이 어긋난 행을 표현 불가능하게.
  CONSTRAINT approval_notifications_sent_shape
    CHECK ((status = 'sent') = (sent_at IS NOT NULL AND ses_message_id IS NOT NULL)),
  CONSTRAINT approval_notifications_settled_shape
    CHECK ((status IN ('undeliverable', 'obsolete', 'dead')) = (settled_at IS NOT NULL))
);

-- ★ **요청당 정확히 1통 — 이것이 그 정의다.** 선조회가 아니라 인덱스가 집행한다.
--   재전달·중복 enqueue 는 모두 이 인덱스에서 죽는다. 같은 요청의 알림을 다시 보내야 하는 날
--   (P5 "알림 재발송" 버튼)은 이 인덱스를 다시 보는 날이다.
CREATE UNIQUE INDEX approval_notifications_approval_id_key ON approval_notifications (approval_id);

-- 워커의 유일한 조회 경로. 종단 행은 이 인덱스를 키우지 않는다.
CREATE INDEX approval_notifications_due_idx ON approval_notifications (next_attempt_at) WHERE status = 'pending';

-- 속도 상한 계수 경로.
CREATE INDEX approval_notifications_org_claimed_idx ON approval_notifications (organization_id, claimed_at)
  WHERE claimed_at IS NOT NULL;

-- 왜: 식별 컬럼이 가변이면 한 요청의 알림이 UPDATE 한 줄로 **다른 조직의 소유자에게** 간다.
CREATE TRIGGER approval_notifications_immutable_core
  BEFORE UPDATE ON approval_notifications
  FOR EACH ROW EXECUTE FUNCTION reject_column_update_except(
    'status', 'attempt_count', 'next_attempt_at', 'claimed_at', 'last_error', 'ses_message_id', 'sent_at', 'settled_at');

-- 왜: 종단 행이 다시 pending 이 되면 **같은 요청에 두 번째 알림**이 나간다. 요청당 1통이 깨진다.
CREATE OR REPLACE FUNCTION approval_notifications_reject_terminal_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status <> 'pending' THEN
    RAISE EXCEPTION 'approval notification % is terminal (%)', OLD.id, OLD.status
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER approval_notifications_terminal_guard
  BEFORE UPDATE ON approval_notifications
  FOR EACH ROW EXECUTE FUNCTION approval_notifications_reject_terminal_change();

CREATE TRIGGER approval_notifications_no_delete
  BEFORE DELETE ON approval_notifications
  FOR EACH ROW EXECUTE FUNCTION reject_row_delete();

CREATE TRIGGER approval_notifications_no_truncate
  AFTER TRUNCATE ON approval_notifications
  FOR EACH STATEMENT EXECUTE FUNCTION reject_truncate();

-- ---------------------------------------------------------------------------
-- enqueue — approval_requests INSERT 와 **같은 트랜잭션**
-- ---------------------------------------------------------------------------

-- 왜 앱 코드가 아니라 트리거인가:
--   승인 요청을 여는 경로가 이미 둘이다 — 관문의 단건(`audit-sink.ts` 의 `insertPendingWithApproval`)과
--   전환 공지의 배치(§3.2, subject='batch'). 앱 코드에 INSERT 한 줄을 두면 **경로마다** 그 한 줄을
--   기억해야 하고, 잊은 경로의 요청은 소유자에게 알려지지 않은 채 TTL 에 만료된다 — 에이전트는
--   "거절당했다" 로 읽는다. 트리거는 경로를 모른다. 요청 행이 커밋되면 알림 행도 커밋돼 있고,
--   요청 트랜잭션이 롤백되면 알림 행도 없다. 불변식이 **코드 규율이 아니라 스키마의 성질**이 된다.
--
--   `ON CONFLICT DO NOTHING` 이 없는 이유: approval_requests.id 는 PK 라 같은 요청의 INSERT 가 두 번
--   일어날 수 없다. 충돌이 난다면 그것은 사고이고, 삼키지 않고 요청 INSERT 째로 실패해야 한다.
--   (배치 합류의 `INSERT ... ON CONFLICT (id) DO NOTHING` 은 행을 만들지 않으므로 AFTER INSERT 행 트리거가
--   **발화하지 않는다** — 배치당 알림 1통이 여기서 자연히 성립한다.)
--
--   **배치는 2분 늦게 집는다.** 배치(§3.2 전환 공지)는 첫 시도가 요청을 열고 나머지가 **각자의 트랜잭션에서**
--   합류한다. 곧바로 집으면 소유자는 "항목 1건" 짜리 알림을 받고 나머지 19건은 알림 밖에서 늘어난다. 2분은
--   한 HTTP 요청 안에서 seed 20명(§3.1 층 2 상한)이 관문을 지나는 시간을 넉넉히 덮는 눈금이다. 보장은
--   아니다 — 알림 본문은 항목 수를 발송 시점 값으로 적고 "최종 목록은 승인 페이지에서" 라고 말한다.
CREATE OR REPLACE FUNCTION approval_requests_enqueue_notification() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO approval_notifications (approval_id, organization_id, next_attempt_at)
  SELECT NEW.id, a.organization_id,
         NEW.created_at + CASE WHEN NEW.subject = 'batch' THEN interval '2 minutes' ELSE interval '0' END
    FROM agents a
   WHERE a.id = NEW.agent_id;
  IF NOT FOUND THEN
    -- FK 가 이미 막지만(approval_requests.agent_id), 막히는 자리가 여기면 메시지가 원인을 말한다.
    RAISE EXCEPTION 'approval request % has no agent row (%): notification cannot be enqueued', NEW.id, NEW.agent_id
      USING ERRCODE = '23503';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER approval_requests_enqueue_notification
  AFTER INSERT ON approval_requests
  FOR EACH ROW EXECUTE FUNCTION approval_requests_enqueue_notification();

COMMENT ON TABLE approval_notifications IS
  '소유자 승인 알림 outbox. approval_requests INSERT 트리거가 같은 트랜잭션에서 1행을 넣는다(요청당 정확히 1행, 유니크). 수신자·본문 컬럼이 없다 — 수신자는 보낼 때 organizations.owner_email 에서 읽는다.';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'atmark_app') THEN
    RAISE EXCEPTION
      'role atmark_app does not exist; provision the app role before running this migration'
      USING ERRCODE = '42704';
  END IF;
END;
$$;

-- 왜 DELETE 가 없는가: 위 트리거의 1차 방어선. 알림 기록은 보존이다.
GRANT SELECT, INSERT, UPDATE ON approval_notifications TO atmark_app;
