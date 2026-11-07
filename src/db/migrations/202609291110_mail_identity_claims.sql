-- 202609291110_mail_identity_claims.sql
-- 에이전트 주소와 사람 이메일의 **상호 배제**(ADR-0014 결정 7 · 계획 §3.2 M9 · critic 1·3 · 보안 M1 반영판).
--
-- 고객 도메인이 열리면 같은 `bob@agents.customer.com` 이 에이전트 주소이면서 콘솔 사용자(소유자·멤버)일 수 있다 — 에이전트가 자기 소유자 주소로
-- 오는 로그인 링크·승인 알림을 받아 **스스로 승인하거나 콘솔을 가져간다.** 공용 claim 표 하나에 양쪽이 줄을 선다.
--
--   (`organizations.billing_email_is_agent` 칸은 202609291109 가 따로 더한다 — ACCESS EXCLUSIVE 를 몇 ms 만 쥐도록, 재리뷰 M2a.)
--   ① `mail_identity_claims(claim_hash, kind, source_table, source_id)` — 평문 없음: `claim_hash = sha256(atmark_mail_claim_key(address))`.
--      키 = 로컬파트의 첫 `+` 앞(소문자 — **비어 있으면 로컬파트 전체**, critic 1) || '@' || 도메인(소문자). TS `mailClaimKey` 와 같은 표(통합 테스트).
--      종류 셋(critic 3 — `src/domains/contract.ts` `MAIL_CLAIM_KINDS`):
--        · `agent` — 에이전트 주소(대표·별칭). **톰스톤**(지우지 않는다 — 폐기·재발급·도메인 제거와 무관).
--        · `human_member` — 멤버십이 한 번이라도 있었던 사용자 · 조직 소유자 주소. 에이전트와 충돌하면 P0A01(어느 쪽이 먼저든).
--        · `human_invitee` — 초대만 받은 사용자(`users` INSERT — 초대가 사용자 행을 만든다, `members.ts`). 아무 조직이나 아무 주소로 초대할 수
--          있으므로 이 claim 이 에이전트 발급을 막으면 **초대로 남의 에이전트 로컬파트를 선점**한다 → 에이전트 발급이 이긴다: 그 claim 을 지우고
--          그 사용자의 대기 초대를 취소한다(`revoked_at` — 202609250120 가드가 안 보낸 메일을 obsolete 로 닫는다). 초대 INSERT · 멤버십
--          INSERT(수락) 는 에이전트 claim 을 다시 보고 있으면 P0A01(닫힌 쪽).
--      사람 claim(두 종류 모두)은 그 주소의 도메인을 어느 조직이든 지금 쥐고 있으면(verifying·verified·suspended) P0A01 — 에이전트 서브도메인은
--      에이전트 전용이다(보안 M1).
--   ② `atmark_claim_mail_identity(address, kind, table, id)` — 키 잠금 아래에서 위 규칙. 트리거만 부른다(EXECUTE 는 아무 롤에도 없다).
--   ③ 트리거: `agent_addresses` BEFORE INSERT(`…_zz_…` — 다른 BEFORE 트리거 뒤, 잠금 순서 주소 → 도메인 행 → claim) · `users` AFTER INSERT
--      (invitee) · AFTER UPDATE OF email(옛 claim 을 모두 풀고 새 값을 — 멤버였으면 member, 아니면 invitee — 잡는다. 지운 자리표시는 잡지 않는다)
--      · `memberships` AFTER INSERT(member) · `organizations` AFTER INSERT · UPDATE OF owner_email(member) · `org_invites` BEFORE INSERT(invitee 재확인).
--   ④ `atmark_is_agent_mail_identity(email)` — 해시로 agent claim 이 있는지만(§3.15 Paddle 청구 이메일). `atmark_billing` 만 EXECUTE.
--   ⑤ **백필** — 에이전트 주소(폐기 포함) → agent · 멤버십이 있었던 사용자 → member · 그 밖의 지우지 않은 사용자 → invitee · 소유자 주소 → member.
--      **에이전트와 어떤 사람 claim 의 교집합이든 하나라도 있으면 이 파일이 실패한다**(값 없이 개수만). 로컬 두 DB 0건. 배포 전 사전 질의
--      (런북 custom-domains.md): 교집합 0 · `+` 로 시작하는 사용자·소유자 주소 수(`SELECT count(*) FROM users WHERE email LIKE '+%'` ·
--      `… organizations WHERE owner_email LIKE '+%'`) — 이 판은 그 주소도 키를 만든다(로컬파트 전체).
--
-- 해시는 키 없는 SHA-256 이다(HMAC 기각 — ADR-0014 결정 7: 키가 같은 DB·백업에 있어 실제 위협(소유자 롤·백업 유출)에 이득이 없고, 키 회전이 전
-- claim 을 무효로 만든다). 이 표는 어떤 런타임 롤도 읽지 못한다. 사람 claim 은 주소가 지워지면 풀린다(삭제 요청 경로와 같은 트랜잭션).
--
-- 잠금: 새 표 · 함수 · 트리거(agent_addresses · users · memberships · organizations · org_invites — 짧은 SHARE ROW EXCLUSIVE) · 백필 INSERT.
-- 5초 안에 못 잡으면 실패하고 아무것도 바뀌지 않는다.

