-- 202609291100_custom_domains.sql
-- 고객 자기 도메인(에이전트 전용 서브도메인) — 계약 표 셋(ADR-0014 · 계획 `.omc/plans/custom-domains.md` §3.2 · 단계 0, 보안·critic 리뷰 반영판).
--
--   ① `custom_domains` — 조직의 에이전트 전용 서브도메인 하나 = 한 행(한 번의 등록 시도). 상태 기계 pending → verifying → verified ⇄ suspended,
--      어디서든 removed(종착). 지우지 않는다(DELETE 권한 0 · 트리거 거부).
--      **쓰는 롤이 나뉜다**(보안 M2): 상태·확인·사가 칸은 **틱 롤 `atmark_domain_tick`** 만 고친다. admin(콘솔·조직 API)은 행 만들기(식별 칸) ·
--      수동 확인 칸(`last_manual_check_at`·`next_check_at`) · **제거 요청**(`removal_requested_at`, 쓰기 1회 — 트리거가 그 자리에서 removed 로
--      바꾼다)만. admin 롤(콘솔 경로)로는 도메인을 verified 로 만들거나 정지를 풀 수 없다(admin λ 전체 탈취의 한계는 ADR-0014 결정 12).
--      단계 0 에서 틱 롤은 NOLOGIN 이다(`bootstrap-roles`).
--      트리거(BEFORE — 이름 순서대로 돈다):
--        · `custom_domains_limits_guard`(INSERT) — 조직이 기능 허용 목록(`org_features`)에 있어야 한다(P0A07, 보안 L8) · 새 행은 pending 으로만 ·
--          살아 있는 행(removed 제외) ≤ 천장 20 · pending ≤ 2(P0A03). 조직 잠금 아래. 요금제별 한도는 앱이 같은 잠금 아래에서 센다.
--        · `custom_domains_registrable_guard`(INSERT · UPDATE OF status) — verifying·verified·suspended 로 **들어서는** 행은 다른 조직의 같은 apex
--          행 **또는 위아래로 겹치는 도메인**(`a.x.com` ↔ `b.a.x.com`, 보안 L2 — PSL 스냅샷이 바뀌어 apex 판정이 달라져도)이 그 셋 중 하나면
--          거부(P0A02). apex 잠금 아래. 양도(M11)는 같은 트랜잭션에서 옛 행을 먼저 removed(`superseded_by`)로 바꾼다.
--        · `custom_domains_removal_request`(UPDATE) — `removal_requested_at` 은 쓰기 1회이고, 적히는 순간 행을 removed 로 바꾼다(주소는 남는다 —
--          자발적 제거, ADR-0014 D-H).
--        · `custom_domains_row_immutable`(UPDATE) — 식별 칸 불변 · `sending_started_at` 쓰기 1회.
--        · `custom_domains_transition_guard`(UPDATE) — 허용 전이만(`CUSTOM_DOMAIN_TRANSITIONS`). **정지 사유는 세지는 쪽으로만**
--          (`CUSTOM_DOMAIN_SUSPENSION_STRENGTH`) · **reputation·operator 정지는 소유자 롤만 푼다**(보안 M3 — 틱도 못 푼다). 발신 가능 상태
--          (verified·suspended)를 떠나거나 돌아오면 I2+ 정책 동기화 요청을 적는다 · `updated_at`.
--      **동결 톰스톤**(재리뷰 M1): reputation·operator 정지 상태에서 removed 로 나가면(자발적 제거 요청 포함) 전이 가드가 `frozen_reason_at_removal`
--      을 적는다. 같은 도메인 또는 같은 apex 에 그 표시가 있으면 새 행과 verifying 진입이 42501 이다(소유자 롤 예외 — 운영자 해제가 지운다).
--      AFTER 트리거 `custom_domains_retire_on_loss`(진윤겸 2026-09-29) — `suspended(ownership_lost)` 로 들어서거나 다른 행이 이 행을 대체
--      (`superseded_by`)하면 **같은 트랜잭션에서** 이 조직의 이 도메인 활성 별칭을 전부 폐기한다(잎 `identity.address_retired` · ADR-0013 의
--      30일 보류가 시작된다). v1 고객 도메인 주소는 별칭뿐이다(202609291120 가드).
--      유니크 색인 둘: identity 를 소유하는 행은 도메인당 하나 · 조직당 살아 있는 행은 도메인당 하나(M10). 새 표라 여기서 만든다(행 0).
--   ② `org_features` — 운영자 기능 허용 목록(M13). **기본 비어 있다.** 쓰기는 소유자 롤(`pnpm admin:feature`)뿐, admin·틱은 읽기만.
--   ③ `domain_notices` — 도메인 알림 outbox(M14). 수신자·본문 칸이 없다. 틱 롤이 적고, 발송 워커(앱 롤)는 DEFINER
--      `atmark_claim_domain_notice(id)` 로 **집기와 수신자 읽기를 한 문장에** 한다(보안 L3). 끝난 알림(sent · dead · obsolete)은 바뀌지 않는다.
--   ④ 함수: 워밍업 시계 `atmark_mark_domain_sending_started(message_id)`(DEFINER — **보낸(sent) 메시지만**, 보안 L5) · 코드 천장 둘.
--      여권 `domain_verified` 사실(F7)은 v2 로 미뤘다(대표 주소가 고객 도메인일 수 없다) — 그 함수는 만들지 않는다.
--
-- **운영 무변화(단계 0).** 허용 목록이 비어 있어 행이 생길 수 없다. 틱 롤은 로그인할 수 없다.
-- 잠금: 새 표 셋 · 함수 · 트리거 · GRANT. 기존 표는 FK 참조뿐(짧은 SHARE ROW EXCLUSIVE). 5초 안에 못 잡으면 실패하고 아무것도 바뀌지 않는다.

