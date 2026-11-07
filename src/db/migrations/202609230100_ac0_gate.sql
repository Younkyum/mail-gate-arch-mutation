-- 202609230100_ac0_gate.sql
-- GATE — AC-0 판정 도구의 기록면 (계획 §3.2 C1·V1, §6 GATE, §11B B2①②③)
--
-- AC-0 = "대표가 에이전트로부터 개인 메일함 키를 회수한 뒤에도 업무가 돈다". 그 판정은
-- `pnpm check:ac0` 가 **DB 에서** 산출한다 — markdown 체크박스는 판정 근거가 아니다(계획 P2).
-- 이 파일은 판정에 들어가는 **사람만 아는 사실 세 가지**의 기록면을 세운다:
--   ① 게이트 (어느 에이전트/조직, 사람 메일함 주소, 1일차 시작)        → ac0_gates + start 이벤트
--   ② 전달 규칙 ON/OFF 시각 · 재시작 이력                                → ac0_gate_events
--   ③ 사람 메일함 개입 (`human_mailbox_intervention`)                     → human_mailbox_interventions
-- 전달 건수(`forwarded_from_human_mailbox`)와 활동 분모는 **기록하지 않는다** — inbound_messages ·
-- messages · outbound_recipients · threads 에서 매번 다시 계산한다(`src/gate/**`). 판정식이 실측으로
-- 바뀌면(+caf_= 꼬리, `src/gate/forwarded.ts`) 과거 행에도 새 판정식이 소급 적용돼야 하기 때문이다.
--
-- **세 테이블 전부 append-only 다.** 기록을 고치는 방법은 새 기록뿐이다. "OFF 를 기록했는데 사실은
-- 안 껐다" 를 지우는 경로가 있으면 AC-0 은 자기가 무엇을 측정했는지 말할 수 없다(프리모템 #5).
--
-- **기록 시각은 DB 의 now() 다.** CLI(`scripts/ac0-*.ts`)에는 시각 인자가 없다 — 소급 기록 경로가
-- 없다. 미래 시각은 트리거가 거부한다. (SQL 로 과거 시각을 직접 넣는 것은 막지 않는다: 통합 테스트가
-- 14일짜리 게이트를 재현하는 유일한 방법이고, 앱 롤의 INSERT 는 원래 사람이 쓰는 경로가 아니다.)

-- ---------------------------------------------------------------------------
-- 열거형
-- ---------------------------------------------------------------------------

-- start          : 게이트 개시. effective_at = 1일차 00:00 KST.
-- restart        : 재시작. return_day 1(관측부터) | 8(증명부터). effective_at = 복귀 일차 00:00 KST.
-- forwarding_on  : 대표가 Gmail 전달 규칙을 켰다(기록 시각 = 그 시각).
-- forwarding_off : 대표가 Gmail 전달 규칙을 껐다. **이 기록이 없으면 증명 구간은 시작하지 않는다.**
CREATE TYPE ac0_gate_event_kind AS ENUM ('start', 'restart', 'forwarding_on', 'forwarding_off');

-- 왜 카테고리가 DB 열거형인가: B2② — 재시작 복귀 일차를 **카테고리가 결정한다**.
--   address_transition → 1일차(재공지 + 추세 재측정). 나머지 → 8일차.
--   자유 문자열이면 "주소 전환" 과 "주소전환" 이 다른 복귀 일차를 낳는다.
CREATE TYPE human_mailbox_intervention_category AS ENUM (
  'address_transition',  -- 상대가 옛 주소(사람 메일함)로 보냈고 사람이 거기서 읽거나 답했다
  'agent_gap',           -- 에이전트가 처리하지 못했거나 틀리게 처리해서 사람이 직접 했다
  'deliverability',      -- 에이전트 메일이 닿지 않아(스팸함·반송) 사람이 자기 메일함에서 다시 보냈다
  'policy_friction',     -- 승인·정책 흐름이 막혀(만료 등) 사람이 자기 메일함으로 우회했다
  'other'
);

-- ---------------------------------------------------------------------------
-- 보조 함수
-- ---------------------------------------------------------------------------

-- 사람 메일함 주소 배열의 모양. 소문자·주소 모양·NULL 없음·**atmark.ai 금지**
--   (사람 메일함이 에이전트 주소면 에이전트가 쓴 모든 메일이 "소유자가 직접 쓴 메일" 로 읽힌다).
CREATE FUNCTION ac0_mailboxes_valid(mailboxes text[]) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
  SELECT coalesce(bool_and(
           m IS NOT NULL
           AND length(m) BETWEEN 3 AND 254
           AND m = lower(m)
           AND m ~ '^[^@[:space:]<>]+@[^@[:space:]<>]+$'
           AND split_part(m, '@', 2) !~ '(^|\.)atmark\.ai$'
         ), false)
    FROM unnest(mailboxes) AS m
