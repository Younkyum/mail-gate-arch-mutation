-- 202609280102_login_code_attempts.sql
-- 로그인·가입 코드 보안 검토(2026-09-28 L2·L3) — **코드 verify 시도 원장**과 그 보존.
--
--   ① `login_code_attempts(client_key, created_at)` — 코드 verify(로그인·가입) 한 번마다 한 행. `client_key` = HMAC(로그인 키, 'ip:' ‖ 소스 IP)
--      (로그인 요청 원장 `owner_login_requests` 와 같은 키 — IP 는 API Gateway 가 준 `requestContext.http.sourceIp` 만 믿는다, 헤더 아님).
--      IP 평문은 없다. admin 이 요청자 advisory 잠금 아래 지난 15분 행을 세고(30 이상이면 429 `rate_limited` — 주소와 무관) 한 행을 적는다.
--      그래서 코드 verify 트랜잭션은 (상한 밖이면) 언제나 쓴다 — 후보가 있든 없든 같은 쓰기다.
--   ② 보존 — 하루 넘은 행은 SECURITY DEFINER `purge_login_code_attempts()` 가 지운다(인자 없음 · 한 번에 10 000). 부르는 쪽은 TTL
--      스위퍼(앱 롤, `workers/approval-expiry.ts`) — 앱 롤은 이 함수 EXECUTE 하나이고 표 권한은 0 이다(`APP_FORBIDDEN_LOGIN_TABLES`).
--      admin 롤에는 DELETE 가 없다(ADR-0006 — admin DELETE 0 그대로).
--   ③ 권한 — admin: SELECT(계수) · INSERT(client_key 한 칸 — 시각은 DB 가 적는다). login-mailer·앱 롤: 표 권한 0.
--
-- 새 표라 색인은 트랜잭션 안에서 만든다(비어 있다). 기존 표를 잠그지 않는다.

SET LOCAL lock_timeout = '5s';

CREATE TABLE login_code_attempts (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_key  text NOT NULL CHECK (client_key ~ '^[0-9a-f]{64}$'),
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX login_code_attempts_client_idx ON login_code_attempts (client_key, created_at);
CREATE INDEX login_code_attempts_created_idx ON login_code_attempts (created_at);

CREATE TRIGGER login_code_attempts_no_update
  BEFORE UPDATE ON login_code_attempts
  FOR EACH ROW EXECUTE FUNCTION reject_row_update();
CREATE TRIGGER login_code_attempts_no_truncate
  AFTER TRUNCATE ON login_code_attempts
  FOR EACH STATEMENT EXECUTE FUNCTION reject_truncate();

COMMENT ON TABLE login_code_attempts IS
  '로그인·가입 코드 verify 시도 원장 — 요청자 키(HMAC(로그인 키, ip:소스 IP))와 시각뿐. 요청자당 15분 30회 상한의 분자. admin 은 SELECT·INSERT(client_key), 하루 넘은 행은 purge_login_code_attempts() 만 지운다. 앱 롤 권한 0.';

CREATE FUNCTION purge_login_code_attempts() RETURNS integer
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  WITH gone AS (
    DELETE FROM public.login_code_attempts a
     WHERE a.id IN (
             SELECT o.id FROM public.login_code_attempts o
              WHERE o.created_at < now() - interval '1 day'
              ORDER BY o.created_at
              LIMIT 10000)
    RETURNING 1
  )
  SELECT count(*)::int FROM gone
$$;

COMMENT ON FUNCTION purge_login_code_attempts() IS
  '코드 verify 시도 원장 보존 — 하루 넘은 행만, 한 번에 10 000, 지운 수. 인자 없음. 앱 롤(TTL 스위퍼)만 EXECUTE.';

REVOKE ALL ON FUNCTION purge_login_code_attempts() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION purge_login_code_attempts() TO atmark_app;

REVOKE ALL ON login_code_attempts FROM PUBLIC;
GRANT SELECT ON login_code_attempts TO atmark_admin;
GRANT INSERT (client_key) ON login_code_attempts TO atmark_admin;