SET LOCAL lock_timeout = '5s';

-- 이 파일이 GRANT 하는 롤이 먼저 있어야 한다(202609230720 과 같은 규칙) — 없으면 아무것도 바꾸지 않고 멈춘다.
DO $$
DECLARE
  missing text;
BEGIN
  SELECT string_agg(name, ', ') INTO missing
    FROM unnest(ARRAY['atmark_admin', 'atmark_app', 'atmark_domain_tick']) AS name
   WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = name);
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION 'role % does not exist — migrate 핸들러의 bootstrap-roles 를 먼저 돌려라(로컬: docs/runbooks/custom-domains.md §1)', missing;
  END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- 코드 천장 — `src/billing/plans.ts` 와 같은 값(단위 테스트가 대조). 주소 천장은 202609291120(도메인 길이의 함수).
-- ---------------------------------------------------------------------------

CREATE FUNCTION atmark_custom_domains_ceiling() RETURNS integer
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$ SELECT 20 $$;

CREATE FUNCTION atmark_custom_domains_pending_max() RETURNS integer
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$ SELECT 2 $$;

-- ---------------------------------------------------------------------------
-- ② org_features (custom_domains 가드가 읽으므로 먼저)
-- ---------------------------------------------------------------------------

CREATE TABLE org_features (
  organization_id  uuid NOT NULL REFERENCES organizations (id) ON DELETE RESTRICT,
  feature          text NOT NULL CHECK (feature IN ('custom_domains')),
  enabled_at       timestamptz NOT NULL DEFAULT now(),
  -- 운영자 식별(CLI 의 운영자 이름 · 사건 번호). 코드 모양만 받는다(자유 문장·이메일 없음).
  enabled_by       text NOT NULL CHECK (enabled_by ~ '^[a-z0-9][a-z0-9_.:-]{0,63}$'),
  PRIMARY KEY (organization_id, feature)
);

COMMENT ON TABLE org_features IS
  '운영자 기능 허용 목록(ADR-0014 M13). 기본 비어 있다. 쓰기는 소유자 롤(pnpm admin:feature)뿐 — 끄기는 행 DELETE(소유자 롤). admin·틱은 읽기만.';

-- ---------------------------------------------------------------------------
-- ① custom_domains
-- ---------------------------------------------------------------------------

