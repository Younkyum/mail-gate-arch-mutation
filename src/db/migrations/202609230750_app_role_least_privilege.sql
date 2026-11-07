-- 202609230750_app_role_least_privilege.sql
-- 앱 롤(`atmark_app` — api Lambda 와 모든 워커)의 권한을 **앱 코드가 실제로 보내는 쓰기**로 줄이고, 줄일 수 없는 쓰기에는
-- DB 가드를 세운다 (ADR-0006 보강 — 2차 적대적 검증 H-A · H-B · M-A · M-C · L-A · L-D).
--
-- 무엇이 틀렸나 — 검증자가 `atmark_app` 으로 **실제로** 해 보인 것:
--   H-A ① `UPDATE approval_requests SET status='approved'` → 릴리스 일정이 트리거로 생긴다(승인 위조).
--       ② `INSERT policy_versions` + `UPDATE agent_policies SET outbound_mode='unrestricted'` → 정책 해제.
--       ③ `UPDATE agent_api_keys SET revoked_at = NULL` → 폐기한 토큰이 되살아난다(복구 = 패치 + 회전이 무력화).
--       ④ `INSERT sender_relationships`(seed / granted_by='owner_provisioning') → 승인 없는 상대 허용.
--       ⑤ `UPDATE audit_logs SET decision='allowed'` → 승인 없이 "허용" 으로 다시 쓰인 감사.
--   H-B `INSERT organizations/agents(status active)/agent_addresses(예약 로컬파트 'login@' 포함)/agent_api_keys/
--       agent_policies/policy_versions` → 공격자 토큰을 가진 **영속 백도어 에이전트**. `UPDATE agent_addresses SET
--       agent_id=<백도어>` → 피해자 주소를 가로챈다. 패치 + 비밀 회전 뒤에도 남는다 — ADR-0006 의 "복구가 영속성을
--       남기지 않는다" 가 깨진다.
--
-- 앱 롤이 실제로 쓰는 것(grep, 2026-09-23 — `src/**` 에서 `src/admin/**` 제외. 프로비저닝 저장소
--   `src/api/provisioning-store.ts` 와 토큰 발급·폐기는 CLI(소유자 롤)·admin(`atmark_admin`)만 부른다 — api 조립
--   `runtime/composition.ts` 는 토큰 저장소를 **조회(findByHash)** 로만 쓴다):
--   | 테이블 | 앱 롤 쓰기 | 어디서 |
--   |---|---|---|
--   | organizations | UPDATE(sending_started_at) | db/repositories/sending-clock.ts (202609230730 이 이미 좁혔다) |
--   | agents · agent_addresses · agent_api_keys · agent_keypairs · passports · agent_policies · policy_versions | **없음** | 프로비저닝·토큰은 CLI·admin |
--   | suppression_entries | **없음**(읽기만 — policy-source · trust-facts) | |
--   | approval_requests | INSERT(id, agent_id, subject, created_at, expires_at) · UPDATE(status, decided_at, decided_by, granted_scope) | audit-sink(관문) · approval-store(결정·만료) |
--   | approval_request_items · audit_logs(INSERT) | INSERT | audit-sink |
--   | audit_logs | UPDATE(decision, approved_by, resolved_at, resolution_reason) | audit-sink · approval-store |
--   | approval_notifications · approval_releases | INSERT 는 **승인 요청 트리거만**(아래에서 SECURITY DEFINER 로) · UPDATE(outbox 컬럼) | notify/approval-notifier · approval-store |
--   | sender_relationships | INSERT(`approved` 만) | approval-store(결정 경로) |
--   | messages | INSERT · UPDATE(status, lease_id, lease_expires_at, attempt, failure_reason, failed_at, ses_message_id, sent_at) | outbound-store · lease-store · gate · approval-store |
--   | threads | INSERT · UPDATE(last_message_at) | outbound-store · inbound-store |
--   | outbound_prepare_claims | INSERT · UPDATE(claimed_until, generation, updated_at) | outbound-store |
--   | scheduled_sends | INSERT · UPDATE(attempt_count, lease_expires_at, status, dispatched_at, dispatch_outcome, message_id) | scheduled-send-store |
--   | webhook_endpoints | INSERT | webhook-store |
--   | webhook_deliveries | INSERT · UPDATE(attempt_count, next_attempt_at, last_error, last_http_status, status, dead_at, delivered_at) | webhook-store |
--   | inbound_messages · inbound_attachments · inbound_rejections · security_findings · ses_events · approval_link_uses · outbound_recipients | INSERT | inbound-store · ses-event-store · approval-link-use-store · outbound-store |
--   | ac0_gates · ac0_gate_events · human_mailbox_interventions | INSERT | **AC-0 CLI(`scripts/ac0-*`)가 앱 롤로 붙는다** — 그대로 둔다(잔여, ADR-0006) |
--
-- 이 파일이 하는 일:
--   ① 위 표 밖의 INSERT·UPDATE·DELETE 를 거둔다. UPDATE 는 전부 **컬럼 단위**로 다시 준다.
--   ② `approval_notifications`·`approval_releases` 를 만드는 승인 요청 트리거 함수를 SECURITY DEFINER 로 — 앱 롤이 릴리스
--      일정·알림 행을 **직접** 만들 길을 닫는다(트리거만 만든다).
--   ③ `agent_api_keys.revoked_at` 쓰기 1회(모든 롤) — 한 번 폐기된 토큰은 누구도 되살리지 못한다.
--   ④ `agent_addresses` 예약 로컬파트 CHECK — `src/identity/address.ts` `RESERVED_LOCAL_PARTS` 와 같은 목록(정확 일치 —
--      TS 도 접두·접미 규칙이 없다). 목록은 함수 `atmark_reserved_local_parts()` 하나에 있고 통합 테스트가 TS 목록과 대조한다.
--   ⑤ `sender_relationships` INSERT 가드 — `seed`·`granted_by='owner_provisioning'` 은 소유자 롤·`atmark_admin` 만.
--      `approved` 는 같은 에이전트의 **승인된** 요청을 가리켜야 한다(모든 롤).
--   ⑥ `audit_logs` `pending_approval → allowed` 는 연결된 승인 요청이 `approved` 일 때만(모든 롤).
--   ⑦ 승인은 조직 정지(`owner_paused`)·플랫폼 동결(`abuse_freeze`) 중에 성립하지 않는다(L-A) — 정지 중의 승인이 관계를 남기지
--      않게. 거절·만료는 그대로 된다(안전 방향).
--   ⑧ 운영자 정지(`agents.suspended_by='operator'`)는 테이블 소유자(= CLI·마이그레이션 롤)만 걸고 푼다 — `atmark_admin` 의
--      raw UPDATE 로도 안 된다(7).
--   ⑨ `owner_email` 이 바뀌면 그 조직의 **쓰지 않은 로그인 링크를 전부 무효화**한다(M-C): 아직 안 보낸 링크는 `obsolete`,
--      보낸 링크는 `invalidated_at` — 무효화된 링크의 `used_at` 기록(= verify)은 0행이 된다.
--   ⑩ `TEMPORARY` 를 PUBLIC 에서 거둔다(L-D) — DB 이름에 묶이지 않게 `current_database()`.
--
-- `migrate status` 가 ① 의 역방향(앱 롤이 다시 얻으면 ok=false)과 ②~⑨ 트리거의 존재, ⑩ 을 본다
--   (`APP_FORBIDDEN_PRIVILEGES` · `REQUIRED_GUARD_TRIGGERS` · `RESTRICTED_ROLE_GRANTS[atmark_app]`).
--
-- 마이그레이션은 append-only 다. 기존 파일은 한 글자도 건드리지 않았다(0700·0710 의 함수·트리거는 여기서 다시 정의한다).

