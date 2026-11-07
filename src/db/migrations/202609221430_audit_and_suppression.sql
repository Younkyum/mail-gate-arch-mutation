-- 202609221430_audit_and_suppression.sql
-- P1a — AuditLog / SuppressionEntry (계획 §4.3 r3-V2 · §4.2 Stage 2 · §5.4)

-- ---------------------------------------------------------------------------
-- audit_logs
-- ---------------------------------------------------------------------------

CREATE TYPE audit_decision AS ENUM ('allowed', 'denied', 'pending_approval');

-- ★ 규약 (계획 §4.3, r3 V2 정정) — 이 테이블의 존재 이유 전부:
--
--     "발송 *시도*당 정확히 1행. 릴리스는 새 행을 만들지 않고 같은 행을 갱신한다."
--
--   r2 의 불변식("모든 outbound 결정은 audit row 를 정확히 1개 남긴다")은 P1 에서는
--   통과하지만 P2 에서 붕괴한다 — approval 경로는 ①최초 평가(→pending_approval)와
--   ②approval_release 의 게이트 재통과로 **발송 1건당 2행**을 만들기 때문이다.
--   그러면 §5.4 의 감사 완결성 테스트 count(audit_logs) === N 이 깨진다.
--
--   배치 승인(전환 공지 20건)은 시도 20건 = 20행이고 각 행이 동일 approval_id 를
--   공유한다. **승인은 사람의 단위이고 audit 는 발송의 단위다.**
CREATE TABLE audit_logs (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id           char(32) NOT NULL REFERENCES agents (id) ON DELETE RESTRICT,
  -- 왜 nullable 인가: Stage 0~1 에서 거부된 시도는 messages 행이 만들어지기 전에 끝난다.
  --   그런 시도도 audit 에 남아야 한다 — "조용한 거부도 없다"(Principle P3).
  message_id         uuid REFERENCES messages (id) ON DELETE RESTRICT,

  decision           audit_decision NOT NULL,
  -- 왜: 평가 시점의 거부/판정 근거. **불변**이다 — 사후에 바뀌면 AC-9 가 답하는 "왜 이
  --   메일이 나갔는가"가 사후에 다시 쓰인 이야기가 된다.
  reasons            text[] NOT NULL DEFAULT '{}',

  -- 왜: 평가 시점 정책 스냅샷으로의 포인터. 승인 중 정책이 바뀌어도 **최초 평가 시점
  --   값을 유지**한다(§4.3). 그래서 릴리스 갱신에서 이 컬럼은 트리거가 막는다.
  --
  -- 왜 NOT NULL 이 아닌가 (Principle P3 — "조용한 거부도 없다"):
  --   PolicySource 가 정책을 **읽지 못한** 시도에는 스탬프할 버전이 존재하지 않는다.
  --   NOT NULL 로 두면 그 시도는 audit 행을 0개 남긴다 — 그리고 그 장애는 DB 장애 시
  --   **전건**이 되는 사건이라, "시도당 1행"이 가장 필요한 순간에 정확히 0행이 되는
  --   fail-open 이다. 위 24-25행이 이 테이블의 존재 이유로 적어 놓은 것의 정반대다.
  --
  -- 왜 sentinel policy_versions 행(version 0)이 아닌가:
  --   policy_versions 는 agent_id NOT NULL FK 다. sentinel 하나를 만들려면 가짜
  --   organization + 가짜 agent 까지 **세 행**이 필요하고, 그 가짜 agent 는 Stage 0
  --   킬 스위치·과금 집계·에이전트 목록이 전부 예외 처리해야 하는 또 하나의 fail-open
  --   표면이 된다. 구멍을 넓게 뚫고 규약으로 덮는 대신, 좁게 뚫고 아래 CHECK 로 잠근다.
  policy_version_id  uuid REFERENCES policy_versions (id) ON DELETE RESTRICT,
  policy_version     integer CHECK (policy_version IS NULL OR policy_version >= 1),

  evaluated_at       timestamptz NOT NULL DEFAULT now(),
  latency_ms         integer CHECK (latency_ms IS NULL OR latency_ms >= 0),
  -- 왜: 구조화 로그와 audit 행을 잇는 유일한 키(§5.4).
  trace_id           text,

  -- 왜 FK 가 없는가: approval_requests 는 P2 범위다(§4.4). 배치 승인에서는 여러 행이
  --   같은 값을 공유하므로 유니크가 아니다.
  approval_id        uuid,

  -- ---- 아래 3개만 갱신 가능하다 (§4.3) ----
  resolved_at        timestamptz,
  approved_by        text,
  -- 왜 reasons[] 와 분리하는가: §4.3 은 거절·TTL 만료 시 같은 행에
  --   reason='approval_rejected'|'approval_expired' 를 기록하라고 하면서 동시에
  --   reasons[] 의 UPDATE 를 거부하라고 한다. 두 요구를 다 지키는 유일한 방법은
  --   **평가 시점 reasons[] 와 해소 시점 사유를 다른 컬럼에 두는 것**이다.
  resolution_reason  text,

  created_at         timestamptz NOT NULL DEFAULT now(),

  -- 왜: pending 은 종료 상태가 아니다(§4.3 보조 불변식). 해소되었으면 시각이 있어야
  --   pending_age_seconds 메트릭이 거짓 음성을 내지 않는다.
  CONSTRAINT audit_logs_resolution_shape CHECK (
    (decision = 'pending_approval' AND resolved_at IS NULL)
    OR decision <> 'pending_approval'
  ),

  -- 왜: 스탬프 없이 존재해도 되는 행은 **평가 자체가 실패한 거부** 하나뿐이다. 그 외
  --   모든 행에 대해 이 CHECK 는 NOT NULL 과 정확히 같은 일을 한다 — nullable 이 된 것은
  --   컬럼이 아니라 이 한 가지 경우다. 구멍의 크기를 규약이 아니라 DB 가 고정한다.
  --   (두 컬럼은 항상 함께 있거나 함께 없다. 하나만 있는 행은 어느 쪽도 신뢰할 수 없다.)
  CONSTRAINT audit_logs_policy_stamp_presence CHECK (
    (policy_version_id IS NOT NULL AND policy_version IS NOT NULL)
    OR (
      policy_version_id IS NULL
      AND policy_version IS NULL
      AND decision = 'denied'
      AND 'evaluation_error' = ANY (reasons)
    )
  )
);

