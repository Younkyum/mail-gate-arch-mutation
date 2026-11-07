-- 202609250150_org_api_keys.sql
-- 조직 API 키 (확장성 P1 R-6, 계획 §2.5 · 창업자 결정 F-4 — `console.atmark.ai/org-api/v1` · 권한 agents:read·agents:create ·
--   조직당 활성 5 · owner 만 관리 · 접두사 `atk_org_`).
--
-- 세우는 것:
--   ① `org_api_keys` — 해시(sha256)만 저장(평문 칸 없음) · 끝 4자 `hint` · 이름 `label`(에이전트 토큰 이름과 같은 문자 규칙) ·
--      권한 배열(비지 않은 {agents:read, agents:create} 부분집합) · 발급한 사용자 · 만료(선택) · 마지막 사용 · 폐기 ·
--      교체 계보(`rotated_from_id` — 한 키에서 한 번만 교체된다, UNIQUE). `UNIQUE (id, organization_id)` 는 감사 행위자 복합 FK 용(0160).
--   ② 가드(모든 롤):
--      - 불변 핵심 — 바꿀 수 있는 칸은 `label` · `last_used_at` · `revoked_at` 셋뿐(해시·권한·조직·만료를 UPDATE 로 넓히지 못한다).
--      - `revoked_at` 1회(되살리기·폐기 시각 덮기 불가) · `last_used_at` 앞으로만.
--      - 조직당 **활성 절대 천장 20**(앱 상한 5 는 코드 `MAX_ACTIVE_ORG_KEYS` — 같은 advisory 잠금 키로 먼저 센다).
--      - DELETE/TRUNCATE 거부(감사 행이 키 id 를 가리킨다).
--   ③ 권한: `atmark_admin` SELECT(인증은 `token_hash` 로 조회한다) · INSERT(발급 칸) · UPDATE(label, last_used_at, revoked_at).
--      앱·로그인 메일·서명·tlog 롤 **0**(`APP_FORBIDDEN_LOGIN_TABLES` 에 추가 — migrate `status` 가 대조).
--
-- 허용 목록 `src/runtime/role-bootstrap.ts` `RESTRICTED_ROLE_GRANTS` · 가드 목록 `src/runtime/handlers/migrate.ts` `REQUIRED_GUARDS` 를
-- 같은 변경에서 늘렸다. 마이그레이션은 append-only — 기존 파일은 건드리지 않았다. FK `created_by_user_id → users` 는 202609250100 뒤.

-- 잠금 대기 상한(적대적 검토 M5): 뜨거운 표 organizations(FK)에 잠금을 건다 — 오래 기다리면 로그인·세션·감사 경로가 줄줄이 선다.
--   5초 안에 못 잡으면 이 파일만 실패(러너는 파일 하나당 BEGIN/COMMIT)하고 다시 돌리면 된다.
SET LOCAL lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- ① 테이블
-- ---------------------------------------------------------------------------

CREATE TABLE org_api_keys (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id     uuid NOT NULL REFERENCES organizations (id) ON DELETE RESTRICT,
  -- 이름 — agent_api_keys_label_check(202609250010)와 같은 문자 집합. 앱 검증(`isValidTokenLabel`)은 상위 집합.
  label               text NOT NULL CONSTRAINT org_api_keys_label_check CHECK (
    length(label) BETWEEN 1 AND 60
    AND btrim(label) = label
    AND label !~ '[\u0001-\u001f\u007f-\u009f­؜ᅟᅠ᠎​-‏ -‮⁠-⁯⠀ㅤ︀-️﻿ﾠ\U000e0000-\U000e007f]'
  ),
  hint                text NOT NULL CONSTRAINT org_api_keys_hint_check CHECK (hint ~ '^[A-Za-z0-9_-]{4}$'),
  token_hash          text NOT NULL UNIQUE CONSTRAINT org_api_keys_token_hash_check CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  capabilities        text[] NOT NULL CONSTRAINT org_api_keys_capabilities_check CHECK (
    cardinality(capabilities) BETWEEN 1 AND 2
    AND array_position(capabilities, NULL) IS NULL
    AND capabilities <@ ARRAY['agents:read', 'agents:create']::text[]
  ),
  created_by_user_id  uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  created_at          timestamptz NOT NULL DEFAULT now(),
  expires_at          timestamptz CONSTRAINT org_api_keys_expiry_check CHECK (expires_at IS NULL OR expires_at > created_at),
  last_used_at        timestamptz,
  revoked_at          timestamptz,
  rotated_from_id     uuid UNIQUE,
  CONSTRAINT org_api_keys_id_org_key UNIQUE (id, organization_id),
  -- 교체 계보는 같은 조직 안에서만.
  CONSTRAINT org_api_keys_rotated_from_fk FOREIGN KEY (rotated_from_id, organization_id)
    REFERENCES org_api_keys (id, organization_id) ON DELETE RESTRICT
);

