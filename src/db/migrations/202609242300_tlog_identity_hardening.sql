-- 202609242300_tlog_identity_hardening.sql
-- US-013 신원 잎(202609242200)의 적대적 검증 반영 — 202609242200 을 고치지 않고 위에 얹는다.
--
--   ① `tlog_identity_since` (M2) — 신원 잎이 **도입된 시각**(202609242200 의 `schema_migrations.applied_at` = 그 파일 트랜잭션의 시작 시각).
--      도입 전 행은 잎이 없다(backfill 없음, 202609242200 머리말) — 조직 로그가 도입 전에 시작됐으면 로그 시작 ~ 도입 사이에 만든 에이전트·주소·키
--      행이 번들 원천 창에 들어와 `row_without_leaf` 로 **거짓 경보**가 났다. 번들은 신원 원천 창의 시작을 이 시각 뒤로 자르고(`identity_since`),
--      두 검증기는 이 값이 ① 번들 안 모든 신원 잎의 `at` 이하이고 ② 소유자 저장 상태에 고정된 값과 같아야 받는다 — 서버가 나중에 이 값을
--      늦춰 지운 행을 창 밖으로 밀어내지 못한다(ADR-0008 §9.2 ⑳). 한 행 · 고칠 수도 지울 수도 없다(트리거).
--   ② 신원 잎 부분 색인 (L1) — 블록 API 는 한 에이전트의 신원 잎만 본다(`body.agent_id` · seq 순). 조직 잎 전체를 훑지 않게
--      `(org_log_id, body.agent_id, seq) INCLUDE (leaf_hash) WHERE kind LIKE 'identity.%'`. 체인 계산은 색인만으로(leaf_hash), 표시용 잎 JSON 은
--      마지막 N 개만 LIMIT 으로 읽는다.
--   ③ `tlog_identity_block_requests` (L1) — 블록 API 의 조직당 분당 상한(로그인·가입과 같은 모양: 요청 원장 + 창 세기). admin 롤은 적고 세기만
--      한다(DELETE 없음 — admin 롤에는 어느 표에도 DELETE 가 없다, restricted-roles 테스트). 원장 보존 정리는 로그인·가입 원장과 함께 후속.

SET LOCAL lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- ① 신원 잎 도입 시각
-- ---------------------------------------------------------------------------

CREATE TABLE tlog_identity_since (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  since     timestamptz NOT NULL
);

INSERT INTO tlog_identity_since (since)
SELECT coalesce((SELECT applied_at FROM schema_migrations WHERE filename = '202609242200_tlog_identity_leaves.sql'), now());

CREATE FUNCTION tlog_identity_since_frozen() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'tlog_identity_since: 신원 잎 도입 시각은 바꾸거나 지울 수 없다(검증기 저장 상태가 고정한다)' USING ERRCODE = '23514';
END;
$$;

CREATE TRIGGER tlog_identity_since_frozen BEFORE UPDATE OR DELETE ON tlog_identity_since
  FOR EACH ROW EXECUTE FUNCTION tlog_identity_since_frozen();
CREATE TRIGGER tlog_identity_since_no_truncate BEFORE TRUNCATE ON tlog_identity_since
  FOR EACH STATEMENT EXECUTE FUNCTION tlog_identity_since_frozen();

REVOKE ALL ON tlog_identity_since FROM PUBLIC;
GRANT SELECT ON tlog_identity_since TO atmark_admin;

COMMENT ON TABLE tlog_identity_since IS
  '신원 잎(202609242200) 도입 시각 — 번들 identity_since. 검증기가 저장 상태에 고정한다(ADR-0008 §9.2 ⑳, 적대적 검증 M2).';

-- ---------------------------------------------------------------------------
-- ② 한 에이전트의 신원 잎 — 부분 색인
-- ---------------------------------------------------------------------------

CREATE INDEX tlog_leaves_identity_agent_idx
  ON tlog_leaves (org_log_id, ((leaf_json::jsonb -> 'body' ->> 'agent_id')), seq)
  INCLUDE (leaf_hash)
  WHERE kind LIKE 'identity.%';

-- ---------------------------------------------------------------------------
-- ③ 블록 API 조직당 분당 상한
-- ---------------------------------------------------------------------------

CREATE TABLE tlog_identity_block_requests (
  organization_id uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  requested_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX tlog_identity_block_requests_org_idx ON tlog_identity_block_requests (organization_id, requested_at);

REVOKE ALL ON tlog_identity_block_requests FROM PUBLIC;
GRANT SELECT, INSERT ON tlog_identity_block_requests TO atmark_admin;