-- 왜: 에이전트별 감사 조회(AC-9, GET /v1/audit)의 기본 경로.
CREATE INDEX audit_logs_agent_created_idx ON audit_logs (agent_id, created_at DESC);
-- 왜: GET /v1/audit?message_id= (AC-9 E2E 시나리오가 문자 그대로 이 조회를 한다).
CREATE INDEX audit_logs_message_id_idx ON audit_logs (message_id) WHERE message_id IS NOT NULL;
-- 왜: 배치 승인 1건이 만든 20행을 한 번에 찾는다(§4.3).
CREATE INDEX audit_logs_approval_id_idx ON audit_logs (approval_id) WHERE approval_id IS NOT NULL;
-- 왜: atmark.approval.pending_age_seconds 히스토그램이 읽는 경로. TTL 을 넘겨 pending 인
--     행이 0 이어야 한다는 보조 불변식의 측정 수단이다(§4.3 · §5.4).
CREATE INDEX audit_logs_pending_age_idx
  ON audit_logs (created_at) WHERE decision = 'pending_approval';

-- 왜: "immutable audit" 의 실질을 지키면서 상태 전이를 담는다(§4.3).
--   갱신 허용: decision, resolved_at, approved_by, resolution_reason. 그 외 전부 거부 —
--   특히 policy_version 은 승인 중 정책이 바뀌어도 평가 시점 값을 유지한다.
--
-- 왜 deny-list 가 아니라 allow-list 인가:
--   "막을 컬럼"을 열거하면 오늘은 완전해도 **컬럼이 추가되는 순간 그 컬럼이 조용히
--   가변**이 된다 — 기본이 fail-open 이다. 같은 파일이 reject_row_update 주석
--   ("열거하면 나중에 추가된 컬럼이 트리거 밖에 남는다")에서 지적한 바로 그 위험을
--   audit 에서는 반대 방식으로 썼다. 갱신 가능한 4개만 열거하면 새 컬럼의 기본이 불변이다.
--   목록은 src/db/schema.ts 의 AUDIT_LOG_MUTABLE_COLUMNS 와 같아야 한다.
CREATE TRIGGER audit_logs_partial_immutability
  BEFORE UPDATE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION reject_column_update_except(
    'decision', 'resolved_at', 'approved_by', 'resolution_reason'
  );

