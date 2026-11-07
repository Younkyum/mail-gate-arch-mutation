-- 202609301530_waitlist_intake.sql
-- 대기자 명단 신청서 · 초대 계측(마케팅 계획 2026-09-30 §4.1–4.2 · §6.2 "계측 선행조건" · §7 게이트 A). 1520 은 운영에 적용돼 있다 — 이 파일은 그 위에 더한다.
--
--   ① `waitlist_entries` 세 칸(모두 NULL 허용 — 1520 시절 항목은 비어 있다. 다시 묻는 메일은 보내지 않는다 · 계획 §4.2 "기존 대기자"):
--      - `use_case` — 신청서의 필수 질문(ko/en 라디오). 닫힌 값 넷: alerts(보고·알림) · replies(아는 상대에게 답장) · codes(인증코드·가입 메일 수신) ·
--        outreach(모르는 사람에게 먼저 발송). 운영 화면·CLI 가 등급 후보(A · B · 보류)를 이 칸과 메모 유무로 보인다(최종 등급은 운영자).
--      - `heard_from` — "어디서 알게 되셨나요?"(선택). 닫힌 값 일곱: directory · github · reddit · x · search · friend · other. 계획서의 `source` 다 —
--        1520 의 `source`(site|signup — 등록 경로)가 이미 있어 이름을 갈랐다.
--      - `ref` — `/waitlist?ref=` 의 허용목록 값(admin 이 거른다 — 목록 밖은 `none`): github · devto · referral · none · `recipe-<슬러그>`. 쿠키 · UTM 없음.
--      세 칸 모두 **먼저 적은 값이 남는다**(메모와 같은 규칙 — 다시 등록해도 NULL 일 때만 채운다). 트리거가 한 번 적힌 값을 바꾸지 못하게 한다.
--      모양 CHECK 는 `NOT VALID` — 기존 행 검증은 202609301531(기존 행은 전부 NULL).
--   ② `waitlist_join` — 7인자 판(`use_case` · `heard_from` · `ref`)을 새로 두고 4인자 판(가입 요청의 대기 등록 · 배포 사이의 옛 admin)은 7인자 판을
--      NULL 셋으로 부르는 얇은 껍질로 바꾼다. 바뀐 규칙: **확인 메일 재발송 주기 24시간 → 30일**(30일 안에 다시 등록하면 두 번째 확인 메일 없음) ·
--      하루 상한(`waitlist_daily_cap`)의 뜻 — 새 항목 수 → **롤링 24시간에 쌓은 확인 메일 수**(새 항목 · 다시 등록 두 길 모두 `waitlist_queue_confirmation` 이
--      센다 — 상한을 넘으면 항목은 남기고 메일만 쌓지 않는다) · 기본값 500 → 50. 열거 방지는 그대로다(무엇을 했는지 돌려주지 않는다).
--   ③ 상한 — `signup_limits.waitlist_invite_daily_cap` 200 → **5**, `waitlist_daily_cap` 500 → **50**(행 값과 기본값 둘 다 · 함수의 행 없음 대비 값도).
--      증량할 때(계획 §4.2) 운영자가 `UPDATE signup_limits SET waitlist_invite_daily_cap = 10` 한다.
--   ④ `organizations` 네 칸 — 가입 트랜잭션(`create_signup_organization`)이 대기 항목에서 **한 번** 복사한다: `signup_ref` · `signup_heard_from` ·
--      `signup_use_case` · `signup_invite_week`(초대 시각의 ISO 주 — KST, `2026-W41`). 항목 id · 주소 · 메모는 옮기지 않는다(조직 행에서 대기자를
--      다시 찾을 길을 두지 않는다). INSERT 뒤에는 바꿀 수 없다(트리거). 퍼널 코호트(계획 §6.2)의 열쇠다.
--   ⑤ `create_signup_organization` 재정의 — 202609301520 최종본 그대로 + ④ 복사(환영 메일 INSERT · 대기 항목 닫기 포함 전부 그대로).
--   ⑥ `agent_api_keys.first_used_at` — 토큰이 **처음** 쓰인 분(=`last_used_at` 이 NULL 에서 값이 되는 순간의 그 값). 트리거가 한 번만 적는다 — 앱 롤에
--      칸 권한을 주지 않는다(인증 경로의 `touch()` 가 `last_used_at` 만 바꾸면 따라 적힌다). 이미 쓰인 옛 토큰은 NULL 로 남는다(소급하지 않는다 —
--      "첫 MCP 호출" 은 이 파일 뒤에 처음 쓰인 토큰부터 센다). 직접 쓰는 UPDATE 는 불변 트리거(`agent_api_keys_immutable_core`)가 막는다 — 적는
--      트리거는 이름 순서상 그 뒤에 돈다(`…_immutable_core` < `…_stamp_first_used_at`).
--      위조 불가 — INSERT 는 값을 버리고 NULL 로 만들고(`…_force_first_used_null`), 적는 값은 `least(last_used_at, now())` 이며, 한 번 적힌 뒤에는 다시 적지 않는다.
--   ⑦ 권한 — 로그인 메일 롤: `waitlist_entries.use_case` 읽기(확인 메일의 보류 조건부 문단). atmark_ops: 세 칸 읽기(운영 화면). admin: 7인자
--      `waitlist_join` EXECUTE(같은 이름 — 권한 목록은 이름으로 센다). 앱 롤: 0.

