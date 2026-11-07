-- 202609250120_org_invites.sql
-- 조직 초대 (확장성 P1 R-1, 계획 §2.3 · 창업자 결정 F-2 — 검토 끝난 조직만 · 두 통 흐름 · 메일에 조직 이름 없음 · 조직당 멤버 5).
--
-- 흐름(두 통): owner 가 초대 → `org_invites` 한 행(= outbox) → 로그인 메일 Lambda 가 **초대 메일**(초대자 주소 + 서명 링크, 조직
--   이름 없음) → 받은 사람이 착지(`/invite`)에서 claim → **그 브라우저에 결속된 로그인 링크**가 초대받은 주소로(`owner_login_links.
--   invite_id`) → verify 가 같은 트랜잭션에서 `accept_org_invite` → 멤버십 + 세션. 초대 링크만 가진 쪽(전달·스캐너)은 아무것도
--   못 한다 — 로그인 메일은 언제나 초대받은 주소로 간다.
--
-- 세우는 것:
--   ① `org_invites` — 수신자는 `user_id`(→ users.email, 초대할 때 사용자 행을 upsert). 토큰 칸 없음(보낼 때 HMAC,
--      `security/invite-token.ts`). 가드: 불변 핵심 · 수락/취소 1회 · 둘 중 하나만 · 만료 뒤 수락 불가 · outbox 종단 재개방 불가 ·
--      취소·수락되면 아직 안 보낸 메일은 `obsolete` · DELETE/TRUNCATE 거부 · INSERT 는 **`review_status='active'` 조직만** ·
--      조직당 대기 초대 10 · (조직, 사용자)당 대기 초대 1 · 만료 ≤ 7일.
--   ② `membership_events` — 멤버십 변경 감사 상세(append-only, `agent_api_key_events` 와 같은 방식 — `owner_actions` 행 하나에 붙는다).
--   ③ `accept_org_invite(invite, user, now)` — 멤버십을 만드는 세 번째(마지막) 경로(SECURITY DEFINER). NULL = 유효하지 않은 초대
--      (verify 는 "유효하지 않은 링크" 하나로 읽는다). 조직당 멤버 앱 상한 5 → `AT409 member_limit`.
--   ④ `owner_login_links.invite_id` FK + 초대 링크 가드(초대의 사용자·조직과 링크의 사용자·조직이 같고 초대가 대기 중).
--
-- 속도 상한(계획 §6.2)은 `org_invites` 자체를 센다(admin 코드): 조직 하루 20 · 같은 사용자 하루 3(조직 무관) · 대기 10(여기 DB).
--   계획의 별도 원장(`invite_requests`)은 두지 않았다 — 초대 행이 곧 원장이고 주소 대신 사용자 id 로 센다(같은 값).
--   전역 시간당 메일 상한은 가입 메일과 공유(메일러 `SIGNUP_MAIL_GLOBAL_HOURLY_CAP`).
--
-- 권한: 앱 롤 0. admin: org_invites INSERT(요청 칸) · SELECT(outbox 제외) · UPDATE(revoked_at) / membership_events INSERT·SELECT /
--   users INSERT(email) / EXECUTE accept_org_invite. login_mailer: org_invites 발송 컬럼 + (id, user_id, invited_by_user_id, created_at,
--   expires_at) 읽기 · signup_email_suppressed 재사용(이미 EXECUTE).
--
-- 마이그레이션은 append-only 다. 기존 파일은 한 글자도 건드리지 않았다.

-- 잠금 대기 상한(적대적 검토 M5): 뜨거운 표 owner_login_links(FK·트리거) · organizations·owner_actions(FK)에 잠금을 건다 — 오래 기다리면 로그인·세션·감사 경로가 줄줄이 선다.
--   5초 안에 못 잡으면 이 파일만 실패(러너는 파일 하나당 BEGIN/COMMIT)하고 다시 돌리면 된다.
SET LOCAL lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- ① org_invites
-- ---------------------------------------------------------------------------

CREATE TYPE org_invite_status AS ENUM ('pending', 'sent', 'obsolete', 'undeliverable', 'dead');