CREATE TABLE custom_domains (
  id                               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id                  uuid NOT NULL REFERENCES organizations (id) ON DELETE RESTRICT,
  domain                           text NOT NULL,
  registrable_domain               text NOT NULL,
  status                           text NOT NULL DEFAULT 'pending'
                                     CHECK (status IN ('pending', 'verifying', 'verified', 'suspended', 'removed')),
  suspended_reason                 text CHECK (suspended_reason IN ('ownership_lost', 'dkim_failed', 'reputation', 'operator', 'plan_limit')),
  pending_reason                   text CHECK (pending_reason IN ('subdomain_has_mail', 'registrable_taken')),
  challenge_token                  text NOT NULL CHECK (challenge_token ~ '^[A-Za-z0-9_-]{43}$'),
  txt_verified_at                  timestamptz,
  saga_step                        text NOT NULL DEFAULT 'none'
                                     CHECK (saga_step IN ('none', 'identity', 'mail_from', 'config_set', 'policy', 'done')),
  saga_attempts                    integer NOT NULL DEFAULT 0 CHECK (saga_attempts >= 0),
  removal_step                     text NOT NULL DEFAULT 'none' CHECK (removal_step IN ('none', 'policy', 'identity', 'done')),
  last_error                       text CHECK (last_error ~ '^[a-z][a-z0-9_.:-]{0,79}$'),
  ses_identity_row_tag             uuid,
  superseded_by                    uuid REFERENCES custom_domains (id) ON DELETE RESTRICT,
  dkim_status                      text NOT NULL DEFAULT 'unknown'
                                     CHECK (dkim_status IN ('unknown', 'not_started', 'pending', 'success', 'failed', 'temporary_failure')),
  dkim_tokens                      text[] NOT NULL DEFAULT '{}'::text[]
                                     CHECK (cardinality(dkim_tokens) <= 3 AND array_to_string(dkim_tokens, ',') ~ '^([a-z0-9]{1,64}(,|$))*$'),
  mail_from_status                 text NOT NULL DEFAULT 'unknown'
                                     CHECK (mail_from_status IN ('unknown', 'not_started', 'pending', 'success', 'failed', 'temporary_failure')),
  inbound_mx_status                text NOT NULL DEFAULT 'unknown' CHECK (inbound_mx_status IN ('unknown', 'missing', 'ses', 'other')),
  policy_digest                    text CHECK (policy_digest ~ '^[0-9a-f]{64}$'),
  policy_sync_requested_at         timestamptz,
  last_checked_at                  timestamptz,
  next_check_at                    timestamptz NOT NULL DEFAULT now(),
  consecutive_definitive_failures  integer NOT NULL DEFAULT 0 CHECK (consecutive_definitive_failures >= 0),
  last_manual_check_at             timestamptz,
  sending_started_at               timestamptz,
  registration_expires_at          timestamptz,
  registration_checked_at          timestamptz,
  verified_at                      timestamptz,
  suspended_at                     timestamptz,
  removed_at                       timestamptz,
  removal_due_at                   timestamptz,
  removal_requested_at             timestamptz,
  -- 동결 톰스톤(재리뷰 M1) — reputation·operator 정지 상태에서 removed 로 나간 행에 그 사유를 남긴다(전이 가드가 적는다). 같은 도메인·같은 apex 에
  --   이 표시가 있으면 새 행(INSERT)과 verifying 진입을 거부한다(42501, 소유자 롤 예외) — "지우고 다시 등록" 으로 동결을 벗어나지 못하게.
  --   운영자 해제(`pnpm admin:domain --unfreeze`, 단계 4)가 소유자 롤로 NULL 로 되돌린다.
  frozen_reason_at_removal         text CHECK (frozen_reason_at_removal IN ('reputation', 'operator')),
  identity_deleted_at              timestamptz,
  created_by_user_id               uuid REFERENCES users (id) ON DELETE RESTRICT,
  created_at                       timestamptz NOT NULL DEFAULT now(),
  updated_at                       timestamptz NOT NULL DEFAULT now(),
  -- 이름 모양 — 소문자 LDH 라벨 둘 이상, 라벨 1~63자, 앞뒤 하이픈 없음, 끝 점 없음, R-LDH(`xn--` 등) 없음, 마지막 라벨이 숫자만이 아님,
  --   **100자 이하**(`CUSTOM_DOMAIN_MAX_LENGTH` — 정책 크기 · critic 4). 등록 가능 apex 판정(PSL)은 SQL 로 옮기지 않는다.
  CONSTRAINT custom_domains_domain_shape CHECK (
    length(domain) <= 100
    AND domain ~ '^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$'
    AND domain !~ '(^|\.)[a-z0-9]{2}--'
    AND domain !~ '\.[0-9]+$'),
  CONSTRAINT custom_domains_registrable_shape CHECK (
    registrable_domain ~ '^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$'
    AND length(domain) > length(registrable_domain)
    AND right(domain, length(registrable_domain) + 1) = '.' || registrable_domain),
  -- 우리 도메인 아래는 누구의 것도 아니다.
  CONSTRAINT custom_domains_not_platform CHECK (registrable_domain <> 'atmark.ai' AND right(domain, 10) <> '.atmark.ai'),
  CONSTRAINT custom_domains_suspended_reason_shape CHECK ((status = 'suspended') = (suspended_reason IS NOT NULL)),
  CONSTRAINT custom_domains_pending_reason_shape CHECK (pending_reason IS NULL OR status = 'pending'),
  CONSTRAINT custom_domains_txt_before_identity CHECK (status NOT IN ('verifying', 'verified', 'suspended') OR txt_verified_at IS NOT NULL),
  CONSTRAINT custom_domains_verified_at_shape CHECK (status NOT IN ('verified', 'suspended') OR verified_at IS NOT NULL),
  CONSTRAINT custom_domains_suspended_at_shape CHECK (status <> 'suspended' OR suspended_at IS NOT NULL),
  CONSTRAINT custom_domains_removed_at_shape CHECK ((status = 'removed') = (removed_at IS NOT NULL)),
  CONSTRAINT custom_domains_superseded_shape CHECK (superseded_by IS NULL OR (status = 'removed' AND superseded_by <> id)),
  CONSTRAINT custom_domains_frozen_tombstone_shape CHECK (frozen_reason_at_removal IS NULL OR status = 'removed'),
  -- domain_notices 의 복합 FK 대상 — 알림의 조직이 도메인의 조직과 다를 수 없다.
  CONSTRAINT custom_domains_id_org_key UNIQUE (id, organization_id)
);

