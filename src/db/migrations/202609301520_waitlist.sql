-- 202609301520_waitlist.sql
-- 대기자 명단 · 초대 전용 가입(진윤겸 2026-09-30 결정 — 모든 에이전트가 atmark.ai 도메인을 함께 쓰므로 남용자 한 명이 모두의 도달률을 깎는다).
--
--   ① `waitlist_entries` — 대기자 한 사람 한 행. 모으는 개인 정보는 **이메일과 한 줄 메모뿐**이다(개인정보 처리 안내 — src/site/privacy.ts).
--      `lang`(ko|en)·`source`(site|signup)는 사람을 가리키지 않는 운영 칸이다. 상태는 `waiting` → `invited`(초대 14일 — 약관) → `joined`.
--      **지우기(운영자 remove · 삭제 요청)는 행을 지운다**(주소·메모가 남지 않는다 — 상태 `removed` 는 두지 않았다). 가입하면(`joined`) 주소·메모를
--      NULL 로 비우고 행만 남긴다(초대·가입 수 통계 — 사람을 가리키는 칸 0). 초대받고 가입하지 않은 행은 만료 30일 뒤 보존 과제가 지운다(⑥).
--   ② `waitlist_events` — 운영 행위 감사(초대 · 지우기 · 가입). 항목 id·행위·행위자·시각만(주소·메모 없음). append-only.
--   ③ `waitlist_mails` — 대기 확인 · 초대 메일 outbox. 수신자·본문 칸이 없다: 수신자는 보내는 순간 `waitlist_entries.email` 에서 읽고(행이 지워졌거나
--      비었으면 obsolete), 본문은 상수 템플릿(`src/notify/waitlist-template.ts`). 항목을 지워도 메일 행이 남도록 FK 를 두지 않는다(행에 개인 정보 없음).
--      종단 동결 · 정체성 칸 불변 · DELETE·TRUNCATE 거부(환영 메일 `welcome_mails` 와 같은 규율).
--   ④ 함수
--      - `waitlist_join(email, lang, note, source)` — SECURITY DEFINER, admin 롤. 대기 등록(멱등): 이미 멤버인 주소 · 살아 있는 초대 · 가입 끝남 →
--        아무것도 하지 않는다. 새 행이거나 마지막 확인 메일이 24시간 전이면 확인 메일 한 통을 쌓는다. 무엇을 했는지 돌려주지 않는다(열거 방지).
--      - `waitlist_invite_live(email)` — SECURITY DEFINER, admin 롤. 가입 요청이 가입 링크를 적을지(초대가 살아 있나)의 참/거짓 하나.
--      - 소유자 코어 `waitlist_invite_core` · `waitlist_invite_oldest_core` · `waitlist_remove_core` — CLI(`pnpm admin:waitlist`)·로컬 운영 화면
--        (소유자 롤)과 호스팅 정의 함수가 같은 코어를 부른다. 초대는 전역 하루 상한(`signup_limits.waitlist_invite_daily_cap`, 기본 200) · 한 번에 50
--        (도달률 — 초대한 만큼 새 발신 조직이 생긴다), 지우기는 전역 하루 상한(`waitlist_remove_daily_cap`, 기본 200).
--      - 호스팅 정의 함수 `ops_waitlist_invite` · `ops_waitlist_invite_oldest` · `ops_waitlist_remove` — atmark_ops. 콘솔 열림 → 세션 → 코어
--        (행위자 `ops:<운영자 uuid>`). step-up 은 없다(되돌릴 수 있는 방향 — 초대는 받은 사람이 가입해야 효과가 있고, 지운 사람은 다시 등록할 수 있다).
--   ⑤ `create_signup_organization` 재정의(202609301510 최종본 기준) — 새 조직 갈래가 **살아 있는 초대**를 요구하고(없으면 NULL — 링크 미소진),
--      조직을 `active`(Free — 요금제 행 없음 · 베타 부여 없음 · reviewed_at NULL)로 만들고, 대기 항목을 `joined`(주소·메모 비움)로 닫는다. 환영 메일
--      INSERT 는 1510 그대로. 검토 대기 총수 상한(`pending_review_cap`) → 롤링 24시간 새 셀프 가입 조직 수(`self_signup_daily_cap`, 기본 200 — 안전망).
--      `create_member_organization`(콘솔 "새 조직" — 이미 가입한 사용자)도 `active` · 같은 24시간 상한.
--   ⑥ 보존 — `purge_expired_signup_links()`(TTL 스위퍼 하루 창, 앱 롤) 재정의: 가입 링크 보존 그대로 + 초대 만료 30일이 지난 `invited` 항목 · 이미
--      멤버가 된 주소의 대기 항목을 지운다. 반환은 지운 행의 합.
--   ⑥-2 `ops_actions.action` · `ops_record_failure` 행위 허용 목록에 대기자 명단 셋(호스팅 실패 기록 — 보안 검토 L).
--   보안 검토(2026-09-30) 반영: 콘솔 새 조직은 이미 active · 미동결 조직의 owner 일 때만 active(아니면 pending_review) · 거절·동결 조직의 owner 는 거부 ·
--   전용 하루 상한(`member_org_daily_cap` 20). 새 대기 항목 하루 상한(`waitlist_daily_cap` 500 — 넘으면 저장만, 확인 메일 없음). 끝난 초대로 다시
--   등록하면 `waiting` 으로 되돌린다.
--   ⑦ 베타 스위치 SQL 짝 `ops_activation_beta_enabled()` → false(TS `BETA_ON_ACTIVATION = false` 와 함께 — 운영자 활성화도 요금제를 주지 않는다).
--   ⑧ 권한 — admin: `waitlist_join` · `waitlist_invite_live` EXECUTE 둘(표 권한 0). 로그인 메일 롤: `waitlist_mails` 발송 칸 + `waitlist_entries`
--      (id, email, status, invite_expires_at) 읽기. atmark_ops: 두 표 읽기 칸 + 정의 함수 셋. 앱 롤: 0(보존은 함수 하나로만).
--
-- 기존 `pending_review` 조직은 건드리지 않는다(운영자가 따로 처리한다).

