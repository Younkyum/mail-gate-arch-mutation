-- 202609250010_agent_api_keys_label_hint.sql
-- 콘솔 v4 토큰 목록(D7 · 명세 console-v4-design.md §(e) E1) — 에이전트당 **이름 있는 여러 토큰**(활성 상한 5) · 끝 4자 표시 · 개별 폐기.
--
--   ① 칸 둘: `label`(소유자가 붙이는 이름, 1–60자) · `hint`(평문의 **끝 4자** — base64url 비밀부 43자 중 24비트. 목록에서 "어느 토큰인가"
--      를 가리는 용도이고 남은 232비트는 그대로다). 옛 행은 둘 다 NULL — 이름은 "이름 없음", 끝 4자는 **복구할 수 없다**(평문을 저장한 적이
--      없다). 백필은 하지 않는다.
--   ② 불변 핵심 트리거를 다시 세운다: 바꿀 수 있는 칸 = `revoked_at` · `last_used_at` · **`label`**. `hint` 는 목록에 없으므로 INSERT 때
--      정해진 뒤 누구도 못 바꾼다(`reject_column_update_except` 는 "바꿔도 되는 칸" 만 받는다 — 새 칸의 기본이 불변). 트리거 이름은 같다.
--   ③ 활성 상한 5 — **모든 롤·모든 INSERT 경로**(콘솔 새 토큰 · CLI `admin:agent-token` · 회전 · 프로비저닝)에 DB 가 한 번 더 막는다.
--      에이전트 단위 advisory 잠금 아래에서 센다 — 코드(`src/admin/ops/tokens.ts`)도 같은 잠금 키로 먼저 세고 409 `token_limit` 을 낸다
--      (xact advisory 잠금은 같은 세션에서 다시 잡아도 된다). 회전은 전부 폐기 뒤 1개라 걸리지 않는다. UPDATE 로는 활성 수가 늘 수 없다
--      (`revoked_at` 은 한 번만 · `expires_at` 은 불변).
--   ④ `atmark_admin` 에 `label` 한 칸 UPDATE(이름 바꾸기). 앱 롤(`atmark_app`)에는 아무것도 더하지 않는다.
--   ⑤ `agent_api_key_events` — 토큰 한 개 폐기·이름 바꾸기 감사의 **부속 상세**(append-only). 감사 행(`owner_actions`)은 모양상 식별자
--      하나(`target_id` = 에이전트 id — 로그 필터)뿐이라, 어느 토큰인지(`key_id`)와 이름 바꾸기의 전·후 이름은 여기 한 행으로 남는다
--      (주소를 도메인 표에 남기는 seed 추가와 같은 모양). 감사 행 하나에 상세 하나(PK = `owner_action_id`). admin 롤은 INSERT 만.
--
-- 잠금 대기 상한(M2): ②·③ 은 `agent_api_keys`(인증 경로가 매 요청 읽고 `last_used_at` 을 쓰는 표)에 ACCESS EXCLUSIVE 를 잡는다. 긴 트랜잭션
--   뒤에 줄 서면 그동안 모든 인증이 막힌다 — 첫 문장이 `SET LOCAL lock_timeout`(202609242200·2300 과 같다. 러너는 파일 하나당 BEGIN/COMMIT).
--
-- 허용 목록 `src/runtime/role-bootstrap.ts` `RESTRICTED_ROLE_GRANTS` · 가드 목록 `src/runtime/handlers/migrate.ts` `REQUIRED_GUARDS` 를
-- 같은 변경에서 늘렸다(migrate `status` 가 대조). 마이그레이션은 append-only — 기존 파일은 건드리지 않았다.

