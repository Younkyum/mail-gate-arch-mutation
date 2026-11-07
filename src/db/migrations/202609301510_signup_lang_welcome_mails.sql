-- 202609301510_signup_lang_welcome_mails.sql
-- 셀프 가입 환영 메일(onve@atmark.ai, 2026-09-30) — 가입 언어를 적고, 새 가입 한 번에 환영 메일 outbox 한 행.
--
--   ① `signup_links.lang` — 가입 요청의 화면 언어(`ko`·`en`). admin 이 요청 행을 적을 때 함께 적는다(본문 `lang` → 콘솔 언어 쿠키 →
--      `Accept-Language`). **NULL 허용**: 이 칸을 모르는 옛 admin 코드가 적은 행은 NULL 이고 환영 메일은 한국어로 간다(`coalesce`).
--      모양 CHECK 는 `NOT VALID` — 기존 행 검증은 202609301511(기존 행은 전부 NULL 이라 통과한다).
--   ② `welcome_mails` — 환영 메일 outbox. **사용자당 한 행**(`user_id` UNIQUE) — 같은 사람이 조직을 몇 번 만들어도 한 통이다. 수신자·본문 칸이
--      없다: 수신자는 보내는 순간 `users.email` 에서 읽고, 본문은 상수 템플릿(`src/notify/welcome-template.ts`)이다. INSERT 는 **아무 롤에도 없다** —
--      `create_signup_organization`(SECURITY DEFINER, 소유자)이 새 조직을 만드는 갈래에서만 적는다. 초대받은 멤버 · 돌아온 소유자(이미 조직이 있는
--      주소) · `create_member_organization`(콘솔 "새 조직") · 운영자 CLI(`admin:org-create`)는 행을 만들지 않는다.
--      종단(`sent`·`dead`·`undeliverable`·`obsolete`)은 트리거가 동결한다(`contact_forwards` 와 같은 규율) · 정체성 칸 불변 · DELETE·TRUNCATE 거부.
--   ③ `create_signup_organization` 재정의 — 202609280100 본문 그대로 + 새 조직 갈래에서 조직 INSERT 바로 뒤에 환영 메일 한 행
--      (`ON CONFLICT (user_id) DO NOTHING`). 사용자 행은 조직 INSERT 의 AFTER 트리거(`organizations_owner_membership`)가 이미 만들었다.
--   ④ 권한 — admin: `signup_links.lang` INSERT. 로그인 메일 롤: `welcome_mails` 발송 칸(SELECT·UPDATE)만(조직 id 는 읽지 않는다). 앱·admin·ops 롤 0.
--
-- 발송은 login-mailer λ 의 `welcome` 단계(`src/workers/welcome-mailer.ts`)가 기능 플래그 `ATMARK_WELCOME_MAIL_ENABLED`(기본 꺼짐)로 켠다 —
--   꺼진 동안 행은 `pending` 으로 쌓이고, 켠 뒤 48시간이 지난 행은 `obsolete` 로 닫힌다(오래된 가입자에게 한꺼번에 가지 않는다).

-- `signup_links`(가입 요청·확정이 쓰는 표)에 칸을 더한다(ACCESS EXCLUSIVE — 짧다). 5초 안에 못 잡으면 이 파일만 실패하고 다시 돌리면 된다.
SET LOCAL lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- ① signup_links.lang
-- ---------------------------------------------------------------------------

ALTER TABLE signup_links ADD COLUMN lang text;
ALTER TABLE signup_links ADD CONSTRAINT signup_links_lang_check CHECK (lang IS NULL OR lang IN ('ko', 'en')) NOT VALID;

COMMENT ON COLUMN signup_links.lang IS
  '가입 요청의 화면 언어(ko|en). 환영 메일의 언어다(NULL = 옛 코드가 적은 행 → ko). admin 이 요청 행과 함께 적는다.';

-- ---------------------------------------------------------------------------
-- ② welcome_mails
-- ---------------------------------------------------------------------------

CREATE TABLE welcome_mails (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- 수신자. 주소 칸이 없다 — 보내는 순간 users.email 에서 읽는다(로그인 링크·초대와 같은 규율). 사용자당 한 통.
  user_id          uuid NOT NULL UNIQUE REFERENCES users (id) ON DELETE RESTRICT,
  -- 가입으로 만들어진 조직(추적용 — 발송 롤은 읽지 않는다).
  organization_id  uuid NOT NULL REFERENCES organizations (id) ON DELETE RESTRICT,
  lang             text NOT NULL CHECK (lang IN ('ko', 'en')),
  status           text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'dead', 'undeliverable', 'obsolete')),
  attempt_count    integer NOT NULL DEFAULT 0 CHECK (attempt_count BETWEEN 0 AND 20),
  next_attempt_at  timestamptz NOT NULL DEFAULT now(),
  claimed_at       timestamptz,
  sent_at          timestamptz,
  settled_at       timestamptz,
  ses_message_id   text CHECK (ses_message_id IS NULL OR ses_message_id ~ '^[A-Za-z0-9][A-Za-z0-9._=-]{0,254}$'),
  -- 사유 **코드**만(주소·본문 금지).
  last_error       text CHECK (last_error IS NULL OR last_error ~ '^[a-z_]{1,40}$'),
  created_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT welcome_mails_sent_shape
    CHECK ((status = 'sent') = (sent_at IS NOT NULL AND ses_message_id IS NOT NULL)),
  CONSTRAINT welcome_mails_settled_shape
    CHECK ((status IN ('dead', 'undeliverable', 'obsolete')) = (settled_at IS NOT NULL))
);