-- identity 를 소유하는 행은 도메인당 하나(SES identity 는 계정에 하나).
CREATE UNIQUE INDEX custom_domains_identity_owner_key ON custom_domains (domain) WHERE status IN ('verifying', 'verified', 'suspended');
-- 조직당 살아 있는 행은 도메인당 하나 — 정책 로더의 "비-removed 행 최대 1" 불변식(M10).
CREATE UNIQUE INDEX custom_domains_org_live_key ON custom_domains (organization_id, domain) WHERE status <> 'removed';
-- 틱의 예산 질의(next_check_at 순).
CREATE INDEX custom_domains_due_idx ON custom_domains (next_check_at) WHERE status <> 'removed' OR removal_step <> 'done';
-- 교차 조직 apex · 계층 점유 검사.
CREATE INDEX custom_domains_registrable_idx ON custom_domains (registrable_domain) WHERE status IN ('verifying', 'verified', 'suspended');

COMMENT ON TABLE custom_domains IS
  '조직의 에이전트 전용 서브도메인(ADR-0014). 행 = 한 번의 등록 시도, 지우지 않는다. 상태 칸은 atmark_domain_tick 만, admin 은 만들기·수동 확인·제거 요청만.';
COMMENT ON COLUMN custom_domains.policy_sync_requested_at IS
  'NOT NULL = I2+ identity policy 동기화가 밀려 있다(주소 발급·폐기 · 발신 가능 상태 이탈·복귀 — 트리거가 적는다). 틱이 동기화한 뒤 비운다.';
COMMENT ON COLUMN custom_domains.sending_started_at IS
  '도메인 워밍업 Day 1 = 첫 발송 성공(atmark_mark_domain_sending_started, 1회). 칼럼 UPDATE 권한은 아무 롤에도 없다.';
COMMENT ON COLUMN custom_domains.removal_requested_at IS
  '소유자의 제거 요청(쓰기 1회, admin). 적히는 순간 트리거가 removed 로 바꾼다. 주소는 남는다(자발적 제거 — ADR-0014 D-H).';

-- 동결 톰스톤(재리뷰 M1) — 같은 도메인 또는 같은 apex 에 평판·운영자 동결을 지닌 채 제거된 행이 있으면 거부(소유자 롤 예외).
CREATE FUNCTION custom_domains_assert_not_frozen(p_domain text, p_registrable text) RETURNS void
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF pg_has_role(current_user, (SELECT c.relowner FROM pg_catalog.pg_class c WHERE c.oid = 'public.custom_domains'::regclass), 'USAGE') THEN
    RETURN;
  END IF;
  IF EXISTS (SELECT 1 FROM public.custom_domains d
              WHERE (d.domain = p_domain OR d.registrable_domain = p_registrable) AND d.frozen_reason_at_removal IS NOT NULL) THEN
    RAISE EXCEPTION 'custom_domains: 이 도메인은 동결된 채 제거됐다 — 운영자만 풀 수 있다' USING ERRCODE = '42501';
  END IF;
END;
$$;

-- 기능 허용 · 동결 톰스톤 · 새 행은 pending 으로만 · 조직 천장 · pending 상한.
CREATE FUNCTION custom_domains_limits_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE
  live integer;
  pending integer;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.org_features f WHERE f.organization_id = NEW.organization_id AND f.feature = 'custom_domains') THEN
    RAISE EXCEPTION 'custom_domains: 조직이 고객 도메인 기능 허용 목록에 없다' USING ERRCODE = 'P0A07';
  END IF;
  PERFORM public.custom_domains_assert_not_frozen(NEW.domain, NEW.registrable_domain);
  IF NEW.status <> 'pending' OR NEW.suspended_reason IS NOT NULL OR NEW.pending_reason IS NOT NULL OR NEW.txt_verified_at IS NOT NULL
     OR NEW.saga_step <> 'none' OR NEW.removal_step <> 'none' OR NEW.superseded_by IS NOT NULL OR NEW.ses_identity_row_tag IS NOT NULL
     OR NEW.sending_started_at IS NOT NULL OR NEW.verified_at IS NOT NULL OR NEW.suspended_at IS NOT NULL OR NEW.removed_at IS NOT NULL
     OR NEW.removal_requested_at IS NOT NULL OR NEW.policy_digest IS NOT NULL OR NEW.policy_sync_requested_at IS NOT NULL
     OR NEW.frozen_reason_at_removal IS NOT NULL THEN
    RAISE EXCEPTION 'custom_domains: 새 행은 pending 으로만 만든다' USING ERRCODE = '23514';
  END IF;
  NEW.created_at := now();
  NEW.updated_at := now();
  PERFORM pg_advisory_xact_lock(hashtextextended('custom_domains_org:' || NEW.organization_id::text, 0));
  SELECT count(*) FILTER (WHERE d.status <> 'removed'), count(*) FILTER (WHERE d.status = 'pending')
    INTO live, pending
    FROM public.custom_domains d WHERE d.organization_id = NEW.organization_id;
  IF live >= public.atmark_custom_domains_ceiling() THEN
    RAISE EXCEPTION 'custom_domains: 조직의 살아 있는 도메인이 천장(%)에 닿았다', public.atmark_custom_domains_ceiling() USING ERRCODE = 'P0A03';
  END IF;
  IF pending >= public.atmark_custom_domains_pending_max() THEN
    RAISE EXCEPTION 'custom_domains: 조직의 pending 도메인이 상한(%)에 닿았다', public.atmark_custom_domains_pending_max() USING ERRCODE = 'P0A03';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER custom_domains_limits_guard BEFORE INSERT ON custom_domains
  FOR EACH ROW EXECUTE FUNCTION custom_domains_limits_guard();

