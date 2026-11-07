-- 202609250170_owner_action_actor_emails.sql
-- 콘솔 로그의 "누가"(확장성 P1 — 다중 멤버) 를 **세션 id 를 admin 에게 열지 않고** 답한다. 202609250160 의 GRANT 한 칸을 되돌린다.
--
--   ① `atmark_admin` 의 `owner_actions.session_id` SELECT 를 거둔다(0160 이 줬다). 감사 행의 세션 id 는 admin 표면이 읽지 않는 값으로
--      남는다(최소 권한 — `restricted-roles` ⑤ · `admin-logs` 단언). 행위자 **종류**는 `org_api_key_id` 칸(0160, 계속 SELECT)만으로 가른다:
--      값이 있으면 조직 키, 없으면 세션.
--   ② `owner_action_actor_emails(org, ids)` — SECURITY DEFINER. 그 조직의 감사 행 중 **세션 행위**의 사용자 주소만 `(id, email)` 로 돌려준다.
--      세션 id·사용자 id 는 돌려주지 않는다. 한 번에 200 id 까지(로그 한 쪽은 100). admin 은 이미 `users`·`owner_sessions` 를 읽는다 —
--      새로 여는 값은 없고, 감사 행 → 세션 조인을 함수 안에 가둔다.
--
-- 허용 목록(`RESTRICTED_ROLE_GRANTS` — `owner_actions.session_id:SELECT` 삭제 · `function:owner_action_actor_emails:EXECUTE` 추가)을 같은
-- 변경에서 고쳤다. 마이그레이션은 append-only — 0160 은 건드리지 않았다.

-- 잠금 대기 상한(적대적 검토 M5): 뜨거운 표 owner_actions(권한 회수)에 잠금을 건다 — 오래 기다리면 로그인·세션·감사 경로가 줄줄이 선다.
--   5초 안에 못 잡으면 이 파일만 실패(러너는 파일 하나당 BEGIN/COMMIT)하고 다시 돌리면 된다.
SET LOCAL lock_timeout = '5s';

REVOKE SELECT (session_id) ON owner_actions FROM atmark_admin;

CREATE FUNCTION owner_action_actor_emails(p_organization_id uuid, p_ids uuid[])
RETURNS TABLE (id uuid, email text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT o.id, u.email
    FROM owner_actions o
    JOIN owner_sessions s ON s.id = o.session_id AND s.organization_id = o.organization_id
    JOIN users u ON u.id = s.user_id
   WHERE o.organization_id = p_organization_id
     AND o.id = ANY (p_ids)
     AND cardinality(p_ids) <= 200
$$;

COMMENT ON FUNCTION owner_action_actor_emails(uuid, uuid[]) IS
  '콘솔 로그 행위자 표시 — 조직의 세션 감사 행 → 사용자 주소만. 세션 id 를 admin 에게 열지 않는다. 한 번에 200 id.';

REVOKE ALL ON FUNCTION owner_action_actor_emails(uuid, uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION owner_action_actor_emails(uuid, uuid[]) TO atmark_admin;
