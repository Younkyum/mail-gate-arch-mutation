-- 202609221440_message_recipient_count.sql
-- P1b — messages.recipient_count (계획 §3.3 워밍업 캡 · R22 · src/policy/rules/limits.ts)
--
-- 왜 이 컬럼이 필요한가 (P1a 가 남긴 유일한 구멍):
--   `SendCounters.orgRecipientsLastDay` 의 눈금은 **수신자 수**다. limits.ts 는 그 값에
--   이번 시도의 수신자 수를 더해 워밍업 캡과 비교하고, 그것이 R22("SES 계정 한도 50,000통/일,
--   남은 제동장치는 limits.ts 뿐")에 대한 유일한 제동장치다.
--
--   그런데 P1a 의 messages 테이블에는 **수신자에 관한 컬럼이 하나도 없다** — 수신자와 본문은
--   S3 에만 있다(PRD 제약 · §5.2 V5 컬럼 화이트리스트). 즉 Postgres 만으로는 그 카운터를
--   구할 방법이 없었고, 구현체가 메시지 수를 채우는 순간 캡이 **최대 50배** 느슨해진다
--   (limits.ts `isWarmupCapExceeded` 주석이 정확히 그 사고를 지목한다).
--
-- 왜 주소가 아니라 개수인가:
--   개수는 PII 가 아니다. 주소 목록을 여기 두면 "raw email 을 Postgres 에 저장하지 않는다"는
--   PRD 제약을 수신자 축에서 우회하게 되고, §5.2 V5 화이트리스트가 막으려던 것이 그것이다.
--   캡이 필요로 하는 것은 **기수(cardinality) 하나**뿐이다.
--
-- 왜 DEFAULT 0 인가: inbound 행에는 발송 수신자가 없다. 그리고 NOT NULL 없이 두면
--   NULL 한 행이 sum() 에서 조용히 사라져 캡이 그만큼 느슨해진다 — 카운터의 기본값은
--   "모른다"가 아니라 "0"이어야 하고, outbound 경로는 아래 CHECK 가 0 을 금지한다.

ALTER TABLE messages
  ADD COLUMN recipient_count integer NOT NULL DEFAULT 0 CHECK (recipient_count >= 0);

-- 왜 outbound 에 >= 1 을 강제하는가: 수신자 0명짜리 발송 행은 존재할 수 없고, 만약
--   존재한다면 그 행은 캡에 **한 명도 기여하지 않으면서** SES 호출을 냈다는 뜻이다.
--   기본값 0 을 그대로 둔 채 INSERT 하는 경로(캡 우회)를 DB 에서 닫는다.
ALTER TABLE messages
  ADD CONSTRAINT messages_outbound_has_recipients
  CHECK (direction <> 'outbound' OR recipient_count >= 1);

-- 왜 부분 인덱스인가: 워밍업 캡 질의는 24시간 창의 outbound 행만 본다. 전체 인덱스는
--   inbound 가 쌓이는 P3 이후 낭비가 되고, 발송 경로 위의 질의라 매 시도마다 돈다.
CREATE INDEX messages_outbound_dispatch_window_idx
  ON messages (agent_id, created_at)
  WHERE direction = 'outbound' AND status IN ('dispatching', 'sent');

COMMENT ON COLUMN messages.recipient_count IS
  '이 발송의 수신자 수. 주소가 아니라 기수만 둔다 — 워밍업 캡(계획 §3.3)의 눈금이 수신자 수이고, Postgres 에 수신자 목록을 두지 않는다는 PRD 제약과 양립하는 유일한 형태다.';
