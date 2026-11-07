-- 202609250220_invited_user_erasure.sql
-- 초대만 받은 사용자 행의 주소 지우기 (ADR-0010 후속 L7 — 적대적 검토).
--
-- 초대할 때 대상 주소로 `users` 행을 만든다(`inviteMemberOp`). 수락하지 않으면 멤버십 없는 사용자 행(= 제3자 주소)이 영원히 남았다 —
--   `users` 는 DELETE·주소 UPDATE 가 막혀 있고(`users_no_delete`·`users_immutable_core`) `org_invites.user_id` 가 FK 로 가리킨다.
--   행은 지우지 않는다(id 는 감사·투명성 잎·초대 행이 가리킨다 — 잎에는 사용자 **id** 만 있고 주소는 없다). 주소만 지운다.
--
-- 세우는 것:
--   ① `users.erased_at` — 주소를 지운 시각(1회). 지운 행의 `email` = `'erased-' || id || '@erased.invalid'`(모양 CHECK 를 통과하는
--      고유 자리표시). 원래 주소가 UNIQUE 에서 풀리므로 같은 주소를 다시 초대하면 **새** 사용자 행이 생긴다.
--   ② `users_immutable_core` 재생성(같은 이름) — 바뀌는 칸에 `email`·`erased_at` 을 더하고, 그 두 칸은 새 가드 `users_erasure_guard` 가
--      잡는다: **테이블 소유자(= 아래 SECURITY DEFINER 함수·운영자 셸)만** · 1회(`erased_at` NULL → 값) · 주소는 정확히 그 자리표시로만.
--      소유자 판별은 `organizations_review_guard` 와 같다(권한이 아니라 소유자 여부). INSERT 는 `erased_at` 을 적지 못하고
--      자리표시 도메인(`erased.invalid`) 주소를 만들지 못한다 — 남의 자리표시를 미리 차지해 지우기를 UNIQUE 위반으로 막는 길을 닫는다.
--   ③ `invited_only_user_erasable(user, email)` — 지우기 조건 **하나의 정의**(배치 후보 선정과 최종 판정이 같은 식을 쓴다 — 적대적 검토 M1):
--        멤버십 행이 **한 번도** 없다(제거된 것 포함) · 초대가 하나 이상 있고 마지막 초대의 끝(수락·취소·만료 중 먼저 적힌 것의 최댓값)이
--        30일 전 이하다(대기 초대의 끝은 미래 만료라 여기서 빠진다) · 초대 메일 outbox 에 대기 행 없음 · 살아 있는 로그인 링크 없음 ·
--        이 주소가 어느 조직의 주 소유자(`owner_email`)도 아니다(새 색인 `organizations (owner_email)`).
--      **가입 링크는 조건이 아니다**(적대적 검토 L3): 가입 링크는 사용자 행이 아니라 주소를 가리키므로 제3자가 그 주소로 가입 링크를
--        계속 청해 지우기를 끝없이 미룰 수 있었다. 가입 확정(`create_signup_organization`)과의 경합은 조건이 아니라 **잠금**으로 닫는다 —
--        ④ 가 가입 확정과 같은 advisory 키(`signup_email:<주소>`)를 잡는다. 지우기가 먼저면 가입 확정은 그 뒤 주소로 사용자를 못 찾아
--        **새** 사용자 행을 만들고(`organizations_owner_membership`), 가입 확정이 먼저면 지우기가 owner 멤버십을 보고 false.
--   ④ `erase_invited_only_user(user)` — 사용자 행을 `FOR UPDATE NOWAIT` 로 잡고(못 잡으면 55P03 — 배치는 건너뛴다) 가입 확정 잠금을
--      `pg_try_advisory_xact_lock` 으로 잡은 뒤(못 잡으면 false) ③ 을 **다시** 본다. 하나라도 어긋나면 아무것도 바꾸지 않고 false.
--      EXECUTE 는 **아무 롤에도 주지 않는다**(소유자만 — admin·앱·로그인 메일 롤 42501).
--   ⑤ `erase_invited_only_users(limit)` — 보존 과제(approval-expiry Lambda, 앱 롤)가 하루 한 번 부르는 배치. 후보 = 안 지웠고 ③ 이 참인
--      사용자(최종 판정과 **같은 식** — 막힌 행이 `ORDER BY id LIMIT` 앞자리를 차지해 뒤를 굶기지 않는다)를 최대 `limit`(함수 안에서 1–500 으로
--      자른다)개 골라 ④ 를 부른다. 배치 안에서는 **기다리지 않는다**(NOWAIT · try-lock). 행마다 서브트랜잭션이라 한 행의 실패(UNIQUE·CHECK·
--      FK·잠금·교착·직렬화)가 배치를 멈추지 않는다(`skipped`). `query_canceled`(statement_timeout·취소)는 잡지 않는다 — 잡으면 시간 상한이 꺼진
--      채 루프가 계속된다. 사용자를 고를 수 없으므로 앱 롤이 아무 때나 불러도 할 수 있는 일은 "어차피 지워질 행을 지우기" 뿐이다.
--   ⑥ `invited_user_erasure_backlog()` — 약속(30일)을 7일 넘긴 행 수(멤버십 없음 · 안 지움 · 마지막 초대의 끝 ≤ 37일 전). 보존 과제가 하루
--      한 번 `atmark.privacy.erasure_backlog` 로 내고 0 초과면 알람(`atmark-privacy-erasure-backlog`). 일시적인 막힘(로그인 링크 10분)은
--      일부러 빼지 않는다 — 37일 넘게 막힌 대기 메일·잠금은 그 자체로 고장이다.
--   ⑦ `org_invites_invitee_live` — 초대 INSERT 가 대상 사용자 행을 `FOR KEY SHARE` 로 잡고 지운 행이면 거부(AT409 `invitee_erased`).
--      지우기와 초대가 엇갈릴 때(초대 쪽이 옛 사용자 id 를 고른 뒤 지우기가 커밋) 지운 행에 초대가 붙는 경합을 닫는다. 반대 순서(초대가
--      먼저 잠금)면 지우기가 NOWAIT 로 건너뛰고 다음 날 대기 초대를 본다.
--   ⑧ 색인 — `memberships (user_id)`("멤버십이 한 번도 없다" 를 제거된 행까지 — `memberships_live_key` 는 살아 있는 행만의 부분 색인) ·
--      `organizations (owner_email)`(③ 의 주 소유자 검사 — 없으면 후보마다 조직 전체를 훑는다).
--
-- 모든 SECURITY DEFINER 함수는 `search_path = pg_catalog, public, pg_temp`(pg_temp **마지막** — 빠뜨리면 pg_temp 가 맨 앞에서 먼저 찾아진다,
--   적대적 검토 L1 · migrate `status` 의 `unsafeSecurityDefiners` 가 강제한다).
--
-- 권한: 앱 롤 EXECUTE `erase_invited_only_users(integer)` · `invited_user_erasure_backlog()`. `erase_invited_only_user(uuid)`·③ 은 누구에게도
--   없다. admin·로그인 메일 롤 0. 허용 목록 `RESTRICTED_ROLE_GRANTS` · 가드 `REQUIRED_GUARDS`(users_erasure_guard · org_invites_invitee_live) 를
--   같은 변경에서 늘렸다.
--
-- 마이그레이션은 append-only 다. 기존 파일은 한 글자도 건드리지 않았다. (이 파일은 운영 미적용 상태에서 적대적 검토 M1·L1·L3·L4 로 고쳤다 —
--   로컬 DB 의 checksum 을 함께 갱신.)

