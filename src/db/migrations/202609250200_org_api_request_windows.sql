-- 202609250200_org_api_request_windows.sql
-- ADR-0010 후속 L5 — `/org-api` 스로틀이 전 조직 공유였다(API Gateway `ANY /org-api/{proxy+}` 버킷 하나). 키 하나가 그 몫을 다 쓰면
--   다른 모든 조직의 CI 가 429 를 받았다. 인증이 Lambda 안이라 API Gateway 사용량 계획으로는 나눌 수 없다 → **DB 창 계수**.
--
-- 세우는 것:
--   ① `org_api_request_windows(org_api_key_id, organization_id, window_start, n)` — 키 × 분 창 하나에 행 하나(append 아님 — upsert).
--      인증 성공 직후 한 문장(`src/admin/org-api/rate-limit.ts`): `INSERT … ON CONFLICT DO UPDATE SET n = n + 1 WHERE n < 키 상한` +
--      같은 문장에서 같은 창의 조직 합(`sum(n)`). 키당 분당 60 · 조직당 분당 120 → 429 `rate_limited` + `Retry-After`.
--      조직은 키의 조직과 같아야 한다(복합 FK → `org_api_keys (id, organization_id)`).
--   ② 가드(`org_api_request_windows_guard`, 소유자 롤 밖 모든 롤): INSERT 는 **지금 창**(`date_trunc('minute', now())`)에 n = 1 로만,
--      UPDATE 는 지금 창의 n 을 **정확히 1** 올리는 것만. admin 롤이 탈취돼도 계수를 되감거나(0 으로) 미래 창을 미리 채워 남의 조직을
--      막지 못한다. 소유자 롤(운영자 셸·테스트 심기·보존 함수)은 서지 않는다(`organizations_review_guard` 와 같은 판별).
--   ③ 보존 — 7일 넘은 창 행을 지우는 SECURITY DEFINER `purge_org_api_request_windows()`(인자 없음 · 한 번에 10 000 행 · 지운 행 수).
--      DELETE 권한은 **아무 롤에도** 주지 않는다. 부르는 쪽은 TTL 스위퍼(approval-expiry Lambda · 앱 롤 — 스니펫 보존 202609241700 과
--      같은 5분 스케줄)이고, 앱 롤은 이 함수 EXECUTE 하나만 받는다(표 권한 0 — `APP_FORBIDDEN_LOGIN_TABLES`).
--   ④ 권한: `atmark_admin` SELECT(같은 문장의 조직 합·RETURNING) · INSERT(네 칸) · UPDATE(n). 앱·로그인 메일·서명·tlog 롤 표 권한 0.
--
-- 허용 목록 `src/runtime/role-bootstrap.ts` `RESTRICTED_ROLE_GRANTS` · 가드 목록 `src/runtime/handlers/migrate.ts` `REQUIRED_GUARDS` ·
-- `APP_FORBIDDEN_LOGIN_TABLES` 를 같은 변경에서 늘렸다. 마이그레이션은 append-only — 기존 파일은 건드리지 않았다.

-- 잠금 대기 상한(적대적 검토 M5): 복합 FK 가 org_api_keys(매 /org-api 요청이 읽고 last_used_at 을 쓴다)에 SHARE ROW EXCLUSIVE 를
--   잡는다. 5초 안에 못 잡으면 이 파일만 실패(러너는 파일 하나당 BEGIN/COMMIT)하고 다시 돌리면 된다.
SET LOCAL lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- ① 테이블
-- ---------------------------------------------------------------------------

CREATE TABLE org_api_request_windows (
  org_api_key_id   uuid NOT NULL,
  organization_id  uuid NOT NULL,
  window_start     timestamptz NOT NULL CONSTRAINT org_api_request_windows_minute_check CHECK (window_start = date_trunc('minute', window_start)),
  n                integer NOT NULL CONSTRAINT org_api_request_windows_n_check CHECK (n >= 1),
  PRIMARY KEY (org_api_key_id, window_start),
  CONSTRAINT org_api_request_windows_key_fk FOREIGN KEY (org_api_key_id, organization_id)
    REFERENCES org_api_keys (id, organization_id) ON DELETE RESTRICT
);

-- 같은 창의 조직 합(매 요청) · 보존 스윕(window_start < now() - 7d).
CREATE INDEX org_api_request_windows_org_idx ON org_api_request_windows (organization_id, window_start);
CREATE INDEX org_api_request_windows_window_idx ON org_api_request_windows (window_start);

-- ---------------------------------------------------------------------------
-- ② 가드 — 지금 창 · 1 씩만 (소유자 롤 밖)
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION org_api_request_windows_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF pg_has_role(current_user, (SELECT c.relowner FROM pg_catalog.pg_class c WHERE c.oid = TG_RELID), 'USAGE') THEN
    RETURN NEW;
  END IF;
  IF NEW.window_start <> date_trunc('minute', now()) THEN
    RAISE EXCEPTION 'org_api_request_windows: only the current minute window can be counted' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.n <> 1 THEN
      RAISE EXCEPTION 'org_api_request_windows: a new window starts at n = 1' USING ERRCODE = '23514';
    END IF;
  ELSIF NEW.n <> OLD.n + 1 OR NEW.org_api_key_id <> OLD.org_api_key_id OR NEW.organization_id <> OLD.organization_id
        OR NEW.window_start <> OLD.window_start THEN
    RAISE EXCEPTION 'org_api_request_windows: a window only counts up by one' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER org_api_request_windows_guard
  BEFORE INSERT OR UPDATE ON org_api_request_windows
  FOR EACH ROW EXECUTE FUNCTION org_api_request_windows_guard();

COMMENT ON TABLE org_api_request_windows IS
  '/org-api 키 × 분 창 요청 수(ADR-0010 L5) — 키당 60 · 조직당 120/분. upsert 로 1 씩만. 7일 뒤 purge_org_api_request_windows() 가 지운다. 앱 롤 표 권한 0.';

-- ---------------------------------------------------------------------------
-- ③ 보존 — 7일 넘은 창만 지우는 함수(인자 없음)
-- ---------------------------------------------------------------------------

CREATE FUNCTION purge_org_api_request_windows() RETURNS integer
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  WITH gone AS (
    DELETE FROM org_api_request_windows w
     WHERE (w.org_api_key_id, w.window_start) IN (
             SELECT o.org_api_key_id, o.window_start FROM org_api_request_windows o
              WHERE o.window_start < now() - interval '7 days'
              ORDER BY o.window_start
              LIMIT 10000)
    RETURNING 1
  )
  SELECT count(*)::int FROM gone
$$;

COMMENT ON FUNCTION purge_org_api_request_windows() IS
  '/org-api 창 행 보존 — 7일 넘은 행만, 한 번에 10 000 행, 지운 수. 인자 없음(무엇을 지울지 호출자가 고르지 못한다). 앱 롤(TTL 스위퍼)만 EXECUTE.';

REVOKE ALL ON FUNCTION purge_org_api_request_windows() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION purge_org_api_request_windows() TO atmark_app;

-- ---------------------------------------------------------------------------
-- ④ 권한
-- ---------------------------------------------------------------------------

REVOKE ALL ON org_api_request_windows FROM PUBLIC;
GRANT SELECT ON org_api_request_windows TO atmark_admin;
GRANT INSERT (org_api_key_id, organization_id, window_start, n) ON org_api_request_windows TO atmark_admin;
GRANT UPDATE (n) ON org_api_request_windows TO atmark_admin;