-- 교차 조직 apex · 계층 점유 — identity 를 가질 수 있는 상태로 들어서는 순간 본다.
CREATE FUNCTION custom_domains_registrable_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF NEW.status NOT IN ('verifying', 'verified', 'suspended') THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.status IN ('verifying', 'verified', 'suspended') THEN
    RETURN NEW; -- 이미 점유 중인 행의 상태 이동(verified ⇄ suspended)은 새 점유가 아니다.
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('custom_domain_registrable:' || NEW.registrable_domain, 0));
  PERFORM public.custom_domains_assert_not_frozen(NEW.domain, NEW.registrable_domain);
  IF EXISTS (
    SELECT 1 FROM public.custom_domains d
     WHERE d.organization_id <> NEW.organization_id
       AND d.status IN ('verifying', 'verified', 'suspended')
       AND d.id <> NEW.id
       AND (d.registrable_domain = NEW.registrable_domain
            OR d.domain = NEW.domain
            OR right(NEW.domain, length(d.domain) + 1) = '.' || d.domain
            OR right(d.domain, length(NEW.domain) + 1) = '.' || NEW.domain)
  ) THEN
    -- 다른 조직의 도메인 이름을 싣지 않는다(존재만 알린다).
    RAISE EXCEPTION 'custom_domains: 이 등록 가능 도메인 아래(또는 겹치는 도메인)는 다른 조직이 쓰고 있다' USING ERRCODE = 'P0A02';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER custom_domains_registrable_guard BEFORE INSERT OR UPDATE OF status ON custom_domains
  FOR EACH ROW EXECUTE FUNCTION custom_domains_registrable_guard();

-- 제거 요청(admin 의 유일한 상태 경로) — 쓰기 1회, 그 자리에서 removed.
CREATE FUNCTION custom_domains_removal_request() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF NEW.removal_requested_at IS NOT DISTINCT FROM OLD.removal_requested_at THEN
    RETURN NEW;
  END IF;
  IF OLD.removal_requested_at IS NOT NULL OR NEW.removal_requested_at IS NULL THEN
    RAISE EXCEPTION 'custom_domains: 제거 요청은 한 번만 적는다(id=%)', OLD.id USING ERRCODE = '23514';
  END IF;
  NEW.removal_requested_at := now();
  IF OLD.status <> 'removed' THEN
    NEW.status := 'removed';
    NEW.removed_at := now();
    NEW.suspended_reason := NULL;
    NEW.pending_reason := NULL;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER custom_domains_removal_request BEFORE UPDATE ON custom_domains
  FOR EACH ROW EXECUTE FUNCTION custom_domains_removal_request();

CREATE FUNCTION custom_domains_row_immutable() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.organization_id IS DISTINCT FROM OLD.organization_id OR NEW.domain IS DISTINCT FROM OLD.domain
     OR NEW.registrable_domain IS DISTINCT FROM OLD.registrable_domain OR NEW.challenge_token IS DISTINCT FROM OLD.challenge_token
     OR NEW.created_by_user_id IS DISTINCT FROM OLD.created_by_user_id OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'custom_domains: 식별 칸(id · 조직 · 도메인 · apex · 토큰 · 만든 사람 · 만든 시각)은 바뀌지 않는다(id=%)', OLD.id USING ERRCODE = '23514';
  END IF;
  -- 동결 톰스톤은 전이 가드만 적고(이 트리거 뒤에 돈다) 소유자 롤(운영자 해제)만 지운다.
  IF NEW.frozen_reason_at_removal IS DISTINCT FROM OLD.frozen_reason_at_removal
     AND NOT pg_has_role(current_user, (SELECT c.relowner FROM pg_catalog.pg_class c WHERE c.oid = TG_RELID), 'USAGE') THEN
    RAISE EXCEPTION 'custom_domains: 동결 톰스톤은 운영자만 바꾼다(id=%)', OLD.id USING ERRCODE = '42501';
  END IF;
  IF NEW.sending_started_at IS DISTINCT FROM OLD.sending_started_at AND OLD.sending_started_at IS NOT NULL THEN
    RAISE EXCEPTION 'custom_domains: sending_started_at 은 한 번만 적는다(id=%)', OLD.id USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER custom_domains_row_immutable BEFORE UPDATE ON custom_domains
  FOR EACH ROW EXECUTE FUNCTION custom_domains_row_immutable();

