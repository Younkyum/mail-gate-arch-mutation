-- 202609230700_owner_admin_sessions.sql
-- 관리 백엔드 — 소유자 로그인(매직링크) · 세션 · 감사 (`.omc/handoffs/admin-mcp-contract.md`).
--
-- 넷을 세운다:
--   ① `owner_login_links`    — 로그인 링크 **겸 outbox**. admin Lambda 가 INSERT 하고, 메일은 **전용 Lambda
--                              `atmark-login-mailer`**(역할 atmark-runtime-login-mailer · DB 롤 atmark_login_mailer)가 보낸다.
--                              admin 역할에는 SES 가 없다.
--   ② `owner_login_requests` — 로그인 요청의 속도 상한 원장(요청자 키의 HMAC 만 — IP 평문 없음).
--   ③ `owner_sessions`       — 서버측 세션. **토큰 해시만** 저장한다(평문 컬럼 없음).
--   ④ `owner_actions`        — 관리 행위 감사(append-only). 비밀·토큰 평문·수신자 목록을 담을 자리가 없다.
--
-- 권한 경계(이 파일의 본체): 앱 롤(`atmark_app` — api Lambda 와 모든 워커)은 ①②③④ 어디에도 **아무 권한이 없다**
--   (ADR-0006). 앱 롤이 링크 id·만료를 읽을 수 있으면 api Lambda 탈취자가 스스로 로그인을 요청해(자기 브라우저 논스)
--   그 행을 읽고, 로그인 키를 쥔 쪽과 합쳐 소유자 세션을 만든다 — 그 경로를 여기서 끊는다. ① 의 발송 컬럼 권한은
--   `atmark_login_mailer` 에, 로그인·세션·감사 권한은 `atmark_admin` 에 **202609230720 이 준다**(롤 두 개는 migrate 의
--   `bootstrap-roles` 가 먼저 만든다). 이 파일은 GRANT 를 하나도 하지 않는다.
-- 마이그레이션은 append-only 다. 기존 파일은 한 글자도 건드리지 않았다. (이 파일 자체는 운영 미적용 상태에서 ADR-0006 에
--   맞춰 고쳐졌다 — 적용된 곳은 로컬 DB 뿐이었고 그 DB 는 되돌려 다시 적용했다.)

-- ---------------------------------------------------------------------------
-- ① owner_login_links
-- ---------------------------------------------------------------------------

CREATE TYPE owner_login_link_status AS ENUM ('pending', 'sent', 'obsolete', 'undeliverable', 'dead');

-- ★ 수신자 주소 컬럼이 없다 — 보내는 순간 `organizations.owner_email` 에서 읽는다(approval_notifications 와 같은
--   규율). 여기 주소 컬럼이 있으면 그 컬럼을 채우는 코드가 곧 "수신자를 고르는 코드" 가 된다.
-- ★ 토큰 컬럼이 없다 — 링크 토큰은 보낼 때 HMAC(`atmark/owner-login-keys`)으로 만든다(`security/owner-login-token.ts`).
CREATE TABLE owner_login_links (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid NOT NULL REFERENCES organizations (id) ON DELETE RESTRICT,
  -- 로그인을 **요청한 브라우저**의 논스(쿠키) 해시. verify 는 같은 논스를 요구한다 — 메일의 토큰만으로는
  --   세션이 나오지 않는다(메일 스캐너·전달된 메일). **이것만으로는 발송 쪽 탈취를 막지 못한다**: 로그인 키와 링크
  --   id·만료를 쥔 쪽은 스스로 로그인을 요청해 자기 논스를 받을 수 있다. 그래서 그 둘을 쥐는 주체를 로그인 메일
  --   전용 Lambda 하나로 줄였다(ADR-0006) — 앱 롤은 이 테이블에 권한이 없다.
  browser_binding  text NOT NULL CHECK (browser_binding ~ '^[0-9a-f]{64}$'),
  created_at       timestamptz NOT NULL DEFAULT now(),
  -- 토큰에 ms 로 실린다 — 비교가 정확하도록 ms 로 자른 값만 받는다.
  expires_at       timestamptz NOT NULL CHECK (expires_at = date_trunc('milliseconds', expires_at)),
  -- 단일 사용. NULL → 값 1회(아래 트리거) · 만료 뒤에는 쓸 수 없다.
  used_at          timestamptz,

  -- ---- outbox (approval_notifications 와 같은 모양) ----
  status           owner_login_link_status NOT NULL DEFAULT 'pending',
  attempt_count    integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  next_attempt_at  timestamptz NOT NULL DEFAULT now(),
  claimed_at       timestamptz,
  last_error       text CHECK (last_error ~ '^[a-z_]{1,40}$'),
  ses_message_id   text,
  sent_at          timestamptz,
  settled_at       timestamptz,

  -- 15분. 그보다 긴 링크는 메일함에 남은 채 "로그인 권한" 이 되는 시간이 길어진다.
  CONSTRAINT owner_login_links_ttl CHECK (expires_at > created_at AND expires_at - created_at <= interval '15 minutes'),
  CONSTRAINT owner_login_links_sent_shape
    CHECK ((status = 'sent') = (sent_at IS NOT NULL AND ses_message_id IS NOT NULL)),
  CONSTRAINT owner_login_links_settled_shape
    CHECK ((status IN ('obsolete', 'undeliverable', 'dead')) = (settled_at IS NOT NULL))
);

