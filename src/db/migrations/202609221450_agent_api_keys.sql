-- 202609221450_agent_api_keys.sql
-- P1b — agent-scoped API 토큰 저장소 (계획 §6 P1b 7번 · §47)
--
-- ---------------------------------------------------------------------------
-- 왜 **새 파일**인가 (기존 4개를 고치지 않는다)
-- ---------------------------------------------------------------------------
-- P1a 의 원칙은 "아직 실행된 적 없으니 기존 파일을 고친다" 였다. 그 전제가
-- 이 커밋에서 사라졌다 — `src/db/migrate.ts` 가 파일별 **sha256 체크섬**을
-- `schema_migrations` 에 남기고, 적용된 파일의 내용이 달라지면
-- `MigrationChecksumMismatchError` 로 멈춘다.
--
-- 즉 이미 마이그레이션을 돌린 개발 DB(그리고 곧 STG)에서 기존 파일을 고치는 것은
-- **조용히 무시되거나(이력이 있으니 건너뛴다) 시끄럽게 실패하거나** 둘 중 하나다.
-- 전자가 더 나쁘다: 리포의 SQL 과 실제 스키마가 갈라진 채 CI 는 초록불이 된다.
-- 마이그레이션은 이 시점부터 append-only 다.
--
-- ---------------------------------------------------------------------------

-- 왜 ENUM 배열인가 (`text[]` 가 아니라):
--   값 집합이 열려 있으면 **오타 하나가 권한 검사를 조용히 무력화한다** —
--   `'messages:sned'` 를 가진 토큰은 어떤 검사에도 걸리지 않고 그냥 권한이 없는
--   토큰이 되며, 발급자는 자기가 무엇을 잘못했는지 영원히 모른다.
--   `billing_status`·`audit_decision` 을 ENUM 으로 둔 것과 같은 이유다.
--   목록은 src/identity/agent-token.ts 의 AGENT_TOKEN_CAPABILITIES 와 같아야 하고,
--   src/db/repositories/agent-token-store.ts 가 그 동일성을 컴파일 타임에 단언한다.
CREATE TYPE agent_token_capability AS ENUM (
  'messages:send',
  'messages:read',
  'audit:read',
  'agent:read_self'
);

-- 왜 평문 컬럼이 아예 없는가: 있으면 언젠가 채워진다. sha256 해시만 저장하고
--   평문은 발급 응답에서 1회 반환된 뒤 사라진다 — 분실 시 경로는 재발급뿐이다.
--   토큰 비밀부가 256비트 난수이므로 salt 없는 해시로 충분하다(agent-token.ts).
CREATE TABLE agent_api_keys (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id     char(32) NOT NULL REFERENCES agents (id) ON DELETE RESTRICT,
  token_hash   char(64) NOT NULL CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  -- 왜 비어 있으면 안 되는가: 권한 0개인 토큰은 어떤 요청도 통과시키지 못하면서
  --   "유효한 토큰"으로 존재한다. 표현 불가능하게 만든다.
  capabilities agent_token_capability[] NOT NULL CHECK (cardinality(capabilities) > 0),
  revoked_at   timestamptz,
  expires_at   timestamptz,
  last_used_at timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- 왜 유니크인가: 해시 충돌이 아니라 **중복 발급**을 막는다. 같은 해시가 두 행이면
--   findByHash 가 어느 행을 돌려줄지 정해지지 않고, 한 행만 폐기된 상태가 가능해진다.
CREATE UNIQUE INDEX agent_api_keys_token_hash_key ON agent_api_keys (token_hash);

-- 왜: 에이전트별 토큰 목록·일괄 폐기의 접근 경로.
CREATE INDEX agent_api_keys_agent_id_idx ON agent_api_keys (agent_id);

-- 왜 이 둘만 가변인가:
--   `capabilities` 가 가변이면 권한 상향이 UPDATE 한 줄이 되고, 그 UPDATE 는
--   발급 이력 어디에도 남지 않는다 — "이 토큰은 무엇을 할 수 있었는가"가 사후에
--   다시 쓰인다. 권한 변경은 **폐기 + 재발급**이다.
--   `agent_id` 가 가변이면 한 에이전트의 토큰이 다른 에이전트의 것이 되어 §47 의
--   self-scope 전체가 무의미해진다.
CREATE TRIGGER agent_api_keys_immutable_core
  BEFORE UPDATE ON agent_api_keys
  FOR EACH ROW EXECUTE FUNCTION reject_column_update_except('revoked_at', 'last_used_at');

-- 왜 DELETE 를 막는가: 폐기는 `revoked_at` 을 찍는 것이지 행을 지우는 것이 아니다.
--   지울 수 있으면 "어느 토큰이 이 메일을 보냈는가"(AC-9)가 삭제로 답을 잃는다.
--   DELETE 권한을 주지 않는 것이 1차 방어선이고 이 트리거가 2차다.
CREATE TRIGGER agent_api_keys_no_delete
  BEFORE DELETE ON agent_api_keys
  FOR EACH ROW EXECUTE FUNCTION reject_row_delete();

-- 왜 TRUNCATE 까지: 위 트리거는 FOR EACH ROW 이고 Postgres 는 TRUNCATE 에 행 트리거를
--   발화시키지 않는다. audit_logs 와 같은 구멍이다.
CREATE TRIGGER agent_api_keys_no_truncate
  AFTER TRUNCATE ON agent_api_keys
  FOR EACH STATEMENT EXECUTE FUNCTION reject_truncate();

-- 왜 DELETE 가 없는가: 위 트리거의 1차 방어선. 권한이 없으면 트리거에 도달조차 하지 않는다.
--   (마이그레이션 4가 REVOKE ALL ... FROM PUBLIC 을 이미 했으므로 여기서는 GRANT 만 한다.)
GRANT SELECT, INSERT, UPDATE ON agent_api_keys TO atmark_app;

COMMENT ON TABLE agent_api_keys IS
  'agent-scoped 토큰. 평문은 저장하지 않고 sha256 해시만 둔다. 폐기는 revoked_at 이며 행 삭제가 아니다 (계획 §47 · src/identity/agent-token.ts).';