$$;

-- 미래 시각 금지. 1분 여유는 앱 서버와 DB 의 시계 차.
CREATE FUNCTION reject_future_recorded_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.recorded_at > now() + interval '1 minute' THEN
    RAISE EXCEPTION '%.recorded_at cannot be in the future (got %, now %)', TG_TABLE_NAME, NEW.recorded_at, now()
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

-- ---------------------------------------------------------------------------
-- ac0_gates
-- ---------------------------------------------------------------------------

-- 게이트는 **대표의 에이전트 하나**(agent_id) 또는 **조직 전체**(agent_id NULL)에 대해 돈다.
-- 전달 판정·활동 분모의 범위가 이것으로 정해진다.
CREATE TABLE ac0_gates (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid NOT NULL REFERENCES organizations (id) ON DELETE RESTRICT,
  agent_id         char(32) REFERENCES agents (id) ON DELETE RESTRICT,
  -- 대표의 **사람 메일함** 주소 전부(Gmail 계정 + "다른 주소에서 메일 보내기" 별칭 + Workspace 주소).
  --   전달 판정식(`src/gate/forwarded.ts`)이 envelope sender 를 이 주소의 전달 형태와 대조하고,
  --   From 이 이 주소면 "대표가 직접 쓴 메일" 로 전달에서 뺀다. 별칭이 빠지면 대표가 별칭으로
  --   에이전트에게 직접 쓴 메일이 전달로 잘못 세진다 — 런북에 적었다.
  --   **organizations.owner_email 을 읽지 않는 이유**: 그 컬럼의 읽기는 알림 모듈에만 허용돼 있고
  --   (test/arch/gate-chokepoint), 승인 알림 수신 주소와 전달 규칙을 건 메일함이 같다는 보장도 없다.
  human_mailboxes  text[] NOT NULL CHECK (
                     cardinality(human_mailboxes) BETWEEN 1 AND 5
                     AND ac0_mailboxes_valid(human_mailboxes)
                   ),
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX ac0_gates_organization_idx ON ac0_gates (organization_id, created_at DESC);

CREATE TRIGGER ac0_gates_no_update BEFORE UPDATE ON ac0_gates
  FOR EACH ROW EXECUTE FUNCTION reject_row_update();
CREATE TRIGGER ac0_gates_no_delete BEFORE DELETE ON ac0_gates
  FOR EACH ROW EXECUTE FUNCTION reject_row_delete();
CREATE TRIGGER ac0_gates_no_truncate BEFORE TRUNCATE ON ac0_gates
  FOR EACH STATEMENT EXECUTE FUNCTION reject_truncate();

-- ---------------------------------------------------------------------------
-- ac0_gate_events
-- ---------------------------------------------------------------------------

CREATE TABLE ac0_gate_events (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  gate_id       uuid NOT NULL REFERENCES ac0_gates (id) ON DELETE RESTRICT,
  kind          ac0_gate_event_kind NOT NULL,
  recorded_at   timestamptz NOT NULL DEFAULT now(),
  -- start·restart 만: 구간이 시작하는 KST 자정. 기록 시각보다 **뒤**여야 한다 — 이미 지난 날을 1일차로
  --   삼으면 규칙 ON 기록보다 앞선 날이 관측에 들어간다.
  effective_at  timestamptz,
  return_day    smallint,
  cause         text,

  CONSTRAINT ac0_gate_events_shape CHECK (
    CASE kind
      WHEN 'start' THEN
        effective_at IS NOT NULL AND effective_at > recorded_at AND return_day = 1 AND cause IS NULL
      WHEN 'restart' THEN
        effective_at IS NOT NULL AND effective_at > recorded_at AND return_day IN (1, 8)
        AND cause IN ('intervention_address_transition', 'intervention_other', 'forwarding_leak',
                      'forwarding_reenabled', 'observation_trend', 'observation_invalid')
        -- B2②: 주소 전환·전달 누수·규칙 재가동·관측 실패는 1일차, 그 외 개입만 8일차.
        AND (return_day = 8) = (cause = 'intervention_other')
      ELSE
        effective_at IS NULL AND return_day IS NULL AND cause IS NULL
    END
  ),
  -- 일차 경계는 KST 00:00(= 15:00 UTC)이다. 근거는 `src/observability/ac0-metrics.ts` 머리말.
  CONSTRAINT ac0_gate_events_kst_midnight CHECK (
    effective_at IS NULL OR mod(extract(epoch FROM effective_at) + 32400, 86400) = 0
  )
);

-- 게이트당 start 는 하나. 새로 시작하는 방법은 restart(return_day 1) 뿐이다 — 재시작 횟수가 남아야
--   "재시작 3회 초과 = AC-0 이 아직 참이 아니다"(§3.2) 를 셀 수 있다.
CREATE UNIQUE INDEX ac0_gate_events_one_start ON ac0_gate_events (gate_id) WHERE kind = 'start';
CREATE INDEX ac0_gate_events_gate_idx ON ac0_gate_events (gate_id, recorded_at);

CREATE TRIGGER ac0_gate_events_not_future BEFORE INSERT ON ac0_gate_events
  FOR EACH ROW EXECUTE FUNCTION reject_future_recorded_at();
CREATE TRIGGER ac0_gate_events_no_update BEFORE UPDATE ON ac0_gate_events
  FOR EACH ROW EXECUTE FUNCTION reject_row_update();
CREATE TRIGGER ac0_gate_events_no_delete BEFORE DELETE ON ac0_gate_events
  FOR EACH ROW EXECUTE FUNCTION reject_row_delete();
CREATE TRIGGER ac0_gate_events_no_truncate BEFORE TRUNCATE ON ac0_gate_events
  FOR EACH STATEMENT EXECUTE FUNCTION reject_truncate();

-- ---------------------------------------------------------------------------
-- human_mailbox_interventions
-- ---------------------------------------------------------------------------

-- **개입이다:** 에이전트가 처리했어야 할 메일을 사람이 자기 메일함에서 직접 읽거나 쓴 것.
-- **개입이 아니다:** 승인 매직링크 클릭(제품의 정상 동작, §3.2 V1②). 그래서 이 테이블에 쓰는 코드
--   경로는 사람이 부르는 CLI(`pnpm ac0:intervention`) 하나뿐이고, 승인 경로는 이 테이블을 모른다.
--
-- 개입 시각 = 기록 시각이다(occurred_at 컬럼이 없다). 늦게 적으면 늦은 날로 들어간다 — 그 방향은
--   보수적이다(관측 구간의 개입이 증명 구간으로 밀릴 수는 있어도, 증명 구간의 개입을 관측으로
--   되돌려 숨길 수는 없다).
--
-- reason 은 **대표가 쓰는 한 줄 메모**다. 메일 원문·본문을 붙여 넣는 자리가 아니다(PRD) — 500자 상한,
--   줄바꿈·제어문자 금지가 그것을 모양으로 막는다.
CREATE TABLE human_mailbox_interventions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  gate_id      uuid NOT NULL REFERENCES ac0_gates (id) ON DELETE RESTRICT,
  category     human_mailbox_intervention_category NOT NULL,
  reason       text NOT NULL CHECK (length(btrim(reason)) BETWEEN 1 AND 500 AND reason !~ '[[:cntrl:]]'),
  recorded_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX human_mailbox_interventions_gate_idx ON human_mailbox_interventions (gate_id, recorded_at);

CREATE TRIGGER human_mailbox_interventions_not_future BEFORE INSERT ON human_mailbox_interventions
  FOR EACH ROW EXECUTE FUNCTION reject_future_recorded_at();
CREATE TRIGGER human_mailbox_interventions_no_update BEFORE UPDATE ON human_mailbox_interventions
  FOR EACH ROW EXECUTE FUNCTION reject_row_update();
CREATE TRIGGER human_mailbox_interventions_no_delete BEFORE DELETE ON human_mailbox_interventions
  FOR EACH ROW EXECUTE FUNCTION reject_row_delete();
CREATE TRIGGER human_mailbox_interventions_no_truncate BEFORE TRUNCATE ON human_mailbox_interventions
  FOR EACH STATEMENT EXECUTE FUNCTION reject_truncate();

-- 앱 롤: 읽기와 추가만. UPDATE·DELETE 권한 자체가 없고, 있어도 트리거가 막는다.
GRANT SELECT, INSERT ON ac0_gates TO atmark_app;
GRANT SELECT, INSERT ON ac0_gate_events TO atmark_app;
GRANT SELECT, INSERT ON human_mailbox_interventions TO atmark_app;

COMMENT ON TABLE ac0_gates IS
  'AC-0 게이트(§3.2 C1). 범위(에이전트|조직)와 사람 메일함 주소. append-only. 판정은 pnpm check:ac0 가 DB 에서 산출.';
COMMENT ON TABLE ac0_gate_events IS
  'AC-0 게이트 이벤트: start · restart(return_day 1|8, B2②) · 전달 규칙 on/off. append-only, 기록 시각 = DB now().';
COMMENT ON TABLE human_mailbox_interventions IS
  'human_mailbox_intervention (§3.2 V1②). 매직링크 클릭은 개입이 아니다. 카테고리가 재시작 복귀 일차를 정한다(B2②). append-only.';