-- ---------------------------------------------------------------------------
-- ① 앱 롤 권한 — 거두고 컬럼 단위로 다시 준다
-- ---------------------------------------------------------------------------

-- 프로비저닝·토큰·정책 — 앱 롤 쓰기 0 (H-A ②③ · H-B).
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON
  organizations, agents, agent_addresses, agent_api_keys, agent_keypairs, passports, agent_policies, policy_versions
  FROM atmark_app;
-- 202609230730 이 준 한 칸은 되돌려 준다(위 REVOKE 는 테이블 단위라 컬럼 GRANT 를 건드리지 않지만, 의도를 한 곳에 적는다).
GRANT UPDATE (sending_started_at) ON organizations TO atmark_app;

-- 억제 목록 — 앱 코드는 읽기만 한다. 쓰기가 열려 있으면 api 탈취가 억제 항목을 지워 신고한 수신자에게 다시 보낸다.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON suppression_entries FROM atmark_app;

-- 쓰는 컬럼만. REVOKE 가 테이블 단위 권한만 거두므로, 다시 주는 것은 전부 컬럼 단위다.
REVOKE INSERT, UPDATE ON approval_requests FROM atmark_app;
-- 관문이 만드는 `pending` 행의 다섯 칸. 결정 칸(status·decided_*·granted_scope)을 INSERT 로 채우는 길이 없다 —
--   "처음부터 approved 인 요청" 을 만들어 ⑤ 의 관계 가드를 통과시키는 우회를 닫는다.
GRANT INSERT (id, agent_id, subject, created_at, expires_at) ON approval_requests TO atmark_app;
-- 결정 경로(`/approve` 매직링크 · 만료 스위퍼). ★ 구조적 잔여: api 탈취(승인 링크 키 + 앱 롤) ⇒ 승인 위조 — ADR-0006.
GRANT UPDATE (status, decided_at, decided_by, granted_scope) ON approval_requests TO atmark_app;

