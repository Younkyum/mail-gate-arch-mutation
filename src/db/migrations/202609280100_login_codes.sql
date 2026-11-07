-- 202609280100_login_codes.sql
-- 로그인·가입 메일의 **6자리 코드**(진윤겸 2026-09-28 승인). 링크는 요청한 브라우저에서만 되므로(논스 쿠키) 휴대폰·앱 내장 브라우저로
-- 메일을 읽으면 막힌다 — 같은 메일의 코드를 요청한 브라우저에 옮겨 적으면 된다(`src/security/login-code.ts`).
--
--   ① 코드는 **저장하지 않는다.** 링크 토큰처럼 login-mailer 가 보낼 때 로그인 키로 파생하고(HMAC(키, 문맥 ‖ kid ‖ 링크 id ‖ 만료)),
--      admin 이 검증할 때 다시 계산한다(ADR-0006 — 새 저장·발송 경로 없음). 그래서 이 파일에는 코드 칸이 없다.
--   ② `code_failures` — 한 로그인 시도(같은 브라우저 결속의 살아 있는 링크)에서 틀린 코드 수. 틀린 코드 하나마다 그 브라우저에 결속된
--      살아 있는 후보 링크 **전부**가 +1(admin 이 행 잠금 아래 한 문장으로 올린다). 5 가 되면 그 링크는 **링크로도 코드로도** 쓸 수 없다
--      (verify 조건 · 가입 함수 · 아래 가드 트리거). 링크와 코드는 한 시도를 여는 두 방법이다 — `used_at` 하나를 함께 태운다.
--   ③ 가드 트리거(모든 롤) — `code_failures` 는 한 번에 +1 씩만 오르고 내려가지 않는다 · 5번 틀린 링크의 `used_at` 쓰기는 거부.
--      불변 트리거(`*_immutable_core`)는 가변 칸 목록이 고정이라 새 칸을 더해 다시 세운다(목록 밖 칸은 여전히 불변).
--   ④ `create_signup_organization` — 5번 틀린 가입 링크는 NULL(거부). 나머지 본문은 202609250110 그대로(search_path 는 0240 과 같다).
--   ⑤ 권한 — admin: `owner_login_links.code_failures` UPDATE(SELECT 는 표 단위로 이미 있다) · `signup_links` 의 결속·상태·틀린 수 SELECT 와
--      틀린 수 UPDATE(가입 코드는 결속으로 후보를 찾는다). login-mailer 는 바뀌지 않는다 — 코드 파생에 쓰는 id·만료는 이미 읽는다.
--      앱 롤은 두 표에 여전히 0. 허용 목록 `RESTRICTED_ROLE_GRANTS`(admin) · 가드 목록 `REQUIRED_GUARDS` 를 같은 변경에서 늘렸다.
--
-- 코드 수명 = 링크 수명(로그인 15분 · 가입 30분). 한 메일의 코드와 링크가 다른 시각에 죽으면 안내가 두 줄이 된다 — 무차별 대입의 상한은
--   수명이 아니라 ② 의 5회(와 요청 상한 · 로그인 메일러의 사용자당 시간당 10통 · API 스로틀 1 rps)가 진다.
--
-- 잠금: `owner_login_links` → `signup_links` 순서(ACCESS EXCLUSIVE — 칸 더하기는 기본값 상수라 표를 다시 쓰지 않고, CHECK 는 `NOT VALID` 라
--   훑지 않는다). 둘 다 작은 표이고 5초 안에 못 잡으면 실패하고 아무것도 바뀌지 않는다. 검증은 202609280101.
-- 롤백 호환: 옛 코드는 이 칸을 읽지도 쓰지도 않는다(기본값 0 — 옛 verify 는 그대로 통한다).

SET LOCAL lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- ② code_failures
-- ---------------------------------------------------------------------------

ALTER TABLE owner_login_links ADD COLUMN code_failures smallint NOT NULL DEFAULT 0;
ALTER TABLE owner_login_links
  ADD CONSTRAINT owner_login_links_code_failures_range CHECK (code_failures BETWEEN 0 AND 5) NOT VALID;
COMMENT ON COLUMN owner_login_links.code_failures IS
  '이 링크의 브라우저 결속으로 들어온 틀린 코드 수(한 번에 +1, 내려가지 않는다). 5 면 링크로도 코드로도 로그인할 수 없다. 코드 자체는 저장하지 않는다(로그인 키로 파생).';

ALTER TABLE signup_links ADD COLUMN code_failures smallint NOT NULL DEFAULT 0;
ALTER TABLE signup_links
  ADD CONSTRAINT signup_links_code_failures_range CHECK (code_failures BETWEEN 0 AND 5) NOT VALID;
COMMENT ON COLUMN signup_links.code_failures IS
  '이 링크의 브라우저 결속으로 들어온 틀린 코드 수(한 번에 +1, 내려가지 않는다). 5 면 링크로도 코드로도 가입을 마칠 수 없다. 코드 자체는 저장하지 않는다.';

-- ---------------------------------------------------------------------------
-- ③ 가드
-- ---------------------------------------------------------------------------

DROP TRIGGER owner_login_links_immutable_core ON owner_login_links;
CREATE TRIGGER owner_login_links_immutable_core
  BEFORE UPDATE ON owner_login_links
  FOR EACH ROW EXECUTE FUNCTION reject_column_update_except(
    'used_at', 'status', 'attempt_count', 'next_attempt_at', 'claimed_at', 'last_error', 'ses_message_id', 'sent_at', 'settled_at',
    'invalidated_at', 'code_failures');