SET LOCAL lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- ① waitlist_entries — 신청서 세 칸
-- ---------------------------------------------------------------------------

ALTER TABLE waitlist_entries
  ADD COLUMN use_case text,
  ADD COLUMN heard_from text,
  ADD COLUMN ref text;
ALTER TABLE waitlist_entries ADD CONSTRAINT waitlist_entries_use_case_check
  CHECK (use_case IS NULL OR use_case IN ('alerts', 'replies', 'codes', 'outreach')) NOT VALID;
ALTER TABLE waitlist_entries ADD CONSTRAINT waitlist_entries_heard_from_check
  CHECK (heard_from IS NULL OR heard_from IN ('directory', 'github', 'reddit', 'x', 'search', 'friend', 'other')) NOT VALID;
ALTER TABLE waitlist_entries ADD CONSTRAINT waitlist_entries_ref_check
  CHECK (ref IS NULL OR ref IN ('github', 'devto', 'referral', 'none') OR ref ~ '^recipe-[a-z0-9-]{1,40}$') NOT VALID;

COMMENT ON COLUMN waitlist_entries.use_case IS
  '신청서의 용도(202609301530): alerts · replies · codes · outreach. 먼저 적은 값이 남는다. NULL = 1520 시절 항목 또는 가입 요청으로 올라온 항목.';
COMMENT ON COLUMN waitlist_entries.heard_from IS
  '"어디서 알게 되셨나요?"(선택, 202609301530): directory · github · reddit · x · search · friend · other. 계획서의 source. 먼저 적은 값이 남는다.';
COMMENT ON COLUMN waitlist_entries.ref IS
  '/waitlist?ref= 의 허용목록 값(202609301530): github · devto · referral · none · recipe-<slug>. 목록 밖은 admin 이 none 으로 적는다. 먼저 적은 값이 남는다.';

-- 정체성 칸 불변 트리거에 세 칸을 더한다(1520 목록 그대로 + use_case · heard_from · ref). 값을 바꾸는 규칙은 아래 트리거가 따로 본다.
DROP TRIGGER waitlist_entries_immutable_core ON waitlist_entries;
CREATE TRIGGER waitlist_entries_immutable_core
  BEFORE UPDATE ON waitlist_entries
  FOR EACH ROW EXECUTE FUNCTION reject_column_update_except(
    'email', 'lang', 'note', 'status', 'invited_at', 'invite_expires_at', 'joined_at', 'invited_by', 'last_confirmation_sent_at',
    'use_case', 'heard_from', 'ref');