-- 왜 decision 을 가변으로 두고도 가드가 필요한가:
--   reasons[] 는 얼어 있는데 decision 은 녹아 있었다 — `UPDATE ... SET decision='allowed'`
--   한 줄로 denied 행이 사후에 allowed 가 되고, 그 행의 reasons[] 는 여전히 거부 사유를
--   담고 있다. AC-9 가 답하는 "왜 이 메일이 나갔는가"가 다시 쓰인 이야기가 된다.
--   §4.3 이 정의한 전이는 하나뿐이다: pending_approval → allowed | denied.
--   (그 외 값에서 출발하는 변경은 전부 거부. 같은 값으로의 갱신은 변경이 아니다.)
CREATE OR REPLACE FUNCTION audit_logs_reject_decision_regression() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.decision IS DISTINCT FROM OLD.decision AND OLD.decision <> 'pending_approval' THEN
    RAISE EXCEPTION
      'audit_logs.decision is terminal once resolved: % -> % (id=%)',
      OLD.decision, NEW.decision, OLD.id
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER audit_logs_decision_transition_guard
  BEFORE UPDATE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION audit_logs_reject_decision_regression();

-- 왜: 보존 정책은 무기한 불변이다(§5.4). DELETE 가 열려 있으면 UPDATE 거부는 장식이다.
CREATE TRIGGER audit_logs_no_delete
  BEFORE DELETE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION reject_row_delete();

-- 왜 DELETE 를 막는 것만으로 부족한가: 위 트리거들은 전부 **FOR EACH ROW** 이고
--   Postgres 는 TRUNCATE 에 행 트리거를 발화시키지 않는다. `TRUNCATE audit_logs` 한 줄이
--   "보존 정책은 무기한 불변"(§5.4)을 지운다 — UPDATE 거부·DELETE 거부가 모두 장식이 된다.
CREATE TRIGGER audit_logs_no_truncate
  AFTER TRUNCATE ON audit_logs
  FOR EACH STATEMENT EXECUTE FUNCTION reject_truncate();

COMMENT ON TABLE audit_logs IS
  '발송 시도당 정확히 1행. 릴리스/거절/만료는 새 행을 만들지 않고 같은 행을 갱신한다 (계획 §4.3 r3-V2). count(audit_logs) === 발송 시도 수 가 §5.4 의 완결성 단언이다.';

-- ---------------------------------------------------------------------------
-- suppression_entries
-- ---------------------------------------------------------------------------

-- 왜: SES bounce/complaint 이벤트가 등록하고 Stage 2 가 읽는다(§4.2). Stage 2 는
--   Stage 7(승인 판정)보다 **먼저** 실행된다 — 어차피 거부될 메일을 사람에게 승인
--   요청으로 보여주지 않는 것이 설계 제약이기 때문이다(승인 피로 = approval 주력
--   모델의 최대 실패 요인).
CREATE TYPE suppression_source AS ENUM ('bounce', 'complaint', 'manual', 'ses_account_level');

CREATE TABLE suppression_entries (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- 왜 조직 스코프인가: 스펙 Ontology 가 SuppressionEntry 를 Organization 에 스코프한다.
  --   에이전트 스코프면 같은 조직의 다른 에이전트가 바운스한 주소로 다시 보낸다.
  organization_id  uuid NOT NULL REFERENCES organizations (id) ON DELETE RESTRICT,
  -- 왜 평문 소문자인가: Stage 2 는 **정확 일치** 조회다. 해시로 두면 인덱스 조회는
  --   되지만 운영자가 목록을 읽고 오탐을 복구할 수 없다. messages.from_address_hash 와
  --   달리 이 값은 조직 자신의 억제 목록이지 제3자 메시지 내용이 아니다.
  address          text NOT NULL CHECK (address = lower(address) AND address ~ '^[^@[:space:]]+@[^@[:space:]]+$'),
  domain           text NOT NULL CHECK (domain = split_part(address, '@', 2)),
  source           suppression_source NOT NULL,
  reason           text,
  -- 왜: soft bounce 는 영구가 아니다. 만료가 없으면 억제 목록이 단조 증가해
  --   정상 수신자를 영구 차단한다.
  expires_at       timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now()
);

-- 왜: Stage 2 의 조회 키이자 중복 등록 방어. 같은 주소가 두 행이면 해제 시 하나가 남는다.
CREATE UNIQUE INDEX suppression_entries_org_address_key
  ON suppression_entries (organization_id, address);
