-- 202609230720_admin_and_login_mailer_roles.sql
-- 관리 표면의 DB 권한을 **전용 롤 둘**로 옮긴다 (ADR-0006, 2026-09-23 보안 검증 H1·H2).
--
--   ① `atmark_admin`        — admin Lambda(console.atmark.ai). 지금까지 admin 은 **소유자 롤**(DDL·GRANT·트리거 DROP 가능)
--                              로 붙었다 — admin 탈취가 곧 append-only 감사 트리거 해제·권한 재부여·전 테넌트 쓰기였다. 이 롤은
--                              **아무것도 소유하지 않고**, 아래 GRANT 만 가진다. 목록은 admin 번들이 실제로 보내는 SQL
--                              (`src/admin/**` · `src/admin/ops/**` · `src/gate/ac0-store.ts` · 프로비저닝 저장소 ·
--                              토큰 저장소 · seed 조회 · sender_marks 저장소)에서 뽑았다.
--   ② `atmark_login_mailer` — 로그인 메일 전용 Lambda(`atmark-login-mailer`). `owner_login_links` 의 **발송 컬럼**과
--                              수신자 한 칸(`organizations.owner_email`)뿐이다.
--
-- 롤 자체는 여기서 만들지 않는다 — `db/migrate.ts` 머리말의 규율(러너는 롤을 만들지 않는다) 그대로, migrate 핸들러의
-- `bootstrap-roles`(RDS 마스터)가 먼저 만든다. 없으면 아래 DO 블록이 이유를 적고 멈춘다(GRANT 를 조용히 건너뛴 DB 를
-- "성공" 으로 보고하지 않는다).
--
-- 허용 목록은 한 번 더 코드에 있다 — `src/runtime/role-bootstrap.ts` `RESTRICTED_ROLE_GRANTS`. migrate 의 `status` 가
-- 실제 권한(pg_class·pg_attribute ACL)을 그 목록과 대조하고, 넘치면 ok=false 다. 이 파일에 GRANT 를 더하면 그 목록도
-- 같은 변경에서 늘려야 한다(`test/integration/runtime/restricted-roles.test.ts` 가 둘의 일치를 본다).

DO $$
DECLARE
  missing text;
BEGIN
  SELECT string_agg(name, ', ') INTO missing
    FROM unnest(ARRAY['atmark_admin', 'atmark_login_mailer']) AS name
   WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = name);
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION 'role % does not exist — migrate 핸들러의 bootstrap-roles 를 먼저 돌려라(로컬: docs/runbooks/admin.md §8)', missing;
  END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- 앱 롤 — 로그인·세션·감사에 권한 0 (202609230700 이 이미 주지 않는다. 사이의 마이그레이션이 주었어도 여기서 거둔다).
-- ---------------------------------------------------------------------------

REVOKE ALL ON owner_login_links, owner_login_requests, owner_sessions, owner_actions FROM atmark_app;

-- ---------------------------------------------------------------------------
-- ① atmark_admin
-- ---------------------------------------------------------------------------

GRANT USAGE ON SCHEMA public TO atmark_admin;

-- 로그인·세션·감사 (`src/admin/session.ts` · `context.ts` `recordOwnerAction`)
GRANT SELECT, INSERT ON owner_login_requests TO atmark_admin;
-- 링크: INSERT 는 요청 행의 다섯 칸만(outbox 상태를 미리 'sent' 로 적는 길 없음 · client_key 는 202609230710) · UPDATE 는
--   사용 시각 하나.
GRANT SELECT ON owner_login_links TO atmark_admin;
GRANT INSERT (organization_id, browser_binding, client_key, expires_at, next_attempt_at) ON owner_login_links TO atmark_admin;
GRANT UPDATE (used_at) ON owner_login_links TO atmark_admin;
GRANT SELECT ON owner_sessions TO atmark_admin;
GRANT INSERT (organization_id, login_link_id, token_hash, expires_at) ON owner_sessions TO atmark_admin;
GRANT UPDATE (revoked_at) ON owner_sessions TO atmark_admin;
-- 감사는 쓰기만(읽기는 소유자 셸 — docs/runbooks/admin.md §8-5).
GRANT INSERT ON owner_actions TO atmark_admin;

-- 조직 — 로그인 대조 · /api/me · 소유자 조직 정지(`owner_paused`, 202609230710). 조직 **생성**은 CLI(소유자 롤)뿐이라
--   INSERT 없음. ★ `abuse_freeze`(플랫폼 동결)는 UPDATE 권한이 없다 — 콘솔이 운영자 동결을 푸는 길을 DB 가 한 번 더 막는다
--   (운영자 CLI `admin:kill-switch --org` 는 소유자 롤이다).
GRANT SELECT ON organizations TO atmark_admin;
GRANT UPDATE (owner_paused) ON organizations TO atmark_admin;

-- 프로비저닝(`api/provisioning-store.ts`) · 토큰(`db/repositories/agent-token-store.ts`) · 정지(`ops/agents.ts`)
GRANT SELECT, INSERT ON agents TO atmark_admin;
GRANT UPDATE (status, suspended_by) ON agents TO atmark_admin;
GRANT SELECT, INSERT ON agent_keypairs, passports, agent_addresses TO atmark_admin;
GRANT SELECT, INSERT ON agent_api_keys TO atmark_admin;
GRANT UPDATE (revoked_at) ON agent_api_keys TO atmark_admin;

-- 정책·seed(`ops/policy.ts` · `ops/seeds.ts`) — 새 버전 행 + 현재 정책 갱신.
GRANT SELECT, INSERT ON agent_policies, policy_versions, sender_relationships TO atmark_admin;
GRANT UPDATE (outbound_mode, limits, config_json, current_version) ON agent_policies TO atmark_admin;

-- 발신자 수동 분류(`ops/sender-marks.ts`) — 앱 롤에는 INSERT 가 없는 테이블이다(202609230020).
GRANT SELECT, INSERT ON sender_marks TO atmark_admin;

-- 승인 대기 조회(`routes/approvals.ts`) — 읽기만. 결정 경로가 없다.
GRANT SELECT ON approval_requests, approval_request_items, messages TO atmark_admin;

-- AC-0 게이트(`gate/ac0-store.ts`) — 기록은 INSERT, 판정 입력은 읽기.
GRANT SELECT, INSERT ON ac0_gates, ac0_gate_events, human_mailbox_interventions TO atmark_admin;
GRANT SELECT ON inbound_messages, outbound_recipients, ses_events TO atmark_admin;

-- ---------------------------------------------------------------------------
-- ② atmark_login_mailer — `workers/owner-login-notifier.ts` · `notify/owner-login-notifier.ts` 의 문장만
-- ---------------------------------------------------------------------------

GRANT USAGE ON SCHEMA public TO atmark_login_mailer;

-- `browser_binding`·`used_at` 은 읽지 못한다. INSERT 없음(로그인 메일을 스스로 촉발할 수 없다).
GRANT SELECT (id, organization_id, created_at, expires_at, status, attempt_count, next_attempt_at, claimed_at)
  ON owner_login_links TO atmark_login_mailer;
GRANT UPDATE (status, attempt_count, next_attempt_at, claimed_at, last_error, ses_message_id, sent_at, settled_at)
  ON owner_login_links TO atmark_login_mailer;
-- 수신자는 여기서만 나온다(링크 → 조직).
GRANT SELECT (id, owner_email) ON organizations TO atmark_login_mailer;