CREATE INDEX owner_login_links_due_idx ON owner_login_links (next_attempt_at) WHERE status = 'pending';
-- 주소(= 조직)당 속도 상한 계수 경로.
CREATE INDEX owner_login_links_org_created_idx ON owner_login_links (organization_id, created_at);

-- 식별·결속·만료는 불변. 바뀔 수 있는 것은 사용 시각과 outbox 컬럼뿐이다.
CREATE TRIGGER owner_login_links_immutable_core
  BEFORE UPDATE ON owner_login_links
  FOR EACH ROW EXECUTE FUNCTION reject_column_update_except(
    'used_at', 'status', 'attempt_count', 'next_attempt_at', 'claimed_at', 'last_error', 'ses_message_id', 'sent_at', 'settled_at');

-- 단일 사용: 한 번 적힌 used_at 은 다시 쓸 수 없다(NULL 로 되돌려 재사용하는 길도 없다).
CREATE TRIGGER owner_login_links_used_once
  BEFORE UPDATE ON owner_login_links
  FOR EACH ROW EXECUTE FUNCTION reject_column_overwrite('used_at');

-- 만료된 링크는 사용 처리할 수 없다 · outbox 종단 행은 다시 열리지 않는다(같은 링크의 두 번째 메일 방지).
CREATE OR REPLACE FUNCTION owner_login_links_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.used_at IS NULL AND NEW.used_at IS NOT NULL AND NEW.used_at >= OLD.expires_at THEN
    RAISE EXCEPTION 'owner login link % is expired', OLD.id USING ERRCODE = '23514';
  END IF;
  IF OLD.status <> 'pending' AND (
       NEW.status IS DISTINCT FROM OLD.status
    OR NEW.attempt_count IS DISTINCT FROM OLD.attempt_count
    OR NEW.next_attempt_at IS DISTINCT FROM OLD.next_attempt_at
    OR NEW.claimed_at IS DISTINCT FROM OLD.claimed_at
    OR NEW.sent_at IS DISTINCT FROM OLD.sent_at
    OR NEW.ses_message_id IS DISTINCT FROM OLD.ses_message_id) THEN
    RAISE EXCEPTION 'owner login notification % is terminal (%)', OLD.id, OLD.status USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER owner_login_links_guard
  BEFORE UPDATE ON owner_login_links
  FOR EACH ROW EXECUTE FUNCTION owner_login_links_guard();

CREATE TRIGGER owner_login_links_no_delete
  BEFORE DELETE ON owner_login_links
  FOR EACH ROW EXECUTE FUNCTION reject_row_delete();

CREATE TRIGGER owner_login_links_no_truncate
  AFTER TRUNCATE ON owner_login_links
  FOR EACH STATEMENT EXECUTE FUNCTION reject_truncate();

-- ★ 앱 롤 권한 없음. 권한은 202609230720(atmark_admin · atmark_login_mailer)이 준다.

COMMENT ON TABLE owner_login_links IS
  '소유자 로그인 링크 겸 outbox. INSERT 는 admin(atmark_admin)만, 발송은 login-mailer(atmark_login_mailer, outbox 컬럼만). 앱 롤 권한 0. 토큰·수신자 컬럼 없음.';

-- ---------------------------------------------------------------------------
-- ② owner_login_requests — 속도 상한 원장
-- ---------------------------------------------------------------------------

