-- 202610071000_quarantine_notices.sql
-- 격리 알림(ADR-0016 2026-10-07 개정 — 진윤겸 요청): 인젝션 방어가 에이전트의 받은 메일을 **격리**하면(스캐너 격리 `injection_risk` · 판정 없음
-- `scanner_error` — 정책 차단 `policy_blocked` 는 아니다) 그 에이전트 조직의 **소유자**(`organizations.owner_email` — 승인 알림과 같은 수신자)에게
-- 알린다. 시스템 메일 범주의 열째(`SYSTEM_MAIL_ENTRYPOINTS` 의 `quarantine_notice`).
--
--   ① `quarantine_notices` — outbox. **에이전트마다 열린 창 하나**(부분 UNIQUE — 대기 중이고 아직 집히지 않은 행). 창의 첫 격리부터 2분 뒤, 그리고
--      그 에이전트의 직전 알림을 집은 시각부터 15분 뒤 중 늦은 때에 나간다 — 에이전트당 15분에 한 통까지. 그 사이 격리는 같은 행의 수를 올린다.
--      수신자 · 제목 · 본문 · 발신 주소 칸이 없다. 끝난 행(sent · suppressed · dead · obsolete)은 바뀌지 않는다.
--   ② `quarantine_notice_items` — 창에 묶인 격리 메일(메일 하나에 한 줄 — PK 가 중복 계수를 막는다) + **검사를 통과한 보낸 사람 도메인**(모양이
--      맞지 않으면 NULL) + 그 From 이 DMARC 인증됐는가(`inbound_messages.from_authenticated` — 보안 리뷰 M2: 인증된 도메인만 본문에 싣는다) + 격리 사유(두 값).
--      제목 · 본문 · 주소의 로컬파트는 어디에도 없다.
--   ③ 트리거 `inbound_messages_quarantine_notice`(AFTER INSERT, 위 두 사유만) → 정의자 함수 `quarantine_notice_record()`. **수신 소비자의 같은
--      트랜잭션**이다(메일 행이 되돌려지면 알림 계수도 없다). 앱 롤은 이 두 표에 INSERT 권한이 없다 — 계수를 부풀리거나 다른 에이전트 창을 고를
--      자리가 없다. 함수 안의 어떤 실패도 메일 기록을 막지 않는다(WARNING 후 넘어간다 — 알림은 최선 노력, 메일 유실은 안 된다). 에이전트 잠금은
--      **기다리지 않는다**(보안 리뷰 L2 — `pg_try_advisory_xact_lock`, 못 잡으면 계수를 건너뛴다). 건너뛴 · 삼킨 메일은 알림기 틱의 대조(최근 24시간 격리
--      메일 중 항목 행이 없는 수 → 메트릭 `atmark.quarantine_notice.unrecorded`)가 드러낸다 — 그 대조의 색인은 202610071001(비트랜잭션).
--   ④ 집기 `atmark_claim_quarantine_notice(id)`(DEFINER) — 임대(5분) · 시도 수 +1 과 **같은 문장에서** 그 조직의 `owner_email` 을 돌려준다(
--      0 또는 1 개 배열 — 알림 모듈의 SQL 은 그 칸을 읽지 않는다, arch gate-chokepoint). 조직 하루 상한(20통)과 그 초과분의 `suppressed` 는 알림기(앱 롤)가 조직 잠금 아래
--      정한다(`src/notify/quarantine-notifier.ts`). 시도 5번을 다 쓴 행은 집지 않는다(보안 리뷰 L3). 알림기는 보내기 **직전에** `last_error = 'sending'` 을
--      적는다 — 그 표지가 남은 채 임대가 끝난 행(보냈는지 모른다 — 보낸 뒤 기록 실패 · 프로세스 죽음)은 다시 보내지 않고 `obsolete(unsettled_send)` 로 닫는다
--      (at-most-once — 격리 알림은 중복이 유실보다 나쁘다: 승인 알림과 반대 선택).
--
-- 잠금: 새 표 둘 · 함수 · `inbound_messages` 에 트리거 하나(CREATE TRIGGER — 짧은 SHARE ROW EXCLUSIVE) · FK(agents · organizations · inbound_messages
-- — 짧은 SHARE ROW EXCLUSIVE). 기존 표의 행을 읽거나 고치지 않는다. 5초 안에 못 잡으면 실패하고 아무것도 바뀌지 않는다.
-- **순서:** 터널 migrate(이 파일) → `deploy-compute migrate=false`. 옛 코드는 이 표를 모른다(행은 쌓이기만 하고 알림기가 없으면 나가지 않는다 —
-- 새 알림기는 24시간 넘은 창을 `obsolete` 로 닫는다). expand-only.

