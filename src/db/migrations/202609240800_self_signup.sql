-- 202609240800_self_signup.sql
-- 셀프 회원가입 (`.omc/handoffs/signup-contract.md` §1 — 진윤겸 결정 2026-09-24 "셀프 회원가입까지 지금").
--
-- 원칙 한 줄: **가입은 자유, 외부 발송은 운영자 활성화 뒤.** 셀프 가입 조직은 `review_status='pending_review'` 로 태어나고
--   관문 Stage 0 이 `pending_review`·`rejected` 조직의 발송을 거부한다(`org_pending_review` · `org_review_rejected`).
--   운영자 CLI(`pnpm admin:org-review`, 소유자 롤)만 `active` 로 바꾼다. **기존 조직은 전부 `active`**(기본값) — 이 파일이
--   적용되는 순간 멈추는 조직은 없다.
--
-- 세운다:
--   ① `organizations.review_status`·`signup_source`·`reviewed_at` + 가드 트리거 — 세 칸은 테이블 소유자(= 마이그레이션·CLI
--      롤)만 바꾼다. admin 롤(`atmark_admin`)의 raw UPDATE 로도, 앞으로 누가 organizations UPDATE 를 넓게 받아도 안 된다
--      (`agents_operator_suspension_guard` 와 같은 방식 — 권한이 아니라 소유자 여부로 가른다).
--   ② `signup_links` — 가입 링크 **겸 outbox**(`owner_login_links` 와 같은 모양). admin 이 INSERT 하고, 메일은 로그인 메일
--      Lambda(`atmark-login-mailer`, DB 롤 `atmark_login_mailer`)가 보낸다. **수신자 칸(`email`)이 행에 있다** — 로그인 링크와
--      다른 점이고 가입의 본질이다(아직 조직이 없다). 그래서 임의 주소로 가는 메일이 되고, 메일 폭탄을 세 겹으로 막는다:
--      요청자 상한·같은 주소 상한(admin, `signup_requests`) + 전역 시간당 상한(메일러, `SIGNUP_MAIL_GLOBAL_HOURLY_CAP`) +
--      억제 목록(아래 ⑤).
--   ③ `signup_requests` — 가입 요청 속도 상한 원장(요청자 키 HMAC · 이메일 해시 — 평문 없음).
--   ④ `create_signup_organization(link, binding, now)` — **조직을 만드는 유일한 비소유자 경로**(SECURITY DEFINER). admin 롤은
--      `organizations` INSERT 가 없다(2차 검증에서 확인된 성질 — 유지). 검증된 링크 행을 **소비하면서만** 조직을 만든다.
--   ⑤ `signup_email_suppressed(email)` — 메일러가 억제 목록을 **주소 하나에 대한 참/거짓**으로만 묻는다(SECURITY DEFINER).
--      억제 목록 테이블은 조직별이고 주소가 가득하다 — 메일러 롤에 SELECT 를 주면 전 테넌트의 억제 주소를 읽는다.
--   ⑥ 승인은 `review_status <> 'active'` 조직에서 성립하지 않는다(정지 중 승인 불가 L-A 와 같은 규칙의 두 번째 층).
--
-- 권한 경계(ADR-0006): 앱 롤(`atmark_app`)은 ②③ 에 **아무 권한이 없고** ④⑤ 를 실행하지 못한다. `atmark_admin` 은 ② INSERT
--   (요청 행의 여섯 칸) · 읽기(발송 컬럼·결속 제외) · ③ INSERT/SELECT · ④ EXECUTE. `atmark_login_mailer` 는 ② 의 발송 컬럼과
--   수신자·만료·id 읽기 · ⑤ EXECUTE. 허용 목록은 `src/runtime/role-bootstrap.ts` `RESTRICTED_ROLE_GRANTS` 에 한 번 더 있고
--   migrate `status` 가 실제 ACL 과 대조한다.
--
-- 마이그레이션은 append-only 다. 기존 파일은 한 글자도 건드리지 않았다.

-- ---------------------------------------------------------------------------
-- ① organizations — 검토 상태
-- ---------------------------------------------------------------------------

CREATE TYPE organization_review_status AS ENUM ('pending_review', 'active', 'rejected');