-- 전이 · 정지 사유의 세기 · 소유자만 푸는 정지 · 정책 동기화 요청.
CREATE FUNCTION custom_domains_transition_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE
  -- 소유자 롤(운영자 CLI)인가 — users_erasure_guard(202609250220)와 같은 판정.
  is_owner boolean := pg_has_role(current_user, (SELECT c.relowner FROM pg_catalog.pg_class c WHERE c.oid = TG_RELID), 'USAGE');
  old_strength integer := CASE OLD.suspended_reason WHEN 'plan_limit' THEN 1 WHEN 'dkim_failed' THEN 2 WHEN 'ownership_lost' THEN 3
                                                    WHEN 'reputation' THEN 4 WHEN 'operator' THEN 5 ELSE 0 END;
  new_strength integer := CASE NEW.suspended_reason WHEN 'plan_limit' THEN 1 WHEN 'dkim_failed' THEN 2 WHEN 'ownership_lost' THEN 3
                                                    WHEN 'reputation' THEN 4 WHEN 'operator' THEN 5 ELSE 0 END;
BEGIN
  NEW.updated_at := now();
  IF NEW.status IS NOT DISTINCT FROM OLD.status THEN
    -- suspended 안에서 사유는 세지는 쪽으로만(소유자 롤 예외).
    IF NEW.status = 'suspended' AND NEW.suspended_reason IS DISTINCT FROM OLD.suspended_reason AND NOT is_owner AND new_strength <= old_strength THEN
      RAISE EXCEPTION 'custom_domains: 정지 사유는 세지는 쪽으로만 바꾼다(% → %, id=%)', OLD.suspended_reason, NEW.suspended_reason, OLD.id
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF NOT ((OLD.status = 'pending' AND NEW.status IN ('verifying', 'removed'))
       OR (OLD.status = 'verifying' AND NEW.status IN ('verified', 'removed'))
       OR (OLD.status = 'verified' AND NEW.status IN ('suspended', 'removed'))
       OR (OLD.status = 'suspended' AND NEW.status IN ('verified', 'removed'))) THEN
    RAISE EXCEPTION 'custom_domains: 허용되지 않는 전이 % → %(id=%)', OLD.status, NEW.status, OLD.id USING ERRCODE = '23514';
  END IF;
  -- 평판·운영자 정지는 사람(소유자 롤 — `pnpm admin:domain --unfreeze`)만 푼다. 틱은 자동 복귀시키지 못한다.
  IF OLD.status = 'suspended' AND OLD.suspended_reason IN ('reputation', 'operator') AND NEW.status = 'verified' AND NOT is_owner THEN
    RAISE EXCEPTION 'custom_domains: % 정지는 운영자만 푼다(id=%)', OLD.suspended_reason, OLD.id USING ERRCODE = '42501';
  END IF;
  -- 동결된 채 제거(자발적 제거 요청 · 틱의 제거 모두 이 경로 — 제거 요청 트리거도 상태를 바꾸므로 여기를 지난다) → 톰스톤(재리뷰 M1).
  IF OLD.status = 'suspended' AND OLD.suspended_reason IN ('reputation', 'operator') AND NEW.status = 'removed' THEN
    NEW.frozen_reason_at_removal := OLD.suspended_reason;
  END IF;
  -- 발신 권한이 있던 상태를 떠나거나 돌아오면 I2+ 정책을 다시 맞춘다(정지 = 정책 삭제 · 복귀 = 재생성). removed 는 제거 사가가 정책을 지운다.
  IF OLD.status IN ('verified', 'suspended') AND NEW.status <> 'removed' THEN
    NEW.policy_sync_requested_at := coalesce(NEW.policy_sync_requested_at, now());
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER custom_domains_transition_guard BEFORE UPDATE ON custom_domains
  FOR EACH ROW EXECUTE FUNCTION custom_domains_transition_guard();

-- 증명된 소유권 상실 · 대체 → 이 조직의 이 도메인 활성 별칭 폐기(같은 트랜잭션). 폐기 가드(202609291002)가 주소 잠금을 잡고 retired_at 을 찍는다.
CREATE FUNCTION custom_domains_retire_on_loss() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  UPDATE public.agent_addresses x
     SET retired_at = pg_catalog.now()
    FROM public.agents a
   WHERE a.id = x.agent_id
     AND a.organization_id = NEW.organization_id
     AND x.domain = NEW.domain
     AND x.retired_at IS NULL
     AND NOT x.is_primary;
  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION custom_domains_retire_on_loss() FROM PUBLIC;

CREATE TRIGGER custom_domains_retire_on_loss AFTER UPDATE ON custom_domains
  FOR EACH ROW
  WHEN ((NEW.status = 'suspended' AND NEW.suspended_reason = 'ownership_lost'
         AND (OLD.status IS DISTINCT FROM 'suspended' OR OLD.suspended_reason IS DISTINCT FROM 'ownership_lost'))
        OR (NEW.superseded_by IS NOT NULL AND OLD.superseded_by IS NULL))
  EXECUTE FUNCTION custom_domains_retire_on_loss();

CREATE TRIGGER custom_domains_no_delete BEFORE DELETE ON custom_domains
  FOR EACH ROW EXECUTE FUNCTION reject_row_delete();