-- 잠금 대기 상한(적대적 검토 M5): `users` 에 칸을 더하고 트리거를 바꾼다(ACCESS EXCLUSIVE) — 세션 해석·로그인·초대가 읽는 표다.
--   5초 안에 못 잡으면 이 파일만 실패(러너는 파일 하나당 BEGIN/COMMIT)하고 다시 돌리면 된다.
SET LOCAL lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- ① users.erased_at
-- ---------------------------------------------------------------------------

ALTER TABLE users ADD COLUMN erased_at timestamptz;

COMMENT ON COLUMN users.erased_at IS
  '초대만 받고 멤버가 된 적 없는 사용자의 주소를 지운 시각(1회, ADR-0010 L7). 지운 행의 email = erased-<id>@erased.invalid. erase_invited_only_user 만 적는다.';

-- ---------------------------------------------------------------------------
-- ② 불변 핵심 재생성 + 지우기 가드
-- ---------------------------------------------------------------------------

DROP TRIGGER users_immutable_core ON users;
CREATE TRIGGER users_immutable_core
  BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION reject_column_update_except('last_organization_id', 'email', 'erased_at');

CREATE OR REPLACE FUNCTION users_erasure_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.erased_at IS NOT NULL THEN
      RAISE EXCEPTION 'users.erased_at cannot be set on insert' USING ERRCODE = '23514';
    END IF;
    -- 자리표시 도메인은 지우기만 쓴다 — 미리 차지하면 그 사용자의 지우기가 UNIQUE 위반으로 영원히 막힌다.
    IF split_part(NEW.email, '@', 2) = 'erased.invalid' THEN
      RAISE EXCEPTION 'users.email domain erased.invalid is reserved' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.email IS DISTINCT FROM OLD.email OR NEW.erased_at IS DISTINCT FROM OLD.erased_at THEN
    IF NOT pg_has_role(current_user, (SELECT c.relowner FROM pg_catalog.pg_class c WHERE c.oid = TG_RELID), 'USAGE') THEN
      RAISE EXCEPTION 'user % address can only be erased by erase_invited_only_user', OLD.id USING ERRCODE = '42501';
    END IF;
    IF OLD.erased_at IS NOT NULL THEN
      RAISE EXCEPTION 'user % is already erased', OLD.id USING ERRCODE = '23514';
    END IF;
    IF NEW.erased_at IS NULL OR NEW.email IS DISTINCT FROM ('erased-' || OLD.id::text || '@erased.invalid') THEN
      RAISE EXCEPTION 'user % address can only change to its erased placeholder together with erased_at', OLD.id USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER users_erasure_guard
  BEFORE INSERT OR UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION users_erasure_guard();


