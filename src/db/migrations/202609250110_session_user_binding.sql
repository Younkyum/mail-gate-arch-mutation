-- 202609250110_session_user_binding.sql
-- 세션·로그인 링크를 **사용자**에 묶는다 · 조직 전환 = 새 세션 행 · 기존 사용자의 새 조직 (확장성 P0 R-1, 계획 §2.2 — **expand**).
--
-- 세우는 것:
--   ① `owner_sessions.user_id` · `switched_from_session_id`(UNIQUE — 부모 하나에 자식 하나). 세션의 조직을 UPDATE 로 바꿀 수 없으므로
--      (불변 트리거, F1) 전환은 새 세션 행이고, 부모는 같은 트랜잭션에서 폐기된다. `owner_sessions_one_link` 를 **같은 이름으로**
--      다시 정의한다: 로그인 링크 · 가입 링크 · 전환 부모 중 정확히 하나.
--   ② 세션 가드(BEFORE INSERT): 사용자가 있으면 그 조직의 **살아 있는 멤버십**이 있어야 한다. 전환 세션이면 부모가 살아 있고
--      (미폐기·미만료) 같은 사용자이며 만료가 부모보다 늦지 않다(전환으로 세션을 연장할 수 없다).
--   ③ `owner_login_links.user_id`(수신자 = `users.email`) · `invite_id`(FK 는 0120). 링크 가드: 사용자가 있고 초대 링크가 아니면
--      그 조직의 살아 있는 멤버십이 있어야 한다.
--   ④ **옛 코드 호환 자동 채움**(BEFORE INSERT, 세션·링크): `user_id` 가 NULL 이면 조직 `owner_email` 의 사용자로 채운다. 배포 창에서
--      옛 admin 코드(user_id 를 모른다)가 로그인·가입 세션을 계속 만들 수 있게. 0140(contract)이 이것을 NULL 거부로 바꾼다.
--   ⑤ `create_signup_organization` — 같은 서명·같은 NULL 규칙·같은 상한. 기존 소유자 판정만 `users ⋈ memberships(owner)` 로
--      (주 소유자인 조직 먼저). 새 조직의 owner 멤버십은 0100 의 조직 INSERT 트리거가 만든다.
--   ⑥ `create_member_organization(session, name)` — 로그인한 사용자의 새 조직(창업자 결정 F-3: 콘솔 `새 조직 만들기` 만).
--      상한: 사용자당 owner 조직 5 · 사용자당 하루 새 조직 2 · 전역 검토 대기 수(`signup_limits.pending_review_cap`, 가입과 공유).
--      넘으면 `AT429`(메시지 `org_limit`).
--
-- 권한: admin INSERT(user_id, switched_from_session_id) on owner_sessions · INSERT(user_id, invite_id) on owner_login_links ·
--   EXECUTE create_member_organization. login_mailer SELECT(user_id) on owner_login_links. 앱 롤 0.
--
-- 마이그레이션은 append-only 다. 기존 파일은 한 글자도 건드리지 않았다.

-- 잠금 대기 상한(적대적 검토 M5): 뜨거운 표 owner_sessions·owner_login_links(칸·제약·트리거)에 잠금을 건다 — 오래 기다리면 로그인·세션·감사 경로가 줄줄이 선다.
--   5초 안에 못 잡으면 이 파일만 실패(러너는 파일 하나당 BEGIN/COMMIT)하고 다시 돌리면 된다.
SET LOCAL lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- ① owner_sessions
-- ---------------------------------------------------------------------------

ALTER TABLE owner_sessions
  ADD COLUMN user_id uuid REFERENCES users (id) ON DELETE RESTRICT,
  ADD COLUMN switched_from_session_id uuid UNIQUE REFERENCES owner_sessions (id) ON DELETE RESTRICT;

ALTER TABLE owner_sessions DROP CONSTRAINT owner_sessions_one_link;
ALTER TABLE owner_sessions ADD CONSTRAINT owner_sessions_one_link
  CHECK (num_nonnulls(login_link_id, signup_link_id, switched_from_session_id) = 1);

CREATE INDEX owner_sessions_user_live_idx ON owner_sessions (user_id) WHERE revoked_at IS NULL;

COMMENT ON COLUMN owner_sessions.user_id IS
  '세션의 사용자. 매 요청 (user_id, organization_id) 의 살아 있는 멤버십과 조인해 역할을 읽는다(없으면 세션 무효).';