-- 기본값이 `active`·`operator` 인 이유: 기존 조직과 CLI(`admin:org-create`)가 만드는 조직은 운영자가 직접 만든 것이다.
--   `pending_review` 는 가입 함수(④)만 적는다.
ALTER TABLE organizations
  ADD COLUMN review_status organization_review_status NOT NULL DEFAULT 'active',
  ADD COLUMN signup_source text NOT NULL DEFAULT 'operator' CHECK (signup_source IN ('operator', 'self_signup')),
  ADD COLUMN reviewed_at timestamptz;

COMMENT ON COLUMN organizations.review_status IS
  '운영자 검토 상태. pending_review·rejected 는 Stage 0 이 발송을 거부한다(org_pending_review·org_review_rejected). 테이블 소유자(운영자 CLI)만 바꾼다(트리거 organizations_review_guard).';
COMMENT ON COLUMN organizations.signup_source IS
  '조직을 만든 경로. operator = 운영자 CLI, self_signup = 가입 함수 create_signup_organization. 불변(소유자 제외).';

-- 검토 세 칸은 **테이블 소유자만** 바꾼다. 권한(GRANT)으로만 막으면 누군가 organizations UPDATE 를 테이블 단위로 다시 주는
--   날 조용히 열린다 — 소유자 여부로 가르면 그 날에도 닫혀 있다. INSERT 도 본다: 비소유자가 organizations INSERT 를 얻어도
--   `active` 조직(= 검토 없이 외부 발송)을 만들 수 없다. 가입 함수(④)는 SECURITY DEFINER 라 current_user 가 소유자다.
CREATE OR REPLACE FUNCTION organizations_review_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF pg_has_role(current_user, (SELECT c.relowner FROM pg_catalog.pg_class c WHERE c.oid = TG_RELID), 'USAGE') THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.review_status IS DISTINCT FROM 'pending_review' OR NEW.signup_source IS DISTINCT FROM 'self_signup'
       OR NEW.reviewed_at IS NOT NULL THEN
      RAISE EXCEPTION 'role % can only create pending_review self_signup organizations', current_user USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.review_status IS DISTINCT FROM OLD.review_status
     OR NEW.signup_source IS DISTINCT FROM OLD.signup_source
     OR NEW.reviewed_at IS DISTINCT FROM OLD.reviewed_at THEN
    RAISE EXCEPTION 'organization % review state can only be changed by the operator (owner role)', OLD.id
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER organizations_review_guard
  BEFORE INSERT OR UPDATE ON organizations
  FOR EACH ROW EXECUTE FUNCTION organizations_review_guard();

-- ---------------------------------------------------------------------------
-- ② signup_links — 가입 링크 겸 outbox
-- ---------------------------------------------------------------------------

CREATE TYPE signup_link_status AS ENUM ('pending', 'sent', 'obsolete', 'undeliverable', 'dead');