-- 신청서 세 칸은 한 번만 적힌다(NULL → 값). 먼저 적은 사람의 답이 남는다 — 남의 주소로 다시 등록해 등급 후보를 바꾸지 못하게.
CREATE FUNCTION waitlist_entries_intake_once() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF (OLD.use_case IS NOT NULL AND NEW.use_case IS DISTINCT FROM OLD.use_case)
     OR (OLD.heard_from IS NOT NULL AND NEW.heard_from IS DISTINCT FROM OLD.heard_from)
     OR (OLD.ref IS NOT NULL AND NEW.ref IS DISTINCT FROM OLD.ref) THEN
    RAISE EXCEPTION 'waitlist_entries % intake answers are write-once', OLD.id USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION waitlist_entries_intake_once() FROM PUBLIC;

CREATE TRIGGER waitlist_entries_intake_once
  BEFORE UPDATE ON waitlist_entries
  FOR EACH ROW EXECUTE FUNCTION waitlist_entries_intake_once();

-- ---------------------------------------------------------------------------
-- ② waitlist_join — 7인자 판 · 4인자 껍질 · 확인 메일 30일
-- ---------------------------------------------------------------------------

-- 확인 메일을 쌓는 **하나뿐인 문**(1520 본문 + 전역 하루 상한). 롤링 24시간에 쌓은 확인 메일(`waitlist_mails` kind = 'confirmation')이 상한
--   (`signup_limits.waitlist_daily_cap`, 행 없음 → 50) 이상이면 아무것도 하지 않는다 — 메일도 쌓지 않고 `last_confirmation_sent_at` 도 적지 않는다(다음
--   등록이 다시 시도한다). 새 항목 길과 다시 등록 길이 모두 여기를 지나므로 한 주소가 30일 주기로 상한을 우회하지 못한다. 세는 동안 전역 잠금으로 줄을 세운다
--   (주소 잠금 → 이 잠금 순서 — 다른 함수는 이 잠금을 쥔 채 주소 잠금을 잡지 않는다).
CREATE OR REPLACE FUNCTION waitlist_queue_confirmation(p_entry public.waitlist_entries) RETURNS void
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_cap  integer;
  v_used integer;
BEGIN
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('waitlist_confirmation_global', 0));
  SELECT l.waitlist_daily_cap INTO v_cap FROM public.signup_limits l WHERE l.id;
  SELECT count(*) INTO v_used FROM public.waitlist_mails WHERE kind = 'confirmation' AND created_at > now() - interval '24 hours';
  IF v_used >= coalesce(v_cap, 50) THEN
    RETURN;
  END IF;
  INSERT INTO public.waitlist_mails (entry_id, kind, lang) VALUES (p_entry.id, 'confirmation', p_entry.lang);
  UPDATE public.waitlist_entries SET last_confirmation_sent_at = now() WHERE id = p_entry.id;
END;
$$;
REVOKE ALL ON FUNCTION waitlist_queue_confirmation(public.waitlist_entries) FROM PUBLIC;

