-- 202609270140_agent_api_key_events_rotation.sql
-- 콘솔 토큰 **한 개 교체**(진윤겸 2026-09-27 — "발급된 토큰에 대해서 rotate 기능도 있어야 할 거 같아") — 감사 상세에 새 토큰 칸.
--
--   ① `agent_api_key_events.new_key_id` — 교체(`agent.token.rotate_one`) 감사 행의 상세: `key_id` = 폐기한 옛 토큰, `new_key_id` = 같은
--      트랜잭션에서 발급한 새 토큰(같은 이름·권한·수명). 한 개 폐기·이름 바꾸기 행은 NULL. 표는 그대로 append-only(UPDATE·DELETE·TRUNCATE
--      트리거)이고 admin 롤은 INSERT 만이다 — 표 단위 GRANT 가 새 칸도 덮는다(허용 목록 `RESTRICTED_ROLE_GRANTS` 변화 없음).
--   ② FK — 새 토큰 행이 있어야 한다(`key_id` 와 같이 ON DELETE RESTRICT). CHECK — 새 토큰은 옛 토큰과 다르고, 교체 상세는 이름 전·후를
--      싣지 않는다(이름은 그대로 옮긴다). 둘 다 `NOT VALID` — 기존 행은 새 칸이 NULL 이라 걸릴 것이 없지만 규칙대로 검증은 202609270141.
--
-- 잠금: `agent_api_keys` 에 짧은 SHARE ROW EXCLUSIVE(먼저 — 앱과 같은 순서, 인증 경로의 `last_used_at` UPDATE 를 잠깐 세운다 · `NOT VALID`
--   라 훑지 않는다) → `agent_api_key_events`(작다 · admin 만 쓴다) ACCESS EXCLUSIVE. 5초 안에 못 잡으면 실패하고 아무것도 바뀌지 않는다.
-- 롤백 호환: 옛 코드는 이 칸을 적지 않는다(NULL) — 한 개 폐기·이름 바꾸기 상세는 그대로 들어간다.

SET LOCAL lock_timeout = '5s';

-- 잠금 순서 = 앱 순서(`agent_api_keys` → `agent_api_key_events` — 교체·폐기 트랜잭션은 토큰 행을 먼저 잡고 상세를 뒤에 적는다). FK 가 어차피
-- 잡을 SHARE ROW EXCLUSIVE 를 맨 앞에서 먼저 잡아, 상세 표를 쥔 채 토큰 표를 기다리다 앱 트랜잭션과 교착하지 않게 한다.
LOCK TABLE agent_api_keys IN SHARE ROW EXCLUSIVE MODE;

ALTER TABLE agent_api_key_events ADD COLUMN new_key_id uuid;

ALTER TABLE agent_api_key_events
  ADD CONSTRAINT agent_api_key_events_new_key_fkey FOREIGN KEY (new_key_id) REFERENCES agent_api_keys (id) ON DELETE RESTRICT NOT VALID;

ALTER TABLE agent_api_key_events
  ADD CONSTRAINT agent_api_key_events_new_key_check CHECK (
    new_key_id IS NULL OR (new_key_id <> key_id AND old_label IS NULL AND new_label IS NULL)) NOT VALID;

COMMENT ON COLUMN agent_api_key_events.new_key_id IS
  '토큰 한 개 교체(agent.token.rotate_one)로 발급한 새 토큰 — key_id 는 폐기한 옛 토큰. 다른 행위는 NULL.';
COMMENT ON TABLE agent_api_key_events IS
  '토큰 한 개 폐기·이름 바꾸기·한 개 교체 감사(owner_actions 행)의 부속 상세 — 토큰 id · 이름 전·후 · 교체의 새 토큰 id. append-only. 해시·평문 없음. 앱 롤 권한 0.';