CREATE INDEX suppression_entries_org_domain_idx
  ON suppression_entries (organization_id, domain);

-- ---------------------------------------------------------------------------
-- 권한 — 위 트리거들이 장식이 되지 않게 하는 부분
-- ---------------------------------------------------------------------------

-- 왜 여기인가: P1a 마이그레이션 4개 중 마지막이다. 8개 테이블이 전부 존재하는 시점이
--   여기뿐이고, 별도 파일로 빼면 "테이블은 있는데 권한은 아직 없는 창"이 마이그레이션
--   사이에 생긴다.
--
-- 왜 필요한가 (트리거 4개가 전부 여기에 기대고 있다):
--   4개 마이그레이션 어디에도 GRANT/REVOKE 가 한 줄도 없었다. 그러면 앱 롤이 테이블
--   **소유자**가 되고, 소유자는 트리거를 DROP 하고 TRUNCATE 권한을 스스로 되돌려 줄 수
--   있다 — audit 불변성·append-only·상태 전이 가드가 전부 한 줄의 DDL 로 사라진다.
--   앱 롤 이름은 `atmark_app` 으로 가정한다(CDK/RDS 프로비저닝이 만드는 롤).
--   마이그레이션은 **atmark_app 이 아닌 별도 소유자 롤**로 실행되어야 한다.

DO $$
DECLARE
  table_owner text;
BEGIN
  -- 왜 롤이 없으면 실패시키는가: 권한 부여를 조용히 건너뛰는 마이그레이션은 위 모든
  --   불변식이 집행되지 않는 DB 를 만들어 놓고 성공했다고 보고한다 — fail closed.
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'atmark_app') THEN
    RAISE EXCEPTION
      'role atmark_app does not exist; provision the app role before running P1a migrations'
      USING ERRCODE = '42704';
  END IF;

  -- 왜 소유권까지 검사하는가: 아래 REVOKE 는 소유자에게 효과가 없다. "앱 롤은 소유자가
  --   아니다"는 주석으로는 지켜지지 않는 종류의 사실이므로 여기서 단언한다.
  SELECT pg_get_userbyid(c.relowner) INTO table_owner
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relname = 'audit_logs';

  IF table_owner = 'atmark_app' THEN
    RAISE EXCEPTION
      'atmark_app owns audit_logs; an owner can drop the immutability triggers — run migrations as a separate owner role'
      USING ERRCODE = '42501';
  END IF;
END;
$$;

-- 왜 PUBLIC 부터인가: public 스키마의 기본 권한은 "누구나"에 가깝다. 앱 롤만 좁혀도
--   다른 롤이 같은 구멍으로 들어온다.
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM PUBLIC;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;

-- 왜 USAGE 만인가: 스키마에 CREATE 가 있으면 앱 롤이 테이블을 새로 만들 수 있고 그중
--   하나가 감사 밖의 저장소가 된다. DDL 은 마이그레이션 롤의 일이다.
GRANT USAGE ON SCHEMA public TO atmark_app;
REVOKE CREATE ON SCHEMA public FROM atmark_app;

-- 왜 TRUNCATE 가 어느 GRANT 에도 없는가: 권한이 없으면 문장 트리거에 **도달조차 하지
--   않는다.** 권한이 1차 방어선이고 트리거는 권한이 잘못 부여됐을 때의 2차 방어선이다.
GRANT SELECT, INSERT, UPDATE ON
  organizations, agents, agent_addresses, agent_policies, messages
  TO atmark_app;

-- 왜 policy_versions 에 UPDATE 가 없는가: append-only 다(§4.3 · R8). 트리거가 거부할
--   권한을 굳이 쥐여 주면 "왜 실패하는가"가 두 층에서 답이 갈린다.
GRANT SELECT, INSERT ON policy_versions TO atmark_app;

-- 왜 audit_logs 에 UPDATE 가 있는가: 릴리스·거절·만료는 같은 행의 갱신이다(§4.3 r3-V2).
--   무엇이 바뀔 수 있는지는 audit_logs_partial_immutability 가 결정한다.
GRANT SELECT, INSERT, UPDATE ON audit_logs TO atmark_app;

-- 왜 DELETE 가 여기에만 있는가: 억제 해제(오탐 복구)는 실제 운영 동작이다. 나머지 7개는
--   append-only 이거나 DELETE 할 업무상 이유가 없다.
GRANT SELECT, INSERT, UPDATE, DELETE ON suppression_entries TO atmark_app;
