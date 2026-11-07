-- 202609240900_signup_security_hardening.sql
-- 셀프 가입 보안 검증(2026-09-24)의 DB·메일·수신 쪽 결함 수정. 0800·0810 은 한 글자도 건드리지 않았다(append-only).
--
-- 세운다:
--   ① H1 — 예약 로컬파트 확대(인증서 도메인 검증 이름 · 운영·신뢰 사칭 이름). `atmark_reserved_local_parts()` 는
--      `src/identity/address.ts` `RESERVED_LOCAL_PARTS` 와 **같은 순서·같은 값**(통합 테스트가 대조). 기존 행이 새 목록에 걸리면
--      CHECK 를 `NOT VALID` 로 되돌린다(0750 과 같은 규칙 — "검증됨" 표시가 거짓이 되지 않게).
--   ② H2 — `system_mail_suppressions`: 시스템 메일(로그인 링크·가입 확인·승인 알림)의 **하드 바운스·불만** 주소. SES 이벤트 소비자
--      (앱 롤)가 적고, 로그인 메일 롤이 발송 전에 본다. 가입 억제 함수(`signup_email_suppressed`)도 이 표를 본다.
--   ③ M3 — `inbound_rejections.reason` 에 `org_not_active`(검토 전·거절 조직의 에이전트로 온 수신).
--   ④ M2 — `create_signup_organization` 에 새 조직 상한 둘(전역 검토 대기 수 · 요청자 키당 24시간 새 조직 수). 넘으면
--      SQLSTATE `AT429`(메시지 `signup_capacity`) — 링크는 소비되지 않는다. 기존 소유자 분기는 상한과 무관.
--   ⑤ L3 — 조직 이름 CHECK 강화(보이지 않는 문자·채움 문자·태그·변형 선택자).
--
-- 권한: 앱 롤은 ② 에 INSERT(address, reason)만 — SELECT·UPDATE·DELETE 없음(`ON CONFLICT DO NOTHING` 은 INSERT 만으로 된다).
--   `atmark_login_mailer` 는 ② 의 `address` SELECT 만. 허용 목록은 `src/runtime/role-bootstrap.ts` `RESTRICTED_ROLE_GRANTS`.

-- ---------------------------------------------------------------------------
-- ① H1 — 예약 로컬파트
-- ---------------------------------------------------------------------------
-- 앞 30개는 0750 그대로, 뒤 24개가 새 이름이다(TS 의 `CERTIFICATE_VALIDATION_RESERVED_LOCAL_PARTS` · `TRUST_RESERVED_LOCAL_PARTS`).
--   ACM·공인 CA 의 이메일 도메인 검증은 `admin`·`administrator`·`webmaster`·`hostmaster`·`postmaster`@도메인으로 간다 — 셀프 가입으로
--   누구나 에이전트 수신함을 가질 수 있게 된 지금 그 이름은 `atmark.ai` 인증서를 제3자가 받는 입구다.
CREATE OR REPLACE FUNCTION atmark_reserved_local_parts() RETURNS text[]
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT ARRAY[
    'postmaster', 'abuse', 'hostmaster', 'webmaster', 'noc', 'security',
    'dmarc', 'noreply', 'no-reply', 'bounce', 'mailer-daemon', 'notify',
    'blocked-test',
    'admin', 'support', 'billing', 'help', 'info', 'login', 'console', 'atmark', 'team', 'sales', 'hello', 'root',
    'system', 'approve', 'api', 'mail', 'www',
    'administrator', 'ssladmin', 'ssl-admin', 'sslwebmaster',
    'it', 'domains', 'privacy', 'legal', 'contact', 'signup', 'verify', 'trust', 'compliance', 'operator', 'accounts',
    'payments', 'helpdesk', 'help-desk', 'security-team', 'dpo', 'press', 'careers', 'jobs', 'abuse-report'
  ]::text[]
$$;

