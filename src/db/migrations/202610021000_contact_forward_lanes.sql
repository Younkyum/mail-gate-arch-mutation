-- 202610021000_contact_forward_lanes.sql
-- **문의 전달 시간당 상한을 차선별로 나눈다**(2026-10-02, 진윤겸 승인 — 안 A). 지금까지 `support@` 와 수신 전용 역할 주소(`abuse@`·`postmaster@`,
-- 202609301540)가 `contact_forwards` 전체를 세는 **전역 상한 하나(30/시간)** 를 나눠 썼다 — support@ 로 폭탄이 오면 abuse@ 신고(스팸 신고·차단 해제
-- 협의)가 막히고, 그 반대도 같았다.
--
--   ① `lane` — `'support'`(support@ 만) · `'role'`(봉투 수신자 중 하나라도 abuse@/postmaster@). 수신 소비자가 행을 적을 때 정하고(`src/contact/intake.ts`
--      `laneOf`), 상한은 차선마다 센다: **support 30 · role 10**(수신 쪽 받아들이기와 전달 쪽 시도 수 둘 다). 같은 발신자 5 는 차선과 무관(그대로).
--      기본값 `'support'` — 기존 행(이 파일 전 문의)은 전부 support 차선으로 센다. 기존 행 채우기는 상수 기본값이라 표를 다시 쓰지 않는다(PG 11+).
--   ② CHECK `contact_forwards_lane_check` — **`NOT VALID`**, 검증은 202610021001(1530/1531 과 같은 쌍). 새 행·UPDATE 에는 바로 선다.
--   ③ 종단 동결 트리거 함수 재정의 — 202609241500 본문 그대로 + **`lane` 도 정체성 칸**(불변). 차선을 바꿔 다른 차선의 상한으로 옮기는 길을 닫는다.
--   ④ 권한 — 앱 롤: `lane` INSERT 만(UPDATE 없음). `RESTRICTED_ROLE_GRANTS`(src/runtime/role-bootstrap.ts)와 같은 목록.
--
-- 잠금: `ADD COLUMN`·`ADD CONSTRAINT … NOT VALID` 는 ACCESS EXCLUSIVE 지만 짧다(표를 읽지 않는다). 5초 안에 못 잡으면 이 파일만 실패하고 다시 돌리면 된다.
-- **순서**: migrate(이 파일 · 1001) → `AtmarkCompute`. 옛 코드는 `lane` 을 적지 않으므로 기본값 `'support'` 로 들어간다 — 옛 코드가 도는 동안 역할 주소
-- 문의도 support 차선으로 센다(전과 같은 동작, 상한 30).

SET LOCAL lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- ① · ② lane
-- ---------------------------------------------------------------------------

ALTER TABLE contact_forwards ADD COLUMN lane text NOT NULL DEFAULT 'support';
ALTER TABLE contact_forwards ADD CONSTRAINT contact_forwards_lane_check CHECK (lane IN ('support', 'role')) NOT VALID;

COMMENT ON COLUMN contact_forwards.lane IS
  '전달 상한의 차선 — support(support@ 만) | role(abuse@/postmaster@ 가 하나라도). 시간당 상한을 차선마다 센다(support 30 · role 10). 불변.';

-- ---------------------------------------------------------------------------
-- ③ 종단 동결 — 202609241500 본문 그대로 + lane 불변
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION contact_forwards_terminal_frozen() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status <> 'pending' THEN
    RAISE EXCEPTION 'contact_forwards % is terminal (%)', OLD.id, OLD.status USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.ses_message_id <> OLD.ses_message_id OR NEW.sender_hash <> OLD.sender_hash OR NEW.received_at <> OLD.received_at
     OR NEW.lane <> OLD.lane THEN
    RAISE EXCEPTION 'contact_forwards identity columns are immutable' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

-- ---------------------------------------------------------------------------
-- ④ 권한 — INSERT 만
-- ---------------------------------------------------------------------------

GRANT INSERT (lane) ON contact_forwards TO atmark_app;