SET LOCAL lock_timeout = '5s';

-- 이 파일이 GRANT 하는 롤이 먼저 있어야 한다 — 없으면 아무것도 바꾸지 않고 멈춘다.
DO $$
DECLARE
  missing text;
BEGIN
  SELECT string_agg(name, ', ') INTO missing
    FROM unnest(ARRAY['atmark_admin', 'atmark_app']) AS name
   WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = name);
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION 'role % does not exist — migrate 핸들러의 bootstrap-roles 를 먼저 돌려라', missing;
  END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- ① quarantine_notices
-- ---------------------------------------------------------------------------

CREATE TABLE quarantine_notices (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id         character(32) NOT NULL REFERENCES agents (id) ON DELETE RESTRICT,
  organization_id  uuid NOT NULL REFERENCES organizations (id) ON DELETE RESTRICT,
  -- 창의 첫 격리 · 마지막 격리(정의자 함수가 now() 로만 적는다).
  first_at         timestamptz NOT NULL DEFAULT now(),
  last_at          timestamptz NOT NULL DEFAULT now(),
  message_count    integer NOT NULL DEFAULT 0 CHECK (message_count >= 0),
  status           text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'suppressed', 'dead', 'obsolete')),
  attempt_count    integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  next_attempt_at  timestamptz NOT NULL,
  claimed_at       timestamptz,
  last_error       text CHECK (last_error ~ '^[a-z][a-z0-9_.:-]{0,79}$'),
  ses_message_id   text CHECK (ses_message_id ~ '^[A-Za-z0-9._-]{1,128}$'),
  sent_at          timestamptz,
  CONSTRAINT quarantine_notices_sent_shape CHECK ((status = 'sent') = (sent_at IS NOT NULL AND ses_message_id IS NOT NULL)),
  CONSTRAINT quarantine_notices_window_shape CHECK (last_at >= first_at)
);

-- 에이전트마다 열린 창 하나 — 정의자 함수가 잠금 아래 찾고, 경합에서 진 쪽은 이 색인에 막힌다(함수가 WARNING 후 넘어간다).
CREATE UNIQUE INDEX quarantine_notices_open_key ON quarantine_notices (agent_id) WHERE status = 'pending' AND claimed_at IS NULL;
CREATE INDEX quarantine_notices_due_idx ON quarantine_notices (next_attempt_at) WHERE status = 'pending';
-- 조직 하루 상한(집은 시각 기준) · 에이전트의 직전 알림(15분 간격 · 상한 초과분 합계).
CREATE INDEX quarantine_notices_org_claimed_idx ON quarantine_notices (organization_id, claimed_at) WHERE claimed_at IS NOT NULL;
CREATE INDEX quarantine_notices_agent_claimed_idx ON quarantine_notices (agent_id, claimed_at) WHERE claimed_at IS NOT NULL;

-- 끝난 알림은 바뀌지 않는다 · 집힌 창의 수는 더 늘지 않는다(집은 뒤의 렌더가 읽은 수가 마지막 수다).
CREATE FUNCTION quarantine_notices_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF OLD.status <> 'pending' THEN
    RAISE EXCEPTION 'quarantine_notices: 끝난 알림(%)은 바뀌지 않는다(id=%)', OLD.status, OLD.id USING ERRCODE = '23514';
  END IF;
  IF OLD.claimed_at IS NOT NULL AND (NEW.message_count IS DISTINCT FROM OLD.message_count OR NEW.last_at IS DISTINCT FROM OLD.last_at) THEN
    RAISE EXCEPTION 'quarantine_notices: 집힌 창의 수는 바뀌지 않는다(id=%)', OLD.id USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER quarantine_notices_immutable_core BEFORE UPDATE ON quarantine_notices
  FOR EACH ROW EXECUTE FUNCTION reject_column_update_except('status', 'attempt_count', 'next_attempt_at', 'claimed_at', 'last_error',
                                                            'ses_message_id', 'sent_at', 'message_count', 'last_at');