SET LOCAL lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- ① waitlist_entries
-- ---------------------------------------------------------------------------

CREATE TABLE waitlist_entries (
  id                         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- 정규화한 주소(trim + 소문자) — `signup_links.email` 과 **같은 모양**(초대받은 주소가 그대로 가입 링크가 된다). 가입하면 NULL(아래 모양 CHECK).
  email                      text UNIQUE CHECK (
                               email IS NULL OR (
                                 length(email) BETWEEN 6 AND 254
                                 AND email = lower(email)
                                 AND email ~ '^[a-z0-9._%+-]{1,64}@[a-z0-9-]+(\.[a-z0-9-]+)+$'
                                 AND split_part(email, '@', 2) !~ '(^|\.)atmark\.ai$')),
  lang                       text NOT NULL CHECK (lang IN ('ko', 'en')),
  -- 한 줄 메모("에이전트로 무엇을 하실 건가요?") — 사용자 내용. 1~200자 · 앞뒤 공백 없음 · 제어·양방향·폭 없는 문자 없음(운영 화면은 textContent 로만 그린다).
  note                       text CHECK (
                               note IS NULL OR (
                                 char_length(note) BETWEEN 1 AND 200
                                 AND note = btrim(note)
                                 AND note !~ '[\u0001-\u001f\u007f-\u009f­​-‏ -‮⁠-⁯﻿]')),
  source                     text NOT NULL CHECK (source IN ('site', 'signup')),
  status                     text NOT NULL DEFAULT 'waiting' CHECK (status IN ('waiting', 'invited', 'joined')),
  created_at                 timestamptz NOT NULL DEFAULT now(),
  invited_at                 timestamptz,
  invite_expires_at          timestamptz,
  joined_at                  timestamptz,
  -- 마지막으로 초대한 행위자(`admin:waitlist:<운영자>` · `admin:web:<운영자>` · `ops:<uuid>`) — 운영자 이름이지 대기자가 아니다.
  invited_by                 text CHECK (invited_by IS NULL OR (length(invited_by) BETWEEN 1 AND 160 AND invited_by !~ '[\u0000-\u001f\u007f]')),
  -- 가입·대기 요청이 마지막으로 확인 메일을 **쌓은** 시각(24시간에 한 통).
  last_confirmation_sent_at  timestamptz,
  -- 가입한 행에는 사람을 가리키는 칸이 없다(개인정보 처리 안내 — "가입하면 대기자 항목은 지웁니다").
  CONSTRAINT waitlist_entries_joined_shape CHECK ((status = 'joined') = (joined_at IS NOT NULL) AND (status = 'joined') = (email IS NULL)),
  CONSTRAINT waitlist_entries_joined_note CHECK (status <> 'joined' OR note IS NULL),
  CONSTRAINT waitlist_entries_invite_shape CHECK (
    (invited_at IS NULL) = (invite_expires_at IS NULL)
    AND (invited_at IS NULL) = (invited_by IS NULL)
    AND (status = 'waiting') = (invited_at IS NULL)
    AND (invite_expires_at IS NULL OR invite_expires_at = invited_at + interval '14 days'))
);

CREATE INDEX waitlist_entries_status_created_idx ON waitlist_entries (status, created_at, id);
CREATE INDEX waitlist_entries_invite_expiry_idx ON waitlist_entries (invite_expires_at) WHERE status = 'invited';

-- 정체성 칸(id · created_at · source)은 바뀌지 않는다.
CREATE TRIGGER waitlist_entries_immutable_core
  BEFORE UPDATE ON waitlist_entries
  FOR EACH ROW EXECUTE FUNCTION reject_column_update_except(
    'email', 'lang', 'note', 'status', 'invited_at', 'invite_expires_at', 'joined_at', 'invited_by', 'last_confirmation_sent_at');
CREATE TRIGGER waitlist_entries_no_truncate
  AFTER TRUNCATE ON waitlist_entries
  FOR EACH STATEMENT EXECUTE FUNCTION reject_truncate();

COMMENT ON TABLE waitlist_entries IS
  '대기자 명단(202609301520). 개인 정보 = email · note 뿐. 지우기 = 행 DELETE(소유자 코어만) · 가입 = joined(email·note NULL) · 초대 만료 30일 = 보존 과제가 DELETE. admin 은 정의 함수 둘만, ops 는 읽기 칸만.';

-- ---------------------------------------------------------------------------
-- ② waitlist_events — 운영 행위 감사
-- ---------------------------------------------------------------------------

