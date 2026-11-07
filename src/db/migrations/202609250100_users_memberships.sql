-- 202609250100_users_memberships.sql
-- 사용자·멤버십 (확장성 P0 R-1, `.omc/plans/extensibility-p0-p1.md` §2.1 — **expand**: 지금 배포된 코드와 함께 돈다).
--
-- 지금까지 "소유자" 는 `organizations.owner_email` 한 칸이었다 — 한 주소가 조직 여럿을 가지면 로그인 링크(=메일)도 여럿이고,
--   조직에 두 번째 사람을 들일 자리가 없었다. 이 파일이 세우는 것:
--   ① `users(email)` — 사람 한 명 = 주소 하나. 바뀌는 칸은 `last_organization_id`(다음 로그인의 기본 조직) 하나.
--   ② `memberships(user, organization, role)` — owner·admin·member(창업자 결정 F-1). 지우지 않고 `removed_at` 을 한 번 적는다.
--      가드: 불변 핵심 · 제거 1회 · 제거된 행은 역할도 불변 · **마지막 owner 보호** · **주 소유자 보호**(`users.email =
--      organizations.owner_email` 인 멤버는 강등·제거 불가 — 승인 알림 수신자가 조직 밖 사람이 되지 않게, R-13 에서 풀린다) ·
--      조직당 살아 있는 멤버 **절대 천장 50**(앱 상한 5 는 코드·함수) · DELETE/TRUNCATE 거부.
--      마지막 owner·주 소유자 가드는 **테이블 소유자(운영자 셸·마이그레이션·SECURITY DEFINER 함수)** 에게는 서지 않는다 —
--      `organizations_review_guard` 와 같은 방식(권한이 아니라 소유자 여부로 가른다). admin 롤의 UPDATE 에는 언제나 선다.
--   ③ `organizations` AFTER INSERT 트리거 — `owner_email` 이 있으면 사용자 upsert + owner 멤버십(`joined_via='org_create'`).
--      CLI `admin:org-create`(provisioning-store) · 가입 함수 · 테스트 픽스처가 **코드 변경 없이** 불변식
--      "owner_email ⇒ 그 주소의 owner 멤버십" 을 지킨다.
--   ④ `organizations` AFTER UPDATE OF owner_email 트리거 — 새 주 소유자를 owner 로 들이고(없으면 멤버십, 있으면 승격)
--      옛 주 소유자의 멤버십을 **제거**한다. 202609230710 L5("옛 소유자의 세션이 새 소유자의 조직에 남지 않게")의 멤버십판 —
--      주소를 옮긴 것은 운영자이고, 옛 주소가 계속 들어올 수 있으면 L5 가 무너진다(세션 폐기·링크 무효화는 기존 트리거가 한다).
--   ⑤ 백필 — 기존 `owner_email` 조직마다 owner 멤버십(`joined_via='backfill'`).
--
-- 멤버십 INSERT 경로는 SECURITY DEFINER 함수뿐이다(③ · 0110 `create_member_organization` · 0120 `accept_org_invite`).
--   admin 롤에 memberships INSERT 가 없다.
--
-- 권한: `atmark_app` 0(`APP_FORBIDDEN_LOGIN_TABLES`). `atmark_admin`: users SELECT · UPDATE(last_organization_id) /
--   memberships SELECT · UPDATE(role, removed_at). `atmark_login_mailer`: users(id, email) SELECT 만 — memberships 는 못 읽는다.
--   허용 목록은 `src/runtime/role-bootstrap.ts` `RESTRICTED_ROLE_GRANTS`, 가드는 `src/runtime/handlers/migrate.ts` `REQUIRED_GUARDS`.
--
-- 마이그레이션은 append-only 다. 기존 파일은 한 글자도 건드리지 않았다.

-- 잠금 대기 상한(적대적 검토 M5): 뜨거운 표 organizations(트리거 둘 · users FK)에 잠금을 건다 — 오래 기다리면 로그인·세션·감사 경로가 줄줄이 선다.
--   5초 안에 못 잡으면 이 파일만 실패(러너는 파일 하나당 BEGIN/COMMIT)하고 다시 돌리면 된다.
SET LOCAL lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- ① users
-- ---------------------------------------------------------------------------