-- 함수를 바꾸면 CHECK 는 **새 행**부터 새 목록으로 검사한다. 기존 행은 다시 보지 않으므로, 이미 검증된(convalidated) 제약인데
--   새 목록에 걸리는 행이 있으면 "검증됨" 이 거짓이 된다 — 그때는 제약을 `NOT VALID` 로 다시 세운다(새 행은 계속 검사된다).
--   위반이 없으면 VALIDATE(이전에 NOT VALID 였어도). migrate `status` 의 `reservedLocalPartCheckValidated` 가 이 값을 보고한다.
DO $$
DECLARE
  offenders integer;
  validated boolean;
BEGIN
  SELECT count(*) INTO offenders FROM agent_addresses
   WHERE split_part(address, '@', 1) = ANY (atmark_reserved_local_parts());
  SELECT k.convalidated INTO validated FROM pg_constraint k
   WHERE k.conrelid = 'agent_addresses'::regclass AND k.conname = 'agent_addresses_not_reserved_local_part';
  IF offenders = 0 THEN
    IF validated IS DISTINCT FROM true THEN
      ALTER TABLE agent_addresses VALIDATE CONSTRAINT agent_addresses_not_reserved_local_part;
    END IF;
  ELSE
    IF validated THEN
      ALTER TABLE agent_addresses DROP CONSTRAINT agent_addresses_not_reserved_local_part;
      ALTER TABLE agent_addresses ADD CONSTRAINT agent_addresses_not_reserved_local_part
        CHECK (NOT (split_part(address, '@', 1) = ANY (atmark_reserved_local_parts()))) NOT VALID;
    END IF;
    RAISE WARNING 'agent_addresses 에 예약 로컬파트 주소가 % 개 있다 — CHECK 는 NOT VALID 로 남는다(새 행은 검사된다). docs/runbooks/deploy.md §12 참고', offenders;
  END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- ② H2 — 시스템 메일 억제 목록
