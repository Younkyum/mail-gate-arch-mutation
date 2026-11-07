-- 202609250160_owner_actions_org_key_actor.sql
-- 감사 행위자 둘 — 소유자 세션 **또는** 조직 API 키 (확장성 P1 R-6, 계획 §2.6 · ADR-0008 추가 절).
--
-- 조직 키(`/org-api/v1`, CI)가 에이전트를 만들면 그 행위도 `owner_actions` 한 행(→ 투명성 로그 `owner.action` 잎)이다. 세션이 없으므로:
--   ① `org_api_key_id` 칸 추가 · `session_id` NOT NULL 해제 · **정확히 하나**(`owner_actions_one_actor`) —
--      세션 행위와 키 행위가 섞이거나 둘 다 없는 행은 모양상 들어갈 수 없다.
--   ② 복합 FK `(org_api_key_id, organization_id) → org_api_keys(id, organization_id)` — 다른 조직의 키로 이 조직의 감사를 적지 못한다
--      (세션 쪽 `owner_actions_session_fk` 와 같은 모양. MATCH SIMPLE 이라 NULL 쪽은 검사하지 않는다 — 한쪽만 값이 있다는 것은 ① 이 본다).
--   ③ 권한: `atmark_tlog` SELECT(org_api_key_id) — 잎이 행위자 종류를 가른다(세션 = `c.session`, 키 = `c.api_key` — 이름이 달라 구별된다).
--      `atmark_admin` SELECT(session_id, org_api_key_id) — 콘솔 로그의 "누가"(사용자 주소 · 키 이름) 조인과 검증 번들의 원천 행 행위자 종류.
--      세션 id 는 쿠키가 아니다(쿠키는 해시로만 저장된 별도 토큰) — admin 은 이미 `owner_sessions` 를 읽는다.
--
-- `owner_actions` 는 UPDATE/DELETE 트리거로 불변이다. 칸 추가(기본값 없음)는 행을 다시 쓰지 않는다. 잠금 대기 상한은 0010 과 같다.
-- 옛 코드(세션만 적음)는 이 뒤에도 그대로 돈다 — expand 전용.
--
-- 허용 목록(`RESTRICTED_ROLE_GRANTS`)·가드 목록(`REQUIRED_GUARDS` — `constraint:owner_actions.owner_actions_one_actor`)을 같은 변경에서 늘렸다.

SET LOCAL lock_timeout = '5s';

ALTER TABLE owner_actions ADD COLUMN org_api_key_id uuid;
ALTER TABLE owner_actions ALTER COLUMN session_id DROP NOT NULL;
ALTER TABLE owner_actions
  ADD CONSTRAINT owner_actions_one_actor CHECK (num_nonnulls(session_id, org_api_key_id) = 1);
ALTER TABLE owner_actions
  ADD CONSTRAINT owner_actions_org_key_fk FOREIGN KEY (org_api_key_id, organization_id)
    REFERENCES org_api_keys (id, organization_id) ON DELETE RESTRICT;

CREATE INDEX owner_actions_org_key_idx ON owner_actions (org_api_key_id) WHERE org_api_key_id IS NOT NULL;

COMMENT ON COLUMN owner_actions.org_api_key_id IS
  '조직 API 키 행위자(/org-api/v1). session_id 와 정확히 하나(owner_actions_one_actor). 잎에는 c.api_key 커밋으로만 간다.';

GRANT SELECT (org_api_key_id) ON owner_actions TO atmark_tlog;
GRANT SELECT (session_id, org_api_key_id) ON owner_actions TO atmark_admin;