-- ---------------------------------------------------------------------------
-- ⑧ 색인 — 멤버십 이력(제거 포함) · 주 소유자 주소
-- ---------------------------------------------------------------------------

CREATE INDEX memberships_user_idx ON memberships (user_id);
CREATE INDEX organizations_owner_email_idx ON organizations (owner_email);

-- ---------------------------------------------------------------------------
-- ③ invited_only_user_erasable — 지우기 조건 하나의 정의
-- ---------------------------------------------------------------------------

-- SECURITY DEFINER 가 아니다(부르는 쪽 권한으로 돈다) · SET 이 없어 후보 질의에 인라인된다. 이름은 전부 스키마로 적는다. EXECUTE 는 소유자만.
CREATE OR REPLACE FUNCTION invited_only_user_erasable(p_user_id uuid, p_email text) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT NOT EXISTS (SELECT 1 FROM public.memberships m WHERE m.user_id = p_user_id)
     -- 마지막 초대의 끝(수락·취소·만료) ≤ 30일 전. 초대가 없으면 NULL → 거짓. 대기 초대(끝 = 미래 만료)는 여기서 빠진다.
     AND coalesce((SELECT max(coalesce(i.accepted_at, i.revoked_at, i.expires_at)) FROM public.org_invites i WHERE i.user_id = p_user_id)
                  <= pg_catalog.now() - interval '30 days', false)
     -- 초대 메일 outbox 에 대기 행 없음(지운 주소로 메일이 나가지 않게 — 만료된 대기 행은 발송 워커가 obsolete 로 닫는다).
     AND NOT EXISTS (SELECT 1 FROM public.org_invites i WHERE i.user_id = p_user_id AND i.status = 'pending')
     -- 살아 있는 로그인 링크 없음(쓸 수 있거나 아직 안 보낸 것).
     AND NOT EXISTS (SELECT 1 FROM public.owner_login_links l
                      WHERE l.user_id = p_user_id AND ((l.used_at IS NULL AND l.expires_at > pg_catalog.now()) OR l.status = 'pending'))
     -- 어느 조직의 주 소유자 주소도 아니다(그 조직의 owner 멤버십이 있어야 하므로 위에서 걸리지만 한 번 더).
     AND NOT EXISTS (SELECT 1 FROM public.organizations o WHERE o.owner_email = p_email)
$$;

REVOKE ALL ON FUNCTION invited_only_user_erasable(uuid, text) FROM PUBLIC;

