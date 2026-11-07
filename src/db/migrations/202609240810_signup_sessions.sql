-- 202609240810_signup_sessions.sql
-- 가입 verify 가 소유자 세션을 연다 (`.omc/handoffs/signup-contract.md` §5 · A2 요청 1).
--
-- 무엇이 모자랐나: `owner_sessions.login_link_id` 가 `NOT NULL REFERENCES owner_login_links` 라서(202609230700) 가입 링크로 여는 세션을
--   적을 칸이 없었다 — `create_signup_organization` 이 조직을 만들어도 세션 INSERT 가 실패해 verify 전체가 롤백됐다.
--
-- 세우는 것:
--   ① `owner_sessions.signup_link_id` — 가입 링크 하나 = 세션 하나(UNIQUE, 로그인 링크와 같은 규율 — 같은 링크로 두 번째 세션이 나오는
--      길을 인덱스가 닫는다). 세션은 로그인 링크 **또는** 가입 링크 정확히 하나에서 나온다(CHECK).
--   ② 가입 세션의 조직 = 그 링크가 **소비되며 가리킨 조직**(복합 FK `(signup_link_id, organization_id)` → `signup_links (id, organization_id)`).
--      소비되지 않은 링크(organization_id NULL)나 다른 조직의 링크로는 세션 행이 서지 않는다 — admin 코드가 조직 id 를 잘못 넘겨도 DB 가
--      막는다. 로그인 세션(`signup_link_id` NULL)은 복합 FK 의 MATCH SIMPLE 이라 검사 대상이 아니다.
--   ③ admin 롤 INSERT 한 칸(`signup_link_id`). 불변 트리거(`owner_sessions_immutable_core` — `revoked_at` 밖 전부 불변)는 새 칸도 덮는다.
--
-- 마이그레이션은 append-only 다. 기존 파일은 한 글자도 건드리지 않았다.

ALTER TABLE owner_sessions ALTER COLUMN login_link_id DROP NOT NULL;

-- 복합 FK 의 대상 — 링크 id 는 이미 유일하므로 (id, organization_id) 도 유일하다(인덱스 하나 추가뿐).
ALTER TABLE signup_links ADD CONSTRAINT signup_links_id_org_key UNIQUE (id, organization_id);

ALTER TABLE owner_sessions
  ADD COLUMN signup_link_id uuid UNIQUE REFERENCES signup_links (id) ON DELETE RESTRICT,
  ADD CONSTRAINT owner_sessions_one_link CHECK (num_nonnulls(login_link_id, signup_link_id) = 1),
  ADD CONSTRAINT owner_sessions_signup_link_org_fk FOREIGN KEY (signup_link_id, organization_id)
    REFERENCES signup_links (id, organization_id) ON DELETE RESTRICT;

COMMENT ON COLUMN owner_sessions.signup_link_id IS
  '가입 verify 로 연 세션의 가입 링크(링크 하나 = 세션 하나). login_link_id 와 정확히 하나만 값. 조직은 그 링크가 소비되며 가리킨 조직이어야 한다(복합 FK).';

GRANT INSERT (signup_link_id) ON owner_sessions TO atmark_admin;