CREATE TABLE waitlist_events (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  -- 항목 id(FK 없음 — 지운 항목의 기록도 남는다. 주소·메모는 싣지 않는다).
  entry_id    uuid NOT NULL,
  action      text NOT NULL CHECK (action IN ('invite', 'remove', 'join')),
  actor       text NOT NULL CHECK (length(actor) BETWEEN 1 AND 160 AND actor !~ '[\u0000-\u001f\u007f]'),
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX waitlist_events_action_created_idx ON waitlist_events (action, created_at);
CREATE INDEX waitlist_events_created_idx ON waitlist_events (created_at);

CREATE TRIGGER waitlist_events_no_update
  BEFORE UPDATE ON waitlist_events
  FOR EACH ROW EXECUTE FUNCTION reject_row_update();
CREATE TRIGGER waitlist_events_no_delete
  BEFORE DELETE ON waitlist_events
  FOR EACH ROW EXECUTE FUNCTION reject_row_delete();
CREATE TRIGGER waitlist_events_no_truncate
  AFTER TRUNCATE ON waitlist_events
  FOR EACH STATEMENT EXECUTE FUNCTION reject_truncate();

COMMENT ON TABLE waitlist_events IS
  '대기자 명단 운영 감사(202609301520) — invite · remove · join. 항목 id · 행위자 · 시각뿐(개인 정보 없음). append-only.';

-- ---------------------------------------------------------------------------
-- ③ waitlist_mails — 확인 · 초대 메일 outbox
-- ---------------------------------------------------------------------------

CREATE TABLE waitlist_mails (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- 수신 항목(FK 없음 — 항목을 지워도 이 행은 남고, 보내는 순간 항목이 없으면 obsolete).
  entry_id           uuid NOT NULL,
  kind               text NOT NULL CHECK (kind IN ('confirmation', 'invitation')),
  lang               text NOT NULL CHECK (lang IN ('ko', 'en')),
  -- 초대 메일만 — 쌓을 때의 초대 만료. 보내는 순간 항목의 만료와 다르면(다시 초대) · 지났으면 obsolete.
  invite_expires_at  timestamptz,
  status             text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'dead', 'undeliverable', 'obsolete')),
  attempt_count      integer NOT NULL DEFAULT 0 CHECK (attempt_count BETWEEN 0 AND 20),
  next_attempt_at    timestamptz NOT NULL DEFAULT now(),
  claimed_at         timestamptz,
  sent_at            timestamptz,
  settled_at         timestamptz,
  ses_message_id     text CHECK (ses_message_id IS NULL OR ses_message_id ~ '^[A-Za-z0-9][A-Za-z0-9._=-]{0,254}$'),
  -- 사유 **코드**만(주소·본문 금지).
  last_error         text CHECK (last_error IS NULL OR last_error ~ '^[a-z_]{1,40}$'),
  created_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT waitlist_mails_invite_shape CHECK ((kind = 'invitation') = (invite_expires_at IS NOT NULL)),
  CONSTRAINT waitlist_mails_sent_shape CHECK ((status = 'sent') = (sent_at IS NOT NULL AND ses_message_id IS NOT NULL)),
  CONSTRAINT waitlist_mails_settled_shape CHECK ((status IN ('dead', 'undeliverable', 'obsolete')) = (settled_at IS NOT NULL))
);

CREATE INDEX waitlist_mails_due_idx ON waitlist_mails (next_attempt_at) WHERE status = 'pending';
CREATE INDEX waitlist_mails_claimed_idx ON waitlist_mails (claimed_at) WHERE claimed_at IS NOT NULL;
CREATE INDEX waitlist_mails_entry_idx ON waitlist_mails (entry_id);

CREATE TRIGGER waitlist_mails_immutable_core
  BEFORE UPDATE ON waitlist_mails
  FOR EACH ROW EXECUTE FUNCTION reject_column_update_except(
    'status', 'attempt_count', 'next_attempt_at', 'claimed_at', 'sent_at', 'settled_at', 'ses_message_id', 'last_error');

CREATE FUNCTION waitlist_mails_terminal_frozen() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF OLD.status <> 'pending' THEN
    RAISE EXCEPTION 'waitlist_mails % is terminal (%)', OLD.id, OLD.status USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER waitlist_mails_terminal_frozen
  BEFORE UPDATE ON waitlist_mails
  FOR EACH ROW EXECUTE FUNCTION waitlist_mails_terminal_frozen();
CREATE TRIGGER waitlist_mails_no_delete
  BEFORE DELETE ON waitlist_mails
  FOR EACH ROW EXECUTE FUNCTION reject_row_delete();
CREATE TRIGGER waitlist_mails_no_truncate
  AFTER TRUNCATE ON waitlist_mails
  FOR EACH STATEMENT EXECUTE FUNCTION reject_truncate();

COMMENT ON TABLE waitlist_mails IS
  '대기 확인 · 초대 메일 outbox(202609301520). 수신자는 보내는 순간 waitlist_entries.email. INSERT 는 소유자 함수만. 발송은 login-mailer(발송 칸). 앱·admin 롤 권한 0.';

-- ---------------------------------------------------------------------------
-- ④ 함수
-- ---------------------------------------------------------------------------

-- 운영 상한(소유자만 — `signup_limits` 한 행, 코드 배포 없이 조정). 초대 = 롤링 24시간 전역 초대 수(초대한 만큼 새 발신 조직이 생긴다 — 도달률),
--   지우기 = 롤링 24시간 전역 지우기 수(세션 하나가 명단을 통째로 지우지 못하게). 행이 없으면 함수가 기본값(200)을 쓴다.
--   새 대기 항목 = 롤링 24시간 전역 새 항목 수(기본 500) — 넘은 항목도 **조용히 저장**하되 확인 메일은 쌓지 않는다(응답은 같다 — 새는 것이 없다).
--   남이 아무 주소나 적어 onve@ 로 메일을 보내게 하는 길의 총량 바닥(보안 검토 M — 요청자 상한 · 확인 메일 전용 시간당 예산과 함께).
ALTER TABLE signup_limits
  ADD COLUMN waitlist_invite_daily_cap integer NOT NULL DEFAULT 200 CHECK (waitlist_invite_daily_cap >= 0),
  ADD COLUMN waitlist_remove_daily_cap integer NOT NULL DEFAULT 200 CHECK (waitlist_remove_daily_cap >= 0),
  ADD COLUMN waitlist_daily_cap integer NOT NULL DEFAULT 500 CHECK (waitlist_daily_cap >= 0);

