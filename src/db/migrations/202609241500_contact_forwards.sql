-- 202609241500_contact_forwards.sql
-- US-009 — `support@atmark.ai` 로 온 문의를 운영자 메일함으로 전달한다(ADR-0009).
--
-- 흐름: 수신 소비자(inbound Lambda, 앱 롤)가 문의 한 통을 **받아들이면** 이 표에 행 하나를 적고(outbox), 전달 워커
-- (contact-forwarder Lambda, 발송 역할 · 앱 롤)가 그 행을 집어 운영자에게 새 메일 한 통을 보낸다. 수신자는 이 표에 **없다** —
-- 전달 주소는 Secrets Manager `atmark/contact-forward-to` 에만 있고 전달 워커만 읽는다. 표에는 메일 내용도 없다(PRD: 본문은
-- Postgres 에 두지 않는다 — 내용은 S3 `contact/forward/{ses_message_id}.json`, 키는 ses_message_id 에서 유도하므로 칸이 없다).
--
--   - `ses_message_id` 유니크 — **SES 메시지 하나당 전달 한 번**(SQS 재전달·소비자 재시도가 두 번째 행을 만들 수 없다).
--   - `sender_hash` — 원 발신자(헤더 From, 소문자) 의 sha256. 발신자별 시간당 상한을 세는 축이다. 평문 주소를 두지 않는다.
--   - 종단(`sent`·`suppressed`·`dead`)은 트리거가 동결한다 — 끝난 전달을 `pending` 으로 되돌려 다시 보내게 할 수 없다.
--   - 앱 롤 권한은 컬럼 단위: INSERT 는 수신 소비자가 쓰는 넷, UPDATE 는 전달 워커가 쓰는 결말 칸뿐. DELETE·TRUNCATE 없음.
--
-- 받아들이지 않은 문의는 `inbound_rejections(reason = 'contact_not_forwarded')` 에 사유 코드(`detail`)와 함께 남는다 —
-- 스팸·바이러스 판정 PASS 아님 · DMARC fail · 자기 도메인·자동 응답(루프) · 시간당 상한 · 크기 · MIME 거부.

CREATE TABLE contact_forwards (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ses_message_id          text NOT NULL UNIQUE CHECK (ses_message_id ~ '^[A-Za-z0-9][A-Za-z0-9._=-]{0,254}$'),
  sender_hash             text NOT NULL CHECK (sender_hash ~ '^[0-9a-f]{64}$'),
  status                  text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'suppressed', 'dead')),
  attempt_count           integer NOT NULL DEFAULT 0 CHECK (attempt_count BETWEEN 0 AND 20),
  next_attempt_at         timestamptz NOT NULL,
  claimed_at              timestamptz,
  sent_at                 timestamptz,
  settled_at              timestamptz,
  -- 전달 메일의 SES 메시지 ID(운영자 쪽 사본). 원 문의의 ID(`ses_message_id`)와 다르다.
  forward_ses_message_id  text CHECK (forward_ses_message_id IS NULL OR forward_ses_message_id ~ '^[A-Za-z0-9][A-Za-z0-9._=-]{0,254}$'),
  -- 사유 **코드**만(메일 내용·주소 금지).
  last_error              text CHECK (last_error IS NULL OR last_error ~ '^[a-z_]{1,64}$'),
  -- SES 가 받은 시각. 시간당 상한의 창은 이 축으로 센다(발신자가 정할 수 없는 값).
  received_at             timestamptz NOT NULL,
  created_at              timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT contact_forwards_sent_shape CHECK ((status = 'sent') = (sent_at IS NOT NULL AND forward_ses_message_id IS NOT NULL))
);

CREATE INDEX contact_forwards_due_idx ON contact_forwards (next_attempt_at) WHERE status = 'pending';
CREATE INDEX contact_forwards_received_idx ON contact_forwards (received_at);
CREATE INDEX contact_forwards_sender_idx ON contact_forwards (sender_hash, received_at);
CREATE INDEX contact_forwards_claimed_idx ON contact_forwards (claimed_at) WHERE claimed_at IS NOT NULL;

-- 종단 동결 — 끝난 행은 어떤 롤로도 고칠 수 없다(다시 보내게 만드는 길을 닫는다).
CREATE OR REPLACE FUNCTION contact_forwards_terminal_frozen() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status <> 'pending' THEN
    RAISE EXCEPTION 'contact_forwards % is terminal (%)', OLD.id, OLD.status USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.ses_message_id <> OLD.ses_message_id OR NEW.sender_hash <> OLD.sender_hash OR NEW.received_at <> OLD.received_at THEN
    RAISE EXCEPTION 'contact_forwards identity columns are immutable' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER contact_forwards_terminal_frozen
  BEFORE UPDATE ON contact_forwards
  FOR EACH ROW EXECUTE FUNCTION contact_forwards_terminal_frozen();

GRANT SELECT ON contact_forwards TO atmark_app;
GRANT INSERT (ses_message_id, sender_hash, next_attempt_at, received_at) ON contact_forwards TO atmark_app;
GRANT UPDATE (status, attempt_count, next_attempt_at, claimed_at, sent_at, settled_at, forward_ses_message_id, last_error)
  ON contact_forwards TO atmark_app;

COMMENT ON TABLE contact_forwards IS
  'support@atmark.ai 문의 전달 outbox (US-009, ADR-0009). 수신자·내용 없음 — 수신자는 atmark/contact-forward-to 비밀, 내용은 S3 contact/forward/.';

-- 받아들이지 않은 문의의 결말 코드.
ALTER TABLE inbound_rejections DROP CONSTRAINT inbound_rejections_reason_check;
ALTER TABLE inbound_rejections ADD CONSTRAINT inbound_rejections_reason_check
  CHECK (reason IN ('unknown_recipient', 'virus', 'mime_rejected', 'raw_too_large', 'unstorable', 'org_not_active', 'contact_not_forwarded'));
