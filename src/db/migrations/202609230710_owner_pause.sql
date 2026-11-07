-- 202609230710_owner_pause.sql
-- 소유자 정지와 플랫폼 동결을 **나눈다** (관리 콘솔 검증 H3 · M2 · L5).
--
-- 무엇이 틀렸나: 콘솔의 `POST /api/kill-switch` 가 운영자 스위치(`organizations.abuse_freeze` — abuse 알람·운영자 CLI 가
--   켜는 플랫폼 동결)와 운영자가 건 에이전트 정지를 **소유자 세션 하나로 풀 수 있었다**. 동결 대상 조직의 소유자가 자기
--   동결을 푸는 입구다. 이제:
--   ① `organizations.owner_paused` — 소유자가 켜고 끄는 조직 정지. Stage 0 은 `abuse_freeze OR owner_paused` 를 거부하되
--      사유 코드를 나눈다(`org_owner_paused` · `org_abuse_freeze`). 콘솔은 이 컬럼만 바꾼다. `abuse_freeze` 는 운영자 CLI 만.
--   ② `agents.suspended_by` — 누가 정지했나(`owner` | `operator`). `status = 'suspended'` 와 정확히 함께 산다(CHECK).
--      소유자는 자기 정지만 풀고, 운영자 정지는 운영자만 푼다(`src/admin/ops/agents.ts`).
--      기존 정지 행은 `operator` 로 채운다 — 누가 걸었는지 모르는 정지를 소유자가 풀 수 있게 두지 않는 쪽(fail closed).
--   ③ `owner_login_links.client_key` — 로그인 링크를 요청한 요청자 키(HMAC). 링크 상한을 조직 하나가 아니라
--      (조직, 요청자) 로 건다 — 조직당 5개 상한은 **아무나** 5번 요청해 소유자를 한 시간 잠글 수 있었다(M2).
--      요청자 키는 `owner_login_requests.client_key` 와 같은 값이고(IP 평문 없음), 앱 롤에는 SELECT 도 주지 않는다.
--   ④ `owner_email` 이 바뀌면 그 조직의 살아 있는 소유자 세션을 **전부 폐기**한다(L5) — 옛 소유자의 12시간 세션이 새
--      소유자의 조직에 남지 않게. 지금 코드에는 owner_email 을 바꾸는 경로가 없다(조직 생성 때 INSERT 뿐) — 이 트리거는
--      운영자의 수동 UPDATE 와 앞으로 생길 경로를 덮는다. 트리거 함수는 SECURITY DEFINER 다 — `owner_email` 을 바꿀 수 있는
--      롤이 `owner_sessions` 권한을 갖지 않아도(앱 롤은 organizations 테이블 UPDATE 를 갖고 세션 권한은 0) 폐기가 **빠지지
--      않게**. 함수가 하는 일은 고정된 한 문장(그 조직의 세션 폐기)뿐이고 search_path 를 고정한다.
--
-- 권한: 새 컬럼은 기존 테이블 GRANT 를 따른다(`organizations`·`agents` 는 앱 롤 테이블 단위 GRANT). `owner_login_links` 는
--   컬럼 단위 GRANT 라 앱 롤은 `client_key` 를 읽지도 못한다. 관리 Lambda 전용 롤이 생기면 그 롤에
--   `organizations(owner_paused)` UPDATE · `agents(status, suspended_by)` UPDATE · `owner_login_links(client_key)` INSERT 가 필요하다.
--
-- 마이그레이션은 append-only 다. 기존 파일은 한 글자도 건드리지 않았다.

-- ---------------------------------------------------------------------------
-- ① organizations.owner_paused
-- ---------------------------------------------------------------------------

ALTER TABLE organizations ADD COLUMN owner_paused boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN organizations.owner_paused IS
  '소유자 조직 정지(콘솔). Stage 0 org_owner_paused. 플랫폼 동결(abuse_freeze)과 별개 — 소유자는 abuse_freeze 를 바꾸지 못한다.';

-- ---------------------------------------------------------------------------
-- ② agents.suspended_by
-- ---------------------------------------------------------------------------

ALTER TABLE agents ADD COLUMN suspended_by text CHECK (suspended_by IN ('owner', 'operator'));

-- 누가 걸었는지 모르는 기존 정지 = 운영자 정지(소유자가 풀 수 없는 쪽).
UPDATE agents SET suspended_by = 'operator' WHERE status = 'suspended' AND suspended_by IS NULL;

ALTER TABLE agents ADD CONSTRAINT agents_suspended_by_matches_status
  CHECK ((status = 'suspended') = (suspended_by IS NOT NULL));

COMMENT ON COLUMN agents.suspended_by IS
  '정지한 주체(owner=콘솔, operator=운영자 CLI). status=suspended 일 때만 NOT NULL. 소유자는 operator 정지를 풀 수 없다.';

-- ---------------------------------------------------------------------------
-- ③ owner_login_links.client_key
-- ---------------------------------------------------------------------------

-- NULL 허용: 이 컬럼 전에 적힌 링크. 새 링크는 전부 채운다(`src/admin/session.ts`). 불변 트리거
--   (`owner_login_links_immutable_core` — 목록 밖 컬럼 UPDATE 거부)가 이 컬럼도 덮는다.
ALTER TABLE owner_login_links ADD COLUMN client_key text CHECK (client_key ~ '^[0-9a-f]{64}$');

CREATE INDEX owner_login_links_org_client_created_idx ON owner_login_links (organization_id, client_key, created_at);

-- ---------------------------------------------------------------------------
-- ④ owner_email 변경 → 소유자 세션 전부 폐기
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION organizations_owner_email_revokes_sessions() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  UPDATE public.owner_sessions SET revoked_at = now() WHERE organization_id = NEW.id AND revoked_at IS NULL;
  RETURN NULL;
END;
$$;

CREATE TRIGGER organizations_owner_email_revokes_sessions
  AFTER UPDATE OF owner_email ON organizations
  FOR EACH ROW
  WHEN (OLD.owner_email IS DISTINCT FROM NEW.owner_email)
  EXECUTE FUNCTION organizations_owner_email_revokes_sessions();

REVOKE ALL ON FUNCTION organizations_owner_email_revokes_sessions() FROM PUBLIC;