-- 1520 본문 그대로 + 바뀐 곳: ⓐ 신청서 세 칸(새 항목은 INSERT 에, 기존 항목은 NULL 일 때만) ⓑ 재발송 24시간 → 30일 ⓒ 새 항목 상한 기본값 500 → 50.
CREATE FUNCTION waitlist_join(p_email text, p_lang text, p_note text, p_source text, p_use_case text, p_heard_from text, p_ref text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_entry public.waitlist_entries%ROWTYPE;
  v_lang  text := CASE WHEN p_lang = 'en' THEN 'en' ELSE 'ko' END;
  v_note  text := nullif(btrim(coalesce(p_note, '')), '');
BEGIN
  IF p_email IS NULL OR p_source IS NULL OR p_source NOT IN ('site', 'signup')
     OR (p_use_case IS NOT NULL AND p_use_case NOT IN ('alerts', 'replies', 'codes', 'outreach'))
     OR (p_heard_from IS NOT NULL AND p_heard_from NOT IN ('directory', 'github', 'reddit', 'x', 'search', 'friend', 'other'))
     OR (p_ref IS NOT NULL AND p_ref NOT IN ('github', 'devto', 'referral', 'none') AND p_ref !~ '^recipe-[a-z0-9-]{1,40}$') THEN
    RAISE EXCEPTION 'waitlist_join: invalid input' USING ERRCODE = '22023';
  END IF;
  -- 같은 주소의 등록·가입 확정이 줄을 선다(가입 확정 `create_signup_organization` 은 항목 행을 잠근다).
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('waitlist_email:' || p_email, 0));
  -- 이미 가입한 사람(살아 있는 멤버십) — 대기 명단에 올리지 않는다(로그인하면 된다).
  IF EXISTS (SELECT 1 FROM public.users u JOIN public.memberships m ON m.user_id = u.id AND m.removed_at IS NULL WHERE u.email = p_email) THEN
    RETURN;
  END IF;
  SELECT * INTO v_entry FROM public.waitlist_entries WHERE email = p_email FOR UPDATE;
  IF NOT FOUND THEN
    INSERT INTO public.waitlist_entries (email, lang, note, source, use_case, heard_from, ref)
    VALUES (p_email, v_lang, v_note, p_source, p_use_case, p_heard_from, p_ref)
    RETURNING * INTO v_entry;
    -- 확인 메일 하루 상한은 `waitlist_queue_confirmation` 이 본다(다시 등록하는 길과 같은 문) — 넘으면 항목은 남기고 메일만 쌓지 않는다(응답은 같다).
    PERFORM public.waitlist_queue_confirmation(v_entry);
    RETURN;
  END IF;
  -- 살아 있는 초대 — 가입 화면에서 바로 가입하면 된다(메일을 더 보내지 않는다).
  IF v_entry.status = 'invited' AND v_entry.invite_expires_at > now() THEN
    RETURN;
  END IF;
  -- 초대가 끝났는데 다시 등록했다 — 대기로 되돌린다(등록 시각(순서)은 처음 그대로).
  IF v_entry.status = 'invited' THEN
    UPDATE public.waitlist_entries SET status = 'waiting', invited_at = NULL, invite_expires_at = NULL, invited_by = NULL WHERE id = v_entry.id;
  END IF;
  -- 대기 중 — 비어 있는 칸만 채운다(먼저 적은 메모·답이 남는다 — 본인 확인이 없는 문자열이라 운영 화면은 "본인 확인 안 됨" 으로 보인다).
  IF (v_entry.note IS NULL AND v_note IS NOT NULL)
     OR (v_entry.use_case IS NULL AND p_use_case IS NOT NULL)
     OR (v_entry.heard_from IS NULL AND p_heard_from IS NOT NULL)
     OR (v_entry.ref IS NULL AND p_ref IS NOT NULL) THEN
    UPDATE public.waitlist_entries
       SET note = coalesce(note, v_note),
           use_case = coalesce(use_case, p_use_case),
           heard_from = coalesce(heard_from, p_heard_from),
           ref = coalesce(ref, p_ref)
     WHERE id = v_entry.id;
  END IF;
  -- 마지막 확인 메일이 30일 전이면 한 통 더(30일 안에 다시 등록하면 두 번째 확인 메일은 없다).
  IF v_entry.last_confirmation_sent_at IS NULL OR v_entry.last_confirmation_sent_at <= now() - interval '30 days' THEN
    PERFORM public.waitlist_queue_confirmation(v_entry);
  END IF;
END;
$$;