CREATE TRIGGER custom_domains_no_truncate AFTER TRUNCATE ON custom_domains
  FOR EACH STATEMENT EXECUTE FUNCTION reject_truncate();

-- ---------------------------------------------------------------------------
-- ③ domain_notices — 도메인 알림 outbox(수신자·본문 칸 없음)
-- ---------------------------------------------------------------------------

CREATE TABLE domain_notices (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  domain_id        uuid NOT NULL,
  organization_id  uuid NOT NULL,
  kind             text NOT NULL CHECK (kind IN ('suspended', 'removal_d3', 'removed', 'expiry_warning')),
  -- 같은 사건의 알림은 한 번 — 정지·제거는 그 시각(에폭 초), 만료 예고는 `d30`·`d7`.
  event_key        text NOT NULL CHECK (event_key ~ '^[a-z0-9][a-z0-9:._-]{0,63}$'),
  created_at       timestamptz NOT NULL DEFAULT now(),
  status           text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'dead', 'obsolete')),
  attempt_count    integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  next_attempt_at  timestamptz NOT NULL DEFAULT now(),
  claimed_at       timestamptz,
  last_error       text CHECK (last_error ~ '^[a-z][a-z0-9_.:-]{0,79}$'),
  ses_message_id   text CHECK (ses_message_id ~ '^[A-Za-z0-9._-]{1,128}$'),
  sent_at          timestamptz,
  CONSTRAINT domain_notices_domain_fk FOREIGN KEY (domain_id, organization_id) REFERENCES custom_domains (id, organization_id) ON DELETE RESTRICT,
  CONSTRAINT domain_notices_event_key UNIQUE (domain_id, kind, event_key),
  CONSTRAINT domain_notices_sent_shape CHECK ((status = 'sent') = (sent_at IS NOT NULL AND ses_message_id IS NOT NULL))
);

CREATE INDEX domain_notices_due_idx ON domain_notices (next_attempt_at) WHERE status = 'pending';
CREATE INDEX domain_notices_org_created_idx ON domain_notices (organization_id, created_at);

-- 끝난 알림(sent · dead · obsolete)은 바뀌지 않는다(보안 L3).
CREATE FUNCTION domain_notices_terminal() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF OLD.status <> 'pending' THEN
    RAISE EXCEPTION 'domain_notices: 끝난 알림(%)은 바뀌지 않는다(id=%)', OLD.status, OLD.id USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER domain_notices_immutable_core BEFORE UPDATE ON domain_notices
  FOR EACH ROW EXECUTE FUNCTION reject_column_update_except('status', 'attempt_count', 'next_attempt_at', 'claimed_at', 'last_error', 'ses_message_id', 'sent_at');
CREATE TRIGGER domain_notices_terminal BEFORE UPDATE ON domain_notices
  FOR EACH ROW EXECUTE FUNCTION domain_notices_terminal();
CREATE TRIGGER domain_notices_no_delete BEFORE DELETE ON domain_notices
  FOR EACH ROW EXECUTE FUNCTION reject_row_delete();
CREATE TRIGGER domain_notices_no_truncate AFTER TRUNCATE ON domain_notices
  FOR EACH STATEMENT EXECUTE FUNCTION reject_truncate();

COMMENT ON TABLE domain_notices IS
  '도메인 알림 outbox(ADR-0014 M14). 수신자·본문 없음 — atmark_claim_domain_notice 가 집기와 owner·admin 주소를 한 문장에. 한 통에 한·영 병기.';

-- ---------------------------------------------------------------------------
-- ④ 함수(정의자)
-- ---------------------------------------------------------------------------

