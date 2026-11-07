-- 202609221410_policy.sql
-- P1a — AgentPolicy / PolicyVersion (계획 §4.1 · §4.3 · §4.4)

-- ---------------------------------------------------------------------------
-- outbound_mode
-- ---------------------------------------------------------------------------

-- 왜 5값 전부를 지금 정의하는가 (§4.1 · §4.4):
--   'unrestricted' 는 P1 에서 API 가 400 unrestricted_not_available_in_phase_1 을 반환한다.
--   그럼에도 열거형에 정의를 남기는 이유는 "제한 없음"이 **암묵 상태로 존재하는 것을
--   막기 위해서**다. 암묵 상태는 AC-8 의 적이다 — 열거형에 없으면 나중에 누군가
--   "정책 없음" 을 NULL 이나 우회 경로로 표현하게 된다.
--   'approval_required' 와 'reply_only' 의 분기는 P2 에서 구현된다(§4.4). 여기서는
--   타입만 존재하고 P1 엔진은 그 값을 만나면 도달 불가 분기로 처리한다.
CREATE TYPE outbound_mode AS ENUM (
  'disabled',           -- 킬 스위치. Stage 0 에서 전건 DENY.
  'reply_only',         -- 강등됨. 기존 스레드 내 회신만. (P2)
  'approval_required',  -- P2 의 기본값·주력. P1 에는 분기가 없다.
  'allowlist_only',     -- 정적 허용 목록만. **P1 기본값** — DENY 를 내므로 deny-all demo 가 성립한다.
  'unrestricted'        -- 정의만 존재. P1 API 는 400.
);

-- ---------------------------------------------------------------------------
-- agent_policies
-- ---------------------------------------------------------------------------

CREATE TABLE agent_policies (
  -- 왜: Agent has one AgentPolicy (스펙 Ontology). agent_id 를 PK 로 두면 "정책이 둘인
  --     에이전트"라는 상태가 표현 불가능해진다 — 어느 쪽이 적용되는지 묻는 질문 자체가 사라진다.
  agent_id         char(32) PRIMARY KEY REFERENCES agents (id) ON DELETE RESTRICT,
  -- 왜 기본값이 'allowlist_only' 인가 (§4.4 r3 확정):
  --   P1 은 Stage 7 의 approval_required 분기를 구현하지 않는다. 기본값을
  --   approval_required 로 두면 P1 의 모든 신규 에이전트가 구현되지 않은 분기로 들어간다.
  --   allowlist_only 는 P1 범위 안이고 DENY 를 내므로 demo:p1a 를 성립시킨다.
  --   AC-a1(기본값 approval_required)의 판정은 P2 Acceptance 로 이동했다.
  outbound_mode    outbound_mode NOT NULL DEFAULT 'allowlist_only',
  require_approval boolean NOT NULL DEFAULT false,
  -- 왜: Stage 4 의 분/시/일 한도와 수신자 수 상한. jsonb 인 이유는 한도 축이 P1 이후에도
  --     늘어나기 때문이고, 코드 상수인 warmup_daily_cap 은 여기 **들어가지 않는다**
  --     (§3.3 — "사람이 앱에서 끌 수 없다").
  limits           jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(limits) = 'object'),
  -- 왜: Stage 3 blocklist 와 Stage 7 allowlist 의 내용이 여기 산다. 별도 테이블로 쪼개면
  --     P1a 의 8테이블 경계를 넘고, 정책 스냅샷(policy_versions)이 여러 테이블을 가로질러
  --     찍혀야 해서 "평가 시점 정책"의 원자성이 깨진다.
  config_json      jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(config_json) = 'object'),
  -- 왜: 현재 적용 중인 policy_versions.version. 모든 Decision 에 스탬프되는 값이다(§4.2).
  current_version  integer NOT NULL DEFAULT 1 CHECK (current_version >= 1),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER agent_policies_set_updated_at
  BEFORE UPDATE ON agent_policies
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- policy_versions
-- ---------------------------------------------------------------------------

CREATE TABLE policy_versions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id      char(32) NOT NULL REFERENCES agents (id) ON DELETE RESTRICT,
  version       integer NOT NULL CHECK (version >= 1),
  -- 왜: 평가 시점의 정책 **전문 스냅샷**. agent_policies 를 참조만 하면 정책이 바뀔 때
  --     audit row 가 가리키는 근거가 사후에 변한다 — AC-9("왜 이 메일이 나갔는가")에
  --     답할 수 없게 된다. 스냅샷은 outbound_mode·limits·config_json 을 모두 담는다.
  outbound_mode outbound_mode NOT NULL,
  snapshot      jsonb NOT NULL CHECK (jsonb_typeof(snapshot) = 'object'),
  created_by    text,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- 왜: (agent_id, version) 이 audit_logs 가 참조하는 좌표다. 중복되면 어느 스냅샷이
--     그 결정의 근거였는지 답이 둘이 된다.
CREATE UNIQUE INDEX policy_versions_agent_version_key
  ON policy_versions (agent_id, version);
CREATE INDEX policy_versions_agent_created_idx
  ON policy_versions (agent_id, created_at DESC);

-- 왜 UPDATE·DELETE 를 둘 다 막는가 (§4.3 · R8):
--   정책 변경은 **새 행**을 만들고 기존 행은 불변이다. UPDATE 만 막으면 DELETE+INSERT 로
--   같은 효과를 얻을 수 있다(§4B.1 이 agent_keypairs 에서 지적한 것과 같은 구멍).
--   평가 시점 스냅샷이 사후에 변할 수 있으면 감사 전체가 무의미해진다.
CREATE TRIGGER policy_versions_immutable_update
  BEFORE UPDATE ON policy_versions
  FOR EACH ROW EXECUTE FUNCTION reject_row_update();

CREATE TRIGGER policy_versions_immutable_delete
  BEFORE DELETE ON policy_versions
  FOR EACH ROW EXECUTE FUNCTION reject_row_delete();

-- 왜 세 번째 트리거가 필요한가: 위 둘은 **FOR EACH ROW** 라 TRUNCATE 를 막지 못한다 —
--   Postgres 는 TRUNCATE 에 행 트리거를 발화시키지 않는다. `TRUNCATE audit_logs,
--   policy_versions` 한 줄이면 UPDATE·DELETE 금지를 통째로 우회해 모든 평가 시점
--   스냅샷이 사라진다(audit_logs 의 FK 때문에 두 테이블을 한 문장에 적으면 통과한다).
--   그러면 §4.3 이 지키려던 "근거는 사후에 변하지 않는다"가 "근거가 아예 없다"가 된다.
CREATE TRIGGER policy_versions_no_truncate
  AFTER TRUNCATE ON policy_versions
  FOR EACH STATEMENT EXECUTE FUNCTION reject_truncate();

COMMENT ON TABLE policy_versions IS
  '불변 append-only. 정책 변경 = 새 버전 행 생성. UPDATE/DELETE 는 트리거가 거부한다 (계획 §4.3, R8).';