CREATE INDEX org_api_keys_org_idx ON org_api_keys (organization_id, created_at DESC, id DESC);

-- ---------------------------------------------------------------------------
-- ② 가드
-- ---------------------------------------------------------------------------

CREATE TRIGGER org_api_keys_immutable_core
  BEFORE UPDATE ON org_api_keys
  FOR EACH ROW EXECUTE FUNCTION reject_column_update_except('label', 'last_used_at', 'revoked_at');

CREATE TRIGGER org_api_keys_revoked_once
  BEFORE UPDATE ON org_api_keys
  FOR EACH ROW EXECUTE FUNCTION reject_column_overwrite('revoked_at');

CREATE OR REPLACE FUNCTION org_api_keys_last_used_at_forward_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.last_used_at IS NOT NULL AND (NEW.last_used_at IS NULL OR NEW.last_used_at < OLD.last_used_at) THEN
    RAISE EXCEPTION 'org_api_keys.last_used_at cannot move backward' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER org_api_keys_last_used_at_forward_only
  BEFORE UPDATE ON org_api_keys
  FOR EACH ROW EXECUTE FUNCTION org_api_keys_last_used_at_forward_only();

-- 활성 절대 천장 20 — 코드(`src/admin/ops/org-keys.ts` `lockOrgKeys`)와 **같은 잠금 키**. UPDATE 로는 활성 수가 늘 수 없다
--   (`revoked_at` 1회 · `expires_at` 불변).
CREATE OR REPLACE FUNCTION org_api_keys_active_ceiling() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  active integer;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('org_api_keys_active:' || NEW.organization_id::text, 0));
  SELECT count(*) INTO active FROM public.org_api_keys k
   WHERE k.organization_id = NEW.organization_id AND k.revoked_at IS NULL AND (k.expires_at IS NULL OR k.expires_at > now());
  IF active >= 20 THEN
    RAISE EXCEPTION 'org_api_keys: organization already has % active keys (ceiling 20)', active USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER org_api_keys_active_ceiling
  BEFORE INSERT ON org_api_keys
  FOR EACH ROW EXECUTE FUNCTION org_api_keys_active_ceiling();

CREATE TRIGGER org_api_keys_no_delete
  BEFORE DELETE ON org_api_keys
  FOR EACH ROW EXECUTE FUNCTION reject_row_delete();
CREATE TRIGGER org_api_keys_no_truncate
  AFTER TRUNCATE ON org_api_keys
  FOR EACH STATEMENT EXECUTE FUNCTION reject_truncate();

COMMENT ON TABLE org_api_keys IS
  '조직 API 키(atk_org_) — sha256 해시·끝 4자·이름·권한(agents:read|agents:create)·만료·폐기. 평문 없음. 콘솔 호스트 /org-api/v1 만 받는다. 앱 롤 권한 0.';

-- ---------------------------------------------------------------------------
-- ③ 권한
-- ---------------------------------------------------------------------------

REVOKE ALL ON org_api_keys FROM PUBLIC;
GRANT SELECT ON org_api_keys TO atmark_admin;
GRANT INSERT (organization_id, label, hint, token_hash, capabilities, created_by_user_id, expires_at, rotated_from_id)
  ON org_api_keys TO atmark_admin;
GRANT UPDATE (label, last_used_at, revoked_at) ON org_api_keys TO atmark_admin;