-- 요청자 키 = HMAC(로그인 키, 'ip:' || 소스 IP). IP 평문을 남기지 않는다(IPv4 는 sha256 만으로는 전수 복원된다).
CREATE TABLE owner_login_requests (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_key    text NOT NULL CHECK (client_key ~ '^[0-9a-f]{64}$'),
  requested_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX owner_login_requests_client_idx ON owner_login_requests (client_key, requested_at);

CREATE TRIGGER owner_login_requests_no_update
  BEFORE UPDATE ON owner_login_requests
  FOR EACH ROW EXECUTE FUNCTION reject_row_update();
CREATE TRIGGER owner_login_requests_no_delete
  BEFORE DELETE ON owner_login_requests
  FOR EACH ROW EXECUTE FUNCTION reject_row_delete();
CREATE TRIGGER owner_login_requests_no_truncate
  AFTER TRUNCATE ON owner_login_requests
  FOR EACH STATEMENT EXECUTE FUNCTION reject_truncate();

-- ---------------------------------------------------------------------------
-- ③ owner_sessions
-- ---------------------------------------------------------------------------

CREATE TABLE owner_sessions (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid NOT NULL REFERENCES organizations (id) ON DELETE RESTRICT,
  -- 링크 하나 = 세션 하나. 같은 링크로 두 번째 세션이 나오는 길을 인덱스가 닫는다(단일 사용의 두 번째 층).
  login_link_id    uuid NOT NULL UNIQUE REFERENCES owner_login_links (id) ON DELETE RESTRICT,
  -- sha256(세션 토큰) hex. 평문 컬럼은 없다 — DB 가 새도 쿠키를 만들 수 없다.
  token_hash       text NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  created_at       timestamptz NOT NULL DEFAULT now(),
  expires_at       timestamptz NOT NULL,
  revoked_at       timestamptz,
  CONSTRAINT owner_sessions_ttl CHECK (expires_at > created_at AND expires_at - created_at <= interval '12 hours'),
  -- owner_actions 의 복합 FK 대상 — 감사 행의 조직이 세션의 조직과 다를 수 없다.
  CONSTRAINT owner_sessions_id_org_key UNIQUE (id, organization_id)
);

-- 바뀔 수 있는 것은 폐기 시각 하나 · 한 번 적히면 덮지 않는다("언제부터 무효였는가" 의 경계선).
CREATE TRIGGER owner_sessions_immutable_core
  BEFORE UPDATE ON owner_sessions
  FOR EACH ROW EXECUTE FUNCTION reject_column_update_except('revoked_at');
CREATE TRIGGER owner_sessions_revoked_once
  BEFORE UPDATE ON owner_sessions
  FOR EACH ROW EXECUTE FUNCTION reject_column_overwrite('revoked_at');
CREATE TRIGGER owner_sessions_no_delete
  BEFORE DELETE ON owner_sessions
  FOR EACH ROW EXECUTE FUNCTION reject_row_delete();
CREATE TRIGGER owner_sessions_no_truncate
  AFTER TRUNCATE ON owner_sessions
  FOR EACH STATEMENT EXECUTE FUNCTION reject_truncate();

-- ---------------------------------------------------------------------------
-- ④ owner_actions — 감사(append-only)
-- ---------------------------------------------------------------------------

-- 누가(세션) · 무엇을(행위) · 언제 · 대상(id). **대상은 식별자뿐이다** — 주소·토큰·본문이 들어갈 모양이 아니다
--   (uuid 또는 에이전트 id). seed 추가처럼 주소가 본질인 행위도 대상은 에이전트 id 이고, 주소는 도메인 테이블
--   (sender_relationships·policy_versions)에 이미 남는다.
CREATE TABLE owner_actions (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id       uuid NOT NULL,
  organization_id  uuid NOT NULL,
  action           text NOT NULL CHECK (action ~ '^[a-z][a-z0-9_.]{1,60}$'),
  target_id        text CHECK (target_id ~ '^([0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$'),
  created_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT owner_actions_session_fk FOREIGN KEY (session_id, organization_id)
    REFERENCES owner_sessions (id, organization_id) ON DELETE RESTRICT
);

CREATE INDEX owner_actions_org_created_idx ON owner_actions (organization_id, created_at DESC);

CREATE TRIGGER owner_actions_no_update
  BEFORE UPDATE ON owner_actions
  FOR EACH ROW EXECUTE FUNCTION reject_row_update();
CREATE TRIGGER owner_actions_no_delete
  BEFORE DELETE ON owner_actions
  FOR EACH ROW EXECUTE FUNCTION reject_row_delete();
CREATE TRIGGER owner_actions_no_truncate
  AFTER TRUNCATE ON owner_actions
  FOR EACH STATEMENT EXECUTE FUNCTION reject_truncate();

COMMENT ON TABLE owner_actions IS
  '소유자 관리 행위 감사(append-only). 세션·행위·대상 id·시각만 — 비밀·토큰·수신자 없음. 앱 롤 권한 0.';