-- ★ 토큰 컬럼이 없다 — 토큰은 보낼 때 로그인 키링(`atmark/owner-login-keys`)으로 **다른 서명 문맥**(`atmark-signup-v1`)에서
--   만든다(`security/signup-token.ts`). 로그인 토큰과 서로 통하지 않는다.
CREATE TABLE signup_links (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- 수신자이자 조직 소유자 주소. `organizations_owner_email_shape` 와 **같은 모양** — 가입 함수가 이 값을 그대로
  --   `owner_email` 로 넣는다(모양이 다르면 링크는 만들어지고 조직은 못 만드는 행이 생긴다).
  email              text NOT NULL CHECK (
                       length(email) BETWEEN 6 AND 254
                       AND email = lower(email)
                       AND email ~ '^[a-z0-9._%+-]{1,64}@[a-z0-9-]+(\.[a-z0-9-]+)+$'
                       AND split_part(email, '@', 2) !~ '(^|\.)atmark\.ai$'),
  -- 가입할 조직 이름(요청자가 고른 문자열). **메일 본문에 싣지 않는다**(signup-template.ts) — 피싱 문구의 자리가 된다.
  --   제어문자·줄 구분자·방향 제어·폭 없는 문자를 거부한다(콘솔 화면의 표시 문자열이 된다).
  organization_name  text NOT NULL CHECK (
                       length(organization_name) BETWEEN 1 AND 80
                       AND btrim(organization_name) <> ''
                       AND organization_name !~ '[\u0001-\u001f\u007f-\u009f​-‏ -‮⁠-⁯﻿]'),
  -- 가입을 **요청한 브라우저**의 논스(쿠키 `__Host-atmark_signup`) 해시. 가입 함수가 같은 값을 요구한다.
  browser_binding    text NOT NULL CHECK (browser_binding ~ '^[0-9a-f]{64}$'),
  -- 요청자 키 = HMAC(로그인 키, 'ip:' || IP) — `owner_login_requests.client_key` 와 같은 값. IP 평문 없음.
  client_key         text NOT NULL CHECK (client_key ~ '^[0-9a-f]{64}$'),
  created_at         timestamptz NOT NULL DEFAULT now(),
  -- 토큰에 ms 로 실린다 — 비교가 정확하도록 ms 로 자른 값만 받는다.
  expires_at         timestamptz NOT NULL CHECK (expires_at = date_trunc('milliseconds', expires_at)),
  -- 단일 사용(NULL → 값 1회 · 만료 뒤 불가 — 트리거). 가입 함수만 적는다.
  used_at            timestamptz,
  -- 소비할 때 채운다 — 새로 만든 조직, 또는 같은 주소가 이미 소유한 조직.
  organization_id    uuid REFERENCES organizations (id) ON DELETE RESTRICT,

  -- ---- outbox (owner_login_links 와 같은 모양) ----
  status             signup_link_status NOT NULL DEFAULT 'pending',
  attempt_count      integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  next_attempt_at    timestamptz NOT NULL DEFAULT now(),
  claimed_at         timestamptz,
  last_error         text CHECK (last_error ~ '^[a-z_]{1,40}$'),
  ses_message_id     text,
  sent_at            timestamptz,
  settled_at         timestamptz,

  -- 30분. 조직을 만드는 권한이 메일함에 남는 시간이다.
  CONSTRAINT signup_links_ttl CHECK (expires_at > created_at AND expires_at - created_at <= interval '30 minutes'),
  CONSTRAINT signup_links_used_shape CHECK ((used_at IS NULL) = (organization_id IS NULL)),
  CONSTRAINT signup_links_sent_shape
    CHECK ((status = 'sent') = (sent_at IS NOT NULL AND ses_message_id IS NOT NULL)),
  CONSTRAINT signup_links_settled_shape
    CHECK ((status IN ('obsolete', 'undeliverable', 'dead')) = (settled_at IS NOT NULL))
);

CREATE INDEX signup_links_due_idx ON signup_links (next_attempt_at) WHERE status = 'pending';
-- 전역 시간당 상한의 계수 경로(메일러).
CREATE INDEX signup_links_claimed_idx ON signup_links (claimed_at) WHERE claimed_at IS NOT NULL;
-- 같은 주소·같은 요청자 상한의 계수 경로(admin).
CREATE INDEX signup_links_email_created_idx ON signup_links (email, created_at);
CREATE INDEX signup_links_client_created_idx ON signup_links (client_key, created_at);

-- 식별·수신자·결속·만료는 불변. 바뀔 수 있는 것은 소비 두 칸과 outbox 컬럼뿐이다.
CREATE TRIGGER signup_links_immutable_core
  BEFORE UPDATE ON signup_links
  FOR EACH ROW EXECUTE FUNCTION reject_column_update_except(
    'used_at', 'organization_id',
    'status', 'attempt_count', 'next_attempt_at', 'claimed_at', 'last_error', 'ses_message_id', 'sent_at', 'settled_at');

CREATE TRIGGER signup_links_used_once
  BEFORE UPDATE ON signup_links
  FOR EACH ROW EXECUTE FUNCTION reject_column_overwrite('used_at', 'organization_id');

-- 만료된 링크는 소비할 수 없다 · outbox 종단 행은 다시 열리지 않는다(같은 링크의 두 번째 메일 방지).
CREATE OR REPLACE FUNCTION signup_links_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.used_at IS NULL AND NEW.used_at IS NOT NULL AND NEW.used_at >= OLD.expires_at THEN
    RAISE EXCEPTION 'signup link % is expired', OLD.id USING ERRCODE = '23514';
  END IF;
  IF OLD.status <> 'pending' AND (
       NEW.status IS DISTINCT FROM OLD.status
    OR NEW.attempt_count IS DISTINCT FROM OLD.attempt_count
    OR NEW.next_attempt_at IS DISTINCT FROM OLD.next_attempt_at
    OR NEW.claimed_at IS DISTINCT FROM OLD.claimed_at
    OR NEW.sent_at IS DISTINCT FROM OLD.sent_at
    OR NEW.ses_message_id IS DISTINCT FROM OLD.ses_message_id) THEN
    RAISE EXCEPTION 'signup notification % is terminal (%)', OLD.id, OLD.status USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER signup_links_guard
  BEFORE UPDATE ON signup_links
  FOR EACH ROW EXECUTE FUNCTION signup_links_guard();