CREATE TABLE org_invites (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id     uuid NOT NULL REFERENCES organizations (id) ON DELETE RESTRICT,
  -- 수신자. 주소 칸이 없다 — 보내는 순간 users.email 에서 읽는다(로그인 링크와 같은 규율).
  user_id             uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  role                text NOT NULL CHECK (role IN ('admin', 'member')),
  invited_by_user_id  uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  created_at          timestamptz NOT NULL DEFAULT now(),
  -- 토큰에 ms 로 실린다 — 비교가 정확하도록 ms 로 자른 값만.
  expires_at          timestamptz NOT NULL CHECK (expires_at = date_trunc('milliseconds', expires_at)),
  accepted_at         timestamptz,
  revoked_at          timestamptz,

  -- ---- outbox (signup_links 와 같은 모양) ----
  status              org_invite_status NOT NULL DEFAULT 'pending',
  attempt_count       integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  next_attempt_at     timestamptz NOT NULL DEFAULT now(),
  claimed_at          timestamptz,
  last_error          text CHECK (last_error ~ '^[a-z_]{1,40}$'),
  ses_message_id      text,
  sent_at             timestamptz,
  settled_at          timestamptz,

  CONSTRAINT org_invites_ttl CHECK (expires_at > created_at AND expires_at - created_at <= interval '7 days'),
  CONSTRAINT org_invites_one_end CHECK (accepted_at IS NULL OR revoked_at IS NULL),
  CONSTRAINT org_invites_sent_shape
    CHECK ((status = 'sent') = (sent_at IS NOT NULL AND ses_message_id IS NOT NULL)),
  CONSTRAINT org_invites_settled_shape
    CHECK ((status IN ('obsolete', 'undeliverable', 'dead')) = (settled_at IS NOT NULL)),
  CONSTRAINT org_invites_id_org_key UNIQUE (id, organization_id)
);

CREATE INDEX org_invites_due_idx ON org_invites (next_attempt_at) WHERE status = 'pending';
CREATE INDEX org_invites_org_created_idx ON org_invites (organization_id, created_at);
CREATE INDEX org_invites_user_created_idx ON org_invites (user_id, created_at);
CREATE INDEX org_invites_claimed_idx ON org_invites (claimed_at) WHERE claimed_at IS NOT NULL;

CREATE TRIGGER org_invites_immutable_core
  BEFORE UPDATE ON org_invites
  FOR EACH ROW EXECUTE FUNCTION reject_column_update_except(
    'accepted_at', 'revoked_at',
    'status', 'attempt_count', 'next_attempt_at', 'claimed_at', 'last_error', 'ses_message_id', 'sent_at', 'settled_at');

CREATE TRIGGER org_invites_ended_once
  BEFORE UPDATE ON org_invites
  FOR EACH ROW EXECUTE FUNCTION reject_column_overwrite('accepted_at', 'revoked_at');

CREATE OR REPLACE FUNCTION org_invites_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_pending integer;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.accepted_at IS NOT NULL OR NEW.revoked_at IS NOT NULL OR NEW.status <> 'pending' THEN
      RAISE EXCEPTION 'invite must be created pending' USING ERRCODE = '23514';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM organizations WHERE id = NEW.organization_id AND review_status = 'active') THEN
      RAISE EXCEPTION 'org_not_active' USING ERRCODE = 'AT403', DETAIL = 'only active organizations can invite';
    END IF;
    PERFORM pg_advisory_xact_lock(hashtextextended('org_invites:' || NEW.organization_id::text, 0));
    IF EXISTS (SELECT 1 FROM org_invites
                WHERE organization_id = NEW.organization_id AND user_id = NEW.user_id
                  AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > now()) THEN
      RAISE EXCEPTION 'invite_pending' USING ERRCODE = 'AT409';
    END IF;
    SELECT count(*) INTO v_pending FROM org_invites
     WHERE organization_id = NEW.organization_id AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > now();
    IF v_pending >= 10 THEN
      RAISE EXCEPTION 'invite_limit' USING ERRCODE = 'AT409', DETAIL = 'pending invites per organization';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.accepted_at IS NULL AND NEW.accepted_at IS NOT NULL AND NEW.accepted_at >= OLD.expires_at THEN
    RAISE EXCEPTION 'invite % is expired', OLD.id USING ERRCODE = '23514';
  END IF;
  IF OLD.status <> 'pending' AND (
       NEW.status IS DISTINCT FROM OLD.status
    OR NEW.attempt_count IS DISTINCT FROM OLD.attempt_count
    OR NEW.next_attempt_at IS DISTINCT FROM OLD.next_attempt_at
    OR NEW.claimed_at IS DISTINCT FROM OLD.claimed_at
    OR NEW.sent_at IS DISTINCT FROM OLD.sent_at
    OR NEW.ses_message_id IS DISTINCT FROM OLD.ses_message_id) THEN
    RAISE EXCEPTION 'invite notification % is terminal (%)', OLD.id, OLD.status USING ERRCODE = '23514';
  END IF;
  -- 끝난 초대(취소·수락)의 아직 안 보낸 메일은 닫는다 — 취소한 초대의 메일이 뒤늦게 나가지 않게.
  IF OLD.status = 'pending' AND NEW.status = 'pending'
     AND ((OLD.revoked_at IS NULL AND NEW.revoked_at IS NOT NULL) OR (OLD.accepted_at IS NULL AND NEW.accepted_at IS NOT NULL)) THEN
    NEW.status := 'obsolete';
    NEW.settled_at := now();
    NEW.last_error := CASE WHEN NEW.revoked_at IS NOT NULL THEN 'invite_revoked' ELSE 'invite_accepted' END;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER org_invites_guard
  BEFORE INSERT OR UPDATE ON org_invites
  FOR EACH ROW EXECUTE FUNCTION org_invites_guard();