-- ---------------------------------------------------------------------------
-- 왜 `suppression_entries` 가 아닌가: 그 표는 **조직 스코프**(organization_id NOT NULL, 조직별 유니크)이고 Stage 2 가 그 조직의
--   에이전트 메일에 대해 읽는다. 가입 확인 메일의 수신자에게는 아직 조직이 없다. 조직 없는 행을 허용하도록 넓히면 Stage 2 의
--   의미(테넌트 자신의 목록)가 흐려지고, 앱 롤이 그 표에 INSERT 를 다시 얻어야 한다(0750 이 닫은 권한 — "억제 목록 쓰기는 신고한
--   수신자에게 다시 보내는 길"). 그래서 시스템 메일 전용 표를 따로 두고, 앱 롤에는 **INSERT 한 방향**만 준다.
-- 행은 바꾸지 않는다(UPDATE 트리거 거부). 잘못 들어간 주소의 해제는 소유자 셸에서 DELETE 한다(런북 §12) — 앱·메일러 롤은 DELETE 없음.
CREATE TABLE system_mail_suppressions (
  address     text PRIMARY KEY CHECK (
                length(address) BETWEEN 3 AND 254
                AND address = lower(address)
                AND address ~ '^[^@[:space:]]+@[^@[:space:]]+$'),
  -- 하드 바운스(SES bounceType=Permanent) · 불만(Complaint). 일시 바운스는 적지 않는다.
  reason      text NOT NULL CHECK (reason IN ('hard_bounce', 'complaint')),
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER system_mail_suppressions_no_update
  BEFORE UPDATE ON system_mail_suppressions
  FOR EACH ROW EXECUTE FUNCTION reject_row_update();
CREATE TRIGGER system_mail_suppressions_no_truncate
  AFTER TRUNCATE ON system_mail_suppressions
  FOR EACH STATEMENT EXECUTE FUNCTION reject_truncate();

COMMENT ON TABLE system_mail_suppressions IS
  '시스템 메일(로그인·가입·승인 알림)의 하드 바운스·불만 주소. 앱 롤(SES 이벤트 소비자) INSERT 만, 로그인 메일 롤 address SELECT 만. 해제는 소유자 셸 DELETE.';

REVOKE ALL ON system_mail_suppressions FROM atmark_app, atmark_admin, atmark_login_mailer;
GRANT INSERT (address, reason) ON system_mail_suppressions TO atmark_app;
GRANT SELECT (address) ON system_mail_suppressions TO atmark_login_mailer;

-- 가입 메일의 억제 확인 — 조직 억제 목록(어느 조직이든, 만료 전) **또는** 시스템 메일 억제. 서명·권한은 0800 그대로.
CREATE OR REPLACE FUNCTION signup_email_suppressed(p_email text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.suppression_entries s
     WHERE s.address = lower(p_email) AND (s.expires_at IS NULL OR s.expires_at > now())
  ) OR EXISTS (
    SELECT 1 FROM public.system_mail_suppressions m WHERE m.address = lower(p_email)
  )
$$;

REVOKE ALL ON FUNCTION signup_email_suppressed(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION signup_email_suppressed(text) TO atmark_login_mailer;

-- ---------------------------------------------------------------------------
-- ③ M3 — 검토 전·거절 조직으로 온 수신
-- ---------------------------------------------------------------------------
ALTER TABLE inbound_rejections DROP CONSTRAINT inbound_rejections_reason_check;
ALTER TABLE inbound_rejections ADD CONSTRAINT inbound_rejections_reason_check
  CHECK (reason IN ('unknown_recipient', 'virus', 'mime_rejected', 'raw_too_large', 'unstorable', 'org_not_active'));

-- ---------------------------------------------------------------------------
-- ④ M2 — 익명 조직 생성 상한
-- ---------------------------------------------------------------------------
-- 상한 값은 표 한 행이다(소유자 롤만 — 다른 롤 권한 0). 코드 배포 없이 운영자가 조정하고, 테스트는 롤백되는 트랜잭션에서 낮춘다.
--   행이 없으면 함수가 기본값(200 · 3)을 쓴다 — 표를 지워서 상한을 푸는 길은 없다.
CREATE TABLE signup_limits (
  id                    boolean PRIMARY KEY DEFAULT true CHECK (id),
  -- 검토 대기(pending_review) 조직의 **전역** 총수. 운영자가 검토(활성·거절)하면 줄어든다.
  pending_review_cap    integer NOT NULL CHECK (pending_review_cap >= 0),
  -- 요청자 키(signup_links.client_key = HMAC(IP)) 하나가 롤링 24시간에 **새로 만든** 조직 수.
  per_client_daily_cap  integer NOT NULL CHECK (per_client_daily_cap >= 0)
);
INSERT INTO signup_limits (pending_review_cap, per_client_daily_cap) VALUES (200, 3);
REVOKE ALL ON signup_limits FROM atmark_app, atmark_admin, atmark_login_mailer;

CREATE INDEX organizations_pending_review_idx ON organizations (created_at) WHERE review_status = 'pending_review';
CREATE INDEX signup_links_organization_idx ON signup_links (organization_id) WHERE organization_id IS NOT NULL;

-- 0800 과 같은 서명·같은 반환(uuid)·같은 NULL 규칙. 달라진 것은 **새 조직 분기**뿐이다:
--   전역 잠금 하나 아래서 ① 검토 대기 총수 ≥ 전역 상한 ② 이 링크의 요청자 키가 24시간 안에 새로 만든 조직 수 ≥ 요청자 상한 →
--   `RAISE ... USING ERRCODE = 'AT429'`(메시지 `signup_capacity`, DETAIL `pending_review_cap` | `client_daily_cap`).
--   예외라서 트랜잭션 전체가 되돌아간다 — **링크는 소비되지 않고**(상한이 풀리면 만료 전 같은 링크로 다시), 세션·감사 행도 없다.
--   NULL 이 아니라 예외인 이유: NULL 은 "유효하지 않은 링크"(401) 하나의 뜻이다. 상한은 링크가 유효하고 결속도 맞은 뒤에만
--   판정되므로 링크를 가진 사람에게 "지금은 가입을 받을 수 없다"(409 `signup_capacity`)를 알려도 열거가 새지 않는다.
-- "새로 만든 조직" = 그 조직으로 소비된 **첫** 링크(used_at, id 순). 같은 주소의 이후 링크는 기존 소유자 분기라 세지 않는다.
-- ★ 기존 소유자 분기(같은 주소가 이미 소유한 조직)는 상한과 무관하다 — 조직을 만들지 않는다.
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
  SELECT o.id INTO v_org FROM public.organizations o
   WHERE o.owner_email = v_link.email
   ORDER BY o.created_at, o.id
   LIMIT 1;
  IF v_org IS NULL THEN
    -- 새 조직은 한 줄로 선다(주소 잠금 뒤 — 잠금 순서가 언제나 같아 교착이 없다). 동시 가입 둘이 같은 199 를 읽고 201 이 되지 않게.
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
-- ⑤ L3 — 조직 이름: 보이지 않는 문자 금지 강화
-- ---------------------------------------------------------------------------
-- 금지 문자 집합(앱 검증 `src/admin/**` 은 이것의 **상위집합**이어야 한다 — 앱이 받고 DB 가 거부하면 500 이 된다):
--   U+0001–U+001F, U+007F–U+009F(제어 — U+0000 은 text 에 들어올 수 없다) · U+00AD(soft hyphen) · U+061C(ALM) · U+115F·U+1160
--   (한글 채움) · U+180E(몽골 모음 구분) · U+200B–U+200F(폭 없음·방향 표시) · U+2028–U+202E(줄·문단 구분·방향 제어) ·
--   U+2060–U+206F(단어 결합·보이지 않는 연산자·방향 격리) · U+2800(점자 빈칸) · U+3164(한글 채움) · U+FE00–U+FE0F(변형 선택자) ·
--   U+FEFF(BOM) · U+FFA0(반각 한글 채움) · U+E0000–U+E007F(태그).
ALTER TABLE signup_links DROP CONSTRAINT signup_links_organization_name_check;
ALTER TABLE signup_links ADD CONSTRAINT signup_links_organization_name_check CHECK (
  length(organization_name) BETWEEN 1 AND 80
  AND btrim(organization_name) <> ''
  AND organization_name !~ '[\u0001-\u001f\u007f-\u009f­؜ᅟᅠ᠎​-‏ -‮⁠-⁯⠀ㅤ︀-️﻿ﾠ\U000e0000-\U000e007f]'
) NOT VALID;

-- 가입 조직의 이름도 같은 집합을 거부한다(운영자 조직은 CLI 가 만들므로 대상 밖). 함수가 링크의 이름을 그대로 옮기므로 겹 방어다.
ALTER TABLE organizations ADD CONSTRAINT organizations_self_signup_name_shape CHECK (
  signup_source <> 'self_signup'
  OR name !~ '[\u0001-\u001f\u007f-\u009f­؜ᅟᅠ᠎​-‏ -‮⁠-⁯⠀ㅤ︀-️﻿ﾠ\U000e0000-\U000e007f]'
) NOT VALID;

-- 기존 행이 새 집합에 걸리지 않으면 VALIDATE. 걸리면 NOT VALID 로 남기고(새 행·갱신은 검사된다) 알린다 — 마이그레이션 전체를 멈추지 않는다.
DO $$
DECLARE
  offenders integer;
BEGIN
  SELECT count(*) INTO offenders FROM signup_links
   WHERE organization_name ~ '[\u0001-\u001f\u007f-\u009f­؜ᅟᅠ᠎​-‏ -‮⁠-⁯⠀ㅤ︀-️﻿ﾠ\U000e0000-\U000e007f]';
  IF offenders = 0 THEN
    ALTER TABLE signup_links VALIDATE CONSTRAINT signup_links_organization_name_check;
  ELSE
    RAISE WARNING 'signup_links 에 금지 문자가 든 조직 이름이 % 개 있다 — CHECK 는 NOT VALID 로 남는다', offenders;
  END IF;
  SELECT count(*) INTO offenders FROM organizations
   WHERE signup_source = 'self_signup'
     AND name ~ '[\u0001-\u001f\u007f-\u009f­؜ᅟᅠ᠎​-‏ -‮⁠-⁯⠀ㅤ︀-️﻿ﾠ\U000e0000-\U000e007f]';
  IF offenders = 0 THEN
    ALTER TABLE organizations VALIDATE CONSTRAINT organizations_self_signup_name_shape;
  ELSE
    RAISE WARNING 'organizations 에 금지 문자가 든 가입 조직 이름이 % 개 있다 — CHECK 는 NOT VALID 로 남는다', offenders;
  END IF;
END
$$;