SET LOCAL lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- ① 표
-- ---------------------------------------------------------------------------

CREATE TABLE mail_identity_claims (
  claim_hash    bytea NOT NULL CHECK (octet_length(claim_hash) = 32),
  kind          text NOT NULL CHECK (kind IN ('agent', 'human_member', 'human_invitee')),
  source_table  text NOT NULL CHECK (source_table IN ('agent_addresses', 'users', 'organizations')),
  source_id     text NOT NULL CHECK (source_id ~ '^[0-9a-f-]{32,36}$'),
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (claim_hash, kind, source_table, source_id),
  CONSTRAINT mail_identity_claims_kind_source CHECK (
    (kind = 'agent' AND source_table = 'agent_addresses')
    OR (kind = 'human_member' AND source_table IN ('users', 'organizations'))
    OR (kind = 'human_invitee' AND source_table = 'users'))
);

-- 사람 claim 풀기(원천 행으로 찾는다).
CREATE INDEX mail_identity_claims_source_idx ON mail_identity_claims (source_table, source_id);

COMMENT ON TABLE mail_identity_claims IS
  '에이전트 주소와 사람 이메일의 상호 배제(ADR-0014 M9). 평문 없음 — sha256(atmark_mail_claim_key). agent claim 은 지우지 않는다(톰스톤). 어떤 런타임 롤도 권한 0.';

-- 에이전트 claim 은 톰스톤이다 — 정의자 함수(소유자)도 지우지 못한다.
CREATE FUNCTION mail_identity_claims_agent_tombstone() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF OLD.kind = 'agent' THEN
    RAISE EXCEPTION 'mail_identity_claims: 에이전트 claim 은 지우지 않는다' USING ERRCODE = '23514';
  END IF;
  RETURN OLD;
END;
$$;

CREATE TRIGGER mail_identity_claims_agent_tombstone BEFORE DELETE ON mail_identity_claims
  FOR EACH ROW EXECUTE FUNCTION mail_identity_claims_agent_tombstone();
CREATE TRIGGER mail_identity_claims_no_update BEFORE UPDATE ON mail_identity_claims
  FOR EACH ROW EXECUTE FUNCTION reject_column_update_except();
CREATE TRIGGER mail_identity_claims_no_truncate AFTER TRUNCATE ON mail_identity_claims
  FOR EACH STATEMENT EXECUTE FUNCTION reject_truncate();

-- ---------------------------------------------------------------------------
-- ② 함수
-- ---------------------------------------------------------------------------

-- 판정형 키 — `mailClaimKey`(TS)와 같다: 마지막 `@` 로 나눠 로컬파트의 첫 `+` 앞(비면 로컬파트 전체)을 소문자로, 도메인을 소문자로.
-- 주소가 아니면 NULL.
CREATE FUNCTION atmark_mail_claim_key(p_address text) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path = pg_catalog, public AS $$
  SELECT CASE
           WHEN whole IS NULL OR domain_part IS NULL OR whole = '' OR domain_part = '' THEN NULL
           ELSE lower(CASE WHEN split_part(whole, '+', 1) = '' THEN whole ELSE split_part(whole, '+', 1) END) || '@' || lower(domain_part)
         END
    FROM (SELECT substring(p_address FROM '^(.*)@[^@]*$') AS whole,
                 substring(p_address FROM '@([^@]*)$') AS domain_part) AS parts
$$;

CREATE FUNCTION atmark_mail_claim_hash(p_address text) RETURNS bytea
LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path = pg_catalog, public AS $$
  SELECT sha256(convert_to(public.atmark_mail_claim_key(p_address), 'UTF8'))
$$;