CREATE TABLE users (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- `organizations_owner_email_shape` 와 **같은 모양** — 주 소유자 주소가 곧 사용자 주소다.
  email                 text NOT NULL UNIQUE CHECK (
                          length(email) BETWEEN 6 AND 254
                          AND email = lower(email)
                          AND email ~ '^[a-z0-9._%+-]{1,64}@[a-z0-9-]+(\.[a-z0-9-]+)+$'
                          AND split_part(email, '@', 2) !~ '(^|\.)atmark\.ai$'),
  created_at            timestamptz NOT NULL DEFAULT now(),
  -- 다음 로그인의 기본 조직(조직 전환·새 조직이 적는다). 멤버십이 없어졌으면 로그인이 다른 조직을 고른다.
  last_organization_id  uuid REFERENCES organizations (id) ON DELETE RESTRICT
);

CREATE TRIGGER users_immutable_core
  BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION reject_column_update_except('last_organization_id');
CREATE TRIGGER users_no_delete
  BEFORE DELETE ON users
  FOR EACH ROW EXECUTE FUNCTION reject_row_delete();
CREATE TRIGGER users_no_truncate
  AFTER TRUNCATE ON users
  FOR EACH STATEMENT EXECUTE FUNCTION reject_truncate();

COMMENT ON TABLE users IS
  '콘솔 사용자(주소 하나 = 사람 하나). 바뀌는 칸은 last_organization_id 뿐. 앱 롤 권한 0, 로그인 메일 롤은 (id, email) 읽기만.';

-- ---------------------------------------------------------------------------
-- ② memberships
-- ---------------------------------------------------------------------------

CREATE TABLE memberships (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  organization_id  uuid NOT NULL REFERENCES organizations (id) ON DELETE RESTRICT,
  role             text NOT NULL CHECK (role IN ('owner', 'admin', 'member')),
  -- 멤버십이 생긴 경로 — backfill(이 파일) · org_create(조직 INSERT 트리거) · invite(accept_org_invite) ·
  --   operator(운영자가 owner_email 을 옮겨 새 주 소유자가 들어옴).
  joined_via       text NOT NULL CHECK (joined_via IN ('backfill', 'org_create', 'invite', 'operator')),
  created_at       timestamptz NOT NULL DEFAULT now(),
  removed_at       timestamptz,
  CONSTRAINT memberships_id_org_key UNIQUE (id, organization_id)
);

-- 살아 있는 멤버십은 (사용자, 조직)당 하나. 제거된 뒤 다시 들어오면 새 행이다.
CREATE UNIQUE INDEX memberships_live_key ON memberships (user_id, organization_id) WHERE removed_at IS NULL;
CREATE INDEX memberships_org_live_idx ON memberships (organization_id) WHERE removed_at IS NULL;

CREATE TRIGGER memberships_immutable_core
  BEFORE UPDATE ON memberships
  FOR EACH ROW EXECUTE FUNCTION reject_column_update_except('role', 'removed_at');
CREATE TRIGGER memberships_removed_once
  BEFORE UPDATE ON memberships
  FOR EACH ROW EXECUTE FUNCTION reject_column_overwrite('removed_at');
CREATE TRIGGER memberships_no_delete
  BEFORE DELETE ON memberships
  FOR EACH ROW EXECUTE FUNCTION reject_row_delete();
CREATE TRIGGER memberships_no_truncate
  AFTER TRUNCATE ON memberships
  FOR EACH STATEMENT EXECUTE FUNCTION reject_truncate();

