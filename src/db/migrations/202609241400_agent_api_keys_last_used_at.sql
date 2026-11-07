-- 202609241400_agent_api_keys_last_used_at.sql
-- US-007 — 토큰 마지막 사용 시각. `agent_api_keys.last_used_at` 컬럼과 `AgentApiKeyRepository.touch()` 는
-- 202609221450(P1b)부터 있었지만 **아무도 쓰지 않았다** — 202609230750(앱 롤 최소권한)이 `agent_api_keys` 의
-- UPDATE 를 앱 롤에서 전부 거뒀고(SELECT 만 남았다), `touch()` 를 부르는 코드도 없었다. 이 파일이 하는 일 둘:
--
--   ① 앱 롤에 `last_used_at` **한 칸만** UPDATE 를 준다(`src/identity/agent-token.ts` `authenticateAgentToken` 이
--      인증 성공마다 부른다 — REST·MCP 모두 같은 함수를 지난다). 다른 칸(`revoked_at` 포함)은 여전히 0이다 —
--      컬럼 단위 GRANT 가 "그 칸만" 을 SQL 층에서 강제한다(REVOKE 없이 GRANT 만으로 충분 — 202609230750 이 이미
--      테이블 단위 UPDATE 를 거뒀으므로 컬럼 단위로 다시 여는 것만 남았다).
--   ② **방향 가드.** 컬럼 단위 권한은 "무엇을" 바꿀 수 있는지는 막지만 "어느 방향으로" 는 막지 못한다 —
--      `last_used_at` 을 과거로 되돌리는 UPDATE 도 문법적으로는 그 칸만 건드린다. `touch()` 의 SQL 이 이미
--      `WHERE last_used_at IS NULL OR last_used_at < 분 절삭(now)` 로 뒤로 가지 않지만, 그건 **이 호출 하나**의
--      약속이다. `agent_api_keys_revoked_once`(202609230750)와 같은 이유로 트리거를 **모든 롤에** 세운다 —
--      "마지막 사용 시각이 언제였는가" 가 사후에 앞당겨지면 그 자체로 감사 질문의 답이 지워진다.
--
-- 분 단위 코얼레싱(`date_trunc('minute', …)`)은 SQL 이 아니라 **호출부**(`agent-token-store.ts` `touch()`)가 한다 —
-- 주입된 시계(`now: Date`)를 쓰는 이 코드베이스의 관례를 따른다(SQL `now()` 는 테스트가 시계를 고정할 수 없다).
-- 그래서 이 파일에는 SQL 함수가 없다 — 가드 트리거 하나와 GRANT 한 줄뿐이다.
--
-- 마이그레이션은 append-only 다. 기존 파일은 한 글자도 건드리지 않았다.

-- ---------------------------------------------------------------------------
-- ① 앱 롤 — `last_used_at` 한 칸만
-- ---------------------------------------------------------------------------
GRANT UPDATE (last_used_at) ON agent_api_keys TO atmark_app;

-- ---------------------------------------------------------------------------
-- ② 방향 가드 — 뒤로 가지 않는다 (모든 롤)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION agent_api_keys_last_used_at_forward_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.last_used_at IS NOT NULL AND NEW.last_used_at IS NOT NULL AND NEW.last_used_at < OLD.last_used_at THEN
    RAISE EXCEPTION 'agent_api_keys.last_used_at cannot move backward (was %, got %)', OLD.last_used_at, NEW.last_used_at
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER agent_api_keys_last_used_at_forward_only
  BEFORE UPDATE ON agent_api_keys
  FOR EACH ROW EXECUTE FUNCTION agent_api_keys_last_used_at_forward_only();