-- 4인자 판 — 가입 요청(`requestSignup` — 초대 없는 주소를 명단에 올린다)과 배포 사이의 옛 admin 코드가 부른다. 신청서 세 칸은 비운다.
CREATE OR REPLACE FUNCTION waitlist_join(p_email text, p_lang text, p_note text, p_source text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  PERFORM public.waitlist_join(p_email, p_lang, p_note, p_source, NULL, NULL, NULL);
END;
$$;

REVOKE ALL ON FUNCTION waitlist_join(text, text, text, text, text, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION waitlist_join(text, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION waitlist_join(text, text, text, text, text, text, text) TO atmark_admin;
GRANT EXECUTE ON FUNCTION waitlist_join(text, text, text, text) TO atmark_admin;

-- ---------------------------------------------------------------------------
-- ③ 상한 — 초대 하루 5 · 새 항목 하루 50
-- ---------------------------------------------------------------------------

ALTER TABLE signup_limits ALTER COLUMN waitlist_invite_daily_cap SET DEFAULT 5;
ALTER TABLE signup_limits ALTER COLUMN waitlist_daily_cap SET DEFAULT 50;
UPDATE signup_limits SET waitlist_invite_daily_cap = 5, waitlist_daily_cap = 50 WHERE id;

COMMENT ON COLUMN signup_limits.waitlist_invite_daily_cap IS
  '롤링 24시간 전역 초대 수 상한(202609301530 — 5, 증량 조건을 채우면 10). 할당량이 아니라 최대치다(마케팅 계획 §4.2 DB 이중 잠금).';
COMMENT ON COLUMN signup_limits.waitlist_daily_cap IS
  '롤링 24시간 확인 메일 수 상한(202609301530 — 50, 새 항목 · 다시 등록 모두). 넘은 항목도 저장하되 확인 메일은 쌓지 않는다(응답은 같다).';

-- 1520 본문 그대로 + 행이 없을 때의 값 200 → 5.
CREATE OR REPLACE FUNCTION waitlist_require_invite_room(p_n integer) RETURNS void
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_used integer;
  v_cap  integer;
BEGIN
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('waitlist_invite_global', 0));
  SELECT l.waitlist_invite_daily_cap INTO v_cap FROM public.signup_limits l WHERE l.id;
  SELECT count(*) INTO v_used FROM public.waitlist_events WHERE action = 'invite' AND created_at > now() - interval '24 hours';
  IF v_used + p_n > coalesce(v_cap, 5) THEN
    RAISE EXCEPTION 'waitlist: daily invite cap' USING ERRCODE = 'AT429', DETAIL = 'invite_cap';
  END IF;
END;
$$;
REVOKE ALL ON FUNCTION waitlist_require_invite_room(integer) FROM PUBLIC;

-- ---------------------------------------------------------------------------
-- ④ organizations — 가입 때 한 번 복사하는 네 칸
-- ---------------------------------------------------------------------------

ALTER TABLE organizations
  ADD COLUMN signup_ref text,
  ADD COLUMN signup_heard_from text,
  ADD COLUMN signup_use_case text,
  ADD COLUMN signup_invite_week text;
ALTER TABLE organizations ADD CONSTRAINT organizations_signup_ref_check
  CHECK (signup_ref IS NULL OR signup_ref IN ('github', 'devto', 'referral', 'none') OR signup_ref ~ '^recipe-[a-z0-9-]{1,40}$') NOT VALID;
ALTER TABLE organizations ADD CONSTRAINT organizations_signup_heard_from_check
  CHECK (signup_heard_from IS NULL OR signup_heard_from IN ('directory', 'github', 'reddit', 'x', 'search', 'friend', 'other')) NOT VALID;
ALTER TABLE organizations ADD CONSTRAINT organizations_signup_use_case_check
  CHECK (signup_use_case IS NULL OR signup_use_case IN ('alerts', 'replies', 'codes', 'outreach')) NOT VALID;
ALTER TABLE organizations ADD CONSTRAINT organizations_signup_invite_week_check
  CHECK (signup_invite_week IS NULL OR signup_invite_week ~ '^[0-9]{4}-W(0[1-9]|[1-4][0-9]|5[0-3])$') NOT VALID;

COMMENT ON COLUMN organizations.signup_ref IS '가입한 대기 항목의 ref(202609301530 — 가입 트랜잭션이 한 번 복사, 뒤로 불변). NULL = 대기 명단을 거치지 않은 조직 · 1530 이전 가입.';
COMMENT ON COLUMN organizations.signup_heard_from IS '가입한 대기 항목의 heard_from(계획서의 source, 202609301530 — 한 번 복사, 불변).';
COMMENT ON COLUMN organizations.signup_use_case IS '가입한 대기 항목의 use_case(202609301530 — 한 번 복사, 불변).';
COMMENT ON COLUMN organizations.signup_invite_week IS '가입한 초대의 ISO 주(KST, 예 2026-W41 — 202609301530, 한 번 복사, 불변). 퍼널 코호트의 열쇠.';

-- INSERT 뒤로는 네 칸이 바뀌지 않는다(“한 번 복사”). 소유자 롤도 막는다 — 코호트가 사후에 옮겨 가지 않게.
CREATE FUNCTION organizations_signup_attribution_immutable() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF NEW.signup_ref IS DISTINCT FROM OLD.signup_ref
     OR NEW.signup_heard_from IS DISTINCT FROM OLD.signup_heard_from
     OR NEW.signup_use_case IS DISTINCT FROM OLD.signup_use_case
     OR NEW.signup_invite_week IS DISTINCT FROM OLD.signup_invite_week THEN
    RAISE EXCEPTION 'organizations % signup attribution is copied once at sign-up', OLD.id USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION organizations_signup_attribution_immutable() FROM PUBLIC;

CREATE TRIGGER organizations_signup_attribution_immutable
  BEFORE UPDATE ON organizations
  FOR EACH ROW EXECUTE FUNCTION organizations_signup_attribution_immutable();

-- ---------------------------------------------------------------------------
-- ⑤ create_signup_organization — 1520 최종본 그대로 + 대기 항목의 세 칸 · 초대 주를 조직 행에 한 번 복사
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION create_signup_organization(p_link_id uuid, p_browser_binding text, p_now timestamptz)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_now      timestamptz := greatest(coalesce(p_now, now()), now());
  v_link     public.signup_links%ROWTYPE;
  v_org      uuid;
  v_limits   public.signup_limits%ROWTYPE;
  v_daily    integer;
  v_recent   integer;
  v_entry    uuid;
  v_use_case   text;
  v_heard_from text;
  v_ref        text;
  v_invited_at timestamptz;
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
    -- 초대 전용(202609301520) — 이 주소의 살아 있는 초대. 대기 등록(`waitlist_join`)과 같은 주소 잠금 뒤에 행을 잠근다.
    PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('waitlist_email:' || v_link.email, 0));
    SELECT w.id, w.use_case, w.heard_from, w.ref, w.invited_at INTO v_entry, v_use_case, v_heard_from, v_ref, v_invited_at
      FROM public.waitlist_entries w
     WHERE w.email = v_link.email AND w.status = 'invited' AND w.invite_expires_at > v_now
       FOR UPDATE;
    IF v_entry IS NULL THEN
      RETURN NULL;
    END IF;

    PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('signup_org_create', 0));
    SELECT * INTO v_limits FROM public.signup_limits WHERE id;
    SELECT count(*) INTO v_daily FROM public.organizations o
     WHERE o.signup_source = 'self_signup' AND o.created_at > v_now - interval '24 hours'
       AND EXISTS (SELECT 1 FROM public.signup_links l WHERE l.organization_id = o.id);
    IF v_daily >= coalesce(v_limits.self_signup_daily_cap, 200) THEN
      RAISE EXCEPTION 'signup_capacity' USING ERRCODE = 'AT429', DETAIL = 'self_signup_daily_cap';
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

    -- 검토 없이 active(1520 그대로). 계측(202609301530) — 대기 항목의 ref · heard_from · use_case · 초대 ISO 주(KST)를 **이 INSERT 에서 한 번** 복사한다.
    --   항목 id · 주소 · 메모는 옮기지 않는다.
    INSERT INTO public.organizations (name, owner_email, review_status, signup_source, billing_status,
                                      signup_ref, signup_heard_from, signup_use_case, signup_invite_week)
    VALUES (v_link.organization_name, v_link.email, 'active', 'self_signup', 'trialing',
            v_ref, v_heard_from, v_use_case, pg_catalog.to_char(v_invited_at AT TIME ZONE 'Asia/Seoul', 'IYYY-"W"IW'))
    RETURNING id INTO v_org;

    -- 환영 메일(202609301510) — 새 가입만 · 사용자당 한 통. 사용자 행은 위 INSERT 의 AFTER 트리거(organizations_owner_membership)가 만들었다.
    INSERT INTO public.welcome_mails (user_id, organization_id, lang)
    SELECT u.id, v_org, coalesce(v_link.lang, 'ko') FROM public.users u WHERE u.email = v_link.email
    ON CONFLICT (user_id) DO NOTHING;

    -- 대기 항목 닫기(202609301520) — 사람을 가리키는 칸을 비운다(개인정보 처리 안내: 가입하면 대기자 항목은 지운다). 수는 통계로 남는다.
    UPDATE public.waitlist_entries SET status = 'joined', joined_at = v_now, email = NULL, note = NULL WHERE id = v_entry;
    INSERT INTO public.waitlist_events (entry_id, action, actor) VALUES (v_entry, 'join', 'signup');
  END IF;

  UPDATE public.signup_links SET used_at = v_now, organization_id = v_org WHERE id = v_link.id;
  RETURN v_org;