REVOKE INSERT, UPDATE ON approval_notifications, approval_releases FROM atmark_app;
GRANT UPDATE (status, attempt_count, next_attempt_at, claimed_at, last_error, ses_message_id, sent_at, settled_at)
  ON approval_notifications TO atmark_app;
GRANT UPDATE (status, claim_count, next_release_at, last_deferral_reason, settled_outcome, settled_at)
  ON approval_releases TO atmark_app;

-- audit_logs — 가변 네 칸(트리거 `audit_logs_partial_immutability` 와 같은 목록)만. `allowed` 전이는 ⑥ 이 가드한다.
REVOKE UPDATE ON audit_logs FROM atmark_app;
GRANT UPDATE (decision, approved_by, resolved_at, resolution_reason) ON audit_logs TO atmark_app;

REVOKE UPDATE ON messages FROM atmark_app;
GRANT UPDATE (status, lease_id, lease_expires_at, attempt, failure_reason, failed_at, ses_message_id, sent_at)
  ON messages TO atmark_app;

REVOKE UPDATE ON threads FROM atmark_app;
GRANT UPDATE (last_message_at) ON threads TO atmark_app;

REVOKE UPDATE ON outbound_prepare_claims FROM atmark_app;
GRANT UPDATE (claimed_until, generation, updated_at) ON outbound_prepare_claims TO atmark_app;

REVOKE UPDATE ON scheduled_sends FROM atmark_app;
GRANT UPDATE (attempt_count, lease_expires_at, status, dispatched_at, dispatch_outcome, message_id)
  ON scheduled_sends TO atmark_app;

REVOKE UPDATE ON webhook_deliveries FROM atmark_app;
GRANT UPDATE (attempt_count, next_attempt_at, last_error, last_http_status, status, dead_at, delivered_at)
  ON webhook_deliveries TO atmark_app;

-- 앱 코드에 UPDATE 가 없다.
REVOKE UPDATE ON webhook_endpoints, inbound_messages FROM atmark_app;

-- ---------------------------------------------------------------------------
-- ② 승인 요청 트리거 — 알림·릴리스 일정은 트리거만 만든다 (SECURITY DEFINER)
-- ---------------------------------------------------------------------------
-- 본문은 202609222100 · 202609222300 과 **같다**. 바뀐 것은 실행 권한뿐이다: 소유자(마이그레이션 롤)의 권한으로 돈다 —
--   앱 롤에서 두 테이블의 INSERT 를 거둘 수 있게. 함수가 하는 일은 고정된 INSERT 한 문장이고 search_path 를 고정한다.

CREATE OR REPLACE FUNCTION approval_requests_enqueue_notification() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  INSERT INTO public.approval_notifications (approval_id, organization_id, next_attempt_at)
  SELECT NEW.id, a.organization_id,
         NEW.created_at + CASE WHEN NEW.subject = 'batch' THEN interval '2 minutes' ELSE interval '0' END
    FROM public.agents a
   WHERE a.id = NEW.agent_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'approval request % has no agent row (%): notification cannot be enqueued', NEW.id, NEW.agent_id
      USING ERRCODE = '23503';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION approval_requests_enqueue_notification() FROM PUBLIC;

CREATE OR REPLACE FUNCTION approval_requests_schedule_release() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  INSERT INTO public.approval_releases (message_id, approval_id, audit_id, agent_id, next_release_at, deadline_at)
  SELECT i.message_id, i.approval_id, i.audit_id, NEW.agent_id, NEW.decided_at, NEW.decided_at + interval '48 hours'
    FROM public.approval_request_items i
   WHERE i.approval_id = NEW.id;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION approval_requests_schedule_release() FROM PUBLIC;