CREATE TRIGGER quarantine_notices_guard BEFORE UPDATE ON quarantine_notices
  FOR EACH ROW EXECUTE FUNCTION quarantine_notices_guard();
CREATE TRIGGER quarantine_notices_no_delete BEFORE DELETE ON quarantine_notices
  FOR EACH ROW EXECUTE FUNCTION reject_row_delete();
CREATE TRIGGER quarantine_notices_no_truncate AFTER TRUNCATE ON quarantine_notices
  FOR EACH STATEMENT EXECUTE FUNCTION reject_truncate();

COMMENT ON TABLE quarantine_notices IS
  '격리 알림 outbox(ADR-0016 2026-10-07). 에이전트당 열린 창 하나 · 15분에 한 통. 수신자·본문 없음 — atmark_claim_quarantine_notice 가 집기와 owner_email 을 한 문장에. 한 통에 한·영 병기.';

-- ---------------------------------------------------------------------------
-- ② quarantine_notice_items
-- ---------------------------------------------------------------------------

CREATE TABLE quarantine_notice_items (
  inbound_message_id  uuid PRIMARY KEY REFERENCES inbound_messages (id) ON DELETE RESTRICT,
  notice_id           uuid NOT NULL REFERENCES quarantine_notices (id) ON DELETE RESTRICT,
  -- 보낸 사람 주소의 도메인 — 소문자 LDH 라벨 2개 이상 · TLD 는 글자(또는 xn--) · 253자. 맞지 않으면 NULL(본문에 싣지 않는다).
  sender_domain       text CHECK (sender_domain IS NULL OR (length(sender_domain) <= 253
                        AND sender_domain ~ '^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+([a-z]{2,63}|xn--[a-z0-9-]{1,59})$')),
  -- 보낸 사람 From 이 DMARC 인증됐는가(`inbound_messages.from_authenticated`). 거짓이면 도메인은 본문에 싣지 않고 수로만 센다(위조 From — 보안 리뷰 M2).
  sender_authenticated boolean NOT NULL,
  reason              text NOT NULL CHECK (reason IN ('injection_risk', 'scanner_error')),
  created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX quarantine_notice_items_notice_idx ON quarantine_notice_items (notice_id);

CREATE TRIGGER quarantine_notice_items_immutable BEFORE UPDATE ON quarantine_notice_items
  FOR EACH ROW EXECUTE FUNCTION reject_column_update_except();
CREATE TRIGGER quarantine_notice_items_no_delete BEFORE DELETE ON quarantine_notice_items
  FOR EACH ROW EXECUTE FUNCTION reject_row_delete();
CREATE TRIGGER quarantine_notice_items_no_truncate AFTER TRUNCATE ON quarantine_notice_items
  FOR EACH STATEMENT EXECUTE FUNCTION reject_truncate();

COMMENT ON TABLE quarantine_notice_items IS
  '격리 알림 창에 묶인 격리 메일(메일 하나에 한 줄). 검사를 통과한 보낸 사람 도메인 · 사유만 — 제목·본문·로컬파트 없음.';

-- ---------------------------------------------------------------------------
-- ③ 기록 — inbound_messages AFTER INSERT(격리 사유 둘만)
-- ---------------------------------------------------------------------------

-- 입력은 방금 들어간 메일 행 하나뿐이다(에이전트 · 조직 · 도메인 · 사유를 호출자가 고르지 못한다). 에이전트 단위 잠금 아래 열린 창을 찾고(없으면
-- 새 창 — 직전 알림 15분 간격) 메일 한 줄을 묶고 수를 올린다. **어떤 실패도 메일 기록을 막지 않는다** — 수신 소비자는 23xxx 를 "입력 거부" 로 읽어
-- 메일을 버리므로(`inputRejectionOf`), 여기서 던지면 격리 메일이 사라진다. WARNING 한 줄(SQLSTATE 만) 남기고 넘어간다.
CREATE FUNCTION quarantine_notice_record() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  org uuid;
  notice uuid;
  dom text;
  previous timestamptz;
BEGIN
  IF NEW.quarantine_reason IS NULL OR NEW.quarantine_reason NOT IN ('injection_risk', 'scanner_error') THEN
    RETURN NULL;
  END IF;
  BEGIN
    SELECT a.organization_id INTO org FROM public.agents a WHERE a.id = NEW.agent_id;
    -- 기다리지 않는다(보안 리뷰 L2) — 같은 에이전트의 다른 수신 트랜잭션이 쥐고 있으면 이 메일은 세지 않는다(알림기 대조가 드러낸다).
    IF NOT pg_catalog.pg_try_advisory_xact_lock(pg_catalog.hashtextextended('quarantine_notice:' || NEW.agent_id::text, 0)) THEN
      RAISE WARNING 'quarantine_notice_record: 에이전트 잠금을 못 잡아 계수를 건너뛴다';
      RETURN NULL;
    END IF;
    dom := pg_catalog.lower(NEW.from_domain);
    IF dom IS NULL OR pg_catalog.length(dom) > 253
       OR dom !~ '^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+([a-z]{2,63}|xn--[a-z0-9-]{1,59})$' THEN
      dom := NULL;
    END IF;
    SELECT n.id INTO notice
      FROM public.quarantine_notices n
     WHERE n.agent_id = NEW.agent_id AND n.status = 'pending' AND n.claimed_at IS NULL
     FOR UPDATE;
    IF notice IS NULL THEN
      SELECT max(n.claimed_at) INTO previous FROM public.quarantine_notices n WHERE n.agent_id = NEW.agent_id AND n.claimed_at IS NOT NULL;
      INSERT INTO public.quarantine_notices (agent_id, organization_id, next_attempt_at)
      VALUES (NEW.agent_id, org,
              GREATEST(pg_catalog.now() + interval '2 minutes', coalesce(previous + interval '15 minutes', '-infinity'::timestamptz)))
      RETURNING id INTO notice;
    END IF;
    INSERT INTO public.quarantine_notice_items (inbound_message_id, notice_id, sender_domain, sender_authenticated, reason)
    VALUES (NEW.id, notice, dom, coalesce(NEW.from_authenticated, false), NEW.quarantine_reason);
    UPDATE public.quarantine_notices
       SET message_count = message_count + 1, last_at = GREATEST(last_at, pg_catalog.now())
     WHERE id = notice;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'quarantine_notice_record: 알림 계수를 건너뛴다(sqlstate=%)', SQLSTATE;
  END;
  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION quarantine_notice_record() FROM PUBLIC;

CREATE TRIGGER inbound_messages_quarantine_notice AFTER INSERT ON inbound_messages
  FOR EACH ROW WHEN (NEW.quarantine_reason IN ('injection_risk', 'scanner_error'))
  EXECUTE FUNCTION quarantine_notice_record();

-- ---------------------------------------------------------------------------
-- ④ 집기(정의자) — 수신자는 여기서만 나온다
-- ---------------------------------------------------------------------------

-- 결과 두 칸: `recipients`(집었으면 owner_email 0~1 개 배열, 못 집었으면 NULL) · `unsettled`(참 = 보내기 직전 표지가 남은 행을 이번에 obsolete(unsettled_send)
-- 로 닫았다 — 알림기가 warn 로그 · 메트릭을 남긴다).
-- 대기 중이고 시도 시각이 됐고 임대(5분)가 끝난 알림 하나를 **집고**(claimed_at · 시도 수 +1 — 이 순간부터 창은 닫혀 새 격리는 새 창으로 간다)
-- 같은 문장에서 그 조직의 owner_email 을 돌려준다(없으면 빈 배열). 집지 못하면 NULL. 수신자가 나오는 곳은 이 함수 하나다.
CREATE FUNCTION atmark_claim_quarantine_notice(p_notice_id uuid, OUT recipients text[], OUT unsettled boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  org uuid;
BEGIN
  recipients := NULL;
  unsettled := false;
  -- 보내기 직전 표지('sending')가 남은 채 임대가 끝났다 = 나갔는지 모른다. 다시 보내지 않는다(at-most-once).
  UPDATE public.quarantine_notices n
     SET status = 'obsolete', last_error = 'unsettled_send'
   WHERE n.id = p_notice_id
     AND n.status = 'pending'
     AND n.last_error = 'sending'
     AND n.claimed_at < pg_catalog.now() - interval '5 minutes';
  IF FOUND THEN
    unsettled := true;
    RETURN;
  END IF;
  UPDATE public.quarantine_notices n
     SET claimed_at = pg_catalog.now(), attempt_count = n.attempt_count + 1
   WHERE n.id = p_notice_id
     AND n.status = 'pending'
     AND n.attempt_count < 5
     AND n.last_error IS DISTINCT FROM 'sending'
     AND n.next_attempt_at <= pg_catalog.now()
     AND (n.claimed_at IS NULL OR n.claimed_at < pg_catalog.now() - interval '5 minutes')
  RETURNING n.organization_id INTO org;
  IF org IS NULL THEN
    RETURN;
  END IF;
  SELECT coalesce(array_agg(o.owner_email) FILTER (WHERE o.owner_email IS NOT NULL), ARRAY[]::text[]) INTO recipients
    FROM public.organizations o WHERE o.id = org;
END;
$$;

REVOKE ALL ON FUNCTION atmark_claim_quarantine_notice(uuid) FROM PUBLIC;

-- 트리거가 생긴 시각(이 파일을 적용한 트랜잭션의 now() — 상수로 굳힌다). 틱 대조(unrecorded)의 하한이 이것과 24시간 전 중 늦은 쪽이다 — 트리거 전에 들어온
-- 격리 메일을 "창에 묶이지 않았다" 로 세지 않게(재검증 Low). 앱 롤은 schema_migrations 를 읽지 못하므로 값을 함수 본문에 싣는다. 다시 적용하면 그 시각으로 바뀐다.
DO $$
BEGIN
  EXECUTE pg_catalog.format(
    'CREATE FUNCTION quarantine_notice_started_at() RETURNS timestamptz LANGUAGE sql IMMUTABLE PARALLEL SAFE AS %L',
    pg_catalog.format('SELECT %L::timestamptz', pg_catalog.now()));
END
$$;

-- ---------------------------------------------------------------------------
-- GRANT — `src/runtime/role-bootstrap.ts` `RESTRICTED_ROLE_GRANTS` 와 같다(migrate status 가 대조)
-- ---------------------------------------------------------------------------

-- 앱 롤(알림 배출 — approval-notifier λ): 읽기 칸 · 결말 칸 UPDATE · 집기 함수. INSERT·DELETE 0(행은 트리거만 적는다).
--   `claimed_at` · `attempt_count` · `message_count` · `last_at` 은 정의자 함수만 쓴다.
GRANT SELECT (id, agent_id, organization_id, first_at, last_at, message_count, status, attempt_count, next_attempt_at, claimed_at)
  ON quarantine_notices TO atmark_app;
GRANT UPDATE (status, next_attempt_at, last_error, ses_message_id, sent_at) ON quarantine_notices TO atmark_app;
GRANT SELECT (inbound_message_id, notice_id, sender_domain, sender_authenticated, reason) ON quarantine_notice_items TO atmark_app;
GRANT EXECUTE ON FUNCTION atmark_claim_quarantine_notice(uuid) TO atmark_app;
GRANT EXECUTE ON FUNCTION quarantine_notice_started_at() TO atmark_app;
-- admin(콘솔): 읽기만(지금 쓰는 화면은 없다 — 도메인 알림과 같은 모양).
GRANT SELECT ON quarantine_notices TO atmark_admin;
