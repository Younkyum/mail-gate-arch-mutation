-- 202609250180_member_lifecycle_guards.sql
-- 멤버·초대 수명 가드 보강 (확장성 P0·P1 적대적 검토 M2·M3·L2·L3·L6 — **expand**: 옛 코드와 함께 돈다).
--
-- 세우는 것:
--   ① `org_invites_guard`(0120 과 같은 이름 · CREATE OR REPLACE) — INSERT 는 **active 이고 동결(abuse_freeze)되지 않은** 조직만(M3) ·
--      초대자(`invited_by_user_id`)가 그 조직의 **살아 있는 owner** 일 때만(M2 — 강등·제거된 owner 이름으로 초대가 새로 서지 않는다).
--      나머지(대기 10 · 같은 사람 대기 1 · 수락/취소 전이 · 끝난 초대 메일 obsolete)는 0120 과 같다.
--   ② `accept_org_invite`(같은 서명) — 수락 순간에도 조직이 active·미동결이고(L3) 초대자가 아직 살아 있는 owner 여야 한다(M2).
--      아니면 NULL(= 유효하지 않은 초대 — verify 는 "유효하지 않은 링크" 하나로 읽는다). 확인은 조직 멤버십 잠금 **뒤**에 한다
--      (강등 트랜잭션이 먼저 커밋했으면 그 결과를 본다).
--   ③ `owner_login_links_invite_guard`(같은 이름) — 초대 로그인 링크도 같은 조건(조직 active·미동결 · 초대자 살아 있는 owner)(L3).
--   ④ `org_invite_sendable(invite)` — SECURITY DEFINER. 로그인 메일 롤은 조직·멤버십 칸을 읽지 못한다(최소 권한 — 칸을 더 열지 않는다).
--      초대 메일 워커가 **보내는 순간** 이 함수에 참/거짓만 묻고, 거짓이면 그 메일을 `obsolete`(`org_not_sendable`)로 닫는다(M3).
--      참 = 초대가 대기 중(수락·취소 없음 · 미만료) · 조직 active · 미동결 · 초대자 살아 있는 owner. 초대 id 밖의 값은 돌려주지 않는다.
--   ⑤ `owner_sessions_user_switch_idx` — 사용자당 조직 전환·새 조직 속도 상한(L6, admin 코드 `limitSessionSwitches`)의 계수 경로.
--      전환 자식 세션만 담는 부분 색인이라 작다.
--
-- 권한: `atmark_login_mailer` EXECUTE org_invite_sendable(`RESTRICTED_ROLE_GRANTS` 에 같은 변경으로 추가). 앱·admin 롤 0.
-- 잠금: CREATE OR REPLACE FUNCTION 은 표를 잠그지 않지만, 색인은 `owner_sessions`(로그인 경로 — 매 요청 읽고 로그인마다 쓴다)에 SHARE 잠금을
--   건다 — 대기 상한 5초(0010·0160 과 같다).
--
-- 마이그레이션은 append-only 다 — 0120 은 건드리지 않았다(같은 이름의 함수를 다시 정의한다).

SET LOCAL lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- ① org_invites_guard
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION org_invites_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_pending integer;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.accepted_at IS NOT NULL OR NEW.revoked_at IS NOT NULL OR NEW.status <> 'pending' THEN
      RAISE EXCEPTION 'invite must be created pending' USING ERRCODE = '23514';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM organizations
                    WHERE id = NEW.organization_id AND review_status = 'active' AND NOT abuse_freeze) THEN
      RAISE EXCEPTION 'org_not_active' USING ERRCODE = 'AT403', DETAIL = 'only active, unfrozen organizations can invite';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM memberships
                    WHERE organization_id = NEW.organization_id AND user_id = NEW.invited_by_user_id
                      AND removed_at IS NULL AND role = 'owner') THEN
      RAISE EXCEPTION 'inviter_not_owner' USING ERRCODE = 'AT403', DETAIL = 'only a live owner can invite';
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
  IF OLD.status = 'pending' AND NEW.status = 'pending'
     AND ((OLD.revoked_at IS NULL AND NEW.revoked_at IS NOT NULL) OR (OLD.accepted_at IS NULL AND NEW.accepted_at IS NOT NULL)) THEN
    NEW.status := 'obsolete';
    NEW.settled_at := now();
    NEW.last_error := CASE WHEN NEW.revoked_at IS NOT NULL THEN 'invite_revoked' ELSE 'invite_accepted' END;
  END IF;
  RETURN NEW;
END;
$$;

-- ---------------------------------------------------------------------------
-- ② accept_org_invite
-- ---------------------------------------------------------------------------

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
  -- 잠금 뒤의 조회는 새 스냅샷(READ COMMITTED) — 방금 커밋된 강등·동결을 본다.
  IF NOT EXISTS (SELECT 1 FROM public.organizations o
                  WHERE o.id = v_invite.organization_id AND o.review_status = 'active' AND NOT o.abuse_freeze)
     OR NOT EXISTS (SELECT 1 FROM public.memberships m
                     WHERE m.organization_id = v_invite.organization_id AND m.user_id = v_invite.invited_by_user_id
                       AND m.removed_at IS NULL AND m.role = 'owner') THEN
    RETURN;
  END IF;
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
GRANT EXECUTE ON FUNCTION accept_org_invite(uuid, uuid, timestamptz) TO atmark_admin;

-- ---------------------------------------------------------------------------
-- ③ owner_login_links_invite_guard
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION owner_login_links_invite_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.invite_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM org_invites i
         JOIN organizations o ON o.id = i.organization_id
        WHERE i.id = NEW.invite_id AND i.user_id = NEW.user_id AND i.organization_id = NEW.organization_id
          AND i.accepted_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > now()
          AND o.review_status = 'active' AND NOT o.abuse_freeze
          AND EXISTS (SELECT 1 FROM memberships m
                       WHERE m.organization_id = i.organization_id AND m.user_id = i.invited_by_user_id
                         AND m.removed_at IS NULL AND m.role = 'owner')) THEN
    RAISE EXCEPTION 'login link invite % does not match a pending invite', NEW.invite_id USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

-- ---------------------------------------------------------------------------
-- ④ org_invite_sendable — 초대 메일 워커의 발송 직전 확인
-- ---------------------------------------------------------------------------

CREATE FUNCTION org_invite_sendable(p_invite_id uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT EXISTS (
    SELECT 1
      FROM public.org_invites i
      JOIN public.organizations o ON o.id = i.organization_id
     WHERE i.id = p_invite_id
       AND i.accepted_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > now()
       AND o.review_status = 'active' AND NOT o.abuse_freeze
       AND EXISTS (SELECT 1 FROM public.memberships m
                    WHERE m.organization_id = i.organization_id AND m.user_id = i.invited_by_user_id
                      AND m.removed_at IS NULL AND m.role = 'owner'))
$$;

COMMENT ON FUNCTION org_invite_sendable(uuid) IS
  '초대 메일을 지금 보내도 되는가(대기 중 · 조직 active·미동결 · 초대자 살아 있는 owner). 로그인 메일 롤이 조직·멤버십을 읽지 않고 묻는다.';

REVOKE ALL ON FUNCTION org_invite_sendable(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION org_invite_sendable(uuid) TO atmark_login_mailer;

-- ---------------------------------------------------------------------------
-- ⑤ 전환 속도 상한의 계수 경로
-- ---------------------------------------------------------------------------

CREATE INDEX owner_sessions_user_switch_idx ON owner_sessions (user_id, created_at) WHERE switched_from_session_id IS NOT NULL;