-- ---------------------------------------------------------------------------
-- ③ agent_api_keys.revoked_at — 쓰기 1회 (모든 롤)
-- ---------------------------------------------------------------------------
-- NULL → 값 1회. 값 → NULL(부활)·값 → 다른 값(폐기 시각 고쳐 쓰기)은 거부. CLI 회전·admin 폐기는 전부
--   `... SET revoked_at = now() WHERE ... AND revoked_at IS NULL` 이라 그대로 된다.
CREATE TRIGGER agent_api_keys_revoked_once
  BEFORE UPDATE ON agent_api_keys
  FOR EACH ROW EXECUTE FUNCTION reject_column_overwrite('revoked_at');

-- ---------------------------------------------------------------------------
-- ④ 예약 로컬파트 — DB 도 거부한다
-- ---------------------------------------------------------------------------
-- 목록은 `src/identity/address.ts` `RESERVED_LOCAL_PARTS` 와 **같은 순서·같은 값**이다(정확 일치만 — TS 도 접두 규칙이
--   없다: `postmaster2`·`notify-team` 은 예약이 아니다). 둘의 일치는 `test/integration/runtime/app-role-least-privilege.test.ts`
--   가 본다 — 한쪽만 늘리면 빨개진다.
CREATE OR REPLACE FUNCTION atmark_reserved_local_parts() RETURNS text[]
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT ARRAY[
    'postmaster', 'abuse', 'hostmaster', 'webmaster', 'noc', 'security',
    'dmarc', 'noreply', 'no-reply', 'bounce', 'mailer-daemon', 'notify',
    'blocked-test',
    'admin', 'support', 'billing', 'help', 'info', 'login', 'console', 'atmark', 'team', 'sales', 'hello', 'root',
    'system', 'approve', 'api', 'mail', 'www'
  ]::text[]
$$;

-- NOT VALID: 이미 있는 행은 검사하지 않고(아래에서 위반이 없을 때만 VALIDATE), 새 행과 갱신은 언제나 검사한다.
--   개발 DB 에는 예약 목록이 넓어지기 전에 만든 행이 있을 수 있다 — 그 행 때문에 마이그레이션 전체가 멈추면 나머지
--   권한 축소도 적용되지 않는다. 운영 DB 는 VALIDATE 됐는지 `docs/runbooks/deploy.md` 의 확인 쿼리로 본다.
ALTER TABLE agent_addresses ADD CONSTRAINT agent_addresses_not_reserved_local_part
  CHECK (NOT (split_part(address, '@', 1) = ANY (atmark_reserved_local_parts()))) NOT VALID;

DO $$
DECLARE
  offenders integer;
BEGIN
  SELECT count(*) INTO offenders FROM agent_addresses
   WHERE split_part(address, '@', 1) = ANY (atmark_reserved_local_parts());
  IF offenders = 0 THEN
    ALTER TABLE agent_addresses VALIDATE CONSTRAINT agent_addresses_not_reserved_local_part;
  ELSE
    RAISE WARNING 'agent_addresses 에 예약 로컬파트 주소가 % 개 있다 — CHECK 는 NOT VALID 로 남는다(새 행은 검사된다). docs/runbooks/deploy.md 참고', offenders;
  END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- ⑤ sender_relationships INSERT 가드
-- ---------------------------------------------------------------------------
-- 앱 롤은 결정 경로(`approval-store.insertRelationship`)로 `approved` 관계만 만든다. seed 는 소유자가 프로비저닝 때
--   적는 것이다(CLI = 소유자 롤, 콘솔 = atmark_admin). 허용 목록 방식이다 — 그 둘이 아닌 롤(앱·로그인 메일·앞으로 생길
--   롤)은 seed 를 못 만든다.
-- `approved` 는 **같은 에이전트의 승인된 요청**을 가리켜야 한다. 결정 경로는 같은 트랜잭션에서 요청을 `approved` 로
--   바꾼 뒤 관계를 넣으므로 그대로 된다. (잔여: 앱 롤은 결정 UPDATE 를 가지므로 대기 중 요청을 승인으로 바꾼 뒤 관계를
--   만들 수 있다 — 승인 위조와 같은 잔여, ADR-0006.)
CREATE OR REPLACE FUNCTION sender_relationships_insert_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.trust_category = 'seed' OR NEW.granted_by = 'owner_provisioning')
     AND current_user <> 'atmark_admin'
     AND NOT pg_has_role(current_user, (SELECT c.relowner FROM pg_catalog.pg_class c WHERE c.oid = TG_RELID), 'USAGE') THEN
    RAISE EXCEPTION 'role % cannot create seed relationships (owner/admin only)', current_user
      USING ERRCODE = '42501';
  END IF;
  IF NEW.trust_category = 'approved' AND NOT EXISTS (
       SELECT 1 FROM approval_requests r
        WHERE r.id = NEW.granted_via_approval_id AND r.agent_id = NEW.agent_id AND r.status = 'approved') THEN
    RAISE EXCEPTION 'approved relationship must reference an approved request of the same agent (approval %)',
      NEW.granted_via_approval_id USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER sender_relationships_insert_guard
  BEFORE INSERT ON sender_relationships
  FOR EACH ROW EXECUTE FUNCTION sender_relationships_insert_guard();