SET LOCAL lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- ① 칸
-- ---------------------------------------------------------------------------
-- 이름의 문자 집합은 가입 조직 이름 CHECK(202609240900 `signup_links_organization_name_check`)와 같다 — 제어 문자 · 보이지 않거나 폭 없는
--   글자 · 양방향 제어. 앱 검증(`src/admin/ops/tokens.ts` `isValidTokenLabel`)은 이것의 상위 집합이다.
ALTER TABLE agent_api_keys
  ADD COLUMN label text CONSTRAINT agent_api_keys_label_check CHECK (
    label IS NULL OR (
      length(label) BETWEEN 1 AND 60
      AND btrim(label) = label
      AND label !~ '[\u0001-\u001f\u007f-\u009f­؜ᅟᅠ᠎​-‏ -‮⁠-⁯⠀ㅤ︀-️﻿ﾠ\U000e0000-\U000e007f]'
    )
  ),
  ADD COLUMN hint text CONSTRAINT agent_api_keys_hint_check CHECK (hint IS NULL OR hint ~ '^[A-Za-z0-9_-]{4}$');

-- ---------------------------------------------------------------------------
-- ② 불변 핵심 — label 만 더 연다(hint 는 불변)
-- ---------------------------------------------------------------------------
DROP TRIGGER agent_api_keys_immutable_core ON agent_api_keys;
CREATE TRIGGER agent_api_keys_immutable_core
  BEFORE UPDATE ON agent_api_keys
  FOR EACH ROW EXECUTE FUNCTION reject_column_update_except('revoked_at', 'last_used_at', 'label');

-- ---------------------------------------------------------------------------
-- ③ 활성 상한 5 (모든 롤)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION agent_api_keys_active_limit() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  active integer;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('agent_api_keys_active:' || NEW.agent_id, 0));
  SELECT count(*) INTO active FROM public.agent_api_keys k
   WHERE k.agent_id = NEW.agent_id AND k.revoked_at IS NULL AND (k.expires_at IS NULL OR k.expires_at > now());
  IF active >= 5 THEN
    RAISE EXCEPTION 'agent_api_keys: agent % already has % active tokens (max 5)', NEW.agent_id, active
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER agent_api_keys_active_limit
  BEFORE INSERT ON agent_api_keys
  FOR EACH ROW EXECUTE FUNCTION agent_api_keys_active_limit();

-- ---------------------------------------------------------------------------
-- ④ admin — 이름 한 칸
-- ---------------------------------------------------------------------------
GRANT UPDATE (label) ON agent_api_keys TO atmark_admin;

-- ---------------------------------------------------------------------------
-- ⑤ 토큰 감사 상세 — 어느 토큰인가 · 이름 전·후 (append-only)
-- ---------------------------------------------------------------------------
-- 이름 칸은 `agent_api_keys.label` 과 같은 CHECK(전 이름은 그 칸에서 읽은 값, 새 이름은 그 칸에 들어간 값). 폐기 행은 이름이 없다.
CREATE TABLE agent_api_key_events (
  owner_action_id  uuid PRIMARY KEY REFERENCES owner_actions (id) ON DELETE RESTRICT,
  key_id           uuid NOT NULL REFERENCES agent_api_keys (id) ON DELETE RESTRICT,
  old_label        text CONSTRAINT agent_api_key_events_old_label_check CHECK (old_label IS NULL OR length(old_label) BETWEEN 1 AND 60),
  new_label        text CONSTRAINT agent_api_key_events_new_label_check CHECK (new_label IS NULL OR length(new_label) BETWEEN 1 AND 60)
);

CREATE INDEX agent_api_key_events_key_idx ON agent_api_key_events (key_id);

CREATE TRIGGER agent_api_key_events_no_update
  BEFORE UPDATE ON agent_api_key_events
  FOR EACH ROW EXECUTE FUNCTION reject_row_update();
CREATE TRIGGER agent_api_key_events_no_delete
  BEFORE DELETE ON agent_api_key_events
  FOR EACH ROW EXECUTE FUNCTION reject_row_delete();
CREATE TRIGGER agent_api_key_events_no_truncate
  AFTER TRUNCATE ON agent_api_key_events
  FOR EACH STATEMENT EXECUTE FUNCTION reject_truncate();

COMMENT ON TABLE agent_api_key_events IS
  '토큰 한 개 폐기·이름 바꾸기 감사(owner_actions 행)의 부속 상세 — 토큰 id · 이름 전·후. append-only. 해시·평문 없음. 앱 롤 권한 0.';

REVOKE ALL ON agent_api_key_events FROM PUBLIC;
GRANT INSERT ON agent_api_key_events TO atmark_admin;