-- 한 조직의 멤버십 변경은 한 줄로 선다(advisory 잠금) — 두 owner 가 동시에 서로를 강등해 owner 0 이 되는 경합,
--   동시 INSERT 둘이 천장을 넘는 경합을 막는다. 잠금 뒤의 계수는 새 스냅샷(READ COMMITTED)이라 앞 트랜잭션의 커밋을 본다.
CREATE OR REPLACE FUNCTION memberships_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_table_owner boolean;
  v_live        integer;
  v_owners      integer;
  v_primary     boolean;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('membership_org:' || NEW.organization_id::text, 0));

  IF TG_OP = 'INSERT' THEN
    IF NEW.removed_at IS NOT NULL THEN
      RAISE EXCEPTION 'membership must be created live' USING ERRCODE = '23514';
    END IF;
    SELECT count(*) INTO v_live FROM memberships WHERE organization_id = NEW.organization_id AND removed_at IS NULL;
    -- 조직당 살아 있는 멤버 절대 천장 50 — 앱 상한(5)이 코드 변경으로 풀려도 이 위로는 못 간다.
    IF v_live >= 50 THEN
      RAISE EXCEPTION 'member_limit' USING ERRCODE = 'AT409', DETAIL = 'memberships_ceiling';
    END IF;
    RETURN NEW;
  END IF;

  -- UPDATE: 제거된 행은 더 바뀌지 않는다(역할 포함).
  IF OLD.removed_at IS NOT NULL THEN
    IF NEW.role IS DISTINCT FROM OLD.role THEN
      RAISE EXCEPTION 'membership % is removed', OLD.id USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  -- 주 소유자(= 승인 알림 수신자)는 강등·제거 불가.
  IF NEW.role IS DISTINCT FROM OLD.role OR NEW.removed_at IS NOT NULL THEN
    v_table_owner := pg_has_role(current_user, (SELECT c.relowner FROM pg_catalog.pg_class c WHERE c.oid = TG_RELID), 'USAGE');
    IF NOT v_table_owner THEN
      SELECT EXISTS (
        SELECT 1 FROM organizations o JOIN users u ON u.email = o.owner_email
         WHERE o.id = NEW.organization_id AND u.id = NEW.user_id) INTO v_primary;
      IF v_primary AND (NEW.role <> 'owner' OR NEW.removed_at IS NOT NULL) THEN
        RAISE EXCEPTION 'primary_owner' USING ERRCODE = 'AT409', DETAIL = 'primary owner cannot be demoted or removed';
      END IF;
    END IF;
  END IF;
  -- 살아 있는 owner 가 owner 가 아니게 되는가(강등 또는 제거).
  IF OLD.role = 'owner' AND (NEW.role <> 'owner' OR NEW.removed_at IS NOT NULL) THEN
    v_table_owner := pg_has_role(current_user, (SELECT c.relowner FROM pg_catalog.pg_class c WHERE c.oid = TG_RELID), 'USAGE');
    IF NOT v_table_owner THEN
      SELECT count(*) INTO v_owners FROM memberships
       WHERE organization_id = NEW.organization_id AND removed_at IS NULL AND role = 'owner' AND id <> OLD.id;
      IF v_owners = 0 THEN
        RAISE EXCEPTION 'last_owner' USING ERRCODE = 'AT409', DETAIL = 'organization must keep an owner';
      END IF;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER memberships_guard
  BEFORE INSERT OR UPDATE ON memberships
  FOR EACH ROW EXECUTE FUNCTION memberships_guard();

COMMENT ON TABLE memberships IS
  '조직 멤버십(owner·admin·member). INSERT 는 SECURITY DEFINER 함수만. 바뀌는 칸은 role·removed_at(1회). 마지막 owner·주 소유자 보호 · 조직당 천장 50. 앱 롤 권한 0.';

-- ---------------------------------------------------------------------------
-- ③ 조직 INSERT → 주 소유자 owner 멤버십
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION organizations_owner_membership() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_user uuid;
BEGIN
  IF NEW.owner_email IS NULL THEN
    RETURN NULL;
  END IF;
  INSERT INTO public.users (email) VALUES (NEW.owner_email) ON CONFLICT (email) DO NOTHING;
  SELECT id INTO v_user FROM public.users WHERE email = NEW.owner_email;
  INSERT INTO public.memberships (user_id, organization_id, role, joined_via) VALUES (v_user, NEW.id, 'owner', 'org_create');
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION organizations_owner_membership() FROM PUBLIC;