-- 도메인 워밍업 시계(M4) — **보낸(sent)** 메시지의 발신 도메인이 고객 도메인이면 그 조직의 살아 있는 행에 **한 번** now() 를 적는다(보안 L5 —
-- 아직 안 나간 메시지로 시계를 당길 수 없다). 입력은 메시지 id 하나뿐이다(시각·도메인·조직을 호출자가 고르지 못한다). 참 = 이번에 적었다.
CREATE FUNCTION atmark_mark_domain_sending_started(p_message_id uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  marked integer;
BEGIN
  UPDATE public.custom_domains d
     SET sending_started_at = pg_catalog.now()
    FROM public.messages m JOIN public.agents a ON a.id = m.agent_id
   WHERE m.id = p_message_id
     AND m.direction = 'outbound'
     AND m.status = 'sent'
     AND m.from_domain <> 'atmark.ai'
     AND d.organization_id = a.organization_id
     AND d.domain = m.from_domain
     AND d.status <> 'removed'
     AND d.sending_started_at IS NULL;
  GET DIAGNOSTICS marked = ROW_COUNT;
  RETURN marked > 0;
END;
$$;

REVOKE ALL ON FUNCTION atmark_mark_domain_sending_started(uuid) FROM PUBLIC;

-- 알림 집기(보안 L3) — 대기 중이고 시도 시각이 됐고 임대(5분)가 끝난 알림 하나를 **집고**(claimed_at · 시도 수 +1) 같은 문장에서 그 조직의
-- 살아 있는 owner·admin 주소(지운 사용자 제외, 최대 20)를 돌려준다. 집지 못하면 NULL. 앱 롤은 users·memberships 권한이 0 이다.
CREATE FUNCTION atmark_claim_domain_notice(p_notice_id uuid) RETURNS text[]
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  org uuid;
  recipients text[];
BEGIN
  UPDATE public.domain_notices n
     SET claimed_at = pg_catalog.now(), attempt_count = n.attempt_count + 1
   WHERE n.id = p_notice_id
     AND n.status = 'pending'
     AND n.next_attempt_at <= pg_catalog.now()
     AND (n.claimed_at IS NULL OR n.claimed_at < pg_catalog.now() - interval '5 minutes')
  RETURNING n.organization_id INTO org;
  IF org IS NULL THEN
    RETURN NULL;
  END IF;
  SELECT coalesce(array_agg(q.email ORDER BY q.email), ARRAY[]::text[]) INTO recipients
    FROM (SELECT DISTINCT u.email
            FROM public.memberships m JOIN public.users u ON u.id = m.user_id AND u.erased_at IS NULL
           WHERE m.organization_id = org AND m.removed_at IS NULL AND m.role IN ('owner', 'admin')
           ORDER BY u.email
           LIMIT 20) AS q;
  RETURN recipients;
END;
$$;

REVOKE ALL ON FUNCTION atmark_claim_domain_notice(uuid) FROM PUBLIC;

-- ---------------------------------------------------------------------------
-- GRANT — `src/runtime/role-bootstrap.ts` `RESTRICTED_ROLE_GRANTS` 와 같다(migrate status 가 대조)
-- ---------------------------------------------------------------------------

-- admin(콘솔·조직 API): 읽기 · 행 만들기(식별 칸) · 수동 확인 칸 · 제거 요청. 상태·확인·사가 칸은 없다(보안 M2). DELETE 없음.
GRANT SELECT ON custom_domains TO atmark_admin;
GRANT INSERT (organization_id, domain, registrable_domain, challenge_token, created_by_user_id, next_check_at) ON custom_domains TO atmark_admin;
GRANT UPDATE (last_manual_check_at, next_check_at, removal_requested_at) ON custom_domains TO atmark_admin;
GRANT SELECT ON org_features TO atmark_admin;
GRANT SELECT ON domain_notices TO atmark_admin;

-- 틱(atmark_domain_tick — 단계 0 에서 NOLOGIN): 상태·확인·사가 칸 · 알림 적기 · 정책 주소·요금제·조직 상태 읽기. sending_started_at ·
--   removal_requested_at 은 없다. DELETE 없음.
GRANT USAGE ON SCHEMA public TO atmark_domain_tick;
GRANT SELECT ON custom_domains TO atmark_domain_tick;
GRANT UPDATE (status, suspended_reason, pending_reason, txt_verified_at, saga_step, saga_attempts, removal_step, last_error,
              ses_identity_row_tag, superseded_by, dkim_status, dkim_tokens, mail_from_status, inbound_mx_status, policy_digest,
              policy_sync_requested_at, last_checked_at, next_check_at, consecutive_definitive_failures,
              registration_expires_at, registration_checked_at, verified_at, suspended_at, removed_at, removal_due_at, identity_deleted_at)
  ON custom_domains TO atmark_domain_tick;
GRANT SELECT ON org_features TO atmark_domain_tick;
GRANT SELECT ON domain_notices TO atmark_domain_tick;
GRANT INSERT (domain_id, organization_id, kind, event_key) ON domain_notices TO atmark_domain_tick;
GRANT SELECT (agent_id, address, domain, is_primary, retired_at) ON agent_addresses TO atmark_domain_tick;
GRANT SELECT (id, organization_id) ON agents TO atmark_domain_tick;
GRANT SELECT (id, review_status) ON organizations TO atmark_domain_tick;
GRANT SELECT (organization_id, plan_code, grace_until) ON org_entitlements TO atmark_domain_tick;

-- 앱 롤(api · inbound · release · scheduled · notifier): 관문·수신이 읽는 칸만 · 워밍업 시계 · 알림 배출(집기는 함수로만).
GRANT SELECT (id, organization_id, domain, status, suspended_reason, sending_started_at, removed_at, created_at) ON custom_domains TO atmark_app;
GRANT EXECUTE ON FUNCTION atmark_mark_domain_sending_started(uuid) TO atmark_app;
GRANT SELECT (id, domain_id, organization_id, kind, event_key, created_at, status, attempt_count, next_attempt_at, claimed_at) ON domain_notices TO atmark_app;
-- `claimed_at` · `attempt_count` 는 집기 함수만 쓴다(재리뷰 L5 — 워커가 임대를 늘리거나 시도 수를 되돌리지 못한다).
GRANT UPDATE (status, next_attempt_at, last_error, ses_message_id, sent_at) ON domain_notices TO atmark_app;
GRANT EXECUTE ON FUNCTION atmark_claim_domain_notice(uuid) TO atmark_app;