COMMENT ON COLUMN owner_sessions.switched_from_session_id IS
  '조직 전환으로 이 세션을 낳은 부모 세션(부모당 자식 하나). 부모는 같은 트랜잭션에서 폐기되고, 만료는 부모를 넘지 못한다.';

-- ④ 자동 채움(expand) — 트리거 이름이 가드보다 앞에 정렬된다(BEFORE 트리거는 이름 순).
CREATE OR REPLACE FUNCTION owner_sessions_fill_user() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.user_id IS NULL THEN
    SELECT u.id INTO NEW.user_id
      FROM organizations o JOIN users u ON u.email = o.owner_email
     WHERE o.id = NEW.organization_id;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER owner_sessions_fill_user
  BEFORE INSERT ON owner_sessions
  FOR EACH ROW EXECUTE FUNCTION owner_sessions_fill_user();

-- ② 세션 가드.
CREATE OR REPLACE FUNCTION owner_sessions_user_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_parent owner_sessions%ROWTYPE;
BEGIN
  IF NEW.user_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM memberships m
        WHERE m.user_id = NEW.user_id AND m.organization_id = NEW.organization_id AND m.removed_at IS NULL) THEN
    RAISE EXCEPTION 'session user is not a live member of organization %', NEW.organization_id USING ERRCODE = '23514';
  END IF;
  IF NEW.switched_from_session_id IS NOT NULL THEN
    SELECT * INTO v_parent FROM owner_sessions WHERE id = NEW.switched_from_session_id;
    IF NOT FOUND OR v_parent.revoked_at IS NOT NULL OR v_parent.expires_at <= now()
       OR v_parent.user_id IS NULL OR NEW.user_id IS DISTINCT FROM v_parent.user_id
       OR NEW.expires_at > v_parent.expires_at THEN
      RAISE EXCEPTION 'session switch from % is not allowed', NEW.switched_from_session_id USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER owner_sessions_user_guard
  BEFORE INSERT ON owner_sessions
  FOR EACH ROW EXECUTE FUNCTION owner_sessions_user_guard();

-- ---------------------------------------------------------------------------
-- ③ owner_login_links
-- ---------------------------------------------------------------------------

-- 불변 트리거(`owner_login_links_immutable_core` — 목록 밖 컬럼 UPDATE 거부)가 두 칸도 덮는다.
ALTER TABLE owner_login_links
  ADD COLUMN user_id uuid REFERENCES users (id) ON DELETE RESTRICT,
  ADD COLUMN invite_id uuid;

-- 사용자 기준 상한의 계수 경로(admin: 사용자 · (사용자, 요청자) 시간당 · 메일러: 사용자 시간당 집기).
CREATE INDEX owner_login_links_user_created_idx ON owner_login_links (user_id, created_at);
CREATE INDEX owner_login_links_user_client_created_idx ON owner_login_links (user_id, client_key, created_at);
CREATE INDEX owner_login_links_user_claimed_idx ON owner_login_links (user_id, claimed_at) WHERE claimed_at IS NOT NULL;

COMMENT ON COLUMN owner_login_links.user_id IS
  '로그인 링크의 수신자(users.email). 한 사용자에게 링크 한 통 — 조직이 여럿이어도.';
COMMENT ON COLUMN owner_login_links.invite_id IS
  '초대 수락 로그인 링크면 그 초대(org_invites). verify 가 같은 트랜잭션에서 accept_org_invite 를 부른다.';

CREATE OR REPLACE FUNCTION owner_login_links_fill_user() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.user_id IS NULL THEN
    SELECT u.id INTO NEW.user_id
      FROM organizations o JOIN users u ON u.email = o.owner_email
     WHERE o.id = NEW.organization_id;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER owner_login_links_fill_user
  BEFORE INSERT ON owner_login_links
  FOR EACH ROW EXECUTE FUNCTION owner_login_links_fill_user();

CREATE OR REPLACE FUNCTION owner_login_links_user_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.user_id IS NOT NULL AND NEW.invite_id IS NULL AND NOT EXISTS (
       SELECT 1 FROM memberships m
        WHERE m.user_id = NEW.user_id AND m.organization_id = NEW.organization_id AND m.removed_at IS NULL) THEN
    RAISE EXCEPTION 'login link user is not a live member of organization %', NEW.organization_id USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER owner_login_links_user_guard
  BEFORE INSERT ON owner_login_links
  FOR EACH ROW EXECUTE FUNCTION owner_login_links_user_guard();