CREATE INDEX welcome_mails_due_idx ON welcome_mails (next_attempt_at) WHERE status = 'pending';
CREATE INDEX welcome_mails_claimed_idx ON welcome_mails (claimed_at) WHERE claimed_at IS NOT NULL;
CREATE INDEX welcome_mails_organization_idx ON welcome_mails (organization_id);

-- 정체성 칸(id · user_id · organization_id · lang · created_at)은 어떤 롤로도 바뀌지 않는다.
CREATE TRIGGER welcome_mails_immutable_core
  BEFORE UPDATE ON welcome_mails
  FOR EACH ROW EXECUTE FUNCTION reject_column_update_except(
    'status', 'attempt_count', 'next_attempt_at', 'claimed_at', 'sent_at', 'settled_at', 'ses_message_id', 'last_error');

-- 종단 동결 — 끝난 행은 어떤 롤로도 고칠 수 없다(보낸 환영 메일을 pending 으로 되돌려 다시 보내게 하는 길을 닫는다).
CREATE OR REPLACE FUNCTION welcome_mails_terminal_frozen() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF OLD.status <> 'pending' THEN
    RAISE EXCEPTION 'welcome_mails % is terminal (%)', OLD.id, OLD.status USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER welcome_mails_terminal_frozen
  BEFORE UPDATE ON welcome_mails
  FOR EACH ROW EXECUTE FUNCTION welcome_mails_terminal_frozen();

CREATE TRIGGER welcome_mails_no_delete
  BEFORE DELETE ON welcome_mails
  FOR EACH ROW EXECUTE FUNCTION reject_row_delete();
CREATE TRIGGER welcome_mails_no_truncate
  AFTER TRUNCATE ON welcome_mails
  FOR EACH STATEMENT EXECUTE FUNCTION reject_truncate();

COMMENT ON TABLE welcome_mails IS
  '셀프 가입 환영 메일 outbox(사용자당 1행). INSERT 는 create_signup_organization 만. 발송은 login-mailer(발송 칸). 수신자·본문 칸 없음. 앱·admin 롤 권한 0.';

-- ---------------------------------------------------------------------------
-- ③ create_signup_organization — 새 조직 갈래에서 환영 메일 한 행(나머지는 202609280100 그대로)
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

    -- 환영 메일(202609301510) — 새 가입만 · 사용자당 한 통. 사용자 행은 위 INSERT 의 AFTER 트리거(organizations_owner_membership)가 만들었다.
    INSERT INTO public.welcome_mails (user_id, organization_id, lang)
    SELECT u.id, v_org, coalesce(v_link.lang, 'ko') FROM public.users u WHERE u.email = v_link.email
    ON CONFLICT (user_id) DO NOTHING;
  END IF;

  UPDATE public.signup_links SET used_at = v_now, organization_id = v_org WHERE id = v_link.id;
  RETURN v_org;
END;
$$;

REVOKE ALL ON FUNCTION create_signup_organization(uuid, text, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION create_signup_organization(uuid, text, timestamptz) TO atmark_admin;

-- ---------------------------------------------------------------------------
-- ④ 권한
-- ---------------------------------------------------------------------------

GRANT INSERT (lang) ON signup_links TO atmark_admin;

REVOKE ALL ON welcome_mails FROM atmark_app, atmark_admin, atmark_login_mailer, atmark_ops;
-- 로그인 메일 롤 — 발송 칸 + 수신자(user_id)·언어·생성 시각·id. 조직 id 는 읽지 않는다.
-- last_error 는 사유 **코드**뿐이다(CHECK) — 발송기가 'sending' 표식(SES 호출 전에 적는 claim)을 읽어 만료된 lease 의 행을 다시 보내지 않는다.
GRANT SELECT (id, user_id, lang, created_at, status, attempt_count, next_attempt_at, claimed_at, last_error)
  ON welcome_mails TO atmark_login_mailer;
GRANT UPDATE (status, attempt_count, next_attempt_at, claimed_at, last_error, ses_message_id, sent_at, settled_at)
  ON welcome_mails TO atmark_login_mailer;