-- ---------------------------------------------------------------------------
-- ④ erase_invited_only_user
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION erase_invited_only_user(p_user_id uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_user public.users%ROWTYPE;
BEGIN
  IF p_user_id IS NULL THEN
    RETURN false;
  END IF;
  -- 잠금 — 초대 INSERT(⑦ FOR KEY SHARE)·로그인 링크·멤버십 INSERT(FK) 와 줄을 선다. **기다리지 않는다**(NOWAIT → 55P03, 배치는 건너뛴다).
  SELECT * INTO v_user FROM public.users WHERE id = p_user_id FOR UPDATE NOWAIT;
  IF NOT FOUND OR v_user.erased_at IS NOT NULL THEN
    RETURN false;
  END IF;
  -- 가입 확정(create_signup_organization)과 같은 advisory 키 — 그 주소로 가입 확정이 진행 중이면 이번엔 건너뛴다(기다리지 않는다).
  IF NOT pg_catalog.pg_try_advisory_xact_lock(pg_catalog.hashtextextended('signup_email:' || v_user.email, 0)) THEN
    RETURN false;
  END IF;
  -- 잠금 뒤의 새 스냅샷으로 조건 전부 다시(배치 후보 선정과 같은 식).
  IF NOT public.invited_only_user_erasable(p_user_id, v_user.email) THEN
    RETURN false;
  END IF;

  UPDATE public.users
     SET email = 'erased-' || p_user_id::text || '@erased.invalid',
         erased_at = pg_catalog.now()
   WHERE id = p_user_id;
  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION erase_invited_only_user(uuid) FROM PUBLIC;

-- ---------------------------------------------------------------------------
-- ⑤ erase_invited_only_users — 보존 과제의 배치
-- ---------------------------------------------------------------------------

-- 비용 상한: 배치 크기는 함수 안에서 1–500 으로 자른다(앱 롤이 큰 값을 넘겨도 일이 늘지 않는다). 배치 안에서는 기다리지 않는다(④ 의
--   NOWAIT · try-lock). 이미 지운 행은 후보에서 빠지므로 몇 번을 불러도 같은 결과로 수렴한다(멱등).
CREATE OR REPLACE FUNCTION erase_invited_only_users(p_limit integer, OUT erased integer, OUT skipped integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_id    uuid;
  v_limit integer := least(greatest(coalesce(p_limit, 1), 1), 500);
BEGIN
  erased := 0;
  skipped := 0;
  -- 후보 = 최종 판정(③)과 **같은 식**. 초대 있는 사용자만 먼저 좁힌다(`org_invites (user_id, created_at)` 색인).
  FOR v_id IN
    SELECT u.id FROM public.users u
     WHERE u.erased_at IS NULL
       AND EXISTS (SELECT 1 FROM public.org_invites i WHERE i.user_id = u.id)
       AND public.invited_only_user_erasable(u.id, u.email)
     ORDER BY u.id
     LIMIT v_limit
  LOOP
    BEGIN
      IF public.erase_invited_only_user(v_id) THEN
        erased := erased + 1;
      ELSE
        skipped := skipped + 1;
      END IF;
    EXCEPTION
      WHEN unique_violation OR check_violation OR foreign_key_violation OR lock_not_available OR deadlock_detected OR serialization_failure THEN
        skipped := skipped + 1;
    END;
  END LOOP;
END;
$$;

REVOKE ALL ON FUNCTION erase_invited_only_users(integer) FROM PUBLIC;

-- ---------------------------------------------------------------------------
-- ⑥ invited_user_erasure_backlog — 약속을 7일 넘긴 행 수(알람)
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION invited_user_erasure_backlog() RETURNS integer
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT count(*)::int FROM public.users u
   WHERE u.erased_at IS NULL
     AND NOT EXISTS (SELECT 1 FROM public.memberships m WHERE m.user_id = u.id)
     AND (SELECT max(coalesce(i.accepted_at, i.revoked_at, i.expires_at)) FROM public.org_invites i WHERE i.user_id = u.id)
         <= now() - interval '37 days'
$$;

REVOKE ALL ON FUNCTION invited_user_erasure_backlog() FROM PUBLIC;

-- ---------------------------------------------------------------------------
-- ⑦ 초대 INSERT — 지운 사용자 행에는 붙지 않는다
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION org_invites_invitee_live() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  -- FOR KEY SHARE: 지우기(FOR UPDATE)가 진행 중이면 기다렸다가 커밋된 최신 행을 본다(READ COMMITTED 재평가).
  PERFORM 1 FROM public.users WHERE id = NEW.user_id AND erased_at IS NULL FOR KEY SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'invitee_erased' USING ERRCODE = 'AT409', DETAIL = 'invitee address was erased — invite the address again';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER org_invites_invitee_live
  BEFORE INSERT ON org_invites
  FOR EACH ROW EXECUTE FUNCTION org_invites_invitee_live();

-- ---------------------------------------------------------------------------
-- 권한
-- ---------------------------------------------------------------------------

REVOKE ALL ON FUNCTION invited_only_user_erasable(uuid, text) FROM atmark_app, atmark_admin, atmark_login_mailer;
REVOKE ALL ON FUNCTION erase_invited_only_user(uuid) FROM atmark_app, atmark_admin, atmark_login_mailer;
REVOKE ALL ON FUNCTION erase_invited_only_users(integer) FROM atmark_admin, atmark_login_mailer;
REVOKE ALL ON FUNCTION invited_user_erasure_backlog() FROM atmark_admin, atmark_login_mailer;
GRANT EXECUTE ON FUNCTION erase_invited_only_users(integer) TO atmark_app;
GRANT EXECUTE ON FUNCTION invited_user_erasure_backlog() TO atmark_app;