CREATE FUNCTION atmark_claim_mail_identity(p_address text, p_kind text, p_source_table text, p_source_id text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  claim_key text := public.atmark_mail_claim_key(p_address);
  claim bytea;
  overridden text[];
BEGIN
  IF claim_key IS NULL THEN
    RAISE EXCEPTION 'mail_identity_claims: 주소 모양이 아니다' USING ERRCODE = '22023';
  END IF;
  IF p_kind NOT IN ('agent', 'human_member', 'human_invitee') THEN
    RAISE EXCEPTION 'mail_identity_claims: 모르는 kind' USING ERRCODE = '22023';
  END IF;
  claim := sha256(convert_to(claim_key, 'UTF8'));
  -- 같은 키를 다투는 트랜잭션(에이전트 발급 ↔ 초대·가입·수락)을 줄 세운다. 잠금을 얻은 뒤의 조회는 그 사이 커밋된 claim 을 본다.
  PERFORM pg_advisory_xact_lock(hashtextextended('mail_identity_claim:' || claim_key, 0));
  IF p_kind = 'agent' THEN
    IF EXISTS (SELECT 1 FROM public.mail_identity_claims c WHERE c.claim_hash = claim AND c.kind = 'human_member') THEN
      -- 값은 싣지 않는다(어느 쪽이 먼저였는지도).
      RAISE EXCEPTION 'mail_identity_conflict' USING ERRCODE = 'P0A01';
    END IF;
    -- 초대만 받은 사람은 에이전트에게 진다 — claim 을 지우고 그 사용자의 대기 초대를 취소한다(초대로 남의 로컬파트를 선점하지 못하게).
    WITH gone AS (
      DELETE FROM public.mail_identity_claims c WHERE c.claim_hash = claim AND c.kind = 'human_invitee' RETURNING c.source_id
    )
    SELECT array_agg(source_id) INTO overridden FROM gone;
    IF overridden IS NOT NULL THEN
      UPDATE public.org_invites i
         SET revoked_at = pg_catalog.now()
       WHERE i.user_id::text = ANY (overridden) AND i.accepted_at IS NULL AND i.revoked_at IS NULL;
    END IF;
  ELSE
    IF EXISTS (SELECT 1 FROM public.mail_identity_claims c WHERE c.claim_hash = claim AND c.kind = 'agent') THEN
      RAISE EXCEPTION 'mail_identity_conflict' USING ERRCODE = 'P0A01';
    END IF;
    -- 에이전트 서브도메인은 에이전트 전용이다(보안 M1) — 어느 조직이든 그 도메인을 쥐고 있으면 사람 주소가 될 수 없다.
    IF EXISTS (SELECT 1 FROM public.custom_domains d
                WHERE d.domain = split_part(claim_key, '@', 2) AND d.status IN ('verifying', 'verified', 'suspended')) THEN
      RAISE EXCEPTION 'mail_identity_conflict' USING ERRCODE = 'P0A01';
    END IF;
  END IF;
  INSERT INTO public.mail_identity_claims (claim_hash, kind, source_table, source_id)
  VALUES (claim, p_kind, p_source_table, p_source_id)
  ON CONFLICT DO NOTHING;
END;
$$;

REVOKE ALL ON FUNCTION atmark_claim_mail_identity(text, text, text, text) FROM PUBLIC;

CREATE FUNCTION atmark_is_agent_mail_identity(p_email text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM public.mail_identity_claims c WHERE c.claim_hash = public.atmark_mail_claim_hash(p_email) AND c.kind = 'agent')
$$;

REVOKE ALL ON FUNCTION atmark_is_agent_mail_identity(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION atmark_is_agent_mail_identity(text) TO atmark_billing;

-- ---------------------------------------------------------------------------
-- ③ 트리거
-- ---------------------------------------------------------------------------

CREATE FUNCTION agent_addresses_mail_identity_claim() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  PERFORM public.atmark_claim_mail_identity(NEW.address, 'agent', 'agent_addresses', NEW.id::text);
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION agent_addresses_mail_identity_claim() FROM PUBLIC;

CREATE TRIGGER agent_addresses_zz_mail_identity_claim BEFORE INSERT ON agent_addresses
  FOR EACH ROW EXECUTE FUNCTION agent_addresses_mail_identity_claim();

-- 사용자 — INSERT 는 invitee(초대가 사용자 행을 만든다), 주소 변경(지우기)은 옛 claim 을 모두 풀고 새 값을 다시 잡는다.
CREATE FUNCTION users_mail_identity_claim() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF OLD.email IS NOT DISTINCT FROM NEW.email THEN
      RETURN NULL;
    END IF;
    DELETE FROM public.mail_identity_claims c
     WHERE c.source_table = 'users' AND c.source_id = NEW.id::text AND c.kind IN ('human_member', 'human_invitee');
  END IF;
  -- 지운 자리표시(`erased-<id>@erased.invalid`, 202609250220)는 사람의 주소가 아니다.
  IF split_part(NEW.email, '@', 2) <> 'erased.invalid' THEN
    PERFORM public.atmark_claim_mail_identity(
      NEW.email,
      CASE WHEN EXISTS (SELECT 1 FROM public.memberships m WHERE m.user_id = NEW.id) THEN 'human_member' ELSE 'human_invitee' END,
      'users',
      NEW.id::text);
  END IF;
  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION users_mail_identity_claim() FROM PUBLIC;

CREATE TRIGGER users_mail_identity_claim AFTER INSERT OR UPDATE OF email ON users
  FOR EACH ROW EXECUTE FUNCTION users_mail_identity_claim();

-- 멤버십 — 초대 수락 · 가입 · 조직 만들기. 에이전트 claim 이 있으면 P0A01(닫힌 쪽).
CREATE FUNCTION memberships_mail_identity_claim() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  address text;
BEGIN
  SELECT u.email INTO address FROM public.users u WHERE u.id = NEW.user_id;
  IF address IS NOT NULL AND split_part(address, '@', 2) <> 'erased.invalid' THEN
    PERFORM public.atmark_claim_mail_identity(address, 'human_member', 'users', NEW.user_id::text);
  END IF;
  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION memberships_mail_identity_claim() FROM PUBLIC;

CREATE TRIGGER memberships_mail_identity_claim AFTER INSERT ON memberships
  FOR EACH ROW EXECUTE FUNCTION memberships_mail_identity_claim();

-- 조직 소유자 주소 — member.
CREATE FUNCTION organizations_mail_identity_claim() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF OLD.owner_email IS NOT DISTINCT FROM NEW.owner_email THEN
      RETURN NULL;
    END IF;
    DELETE FROM public.mail_identity_claims c WHERE c.source_table = 'organizations' AND c.source_id = NEW.id::text AND c.kind = 'human_member';
  END IF;
  IF NEW.owner_email IS NOT NULL THEN
    PERFORM public.atmark_claim_mail_identity(NEW.owner_email, 'human_member', 'organizations', NEW.id::text);
  END IF;
  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION organizations_mail_identity_claim() FROM PUBLIC;

CREATE TRIGGER organizations_mail_identity_claim AFTER INSERT OR UPDATE OF owner_email ON organizations
  FOR EACH ROW EXECUTE FUNCTION organizations_mail_identity_claim();

-- 초대 — 이미 있는 사용자를 초대할 때도(사용자 INSERT 가 없다) 에이전트 claim · 에이전트 도메인을 다시 본다(invitee claim 을 다시 잡는다).
CREATE FUNCTION org_invites_mail_identity_claim() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  address text;
BEGIN
  SELECT u.email INTO address FROM public.users u WHERE u.id = NEW.user_id;
  IF address IS NOT NULL AND split_part(address, '@', 2) <> 'erased.invalid' THEN
    PERFORM public.atmark_claim_mail_identity(address, 'human_invitee', 'users', NEW.user_id::text);
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION org_invites_mail_identity_claim() FROM PUBLIC;

CREATE TRIGGER org_invites_mail_identity_claim BEFORE INSERT ON org_invites
  FOR EACH ROW EXECUTE FUNCTION org_invites_mail_identity_claim();

-- ---------------------------------------------------------------------------
-- ⑤ 백필 — 교집합이 있으면 실패(값 없이 개수만)
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  conflicts integer;
BEGIN
  WITH agent_keys AS (
    SELECT DISTINCT atmark_mail_claim_hash(address) AS h FROM agent_addresses
  ), human_keys AS (
    SELECT DISTINCT atmark_mail_claim_hash(email) AS h FROM users WHERE split_part(email, '@', 2) <> 'erased.invalid'
    UNION
    SELECT DISTINCT atmark_mail_claim_hash(owner_email) FROM organizations WHERE owner_email IS NOT NULL
  )
  SELECT count(*) INTO conflicts FROM agent_keys a JOIN human_keys h ON h.h = a.h;
  IF conflicts > 0 THEN
    RAISE EXCEPTION 'mail_identity_claims 백필: 에이전트 주소와 사람 이메일의 판정형 교집합이 % 건 — 런북 custom-domains.md 사전 질의로 먼저 정리한다', conflicts
      USING ERRCODE = 'P0A01';
  END IF;
END;
$$;

INSERT INTO mail_identity_claims (claim_hash, kind, source_table, source_id)
SELECT atmark_mail_claim_hash(address), 'agent', 'agent_addresses', id::text FROM agent_addresses
ON CONFLICT DO NOTHING;

INSERT INTO mail_identity_claims (claim_hash, kind, source_table, source_id)
SELECT atmark_mail_claim_hash(u.email),
       CASE WHEN EXISTS (SELECT 1 FROM memberships m WHERE m.user_id = u.id) THEN 'human_member' ELSE 'human_invitee' END,
       'users', u.id::text
  FROM users u WHERE split_part(u.email, '@', 2) <> 'erased.invalid'
ON CONFLICT DO NOTHING;

INSERT INTO mail_identity_claims (claim_hash, kind, source_table, source_id)
SELECT atmark_mail_claim_hash(owner_email), 'human_member', 'organizations', id::text FROM organizations WHERE owner_email IS NOT NULL
ON CONFLICT DO NOTHING;