-- ---------------------------------------------------------------------------
-- ⑤ create_signup_organization — 기존 소유자 판정을 멤버십으로
-- ---------------------------------------------------------------------------
-- 202609240900 과 같은 서명·반환·NULL 규칙·상한. 달라진 것은 기존 소유자 분기의 조회뿐이다: 그 주소의 사용자가 **owner 인** 조직
--   (주 소유자인 조직 먼저, 그다음 오래된 멤버십). 새 조직의 owner 멤버십은 조직 INSERT 트리거(0100 ③)가 만든다.
CREATE OR REPLACE FUNCTION create_signup_organization(p_link_id uuid, p_browser_binding text, p_now timestamptz)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
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
     OR v_link.browser_binding <> p_browser_binding THEN
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
-- ⑥ create_member_organization — 로그인한 사용자의 새 조직
-- ---------------------------------------------------------------------------
-- 세션이 주소 증명이다(가입 링크 없이). 새 조직은 가입 조직과 같은 모양(`pending_review` · `self_signup` · `trialing`)이고
--   주 소유자 = 그 사용자 주소. 이름 모양은 테이블 CHECK(`organizations_self_signup_name_shape`) + 여기 길이 검사 — 앱 검사
--   (`isValidOrganizationName`)가 상위 집합이다. 잠금 순서: 사용자 → 전역(`signup_org_create`, 가입 함수와 같은 키 — 전역 대기 수를
--   함께 센다). NULL 이 아니라 예외인 이유: 세션이 무효면 호출 전에 라우터가 401 로 끝냈다 — 여기서 무효 세션은 경합뿐이다.
CREATE OR REPLACE FUNCTION create_member_organization(p_session_id uuid, p_name text)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_user    public.users%ROWTYPE;
  v_limits  public.signup_limits%ROWTYPE;
  v_count   integer;
  v_org     uuid;
BEGIN
  SELECT u.* INTO v_user
    FROM public.owner_sessions s JOIN public.users u ON u.id = s.user_id
   WHERE s.id = p_session_id AND s.revoked_at IS NULL AND s.expires_at > now();
  IF NOT FOUND THEN
    RAISE EXCEPTION 'session is not live' USING ERRCODE = '28000';
  END IF;
  IF p_name IS NULL OR p_name <> btrim(p_name) OR length(p_name) NOT BETWEEN 1 AND 80 THEN
    RAISE EXCEPTION 'invalid organization name' USING ERRCODE = '22023';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('member_org_create:' || v_user.id::text, 0));
  SELECT count(*) INTO v_count FROM public.memberships
   WHERE user_id = v_user.id AND removed_at IS NULL AND role = 'owner';
  IF v_count >= 5 THEN
    RAISE EXCEPTION 'org_limit' USING ERRCODE = 'AT429', DETAIL = 'owner_orgs';
  END IF;
  SELECT count(*) INTO v_count FROM public.memberships
   WHERE user_id = v_user.id AND joined_via = 'org_create' AND created_at > now() - interval '1 day';
  IF v_count >= 2 THEN
    RAISE EXCEPTION 'org_limit' USING ERRCODE = 'AT429', DETAIL = 'daily';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('signup_org_create', 0));
  SELECT * INTO v_limits FROM public.signup_limits WHERE id;
  SELECT count(*) INTO v_count FROM public.organizations WHERE review_status = 'pending_review';
  IF v_count >= coalesce(v_limits.pending_review_cap, 200) THEN
    RAISE EXCEPTION 'org_limit' USING ERRCODE = 'AT429', DETAIL = 'pending_review_cap';
  END IF;

  INSERT INTO public.organizations (name, owner_email, review_status, signup_source, billing_status)
  VALUES (p_name, v_user.email, 'pending_review', 'self_signup', 'trialing')
  RETURNING id INTO v_org;
  RETURN v_org;
END;
$$;

REVOKE ALL ON FUNCTION create_member_organization(uuid, text) FROM PUBLIC;

-- ---------------------------------------------------------------------------
-- 권한
-- ---------------------------------------------------------------------------

GRANT INSERT (user_id, switched_from_session_id) ON owner_sessions TO atmark_admin;
GRANT INSERT (user_id, invite_id) ON owner_login_links TO atmark_admin;
GRANT EXECUTE ON FUNCTION create_member_organization(uuid, text) TO atmark_admin;

GRANT SELECT (user_id) ON owner_login_links TO atmark_login_mailer;