-- ---------------------------------------------------------------------------
-- ⑥ audit_logs — `allowed` 는 승인된 요청 위에서만
-- ---------------------------------------------------------------------------
-- 202609221430 의 전이 가드는 "pending_approval → allowed | denied" 만 허락한다. 그 한 전이가 곧 H-A ⑤ 였다 — 승인
--   없는 대기 행을 `allowed` 로 다시 쓰면 AC-9 의 "왜 이 메일이 나갔는가" 가 거짓이 된다. `denied` 는 안전 방향이라 그대로.
CREATE OR REPLACE FUNCTION audit_logs_allowed_requires_approval() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.decision = 'pending_approval' AND NEW.decision = 'allowed' AND NOT EXISTS (
       SELECT 1 FROM approval_requests r
        WHERE r.id = OLD.approval_id AND r.agent_id = OLD.agent_id AND r.status = 'approved') THEN
    RAISE EXCEPTION 'audit_logs % cannot become allowed without an approved request (approval %)', OLD.id, OLD.approval_id
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER audit_logs_allowed_requires_approval
  BEFORE UPDATE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION audit_logs_allowed_requires_approval();

-- ---------------------------------------------------------------------------
-- ⑦ 정지·동결 중에는 승인이 성립하지 않는다 (L-A)
-- ---------------------------------------------------------------------------
-- 앱 코드(`approval-store.approve`)가 먼저 보고 이유를 돌려준다. 이 트리거는 그 검사가 빠지는 날의 두 번째 층이다.
--   앱 롤은 `owner_paused`·`abuse_freeze` 를 바꾸지 못하므로(202609230730) api 탈취도 정지를 풀고 승인하지 못한다.
CREATE OR REPLACE FUNCTION approval_requests_reject_approve_while_paused() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'pending' AND NEW.status = 'approved' AND EXISTS (
       SELECT 1 FROM agents a JOIN organizations o ON o.id = a.organization_id
        WHERE a.id = NEW.agent_id AND (o.owner_paused OR o.abuse_freeze)) THEN
    RAISE EXCEPTION 'approval % cannot be approved while the organization is paused or frozen', NEW.id
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER approval_requests_reject_approve_while_paused
  BEFORE UPDATE ON approval_requests
  FOR EACH ROW EXECUTE FUNCTION approval_requests_reject_approve_while_paused();

-- ---------------------------------------------------------------------------
-- ⑧ 운영자 정지는 테이블 소유자만 (7)
-- ---------------------------------------------------------------------------
-- `atmark_admin` 은 `agents(status, suspended_by)` UPDATE 를 가진다(소유자 정지·해제). 코드(`ops/agents.ts`)는 운영자
--   정지를 풀지 않지만, admin 롤을 쥔 쪽의 raw UPDATE 는 코드를 거치지 않는다. 테이블 소유자(= 마이그레이션·CLI 롤, 그
--   멤버·슈퍼유저)가 아니면: 운영자 정지 행의 상태·주체를 바꿀 수 없고, 운영자 정지를 새로 걸 수도 없다(INSERT 포함).
CREATE OR REPLACE FUNCTION agents_operator_suspension_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF pg_has_role(current_user, (SELECT c.relowner FROM pg_catalog.pg_class c WHERE c.oid = TG_RELID), 'USAGE') THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.suspended_by = 'operator'
     AND (NEW.status IS DISTINCT FROM OLD.status OR NEW.suspended_by IS DISTINCT FROM OLD.suspended_by) THEN
    RAISE EXCEPTION 'agent % is suspended by the operator — only the operator (owner role) can change it', OLD.id
      USING ERRCODE = '42501';
  END IF;
  IF NEW.suspended_by = 'operator' AND (TG_OP = 'INSERT' OR OLD.suspended_by IS DISTINCT FROM 'operator') THEN
    RAISE EXCEPTION 'role % cannot set an operator suspension', current_user USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER agents_operator_suspension_guard
  BEFORE INSERT OR UPDATE ON agents
  FOR EACH ROW EXECUTE FUNCTION agents_operator_suspension_guard();