CREATE TRIGGER signup_links_no_delete
  BEFORE DELETE ON signup_links
  FOR EACH ROW EXECUTE FUNCTION reject_row_delete();

CREATE TRIGGER signup_links_no_truncate
  AFTER TRUNCATE ON signup_links
  FOR EACH STATEMENT EXECUTE FUNCTION reject_truncate();

COMMENT ON TABLE signup_links IS
  '가입 링크 겸 outbox. INSERT 는 admin(atmark_admin, 요청 행 여섯 칸)만, 소비는 create_signup_organization 만, 발송은 login-mailer(atmark_login_mailer, outbox 컬럼만). 앱 롤 권한 0. 토큰 컬럼 없음.';

-- ---------------------------------------------------------------------------
-- ③ signup_requests — 속도 상한 원장
-- ---------------------------------------------------------------------------

-- 요청자 키 = HMAC(로그인 키, 'ip:' || IP) · 이메일 해시 = HMAC(로그인 키, 'email:' || 정규 주소) — 평문 없음.
--   열거 불가(항상 202)를 지키려면 가입 요청의 **모든** 입력이 같은 모양의 행을 남겨야 한다 — 그래서 주소 대신 해시다.
CREATE TABLE signup_requests (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_key  text NOT NULL CHECK (client_key ~ '^[0-9a-f]{64}$'),
  email_hash  text NOT NULL CHECK (email_hash ~ '^[0-9a-f]{64}$'),
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX signup_requests_client_idx ON signup_requests (client_key, created_at);
CREATE INDEX signup_requests_email_idx ON signup_requests (email_hash, created_at);

CREATE TRIGGER signup_requests_no_update
  BEFORE UPDATE ON signup_requests
  FOR EACH ROW EXECUTE FUNCTION reject_row_update();
CREATE TRIGGER signup_requests_no_delete
  BEFORE DELETE ON signup_requests
  FOR EACH ROW EXECUTE FUNCTION reject_row_delete();
CREATE TRIGGER signup_requests_no_truncate
  AFTER TRUNCATE ON signup_requests
  FOR EACH STATEMENT EXECUTE FUNCTION reject_truncate();

-- ---------------------------------------------------------------------------
-- ④ create_signup_organization — 조직을 만드는 유일한 비소유자 경로
-- ---------------------------------------------------------------------------
-- 한 흐름: 링크 FOR UPDATE → 사용·만료·결속 검사(불일치면 **NULL** — 예외가 아니다: verify 는 NULL 을 "유효하지 않은 링크"
--   하나로 읽는다. 예외는 500 이 되어 "링크는 맞았다" 를 새게 한다) → 같은 주소가 이미 소유한 조직이 있으면 **그 조직**(중복
--   가입 없음) → 없으면 `pending_review` 조직 INSERT → 링크 소비(`used_at`·`organization_id`) → 조직 id.
--
-- ★ 만료는 `greatest(p_now, now())` 로 본다 — `p_now` 는 호출자(admin) 값이다. 과거 시각을 넘겨 만료된 링크를 살리는 길을
--   닫는다(미래 시각은 더 엄격할 뿐이다 — 테스트의 가짜 시계가 쓴다).
-- ★ 같은 주소의 동시 소비 두 건이 조직 둘을 만들지 않게 주소 단위 advisory 잠금.
-- ★ 세션은 만들지 않는다 — admin 코드가 기존 방식(`owner_sessions` INSERT)으로 같은 트랜잭션에서 만든다.
CREATE OR REPLACE FUNCTION create_signup_organization(p_link_id uuid, p_browser_binding text, p_now timestamptz)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_now   timestamptz := greatest(coalesce(p_now, now()), now());
  v_link  public.signup_links%ROWTYPE;
  v_org   uuid;
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
  SELECT o.id INTO v_org FROM public.organizations o
   WHERE o.owner_email = v_link.email
   ORDER BY o.created_at, o.id
   LIMIT 1;
  IF v_org IS NULL THEN
    INSERT INTO public.organizations (name, owner_email, review_status, signup_source, billing_status)
    VALUES (v_link.organization_name, v_link.email, 'pending_review', 'self_signup', 'trialing')
    RETURNING id INTO v_org;
  END IF;

  UPDATE public.signup_links SET used_at = v_now, organization_id = v_org WHERE id = v_link.id;
  RETURN v_org;
END;
$$;

REVOKE ALL ON FUNCTION create_signup_organization(uuid, text, timestamptz) FROM PUBLIC;

-- ---------------------------------------------------------------------------
-- ⑤ signup_email_suppressed — 억제 목록을 주소 하나의 참/거짓으로만
-- ---------------------------------------------------------------------------
-- 억제 항목은 조직별이다(`suppression_entries.organization_id`). 가입 메일에는 아직 조직이 없으므로 **어느 조직에서든**
--   억제된 주소(바운스·불만·수신 거부)에는 보내지 않는다. 만료된 항목은 제외.
CREATE OR REPLACE FUNCTION signup_email_suppressed(p_email text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.suppression_entries s
     WHERE s.address = lower(p_email) AND (s.expires_at IS NULL OR s.expires_at > now())
  )
$$;

REVOKE ALL ON FUNCTION signup_email_suppressed(text) FROM PUBLIC;

-- ---------------------------------------------------------------------------
-- ⑥ 검토 전·거절 조직에서는 승인이 성립하지 않는다
-- ---------------------------------------------------------------------------
-- 앱 코드(`approval-store.approve`)가 먼저 보고 사유를 돌려준다(`ApprovalBlockedByReviewError`). 이 트리거는 그 검사가 빠지는
--   날의 두 번째 층이다. 이름이 정지 트리거(`..._while_paused`) 뒤에 정렬된다 — 둘 다 걸리면 정지가 먼저 보인다(코드와 같은 순서).
CREATE OR REPLACE FUNCTION approval_requests_reject_approve_while_unreviewed() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'pending' AND NEW.status = 'approved' AND EXISTS (
       SELECT 1 FROM agents a JOIN organizations o ON o.id = a.organization_id
        WHERE a.id = NEW.agent_id AND o.review_status <> 'active') THEN
    RAISE EXCEPTION 'approval % cannot be approved while the organization is not active (review)', NEW.id
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER approval_requests_reject_approve_while_unreviewed
  BEFORE UPDATE ON approval_requests
  FOR EACH ROW EXECUTE FUNCTION approval_requests_reject_approve_while_unreviewed();

-- ---------------------------------------------------------------------------
-- 권한
-- ---------------------------------------------------------------------------

-- 앱 롤 — 가입 테이블 권한 0(새 테이블은 기본 0 이지만 의도를 적는다).
REVOKE ALL ON signup_links, signup_requests FROM atmark_app;

-- atmark_admin — 요청 기록 · 링크 INSERT(요청 행 여섯 칸 — outbox 상태를 미리 적는 길 없음) · 읽기(결속·outbox 제외) ·
--   소비는 함수로만(UPDATE 권한 없음).
GRANT SELECT, INSERT ON signup_requests TO atmark_admin;
GRANT INSERT (email, organization_name, browser_binding, client_key, expires_at, next_attempt_at) ON signup_links TO atmark_admin;
GRANT SELECT (id, email, organization_name, client_key, created_at, expires_at, used_at, organization_id)
  ON signup_links TO atmark_admin;
GRANT EXECUTE ON FUNCTION create_signup_organization(uuid, text, timestamptz) TO atmark_admin;

-- atmark_login_mailer — 발송 컬럼 + 수신자·만료·id. 조직 이름은 읽지 않는다(메일에 싣지 않는다). 결속·소비 칸·요청자 키도
--   읽지 않는다. INSERT 없음(가입 메일을 스스로 촉발할 수 없다).
GRANT SELECT (id, email, created_at, expires_at, status, attempt_count, next_attempt_at, claimed_at)
  ON signup_links TO atmark_login_mailer;
GRANT UPDATE (status, attempt_count, next_attempt_at, claimed_at, last_error, ses_message_id, sent_at, settled_at)
  ON signup_links TO atmark_login_mailer;
GRANT EXECUTE ON FUNCTION signup_email_suppressed(text) TO atmark_login_mailer;