CREATE TRIGGER org_invites_no_delete
  BEFORE DELETE ON org_invites
  FOR EACH ROW EXECUTE FUNCTION reject_row_delete();
CREATE TRIGGER org_invites_no_truncate
  AFTER TRUNCATE ON org_invites
  FOR EACH STATEMENT EXECUTE FUNCTION reject_truncate();

COMMENT ON TABLE org_invites IS
  '조직 초대 겸 outbox. INSERT 는 admin(요청 칸)만 · active 조직만 · 대기 10. 수락은 accept_org_invite 만. 발송은 login-mailer(outbox 칸). 수신자·토큰 칸 없음. 앱 롤 권한 0.';

-- ---------------------------------------------------------------------------
-- ② membership_events — 감사 상세
-- ---------------------------------------------------------------------------

CREATE TABLE membership_events (
  owner_action_id  uuid PRIMARY KEY REFERENCES owner_actions (id) ON DELETE RESTRICT,
  membership_id    uuid NOT NULL REFERENCES memberships (id) ON DELETE RESTRICT,
  user_id          uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  old_role         text CHECK (old_role IN ('owner', 'admin', 'member')),
  new_role         text CHECK (new_role IN ('owner', 'admin', 'member')),
  created_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT membership_events_changes CHECK (old_role IS DISTINCT FROM new_role)
);

CREATE INDEX membership_events_membership_idx ON membership_events (membership_id);

CREATE TRIGGER membership_events_no_update
  BEFORE UPDATE ON membership_events
  FOR EACH ROW EXECUTE FUNCTION reject_row_update();
CREATE TRIGGER membership_events_no_delete
  BEFORE DELETE ON membership_events
  FOR EACH ROW EXECUTE FUNCTION reject_row_delete();
CREATE TRIGGER membership_events_no_truncate
  AFTER TRUNCATE ON membership_events
  FOR EACH STATEMENT EXECUTE FUNCTION reject_truncate();

COMMENT ON TABLE membership_events IS
  '멤버십 변경 감사 상세(owner_actions 한 행에 하나). 역할 전·후(가입 = NULL→역할, 제거 = 역할→NULL). append-only. 앱 롤 권한 0.';

