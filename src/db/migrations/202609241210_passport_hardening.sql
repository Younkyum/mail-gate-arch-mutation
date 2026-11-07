-- 202609241210_passport_hardening.sql
-- 신원(PP-B/PP-C) 검증 반영 (2026-09-24, IDENTITY 검증 결과 #3 #4 #10 #11 — ADR-0003 "2026-09-24 검증 반영").
--
--   ① `no_policy_violations` 의 **90일 창** — 서명 롤에 `audit_logs.created_at` SELECT 한 칸(`src/passport/attestations.ts`).
--   ② **조직 검토 전제** — 서명 롤은 조직 행을 읽지 못한다(202609241200 ④ — 조직 이름·소유자 메일). 게시 판정에 필요한 것은
--      "이 에이전트의 조직이 `review_status = 'active'` 인가" 불리언 하나라, 그것만 주는 SECURITY DEFINER 함수를 둔다
--      (`signup_email_suppressed` 와 같은 모양 — 칸 대신 판정 하나). 조직 id·이름·메일은 여전히 못 읽는다.
--   ③ **대기 칸 둘** — 에이전트당 대기(pending) 요청 1개였던 것을 **일반(publish·resign) 1 + 우선(suspend·revoke) 1** 로 나눈다.
--      정지는 비상 경로다: 백오프 중인 게시(최대 60분 간격 × 12회) 뒤에 줄 서면 "정지를 눌렀는데 한 시간 동안 published" 가 된다.
--      서명 워커가 우선 요청을 먼저 잡고, 그 뒤 대기 중 일반 요청을 대체한다(`src/passport/publisher.ts` "우선 요청").
--      업로드만 남은 `signed` 는 더 이상 칸을 차지하지 않는다 — 버전은 이미 커밋됐고 업로드는 요청과 무관하게 현재 버전을 올린다.
--   ④ **요청자 가드** — admin 롤은 INSERT 세 칸(agent_id·kind·requested_by)을 갖는데, 그 값이 무엇이든 받았다: 콘솔 세션이
--      `kind = 'revoke'`(종단 — 관리 API 에 없는 행위)를 넣거나 `requested_by = 'operator:…'` 로 운영자를 사칭할 수 있었다.
--      롤별로 넣을 수 있는 (종류, 요청자) 모양을 트리거가 본다:
--        atmark_admin           → publish · suspend, `admin:session:<uuid>` 만
--        atmark_passport_signer → resign, `system:…` 만(일일 재서명 스캔)
--      소유자 롤(운영자 런북 — revoke)은 제한하지 않는다. 앱 롤은 애초에 INSERT 권한이 없다.
--
-- 허용 목록은 코드에도 있다 — `src/runtime/role-bootstrap.ts` `RESTRICTED_ROLE_GRANTS`(①②) · `src/runtime/handlers/migrate.ts`
-- `REQUIRED_GUARDS`(④ 트리거 · ③ 색인은 CHECK 가 아니라 목록 밖).

-- ---------------------------------------------------------------------------
-- ① 90일 창
-- ---------------------------------------------------------------------------

GRANT SELECT (created_at) ON audit_logs TO atmark_passport_signer;

-- ---------------------------------------------------------------------------
-- ② 조직 검토 판정 — 불리언 하나
-- ---------------------------------------------------------------------------

-- 에이전트가 없으면 NULL(워커는 NULL 을 "활성 아님" 으로 읽는다). STABLE — 한 문장 안에서 같은 답.
CREATE OR REPLACE FUNCTION passport_agent_organization_active(p_agent_id text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT o.review_status = 'active'
    FROM public.agents a JOIN public.organizations o ON o.id = a.organization_id
   WHERE a.id = p_agent_id
$$;

REVOKE ALL ON FUNCTION passport_agent_organization_active(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION passport_agent_organization_active(text) TO atmark_passport_signer;

COMMENT ON FUNCTION passport_agent_organization_active(text) IS
  '서명 롤(atmark_passport_signer)의 게시 전제 판정 — 에이전트 조직의 review_status = active 인가. 조직 행 대신 불리언 하나만 준다(202609241210 ②).';

-- ---------------------------------------------------------------------------
-- ③ 대기 칸 둘
-- ---------------------------------------------------------------------------

-- 기존 행은 이 두 색인을 어길 수 없다: 옛 색인이 (pending ∪ signed) 에이전트당 1개를 강제했으므로 pending 은 에이전트당 1개 이하다.
DROP INDEX passport_publish_requests_one_inflight;

CREATE UNIQUE INDEX passport_publish_requests_one_pending
  ON passport_publish_requests (agent_id) WHERE status = 'pending' AND kind IN ('publish', 'resign');

CREATE UNIQUE INDEX passport_publish_requests_one_pending_priority
  ON passport_publish_requests (agent_id) WHERE status = 'pending' AND kind IN ('suspend', 'revoke');

-- ---------------------------------------------------------------------------
-- ④ 요청자 가드
-- ---------------------------------------------------------------------------

-- SECURITY DEFINER 가 **아니다** — current_user 가 INSERT 를 실행한 롤이어야 판정이 된다.
CREATE OR REPLACE FUNCTION passport_publish_requests_requester_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF current_user = 'atmark_admin' THEN
    IF NEW.kind NOT IN ('publish', 'suspend') OR NEW.requested_by !~ '^admin:session:' THEN
      RAISE EXCEPTION 'atmark_admin may only request publish/suspend as admin:session:<id> (got %, %)', NEW.kind, NEW.requested_by
        USING ERRCODE = '42501';
    END IF;
  ELSIF current_user = 'atmark_passport_signer' THEN
    IF NEW.kind <> 'resign' OR NEW.requested_by !~ '^system:' THEN
      RAISE EXCEPTION 'atmark_passport_signer may only enqueue resign as system:<name> (got %, %)', NEW.kind, NEW.requested_by
        USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER passport_publish_requests_requester
  BEFORE INSERT ON passport_publish_requests
  FOR EACH ROW EXECUTE FUNCTION passport_publish_requests_requester_guard();