-- ---------------------------------------------------------------------------
-- ⑨ owner_email 변경 → 쓰지 않은 로그인 링크 무효화 (M-C)
-- ---------------------------------------------------------------------------

ALTER TABLE owner_login_links ADD COLUMN invalidated_at timestamptz;

COMMENT ON COLUMN owner_login_links.invalidated_at IS
  '소유자 주소가 바뀐 시각(쓰기 1회). 값이 있으면 이 링크로는 로그인할 수 없다(used_at 기록이 0행 — 트리거 owner_login_links_reject_invalidated_use).';

-- 202609230700 의 불변 트리거는 가변 컬럼 목록이 고정이다 — 새 컬럼을 더해 다시 세운다(목록 밖 컬럼은 여전히 불변).
DROP TRIGGER owner_login_links_immutable_core ON owner_login_links;
CREATE TRIGGER owner_login_links_immutable_core
  BEFORE UPDATE ON owner_login_links
  FOR EACH ROW EXECUTE FUNCTION reject_column_update_except(
    'used_at', 'status', 'attempt_count', 'next_attempt_at', 'claimed_at', 'last_error', 'ses_message_id', 'sent_at', 'settled_at',
    'invalidated_at');

CREATE TRIGGER owner_login_links_invalidated_once
  BEFORE UPDATE ON owner_login_links
  FOR EACH ROW EXECUTE FUNCTION reject_column_overwrite('invalidated_at');

-- 무효화된 링크로는 `used_at` 을 적을 수 없다 — 행을 건너뛴다(RETURN NULL). verify 의 조건부 UPDATE 가 0행이 되어
--   "유효하지 않은 링크"(401) 하나로 떨어진다. 예외로 던지지 않는 이유: verify 는 0행을 이미 거부로 읽고, 예외는
--   500 이 되어 "링크는 맞았다" 를 새게 한다.
CREATE OR REPLACE FUNCTION owner_login_links_reject_invalidated_use() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.invalidated_at IS NOT NULL AND OLD.used_at IS NULL AND NEW.used_at IS NOT NULL THEN
    RETURN NULL;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER owner_login_links_reject_invalidated_use
  BEFORE UPDATE ON owner_login_links
  FOR EACH ROW EXECUTE FUNCTION owner_login_links_reject_invalidated_use();

-- 202609230710 의 함수를 넓힌다(세션 폐기는 그대로): 주소가 바뀐 순간 그 조직의 쓰지 않은 링크 —
--   · 아직 안 보낸(`pending`) 링크는 `obsolete` 로 닫는다 → 로그인 메일 워커가 **새 주소로 보내지 않는다**.
--   · 이미 보낸 링크는 `invalidated_at` 을 찍는다 → 옛 주소의 메일함에 남은 링크로 로그인할 수 없다.
CREATE OR REPLACE FUNCTION organizations_owner_email_revokes_sessions() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  UPDATE public.owner_sessions SET revoked_at = now() WHERE organization_id = NEW.id AND revoked_at IS NULL;
  UPDATE public.owner_login_links
     SET status = 'obsolete', settled_at = now(), last_error = 'owner_email_changed'
   WHERE organization_id = NEW.id AND status = 'pending';
  UPDATE public.owner_login_links
     SET invalidated_at = now()
   WHERE organization_id = NEW.id AND used_at IS NULL AND invalidated_at IS NULL;
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION organizations_owner_email_revokes_sessions() FROM PUBLIC;

-- ---------------------------------------------------------------------------
-- ⑩ TEMPORARY — PUBLIC 에서 거둔다 (L-D)
-- ---------------------------------------------------------------------------
-- 임시 테이블은 어느 앱 코드도 쓰지 않는다. PUBLIC 의 기본 TEMP 는 앱·admin·로그인 메일 롤이 `pg_temp` 에 함수·테이블을
--   만들어 search_path 앞쪽을 가리는 재료가 된다. DB 이름은 환경마다 다르다 — `current_database()`.
DO $$
BEGIN
  EXECUTE format('REVOKE TEMPORARY ON DATABASE %I FROM PUBLIC', current_database());
END
$$;