-- 내부 — 확인 메일 한 통을 쌓고 시각을 적는다(호출자가 항목 행을 잠갔다).
CREATE FUNCTION waitlist_queue_confirmation(p_entry public.waitlist_entries) RETURNS void
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  INSERT INTO public.waitlist_mails (entry_id, kind, lang) VALUES (p_entry.id, 'confirmation', p_entry.lang);
  UPDATE public.waitlist_entries SET last_confirmation_sent_at = now() WHERE id = p_entry.id;
END;
$$;
REVOKE ALL ON FUNCTION waitlist_queue_confirmation(public.waitlist_entries) FROM PUBLIC;

-- 대기 등록(멱등 · 열거 방지 — 무엇을 했는지 돌려주지 않는다). 주소 모양은 표 CHECK 가 한 번 더 본다(admin 이 먼저 거른다).
CREATE FUNCTION waitlist_join(p_email text, p_lang text, p_note text, p_source text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_entry public.waitlist_entries%ROWTYPE;
  v_cap   integer;
  v_new   integer;
  v_lang  text := CASE WHEN p_lang = 'en' THEN 'en' ELSE 'ko' END;
  v_note  text := nullif(btrim(coalesce(p_note, '')), '');
BEGIN
  IF p_email IS NULL OR p_source IS NULL OR p_source NOT IN ('site', 'signup') THEN
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
    INSERT INTO public.waitlist_entries (email, lang, note, source) VALUES (p_email, v_lang, v_note, p_source)
    RETURNING * INTO v_entry;
    -- 전역 하루 새 항목 상한(`waitlist_daily_cap`) — 넘으면 항목은 남기고 확인 메일만 쌓지 않는다(응답은 같다).
    SELECT l.waitlist_daily_cap INTO v_cap FROM public.signup_limits l WHERE l.id;
    SELECT count(*) INTO v_new FROM public.waitlist_entries WHERE created_at > now() - interval '24 hours';
    IF v_new <= coalesce(v_cap, 500) THEN
      PERFORM public.waitlist_queue_confirmation(v_entry);
    END IF;
    RETURN;
  END IF;
  -- 살아 있는 초대 — 가입 화면에서 바로 가입하면 된다(메일을 더 보내지 않는다).
  IF v_entry.status = 'invited' AND v_entry.invite_expires_at > now() THEN
    RETURN;
  END IF;
  -- 초대가 끝났는데 다시 등록했다 — 대기로 되돌린다(확인 메일이 약속한 대로 차례를 다시 기다린다 · 보존 과제의 "초대 만료 30일" 에서 빠진다 ·
  --   가장 오래 기다린 N 명 초대의 대상이 된다). 등록 시각(순서)은 처음 그대로다.
  IF v_entry.status = 'invited' THEN
    UPDATE public.waitlist_entries SET status = 'waiting', invited_at = NULL, invite_expires_at = NULL, invited_by = NULL WHERE id = v_entry.id;
  END IF;
  -- 대기 중 — 메모가 비어 있으면 채우고(먼저 적은 메모가 남는다 — 본인 확인이 없는 문자열이라 운영 화면은 "본인 확인 안 됨" 으로 보인다), 마지막 확인 메일이 24시간 전이면 한 통 더.
  IF v_entry.note IS NULL AND v_note IS NOT NULL THEN
    UPDATE public.waitlist_entries SET note = v_note WHERE id = v_entry.id;
  END IF;
  IF v_entry.last_confirmation_sent_at IS NULL OR v_entry.last_confirmation_sent_at <= now() - interval '24 hours' THEN
    PERFORM public.waitlist_queue_confirmation(v_entry);
  END IF;
END;
$$;

-- 가입 요청 — 이 주소의 초대가 살아 있나(참/거짓 하나).
CREATE FUNCTION waitlist_invite_live(p_email text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM public.waitlist_entries w
                  WHERE w.email = p_email AND w.status = 'invited' AND w.invite_expires_at > now())
$$;

-- 행위자 모양 — 비었거나 제어문자·160자 초과면 거부.
CREATE FUNCTION waitlist_require_actor(p_actor text) RETURNS void
LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF p_actor IS NULL OR btrim(p_actor) = '' OR length(p_actor) > 160 OR p_actor ~ '[\u0000-\u001f\u007f]' THEN
    RAISE EXCEPTION 'waitlist: actor is required' USING ERRCODE = '22023';
  END IF;
END;
$$;

-- 내부 — 한 항목 초대(호출자가 행을 잠갔고 상한을 봤다). 초대 14일 · 초대 메일 한 통 · 감사 한 행.
CREATE FUNCTION waitlist_invite_one(p_entry uuid, p_actor text) RETURNS timestamptz
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_now     timestamptz := now();
  v_expires timestamptz := now() + interval '14 days';
  v_lang    text;
BEGIN
  UPDATE public.waitlist_entries
     SET status = 'invited', invited_at = v_now, invite_expires_at = v_expires, invited_by = p_actor
   WHERE id = p_entry
  RETURNING lang INTO v_lang;
  INSERT INTO public.waitlist_mails (entry_id, kind, lang, invite_expires_at) VALUES (p_entry, 'invitation', v_lang, v_expires);
  INSERT INTO public.waitlist_events (entry_id, action, actor) VALUES (p_entry, 'invite', p_actor);
  RETURN v_expires;
END;
$$;

-- 내부 — 전역 하루 초대 상한(`signup_limits.waitlist_invite_daily_cap`, 기본 200). 이번에 `p_n` 명을 더 초대할 수 있나. 전역 잠금 아래에서 센다.
CREATE FUNCTION waitlist_require_invite_room(p_n integer) RETURNS void
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_used integer;
  v_cap  integer;
BEGIN
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('waitlist_invite_global', 0));
  SELECT l.waitlist_invite_daily_cap INTO v_cap FROM public.signup_limits l WHERE l.id;
  SELECT count(*) INTO v_used FROM public.waitlist_events WHERE action = 'invite' AND created_at > now() - interval '24 hours';
  IF v_used + p_n > coalesce(v_cap, 200) THEN
    RAISE EXCEPTION 'waitlist: daily invite cap' USING ERRCODE = 'AT429', DETAIL = 'invite_cap';
  END IF;
