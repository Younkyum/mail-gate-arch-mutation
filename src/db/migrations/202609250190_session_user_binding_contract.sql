-- 202609250190_session_user_binding_contract.sql (계획 번호 0140 — 운영에서 0100–0180 코드 확인 뒤 적용, 2026-09-25)
-- 세션·로그인 링크의 사용자 결속 **contract** (확장성 P0 R-1, 계획 §2.4). **코드 배포(0100–0120 을 쓰는 admin·login-mailer)를 운영에서
--   확인한 뒤에만** src/db/migrations/ 로 옮겨 적용한다 — 같은 릴리스에 넣으면 migrate Lambda 가 코드 배포 전에 적용해 옛 코드의
--   로그인·가입이 멈춘다(S1).
--
--   ① 옛 코드 호환 자동 채움(0110 ④)을 걷는다 — 세션·로그인 링크 INSERT 는 `user_id` 를 반드시 적는다(새 행만 검사: NOT VALID —
--      0110 이전의 옛 행은 이미 조인에서 떨어져 무효다).
--   ② 로그인 메일 롤의 `organizations(id, owner_email)` 읽기를 거둔다 — 0110 부터 수신자는 `users.email`(링크 → 사용자)이고, 로그인
--      메일 코드(`notify/owner-login-notifier.ts`)는 조직 표를 읽지 않는다(arch: owner_email 절 `loginNotifierReads = 0`). ADR-0006 최소 권한.
--
-- 같은 커밋에서: `role-bootstrap.ts` LOGIN_MAILER 목록에서 'organizations.id:SELECT'·'organizations.owner_email:SELECT' 를 빼고,
--   `migrate.ts` REQUIRED_GUARDS 에 'constraint:owner_sessions.owner_sessions_user_required' ·
--   'constraint:owner_login_links.owner_login_links_user_required' 를 더한다. gate-chokepoint arch 의 ROLE_BOOTSTRAP 예외
--   (`'organizations.owner_email:SELECT'`)도 그때 지운다.
--
-- 롤백: 이 파일 뒤 옛 코드로 되돌려야 하면 ①의 두 CHECK 를 먼저 DROP 하고 채움 트리거를 0110 의 정의로 다시 세운다
--   (docs/runbooks/admin.md §P0 배포).

-- 잠금 대기 상한(적대적 검토 M5): 뜨거운 표 owner_sessions·owner_login_links(트리거 DROP · CHECK) · organizations(권한 회수)에 잠금을 건다 — 오래 기다리면 로그인·세션·감사 경로가 줄줄이 선다.
--   5초 안에 못 잡으면 이 파일만 실패(러너는 파일 하나당 BEGIN/COMMIT)하고 다시 돌리면 된다.
SET LOCAL lock_timeout = '5s';

DROP TRIGGER owner_sessions_fill_user ON owner_sessions;
DROP TRIGGER owner_login_links_fill_user ON owner_login_links;
DROP FUNCTION owner_sessions_fill_user();
DROP FUNCTION owner_login_links_fill_user();

ALTER TABLE owner_sessions ADD CONSTRAINT owner_sessions_user_required CHECK (user_id IS NOT NULL) NOT VALID;
ALTER TABLE owner_login_links ADD CONSTRAINT owner_login_links_user_required CHECK (user_id IS NOT NULL) NOT VALID;

REVOKE SELECT (id, owner_email) ON organizations FROM atmark_login_mailer;