DROP TRIGGER signup_links_immutable_core ON signup_links;
CREATE TRIGGER signup_links_immutable_core
  BEFORE UPDATE ON signup_links
  FOR EACH ROW EXECUTE FUNCTION reject_column_update_except(
    'used_at', 'organization_id',
    'status', 'attempt_count', 'next_attempt_at', 'claimed_at', 'last_error', 'ses_message_id', 'sent_at', 'settled_at',
    'code_failures');

-- 두 표가 같은 함수를 쓴다(칸 이름이 같다). 예외로 던진다 — 정상 경로(admin verify · 가입 함수)는 조건으로 먼저 걸러 이 가드에 닿지
--   않으므로, 여기 닿는 것은 코드 결함이다(조용히 0행으로 삼키지 않는다).
CREATE OR REPLACE FUNCTION link_code_failures_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.code_failures < OLD.code_failures OR NEW.code_failures > OLD.code_failures + 1 THEN
    RAISE EXCEPTION 'code_failures of % only moves forward by one', OLD.id USING ERRCODE = '23514';
  END IF;
  IF OLD.used_at IS NULL AND NEW.used_at IS NOT NULL AND OLD.code_failures >= 5 THEN
    RAISE EXCEPTION 'link % is dead after too many wrong codes', OLD.id USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER owner_login_links_code_failures_guard
  BEFORE UPDATE ON owner_login_links
  FOR EACH ROW EXECUTE FUNCTION link_code_failures_guard();

CREATE TRIGGER signup_links_code_failures_guard
  BEFORE UPDATE ON signup_links
  FOR EACH ROW EXECUTE FUNCTION link_code_failures_guard();

-- ---------------------------------------------------------------------------
-- ④ create_signup_organization — 5번 틀린 링크는 거부(나머지는 202609250110 그대로)
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION create_signup_organization(p_link_id uuid, p_browser_binding text, p_now timestamptz)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_now      timestamptz := greatest(coalesce(p_now, now()), now());
  v_link     public.signup_links%ROWTYPE;
  v_org      uuid;
  v_limits   public.signup_limits%ROWTYPE;
  v_pending  integer;
  v_recent   integer;
BEGIN
  IF p_link_id IS NULL OR p_browser_binding IS NULL OR p_browser_binding !~ '^[0-9a-f]{64}$' THEN
    RETURN NULL;
  END IF;
  SELECT * INTO v_link FROM public.signup_links WHERE id = p_link_id FOR UPDATE;
  IF NOT FOUND OR v_link.used_at IS NOT NULL OR v_link.expires_at <= v_now
     OR v_link.browser_binding <> p_browser_binding OR v_link.code_failures >= 5 THEN
    RETURN NULL;
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('signup_email:' || v_link.email, 0));
  SELECT m.organization_id INTO v_org
    FROM public.users u
    JOIN public.memberships m ON m.user_id = u.id AND m.removed_at IS NULL AND m.role = 'owner'
    JOIN public.organizations o ON o.id = m.organization_id
   WHERE u.email = v_link.email
   ORDER BY (o.owner_email = v_link.email) DESC, m.created_at, m.organization_id
   LIMIT 1;
  IF v_org IS NULL THEN
    PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('signup_org_create', 0));
    SELECT * INTO v_limits FROM public.signup_limits WHERE id;
    SELECT count(*) INTO v_pending FROM public.organizations WHERE review_status = 'pending_review';
    IF v_pending >= coalesce(v_limits.pending_review_cap, 200) THEN
      RAISE EXCEPTION 'signup_capacity' USING ERRCODE = 'AT429', DETAIL = 'pending_review_cap';
    END IF;
    SELECT count(*) INTO v_recent
      FROM public.signup_links l
      JOIN public.organizations o ON o.id = l.organization_id
     WHERE l.client_key = v_link.client_key
       AND l.used_at > v_now - interval '24 hours'
       AND o.signup_source = 'self_signup'
       AND NOT EXISTS (
             SELECT 1 FROM public.signup_links e
              WHERE e.organization_id = l.organization_id AND (e.used_at, e.id) < (l.used_at, l.id));
    IF v_recent >= coalesce(v_limits.per_client_daily_cap, 3) THEN
      RAISE EXCEPTION 'signup_capacity' USING ERRCODE = 'AT429', DETAIL = 'client_daily_cap';
    END IF;

    INSERT INTO public.organizations (name, owner_email, review_status, signup_source, billing_status)
    VALUES (v_link.organization_name, v_link.email, 'pending_review', 'self_signup', 'trialing')
    RETURNING id INTO v_org;
  END IF;

  UPDATE public.signup_links SET used_at = v_now, organization_id = v_org WHERE id = v_link.id;
  RETURN v_org;
END;
$$;

REVOKE ALL ON FUNCTION create_signup_organization(uuid, text, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION create_signup_organization(uuid, text, timestamptz) TO atmark_admin;

-- ---------------------------------------------------------------------------
-- ⑤ 권한
-- ---------------------------------------------------------------------------

GRANT UPDATE (code_failures) ON owner_login_links TO atmark_admin;
GRANT SELECT (browser_binding, status, code_failures) ON signup_links TO atmark_admin;
GRANT UPDATE (code_failures) ON signup_links TO atmark_admin;