END;
$$;

-- 소유자 코어 — 한 항목 초대(대기 · 초대 만료 · 살아 있는 초대 = 다시 보냄, 새 14일). 가입 끝난 항목은 409.
CREATE FUNCTION waitlist_invite_core(p_entry uuid, p_actor text)
RETURNS TABLE(entry_id uuid, from_status text, invite_expires_at timestamptz)
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_from text;
BEGIN
  PERFORM public.waitlist_require_actor(p_actor);
  PERFORM public.waitlist_require_invite_room(1);
  SELECT w.status INTO v_from FROM public.waitlist_entries w WHERE w.id = p_entry FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'waitlist entry not found' USING ERRCODE = 'AT404', DETAIL = 'entry_not_found';
  END IF;
  IF v_from = 'joined' THEN
    RAISE EXCEPTION 'waitlist entry already joined' USING ERRCODE = 'AT409', DETAIL = 'already_joined';
  END IF;
  RETURN QUERY SELECT p_entry, v_from, public.waitlist_invite_one(p_entry, p_actor);
END;
$$;

-- 소유자 코어 — 가장 오래 기다린 `waiting` N 명(1~50) 초대. 남은 하루 상한보다 많으면 아무도 초대하지 않는다(429).
CREATE FUNCTION waitlist_invite_oldest_core(p_n integer, p_actor text)
RETURNS TABLE(entry_id uuid, invite_expires_at timestamptz)
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_id uuid;
BEGIN
  PERFORM public.waitlist_require_actor(p_actor);
  IF p_n IS NULL OR p_n < 1 OR p_n > 50 THEN
    RAISE EXCEPTION 'waitlist: count must be 1..50' USING ERRCODE = '22023', DETAIL = 'invalid_count';
  END IF;
  PERFORM public.waitlist_require_invite_room(p_n);
  FOR v_id IN
    SELECT w.id FROM public.waitlist_entries w WHERE w.status = 'waiting' ORDER BY w.created_at, w.id LIMIT p_n FOR UPDATE SKIP LOCKED
  LOOP
    RETURN QUERY SELECT v_id, public.waitlist_invite_one(v_id, p_actor);
  END LOOP;
END;
$$;

-- 소유자 코어 — 항목 지우기(= 행 DELETE — 주소·메모가 남지 않는다). 쌓인 메일은 obsolete. 전역 하루 상한(기본 200). 가입 끝난 항목(개인 정보 없음)은 409.
CREATE FUNCTION waitlist_remove_core(p_entry uuid, p_actor text) RETURNS text
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_from text;
  v_used integer;
  v_cap  integer;
BEGIN
  PERFORM public.waitlist_require_actor(p_actor);
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('waitlist_remove_global', 0));
  SELECT l.waitlist_remove_daily_cap INTO v_cap FROM public.signup_limits l WHERE l.id;
  SELECT count(*) INTO v_used FROM public.waitlist_events WHERE action = 'remove' AND created_at > now() - interval '24 hours';
  IF v_used >= coalesce(v_cap, 200) THEN
    RAISE EXCEPTION 'waitlist: daily remove cap' USING ERRCODE = 'AT429', DETAIL = 'remove_cap';
  END IF;
  SELECT w.status INTO v_from FROM public.waitlist_entries w WHERE w.id = p_entry FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'waitlist entry not found' USING ERRCODE = 'AT404', DETAIL = 'entry_not_found';
  END IF;
  IF v_from = 'joined' THEN
    RAISE EXCEPTION 'waitlist entry already joined' USING ERRCODE = 'AT409', DETAIL = 'already_joined';
  END IF;
  UPDATE public.waitlist_mails SET status = 'obsolete', settled_at = now(), last_error = 'entry_removed'
   WHERE entry_id = p_entry AND status = 'pending';
  DELETE FROM public.waitlist_entries WHERE id = p_entry;
  INSERT INTO public.waitlist_events (entry_id, action, actor) VALUES (p_entry, 'remove', p_actor);
  RETURN v_from;
END;
$$;

