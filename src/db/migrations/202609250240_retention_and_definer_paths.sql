-- 202609250240_retention_and_definer_paths.sql
-- ADR-0010 후속 L5·L7 적대적 검토의 뒷정리 — M2(가입 링크 보존) · L1(SECURITY DEFINER search_path).
--
-- 세우는 것:
--   ① 가입 링크 보존 — 쓰이지 않은 가입 링크(`signup_links`, 주소·조직 이름)는 영원히 남았다(`signup_links_no_delete`). 누군가 남의 주소로
--      가입을 청하면 그 주소가 기한 없이 남는다. 이제 **만료 30일 뒤** 지운다:
--        - `signup_links_no_delete` 재생성(같은 이름 — 같은 BEFORE DELETE 자리) · 함수만 `signup_links_delete_guard()` 로 바꾼다:
--          **테이블 소유자(= 아래 보존 함수·운영자 셸)만** · 쓰이지 않았고(`used_at IS NULL`) · 발송이 끝났고(`status <> 'pending'`) ·
--          만료가 30일 전 이하인 행만. 나머지(쓰인 링크 = 계정의 가입 기록 · 대기 · 30일 안)는 예전과 같은 문장으로 거부한다.
--          소유자 판별은 `organizations_review_guard` 와 같다(`pg_has_role(current_user, relowner)`). 다른 롤은 DELETE 권한이 애초에 없다.
--        - SECURITY DEFINER `purge_expired_signup_links()` — 인자 없음 · 위 조건 + 세션이 가리키지 않는 행 · 한 번에 5 000 · 지운 수.
--          앱 롤(TTL 스위퍼 approval-expiry, 하루 창)만 EXECUTE. 무엇을 지울지 호출자가 고르지 못한다.
--      시간당·하루 가입 상한은 `claimed_at`·`used_at` 의 1시간·24시간 창만 보므로 30일 넘은 행을 지워도 상한 계산은 그대로다.
--   ② 기존 SECURITY DEFINER 함수의 search_path 에 `pg_temp` 를 **마지막에** 적는다(적대적 검토 L1). 적지 않으면 pg_temp 가 암묵으로
--      **맨 앞**에서 먼저 찾아진다(관계 이름) — TEMPORARY 권한이 있는 호출자가 같은 이름의 임시 표로 함수의 질의를 가로챌 수 있다.
--      제한 롤들은 TEMPORARY 가 없다(migrate `status` 의 `databaseTempRoles`)지만 방어를 한 겹 더 둔다. 이미 `public, pg_temp` 인 함수
--      (`tlog_enqueue` · `owner_action_actor_emails`)는 그대로 둔다(pg_catalog 는 적지 않아도 맨 앞이다). migrate `status` 의
--      `unsafeSecurityDefiners` 가 이제 "pg_temp 가 마지막" 을 요구한다.
--
-- 마이그레이션은 append-only 다. 기존 파일은 건드리지 않았다(함수 설정은 ALTER FUNCTION 으로).

-- 잠금 대기 상한(적대적 검토 M5): `signup_links` 트리거를 바꾼다(SHARE ROW EXCLUSIVE) — 가입 요청·발송 워커가 쓰는 표다.
SET LOCAL lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- ① 가입 링크 보존
-- ---------------------------------------------------------------------------

CREATE FUNCTION signup_links_delete_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF pg_has_role(current_user, (SELECT c.relowner FROM pg_catalog.pg_class c WHERE c.oid = TG_RELID), 'USAGE')
     AND OLD.used_at IS NULL
     AND OLD.status <> 'pending'
     AND OLD.expires_at <= now() - interval '30 days' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'rows in % are append-only and cannot be deleted', TG_TABLE_NAME
    USING ERRCODE = '23514', DETAIL = 'only unused, settled signup links 30 days past expiry are purged (purge_expired_signup_links)';
END;
$$;

DROP TRIGGER signup_links_no_delete ON signup_links;
CREATE TRIGGER signup_links_no_delete
  BEFORE DELETE ON signup_links
  FOR EACH ROW EXECUTE FUNCTION signup_links_delete_guard();

CREATE FUNCTION purge_expired_signup_links() RETURNS integer
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
  )
  SELECT count(*)::int FROM gone
$$;

COMMENT ON FUNCTION purge_expired_signup_links() IS
  '쓰이지 않은 가입 링크 보존 — 발송이 끝났고 만료 30일이 지난 행만, 한 번에 5 000, 지운 수(ADR-0010 L7 후속 M2). 인자 없음. 앱 롤(TTL 스위퍼)만 EXECUTE.';

REVOKE ALL ON FUNCTION purge_expired_signup_links() FROM PUBLIC;
REVOKE ALL ON FUNCTION purge_expired_signup_links() FROM atmark_admin, atmark_login_mailer;
GRANT EXECUTE ON FUNCTION purge_expired_signup_links() TO atmark_app;

-- ---------------------------------------------------------------------------
-- ② SECURITY DEFINER search_path — pg_temp 마지막
-- ---------------------------------------------------------------------------

ALTER FUNCTION approval_requests_enqueue_notification() SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION approval_requests_schedule_release() SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION organizations_owner_email_revokes_sessions() SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION create_signup_organization(uuid, text, timestamptz) SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION signup_email_suppressed(text) SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION passport_agent_organization_active(text) SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION organizations_owner_membership() SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION organizations_owner_email_moves_membership() SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION create_member_organization(uuid, text) SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION accept_org_invite(uuid, uuid, timestamptz) SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION org_invite_sendable(uuid) SET search_path = pg_catalog, public, pg_temp;