CREATE TRIGGER organizations_owner_membership
  AFTER INSERT ON organizations
  FOR EACH ROW EXECUTE FUNCTION organizations_owner_membership();

-- ---------------------------------------------------------------------------
-- ④ owner_email 변경 → 새 주 소유자 owner · 옛 주 소유자 제거
-- ---------------------------------------------------------------------------
-- 순서: 새 주 소유자를 먼저 owner 로 세운 뒤 옛 주 소유자를 뺀다. 함수는 소유자 권한(SECURITY DEFINER)이라 마지막 owner 가드가
--   서지 않는다 — owner_email 을 NULL 로 지우는 운영자 조치(주 소유자 없는 조직 = 지금처럼 아무도 로그인 못 함)도 된다.
CREATE OR REPLACE FUNCTION organizations_owner_email_moves_membership() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_user uuid;
BEGIN
  IF NEW.owner_email IS NOT NULL THEN
    INSERT INTO public.users (email) VALUES (NEW.owner_email) ON CONFLICT (email) DO NOTHING;
    SELECT id INTO v_user FROM public.users WHERE email = NEW.owner_email;
    UPDATE public.memberships SET role = 'owner'
     WHERE user_id = v_user AND organization_id = NEW.id AND removed_at IS NULL AND role <> 'owner';
    IF NOT EXISTS (SELECT 1 FROM public.memberships WHERE user_id = v_user AND organization_id = NEW.id AND removed_at IS NULL) THEN
      INSERT INTO public.memberships (user_id, organization_id, role, joined_via) VALUES (v_user, NEW.id, 'owner', 'operator');
    END IF;
  END IF;
  IF OLD.owner_email IS NOT NULL THEN
    UPDATE public.memberships m SET removed_at = now()
      FROM public.users u
     WHERE u.email = OLD.owner_email AND m.user_id = u.id AND m.organization_id = NEW.id AND m.removed_at IS NULL;
  END IF;
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION organizations_owner_email_moves_membership() FROM PUBLIC;

CREATE TRIGGER organizations_owner_email_moves_membership
  AFTER UPDATE OF owner_email ON organizations
  FOR EACH ROW
  WHEN (OLD.owner_email IS DISTINCT FROM NEW.owner_email)
  EXECUTE FUNCTION organizations_owner_email_moves_membership();

-- ---------------------------------------------------------------------------
-- ⑤ 백필
-- ---------------------------------------------------------------------------

INSERT INTO users (email)
SELECT DISTINCT owner_email FROM organizations WHERE owner_email IS NOT NULL
ON CONFLICT (email) DO NOTHING;

-- 가드 트리거는 행마다 조직 advisory 잠금을 건다 — 조직 수만큼 잠금이 한 트랜잭션에 쌓여 `max_locks_per_transaction` 을 넘는다
--   (로컬 16k 조직에서 실측). 백필은 조직당 정확히 한 행이라 가드가 볼 것(천장·마지막 owner)이 없다 — 이 문장 동안만 끈다.
ALTER TABLE memberships DISABLE TRIGGER memberships_guard;
INSERT INTO memberships (user_id, organization_id, role, joined_via)
SELECT u.id, o.id, 'owner', 'backfill'
  FROM organizations o JOIN users u ON u.email = o.owner_email;
ALTER TABLE memberships ENABLE TRIGGER memberships_guard;

-- ---------------------------------------------------------------------------
-- 권한
-- ---------------------------------------------------------------------------

REVOKE ALL ON users, memberships FROM atmark_app, atmark_admin, atmark_login_mailer;

GRANT SELECT ON users TO atmark_admin;
GRANT UPDATE (last_organization_id) ON users TO atmark_admin;
GRANT SELECT ON memberships TO atmark_admin;
GRANT UPDATE (role, removed_at) ON memberships TO atmark_admin;

-- 로그인 메일 수신자(0110 부터 링크 → 사용자). 멤버십·조직 관계는 읽지 않는다.
GRANT SELECT (id, email) ON users TO atmark_login_mailer;