-- 호스팅 정의 함수(atmark_ops) — 콘솔 열림 → 세션 → 코어. 행위자 `ops:<운영자 uuid>`.
CREATE FUNCTION ops_waitlist_invite(p_session_hash text, p_entry uuid)
RETURNS TABLE(entry_id uuid, from_status text, invite_expires_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_session public.ops_sessions%ROWTYPE;
BEGIN
  PERFORM public.ops_require_console_open();
  v_session := public.ops_session_resolve(p_session_hash, true);
  RETURN QUERY SELECT * FROM public.waitlist_invite_core(p_entry, 'ops:' || v_session.operator_id::text);
END;
$$;

CREATE FUNCTION ops_waitlist_invite_oldest(p_session_hash text, p_n integer)
RETURNS TABLE(entry_id uuid, invite_expires_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_session public.ops_sessions%ROWTYPE;
BEGIN
  PERFORM public.ops_require_console_open();
  v_session := public.ops_session_resolve(p_session_hash, true);
  RETURN QUERY SELECT * FROM public.waitlist_invite_oldest_core(p_n, 'ops:' || v_session.operator_id::text);
END;
$$;

CREATE FUNCTION ops_waitlist_remove(p_session_hash text, p_entry uuid) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_session public.ops_sessions%ROWTYPE;
BEGIN
  PERFORM public.ops_require_console_open();
  v_session := public.ops_session_resolve(p_session_hash, true);
  RETURN public.waitlist_remove_core(p_entry, 'ops:' || v_session.operator_id::text);
END;
$$;

REVOKE ALL ON FUNCTION waitlist_join(text, text, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION waitlist_invite_live(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION waitlist_require_actor(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION waitlist_invite_one(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION waitlist_require_invite_room(integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION waitlist_invite_core(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION waitlist_invite_oldest_core(integer, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION waitlist_remove_core(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION ops_waitlist_invite(text, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION ops_waitlist_invite_oldest(text, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION ops_waitlist_remove(text, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION waitlist_mails_terminal_frozen() FROM PUBLIC;

-- ---------------------------------------------------------------------------
-- ⑤ create_signup_organization · create_member_organization — 초대 전용 · active(Free)
-- ---------------------------------------------------------------------------

ALTER TABLE signup_limits ADD COLUMN self_signup_daily_cap integer NOT NULL DEFAULT 200 CHECK (self_signup_daily_cap >= 0);
COMMENT ON COLUMN signup_limits.self_signup_daily_cap IS
  '롤링 24시간에 새로 만들어진 셀프 가입 조직(signup_source = self_signup — 가입 + 콘솔 새 조직)의 전역 수 상한(202609301520). 넘으면 AT429. 초대가 입구를 막으므로 안전망이다.';
COMMENT ON COLUMN signup_limits.pending_review_cap IS
  '(202609301520 부터 쓰지 않는다 — 새 조직은 검토 대기로 남지 않는다. self_signup_daily_cap 이 대신한다.)';

CREATE INDEX organizations_self_signup_created_idx ON organizations (created_at) WHERE signup_source = 'self_signup';

-- 202609301510 최종본(환영 메일 INSERT 포함) 기준. 바뀐 곳: ⓐ 새 조직 갈래가 살아 있는 초대를 요구한다(없으면 NULL — 링크 미소진, 이유를 가리지
--   않는다) ⓑ 검토 대기 총수 상한 → 롤링 24시간 새 셀프 가입 조직 수 ⓒ 조직은 active(베타 부여 없음 · reviewed_at NULL — 검토한 사람이 없다)
--   ⓓ 대기 항목 → joined(주소·메모 NULL) + 감사 'join'. 환영 메일 INSERT 는 1510 그대로다.
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
    SELECT w.id INTO v_entry FROM public.waitlist_entries w
     WHERE w.email = v_link.email AND w.status = 'invited' AND w.invite_expires_at > v_now
       FOR UPDATE;
    IF v_entry IS NULL THEN
      RETURN NULL;
    END IF;

    PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('signup_org_create', 0));
    SELECT * INTO v_limits FROM public.signup_limits WHERE id;
    -- 롤링 24시간 새 가입 조직 수(검토 대기 총수 상한을 대신한다 — 새 조직은 이제 바로 active 다). 가입 링크로 생긴 조직만 센다 — 콘솔 "새 조직" 은
    --   자기 상한(`member_org_daily_cap`)이 따로다.
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

    -- 검토 없이 active(운영자 활성화 `ops_org_activate_core` 가 하는 일 = review_status · reviewed_at + 베타 부여 — 베타는 끔, reviewed_at 은 검토한
    --   사람이 없으니 NULL · 투명성 잎·워밍업 단계는 없다 — 워밍업 기준일은 첫 발송이 적는다). 소유자 롤(SECURITY DEFINER)이라 review_guard 를 지난다.
    INSERT INTO public.organizations (name, owner_email, review_status, signup_source, billing_status)
    VALUES (v_link.organization_name, v_link.email, 'active', 'self_signup', 'trialing')
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

-- 콘솔 "새 조직"(이미 가입한 사용자) — 202609250110 본문에서 바뀐 곳(보안 검토 HIGH — 초대 없이 발신 조직 나무가 자라지 않게):
--   ⓐ 호출자가 owner 인 조직 중 하나라도 거절됐거나(`rejected`) 운영자 동결(`abuse_freeze`)이면 거부(AT429 `org_limit` · DETAIL `account_restricted`).
--   ⓑ 새 조직은 호출자가 **이미 owner 인 조직 중 active · 미동결이 있을 때만** `active`(Free) — 그 사람은 초대로 들어온(또는 운영자가 활성화한) 사람이다.
--      그 밖(초대받은 멤버 · 검토 대기 조직의 owner)은 `pending_review`(운영자가 본다).
--   ⓒ 상한은 콘솔 새 조직 **전용** 롤링 24시간 전역 수(`signup_limits.member_org_daily_cap`, 기본 20 — 가입의 `self_signup_daily_cap` 과 나눈다).
--      가입 링크가 없는 셀프 가입 조직 = 콘솔 새 조직. 사용자당 owner 조직 5 · 사용자당 하루 2 는 그대로.
ALTER TABLE signup_limits ADD COLUMN member_org_daily_cap integer NOT NULL DEFAULT 20 CHECK (member_org_daily_cap >= 0);
COMMENT ON COLUMN signup_limits.member_org_daily_cap IS
  '롤링 24시간에 콘솔 "새 조직"(create_member_organization — 가입 링크 없는 셀프 가입 조직)으로 생긴 조직의 전역 수 상한(202609301520). 넘으면 AT429 org_limit.';

CREATE OR REPLACE FUNCTION create_member_organization(p_session_id uuid, p_name text)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_user    public.users%ROWTYPE;
  v_limits  public.signup_limits%ROWTYPE;
  v_count   integer;
  v_org     uuid;
  v_status  public.organization_review_status;
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
  -- ⓐ 거절 · 동결된 조직의 owner 는 새 조직을 만들지 못한다.
  IF EXISTS (SELECT 1 FROM public.memberships m JOIN public.organizations o ON o.id = m.organization_id
              WHERE m.user_id = v_user.id AND m.removed_at IS NULL AND m.role = 'owner'
                AND (o.review_status = 'rejected' OR o.abuse_freeze)) THEN
    RAISE EXCEPTION 'org_limit' USING ERRCODE = 'AT429', DETAIL = 'account_restricted';
  END IF;
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
  -- ⓒ 콘솔 새 조직 전용 상한 — 가입 링크가 없는 셀프 가입 조직.
  SELECT count(*) INTO v_count FROM public.organizations o
   WHERE o.signup_source = 'self_signup' AND o.created_at > now() - interval '24 hours'
     AND NOT EXISTS (SELECT 1 FROM public.signup_links l WHERE l.organization_id = o.id);
  IF v_count >= coalesce(v_limits.member_org_daily_cap, 20) THEN
    RAISE EXCEPTION 'org_limit' USING ERRCODE = 'AT429', DETAIL = 'member_org_daily_cap';
  END IF;

  -- ⓑ 이미 owner 인 active · 미동결 조직이 있어야 active. 아니면 검토 대기.
  v_status := CASE WHEN EXISTS (SELECT 1 FROM public.memberships m JOIN public.organizations o ON o.id = m.organization_id
                                 WHERE m.user_id = v_user.id AND m.removed_at IS NULL AND m.role = 'owner'
                                   AND o.review_status = 'active' AND NOT o.abuse_freeze)
                   THEN 'active' ELSE 'pending_review' END;

  INSERT INTO public.organizations (name, owner_email, review_status, signup_source, billing_status)
  VALUES (p_name, v_user.email, v_status, 'self_signup', 'trialing')
  RETURNING id INTO v_org;
  RETURN v_org;
END;
$$;

-- ---------------------------------------------------------------------------
-- ⑥ 보존 — 가입 링크 보존 과제(TTL 스위퍼 하루 창)에 대기자 명단을 더한다
-- ---------------------------------------------------------------------------

-- 202609250240 본문 그대로 + 대기 항목 둘: ⓐ 초대받고 가입하지 않았다 — 초대 만료 30일 뒤(개인정보 처리 안내 · 약관) ⓑ 그 주소가 이미 멤버다
--   (조직 초대로 들어왔다 — 가입한 것과 같다). 반환 = 지운 가입 링크 + 지운 대기 항목. 쌓인 메일은 obsolete(보내는 순간 항목이 없으면 어차피 obsolete).
CREATE OR REPLACE FUNCTION purge_expired_signup_links() RETURNS integer
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  WITH gone AS (
    DELETE FROM public.signup_links s
     WHERE s.id IN (
             SELECT l.id FROM public.signup_links l
              WHERE l.used_at IS NULL
                AND l.status <> 'pending'
                AND l.expires_at <= now() - interval '30 days'
                AND NOT EXISTS (SELECT 1 FROM public.owner_sessions o WHERE o.signup_link_id = l.id)
              ORDER BY l.expires_at
              LIMIT 5000)
    RETURNING 1
  ),
  waitlist_gone AS (
    DELETE FROM public.waitlist_entries w
     WHERE w.id IN (
             SELECT e.id FROM public.waitlist_entries e
              WHERE e.status <> 'joined'
                AND ((e.status = 'invited' AND e.invite_expires_at <= now() - interval '30 days')
                     OR EXISTS (SELECT 1 FROM public.users u JOIN public.memberships m ON m.user_id = u.id AND m.removed_at IS NULL
                                 WHERE u.email = e.email))
              ORDER BY e.created_at
              LIMIT 5000)
    RETURNING w.id
  ),
  waitlist_mails_closed AS (
    UPDATE public.waitlist_mails m SET status = 'obsolete', settled_at = now(), last_error = 'entry_purged'
     WHERE m.status = 'pending' AND m.entry_id IN (SELECT g.id FROM waitlist_gone g)
    RETURNING 1
  )
  SELECT ((SELECT count(*) FROM gone) + (SELECT count(*) FROM waitlist_gone))::int
$$;

COMMENT ON FUNCTION purge_expired_signup_links() IS
  '가입 링크 · 대기자 명단 보존 — 쓰이지 않은 가입 링크(발송 끝 · 만료 30일) + 초대 만료 30일이 지난 대기 항목 · 이미 멤버인 주소의 대기 항목(202609301520). 각 5 000, 지운 수의 합. 앱 롤(TTL 스위퍼)만 EXECUTE.';

REVOKE ALL ON FUNCTION purge_expired_signup_links() FROM PUBLIC;
REVOKE ALL ON FUNCTION purge_expired_signup_links() FROM atmark_admin, atmark_login_mailer;
GRANT EXECUTE ON FUNCTION purge_expired_signup_links() TO atmark_app;

-- ---------------------------------------------------------------------------
-- ⑥-2 운영 콘솔 실패 기록 — 대기자 명단 행위(보안 검토 L — 감사 · 알림)
-- ---------------------------------------------------------------------------

-- `ops_actions.action` 에 대기자 명단 행위 셋을 더한다(실패 기록 — 티켓은 여전히 조직 행위뿐: `ops_actions_ticket_shape` 가 조직을 요구한다).
--   같은 이름으로 다시 세운다 — 기존 행은 옛 집합의 부분집합이라 검증이 곧바로 통과한다(ops_actions 는 작다 · 쓰기는 5초 안에 잠긴다).
ALTER TABLE ops_actions DROP CONSTRAINT ops_actions_action_check;
ALTER TABLE ops_actions ADD CONSTRAINT ops_actions_action_check CHECK (action IN ('org.activate', 'org.reject', 'org.freeze_on', 'agent.suspend',
  'operator.approve', 'operator.deny', 'operator.revoke', 'waitlist.invite', 'waitlist.invite_oldest', 'waitlist.remove'));

-- 202609290510 본문 그대로 + 행위 허용 목록에 대기자 명단 셋.
CREATE OR REPLACE FUNCTION ops_record_failure(p_session_hash text, p_client_key text, p_action text, p_org uuid, p_agent text, p_code text)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_session public.ops_sessions%ROWTYPE;
  v_code text := CASE WHEN p_code ~ '^[a-z_]{1,40}$' THEN p_code ELSE 'unknown' END;
  v_action text := CASE WHEN p_action IN ('org.activate', 'org.reject', 'org.freeze_on', 'agent.suspend',
                                          'operator.approve', 'operator.deny', 'operator.revoke',
                                          'waitlist.invite', 'waitlist.invite_oldest', 'waitlist.remove') THEN p_action END;
  v_agent text := CASE WHEN p_agent ~ '^[0-9a-f]{32}$' THEN p_agent END;
  v_n integer;
BEGIN
  v_session := public.ops_session_resolve(p_session_hash, false);
  IF v_session.id IS NOT NULL THEN
    PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('ops_failure_session:' || v_session.id::text, 0));
    SELECT count(*) INTO v_n FROM public.ops_actions a
     WHERE a.kind = 'failure' AND a.session_id = v_session.id AND a.created_at > now() - interval '10 minutes';
    IF v_n >= 30 THEN RETURN; END IF;
    INSERT INTO public.ops_actions (kind, result, operator_id, session_id, action, organization_id, agent_id, code)
    VALUES ('failure', 'failed', v_session.operator_id, v_session.id, v_action, p_org, v_agent, v_code);
    RETURN;
  END IF;
  -- 세션이 무효하면 요청자 키로 센다(I-9).
  IF p_client_key IS NULL OR p_client_key !~ '^[0-9a-f]{64}$' THEN RETURN; END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('ops_failure_client:' || p_client_key, 0));
  SELECT count(*) INTO v_n FROM public.ops_actions a
   WHERE a.kind = 'failure' AND a.client_key = p_client_key AND a.session_id IS NULL AND a.created_at > now() - interval '10 minutes';
  IF v_n >= 30 THEN RETURN; END IF;
  INSERT INTO public.ops_actions (kind, result, client_key, action, organization_id, agent_id, code)
  VALUES ('failure', 'failed', p_client_key, v_action, p_org, v_agent, v_code);
END;
$$;

REVOKE ALL ON FUNCTION ops_record_failure(text, text, text, uuid, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ops_record_failure(text, text, text, uuid, text, text) TO atmark_ops;

-- ---------------------------------------------------------------------------
-- ⑦ 베타 스위치 SQL 짝 — 끈다(TS `BETA_ON_ACTIVATION = false`, src/billing/plans.ts)
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION ops_activation_beta_enabled() RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT false
$$;
REVOKE ALL ON FUNCTION ops_activation_beta_enabled() FROM PUBLIC;

-- ---------------------------------------------------------------------------
-- ⑧ 권한
-- ---------------------------------------------------------------------------

REVOKE ALL ON waitlist_entries, waitlist_events, waitlist_mails FROM atmark_app, atmark_admin, atmark_login_mailer, atmark_ops;

-- admin — 정의 함수 둘(표 권한 0).
GRANT EXECUTE ON FUNCTION waitlist_join(text, text, text, text) TO atmark_admin;
GRANT EXECUTE ON FUNCTION waitlist_invite_live(text) TO atmark_admin;

-- 로그인 메일 롤 — 발송 칸 + 수신 항목의 주소·상태·초대 만료(메모·출처는 읽지 않는다).
-- last_error 는 사유 코드뿐(CHECK) — 발송기가 'sending' 표식(SES 호출 전에 적는 claim)을 읽어 만료된 lease 의 행을 다시 보내지 않는다(환영 메일과 같다).
GRANT SELECT (id, entry_id, kind, lang, invite_expires_at, created_at, status, attempt_count, next_attempt_at, claimed_at, last_error)
  ON waitlist_mails TO atmark_login_mailer;
GRANT UPDATE (status, attempt_count, next_attempt_at, claimed_at, last_error, ses_message_id, sent_at, settled_at)
  ON waitlist_mails TO atmark_login_mailer;
GRANT SELECT (id, email, status, invite_expires_at) ON waitlist_entries TO atmark_login_mailer;

-- atmark_ops — 운영 화면의 읽기 칸(src/ops/console/reads.ts `readWaitlist`) + 정의 함수 셋.
GRANT SELECT (id, email, lang, note, source, status, created_at, invited_at, invite_expires_at, joined_at, invited_by)
  ON waitlist_entries TO atmark_ops;
GRANT SELECT (id, entry_id, action, actor, created_at) ON waitlist_events TO atmark_ops;
GRANT EXECUTE ON FUNCTION ops_waitlist_invite(text, uuid) TO atmark_ops;
GRANT EXECUTE ON FUNCTION ops_waitlist_invite_oldest(text, integer) TO atmark_ops;
GRANT EXECUTE ON FUNCTION ops_waitlist_remove(text, uuid) TO atmark_ops;
