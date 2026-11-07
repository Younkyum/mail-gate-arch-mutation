-- 202610101000_mail_locale.sql
-- 시스템 메일 언어 — 사용자마다 하나(2026-10-10 진윤겸 결정: 한 통에 한 언어 · 기본 영어). 등록부는 `src/i18n/locales.ts`.
--
-- 세우는 것:
--   ① `mail_locales` — 지원하는 메일 언어의 조회 표(코드 한 칸). 언어를 더하는 일 = 새 마이그레이션에서 이 표에 한 행 + 등록부 상수 + 사전 문구.
--      CHECK 를 다시 세우지 않아도 된다(FK 가 이 표를 본다). 행은 지우지 않는다(가리키는 사용자가 있을 수 있다 — 트리거가 막는다).
--   ② `users.mail_locale` — NULL = 아직 고르지 않았다(메일은 저장된 양식 언어 → 'en' 순으로 고른다, `resolveMailLocale`). FK 는 `NOT VALID` 로 세우고
--      다음 파일(1001)에서 VALIDATE 한다(기존 행은 모두 NULL 이라 검증은 곧 끝난다 — 규칙대로 나눈다).
--   ③ `users_immutable_core` 재생성(같은 이름) — 바뀌는 칸에 `mail_locale` 을 더한다(나머지는 202609250220 그대로 — 주소 · 지운 시각은 지우기 가드가 잡는다).
--   ④ 정의자 함수 둘(앱 롤 EXECUTE — 앱 롤은 users · memberships 권한 0 그대로):
--        `atmark_org_mail_locales(org, emails)` — 그 조직의 살아 있는 멤버이거나 주 소유자(`owner_email`)인 주소만, 고른 언어가 있는 것만 (주소, 언어)로.
--          승인 · 도메인 · 격리 알림이 받는 사람마다 언어를 고른다(주소는 이미 앱 롤이 아는 값 — 정의자 집기 함수 · `owner_email`). 50개까지.
--        `atmark_operator_mail_locale(email)` — 그 주소가 **활성 운영자**(`ops_operators.status = 'active'`)일 때만 그 사용자의 언어(문의 전달 · 알림 —
--          받는 곳은 운영자 메일함). 아니면 NULL — 아무 주소의 사용자 여부를 묻는 길이 되지 않게.
--   ⑤ GRANT — admin: `users.mail_locale` UPDATE(콘솔 설정 · 가입 확정 때 가입 언어 한 번) · `signup_links.lang` SELECT(가입 확정이 읽는다).
--      로그인 메일 롤: `users.mail_locale` SELECT(로그인 · 초대 · 환영 · 운영 코드) · `signup_links.lang` SELECT(가입 확인 메일 — 아직 사용자가 없다).
--      허용 목록 `RESTRICTED_ROLE_GRANTS` · 가드 `REQUIRED_GUARDS` 를 같은 변경에서 늘렸다.
--
-- 잠금: `users` 에 칸 하나(기본값 없음 — 표를 다시 쓰지 않는다) · 트리거 교체 · FK(NOT VALID — 기존 행을 읽지 않는다). 모두 짧은 ACCESS EXCLUSIVE.
-- **순서:** 터널 migrate(1000 · 1001) → `deploy-compute migrate=false`. 옛 코드는 새 칸을 모르므로 함께 돌아도 된다(expand-only).

SET LOCAL lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- ① mail_locales
-- ---------------------------------------------------------------------------

CREATE TABLE mail_locales (
  code text PRIMARY KEY CHECK (code ~ '^[a-z]{2}(-[A-Z]{2})?$')
);

INSERT INTO mail_locales (code) VALUES ('en'), ('ko');

CREATE TRIGGER mail_locales_immutable
  BEFORE UPDATE ON mail_locales
  FOR EACH ROW EXECUTE FUNCTION reject_column_update_except();
CREATE TRIGGER mail_locales_no_delete
  BEFORE DELETE ON mail_locales
  FOR EACH ROW EXECUTE FUNCTION reject_row_delete();
CREATE TRIGGER mail_locales_no_truncate
  AFTER TRUNCATE ON mail_locales
  FOR EACH STATEMENT EXECUTE FUNCTION reject_truncate();

COMMENT ON TABLE mail_locales IS
  '지원하는 시스템 메일 언어(src/i18n/locales.ts SUPPORTED_MAIL_LOCALES 와 같은 집합 — 통합 테스트가 대조). 더하기만 한다(마이그레이션). 어느 롤에도 권한 0 — FK 확인은 표 소유자로 돈다.';

-- ---------------------------------------------------------------------------
-- ② users.mail_locale
-- ---------------------------------------------------------------------------

ALTER TABLE users ADD COLUMN mail_locale text;
ALTER TABLE users ADD CONSTRAINT users_mail_locale_fkey FOREIGN KEY (mail_locale) REFERENCES mail_locales (code) NOT VALID;

COMMENT ON COLUMN users.mail_locale IS
  '이 사용자에게 가는 시스템 메일의 언어(콘솔 설정 — 본인만). NULL = 고르지 않음(저장된 양식 언어 → en). 가입 확정이 가입 언어로 한 번 채운다.';

-- ---------------------------------------------------------------------------
-- ③ 불변 핵심 재생성 — 바뀌는 칸에 mail_locale
-- ---------------------------------------------------------------------------

DROP TRIGGER users_immutable_core ON users;
CREATE TRIGGER users_immutable_core
  BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION reject_column_update_except('last_organization_id', 'email', 'erased_at', 'mail_locale');

-- ---------------------------------------------------------------------------
-- ④ 정의자 함수
-- ---------------------------------------------------------------------------

CREATE FUNCTION atmark_org_mail_locales(p_organization_id uuid, p_emails text[])
RETURNS TABLE (email text, mail_locale text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT u.email, u.mail_locale
    FROM public.users u
   WHERE u.email = ANY (p_emails[1:50])
     AND u.erased_at IS NULL
     AND u.mail_locale IS NOT NULL
     AND (EXISTS (SELECT 1 FROM public.memberships m
                   WHERE m.user_id = u.id AND m.organization_id = p_organization_id AND m.removed_at IS NULL)
          OR EXISTS (SELECT 1 FROM public.organizations o
                      WHERE o.id = p_organization_id AND o.owner_email = u.email))
$$;

REVOKE ALL ON FUNCTION atmark_org_mail_locales(uuid, text[]) FROM PUBLIC;

CREATE FUNCTION atmark_operator_mail_locale(p_email text) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT u.mail_locale
    FROM public.ops_operators o JOIN public.users u ON u.email = o.email AND u.erased_at IS NULL
   WHERE o.email = pg_catalog.lower(pg_catalog.btrim(p_email)) AND o.status = 'active'
$$;

REVOKE ALL ON FUNCTION atmark_operator_mail_locale(text) FROM PUBLIC;

-- ---------------------------------------------------------------------------
-- ⑤ GRANT — `src/runtime/role-bootstrap.ts` `RESTRICTED_ROLE_GRANTS` 와 같다(migrate status 가 대조)
-- ---------------------------------------------------------------------------

GRANT UPDATE (mail_locale) ON users TO atmark_admin;
GRANT SELECT (lang) ON signup_links TO atmark_admin;

GRANT SELECT (mail_locale) ON users TO atmark_login_mailer;
GRANT SELECT (lang) ON signup_links TO atmark_login_mailer;

GRANT EXECUTE ON FUNCTION atmark_org_mail_locales(uuid, text[]) TO atmark_app;
GRANT EXECUTE ON FUNCTION atmark_operator_mail_locale(text) TO atmark_app;