END;
$$;

REVOKE ALL ON FUNCTION create_signup_organization(uuid, text, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION create_signup_organization(uuid, text, timestamptz) TO atmark_admin;

-- ---------------------------------------------------------------------------
-- ⑥ agent_api_keys.first_used_at — 처음 쓰인 분, 한 번만(트리거가 적는다)
-- ---------------------------------------------------------------------------

ALTER TABLE agent_api_keys ADD COLUMN first_used_at timestamptz;

COMMENT ON COLUMN agent_api_keys.first_used_at IS
  '토큰이 처음 쓰인 분(202609301530) — last_used_at 이 NULL 에서 값이 될 때 트리거가 그 값으로 한 번 적는다. 직접 쓸 수 없다(불변 트리거). 1530 이전에 이미 쓰인 토큰은 NULL(소급 안 함).';

-- 이름 순서가 뜻이다: BEFORE 트리거는 이름 순으로 돈다 — `agent_api_keys_immutable_core`(직접 쓰기 거부)가 먼저 원래 UPDATE 를 보고, 이 트리거가
--   그 뒤에 칸을 채운다. 옛 토큰(이미 last_used_at 이 있는 행)은 건드리지 않는다 — 그 뒤의 사용은 "처음" 이 아니다.
--   위조 불가: ⓐ INSERT 는 호출자가 준 값을 버린다(아래 `…_force_first_used_null`) ⓑ 적는 값은 호출자의 `last_used_at` 이 아니라
--   `least(NEW.last_used_at, now())` — 미래 시각을 밀어 넣어도 "지금" 을 넘지 못한다 ⓒ 한 번 적힌 뒤에는 `last_used_at` 이 NULL 로 갔다 돌아와도
--   다시 적지 않는다(`OLD.first_used_at IS NOT NULL` 이면 옛 값을 그대로 돌려놓는다).
CREATE FUNCTION agent_api_keys_stamp_first_used_at() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF OLD.first_used_at IS NOT NULL THEN
    NEW.first_used_at := OLD.first_used_at;
  ELSIF OLD.last_used_at IS NULL AND NEW.last_used_at IS NOT NULL THEN
    NEW.first_used_at := least(NEW.last_used_at, now());
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION agent_api_keys_stamp_first_used_at() FROM PUBLIC;

CREATE TRIGGER agent_api_keys_stamp_first_used_at
  BEFORE UPDATE OF last_used_at ON agent_api_keys
  FOR EACH ROW EXECUTE FUNCTION agent_api_keys_stamp_first_used_at();

-- INSERT 는 `first_used_at` 을 항상 NULL 로 만든다 — 발급 경로가(또는 INSERT 권한을 쥔 누가) 미리 채워 "이미 첫 사용" 으로 위조하지 못한다.
CREATE FUNCTION agent_api_keys_force_first_used_null() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  NEW.first_used_at := NULL;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION agent_api_keys_force_first_used_null() FROM PUBLIC;

CREATE TRIGGER agent_api_keys_force_first_used_null
  BEFORE INSERT ON agent_api_keys
  FOR EACH ROW EXECUTE FUNCTION agent_api_keys_force_first_used_null();

-- ---------------------------------------------------------------------------
-- ⑦ 권한
-- ---------------------------------------------------------------------------

-- 로그인 메일 롤 — 확인 메일의 보류 조건부 문단(use_case = outreach)을 고르는 칸 하나(메모·출처·ref 는 읽지 않는다).
GRANT SELECT (use_case) ON waitlist_entries TO atmark_login_mailer;
-- atmark_ops — 운영 화면의 읽기 칸(src/ops/console/reads.ts `readWaitlist`).
GRANT SELECT (use_case, heard_from, ref) ON waitlist_entries TO atmark_ops;
