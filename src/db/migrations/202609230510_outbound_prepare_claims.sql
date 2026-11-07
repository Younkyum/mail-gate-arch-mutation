-- 202609230510_outbound_prepare_claims.sql
-- P3 결함 수정(검증 V2) — **관문에 한 번도 닿지 못한 `pending` 발송 행을 이어서 진행할 권리.**
--
-- ---------------------------------------------------------------------------
-- 무엇이 사라졌나
-- ---------------------------------------------------------------------------
--
-- 발송 앞단(`api/outbound-service.ts` prepare)은 `messages` INSERT(커밋) → 본문 저장 → 관문 순이다. 본문 저장이
-- 실패하거나(S3 일시 장애) 프로세스가 INSERT 뒤·관문 전에 죽으면 행은 `pending` 으로 남고 **audit 행이 없다**
-- (관문을 지나지 않았다). 같은 멱등 키의 재시도(HTTP 5xx 뒤 재호출, 예약 워커의 임대 만료 재집기)는 그 행을
-- `replayed` 로 돌려받고 끝났다 — 새 평가도 새 발송도 없이. 결과: `scheduled_sends=dispatched/replayed`,
-- `messages=pending`, SES 0. 아무도 그 행을 관문으로 데려가지 않는다.
--
-- ---------------------------------------------------------------------------
-- 왜 표가 하나 더 필요한가 — "이어서 진행" 은 **한 명만** 해야 한다
-- ---------------------------------------------------------------------------
--
-- 재시도가 그 행을 관문으로 데려가면 된다. 그런데 "관문에 닿지 않은 pending" 은 "죽은 첫 시도" 와 "아직 가는
-- 중인 첫 시도(동시 재호출)" 를 구별하지 못한다. 둘 다 관문으로 가면 SES 는 lease 가 한 번으로 막지만,
-- **거부·승인 대기 판정은 lease 전에 audit 을 쓰므로** 한 시도가 audit 2행이 된다(§4.3 등식·AC-i1 위반), 승인
-- 요청은 `approval_requests.message_id` UNIQUE 에 부딪힌다. 그래서 관문 앞 구간에 짧은 임대를 둔다:
--
--   - INSERT 한 시도는 **행이 없어도** `messages.created_at + 임대` 까지 쥔 것으로 본다(INSERT 경로를 바꾸지 않는다).
--   - 이어받는 시도는 이 표에 조건부로 행을 쓰거나 만료된 행을 갱신해야만 관문으로 간다(한 명만 이긴다).
--   - 쥔 쪽이 **알고 실패하면**(본문 저장 실패) 즉시 놓는다(`claimed_until = -infinity`) — 5xx 직후의 재시도가
--     임대를 기다리지 않게. `generation` 이 펜싱 토큰이다: 늦게 돌아온 옛 보유자가 새 보유자의 임대를 풀지 못한다.
--
-- 판정은 `messages`·`audit_logs` 에서 다시 한다(`status = 'pending'` 이고 그 행의 audit 이 없을 것). 이 표는
-- "누가 데려갈 차례인가" 만 기록한다 — 판정 컬럼이 없다.
CREATE TABLE outbound_prepare_claims (
  message_id     uuid PRIMARY KEY REFERENCES messages (id) ON DELETE RESTRICT,
  -- 이 시각까지는 현재 보유자의 것이다. `-infinity` 는 "보유자가 놓았다".
  claimed_until  timestamptz NOT NULL,
  -- 0 = INSERT 한 시도가 놓은 흔적, 1 이상 = 이어받은 횟수. 보유자가 놓을 때 자기 세대인지 확인한다.
  generation     integer NOT NULL CHECK (generation >= 0),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE ON outbound_prepare_claims TO atmark_app;

COMMENT ON TABLE outbound_prepare_claims IS
  '관문에 닿지 못한 pending 발송 행을 이어서 진행할 권리(임대). 판정 없음 — 202609230510 머리말.';