-- ---------------------------------------------------------------------------
-- ③ accept_org_invite
-- ---------------------------------------------------------------------------
-- 초대 잠금 → 대기·미만료·수신자 일치(아니면 NULL) → 이미 살아 있는 멤버면 초대만 소비 → 아니면 조직당 멤버 앱 상한 5
--   (넘으면 AT409 — 트랜잭션 전체가 되돌아가 링크도 초대도 소비되지 않는다) → 멤버십 INSERT(joined_via='invite') → 수락 시각.
--   `p_now` 는 `greatest(p_now, now())`(과거 시각으로 만료된 초대를 살리지 못한다 — 가입 함수와 같다).
CREATE OR REPLACE FUNCTION accept_org_invite(p_invite_id uuid, p_user_id uuid, p_now timestamptz,
                                             OUT membership_id uuid, OUT joined boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_now     timestamptz := greatest(coalesce(p_now, now()), now());
  v_invite  public.org_invites%ROWTYPE;
  v_live    integer;
BEGIN
  membership_id := NULL;
  joined := false;
  IF p_invite_id IS NULL OR p_user_id IS NULL THEN
    RETURN;
  END IF;
  SELECT * INTO v_invite FROM public.org_invites WHERE id = p_invite_id FOR UPDATE;
  IF NOT FOUND OR v_invite.accepted_at IS NOT NULL OR v_invite.revoked_at IS NOT NULL
     OR v_invite.expires_at <= v_now OR v_invite.user_id <> p_user_id THEN
    RETURN;
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('membership_org:' || v_invite.organization_id::text, 0));
  SELECT m.id INTO membership_id FROM public.memberships m
   WHERE m.user_id = p_user_id AND m.organization_id = v_invite.organization_id AND m.removed_at IS NULL;
  IF membership_id IS NULL THEN
    SELECT count(*) INTO v_live FROM public.memberships
     WHERE organization_id = v_invite.organization_id AND removed_at IS NULL;
    IF v_live >= 5 THEN
      RAISE EXCEPTION 'member_limit' USING ERRCODE = 'AT409', DETAIL = 'members per organization';
    END IF;
    INSERT INTO public.memberships (user_id, organization_id, role, joined_via)
    VALUES (p_user_id, v_invite.organization_id, v_invite.role, 'invite')
    RETURNING id INTO membership_id;
    joined := true;
  END IF;
  UPDATE public.org_invites SET accepted_at = v_now WHERE id = v_invite.id;
END;
$$;

REVOKE ALL ON FUNCTION accept_org_invite(uuid, uuid, timestamptz) FROM PUBLIC;

-- ---------------------------------------------------------------------------
-- ④ owner_login_links.invite_id
-- ---------------------------------------------------------------------------

ALTER TABLE owner_login_links ADD CONSTRAINT owner_login_links_invite_fk
  FOREIGN KEY (invite_id) REFERENCES org_invites (id) ON DELETE RESTRICT;

-- 초대 로그인 링크는 초대받은 사용자에게, 초대의 조직으로만 — 대기 중인 초대에만.
CREATE OR REPLACE FUNCTION owner_login_links_invite_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.invite_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM org_invites i
        WHERE i.id = NEW.invite_id AND i.user_id = NEW.user_id AND i.organization_id = NEW.organization_id
          AND i.accepted_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > now()) THEN
    RAISE EXCEPTION 'login link invite % does not match a pending invite', NEW.invite_id USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER owner_login_links_invite_guard
  BEFORE INSERT ON owner_login_links
  FOR EACH ROW EXECUTE FUNCTION owner_login_links_invite_guard();

-- ---------------------------------------------------------------------------
-- 권한
-- ---------------------------------------------------------------------------

REVOKE ALL ON org_invites, membership_events FROM atmark_app, atmark_admin, atmark_login_mailer;

GRANT INSERT (organization_id, user_id, role, invited_by_user_id, expires_at, next_attempt_at) ON org_invites TO atmark_admin;
GRANT SELECT (id, organization_id, user_id, role, invited_by_user_id, created_at, expires_at, accepted_at, revoked_at)
  ON org_invites TO atmark_admin;
GRANT UPDATE (revoked_at) ON org_invites TO atmark_admin;
GRANT SELECT, INSERT ON membership_events TO atmark_admin;
-- 초대 대상 사용자 행(주소 하나). 그 밖의 칸은 기본값.
GRANT INSERT (email) ON users TO atmark_admin;
GRANT EXECUTE ON FUNCTION accept_org_invite(uuid, uuid, timestamptz) TO atmark_admin;

-- 로그인 메일 롤 — 발송 칸 + 수신자·초대자·만료·id. 조직·역할·수락·취소는 읽지 않는다(끝난 초대는 가드가 obsolete 로 닫는다).
GRANT SELECT (id, user_id, invited_by_user_id, created_at, expires_at, status, attempt_count, next_attempt_at, claimed_at)
  ON org_invites TO atmark_login_mailer;
GRANT UPDATE (status, attempt_count, next_attempt_at, claimed_at, last_error, ses_message_id, sent_at, settled_at)
  ON org_invites TO atmark_login_mailer;
