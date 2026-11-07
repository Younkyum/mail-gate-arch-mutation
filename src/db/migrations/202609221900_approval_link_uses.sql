-- 202609221900_approval_link_uses.sql
-- P2 — 승인 매직링크의 **단일 사용** 기록 (계획 §3.4 5조, `src/approval/magic-link.ts`).
--
-- 왜 테이블이 필요한가: HMAC 서명은 "우리가 만든 토큰인가" 에만 답한다. "이미 쓰였는가" 는
--   서명이 답할 수 없다 — 같은 토큰은 몇 번을 제시해도 서명이 맞는다. 사용 여부는 **상태**이고
--   상태는 DB 에 있어야 한다.
--
-- ★ `approval_id` 에 외래키가 **없다** — 의도된 미완이다.
--   `approval_requests` 는 병렬 워커의 마이그레이션(202609221800_*)이 만든다. 이 파일은 그
--   파일보다 뒤에 정렬되지만, 두 파일이 동시에 작성되는 동안 상대의 확정을 전제하지 않는다.
--   **배선 워커가 추가할 것** (새 마이그레이션으로, append-only):
--     ALTER TABLE approval_link_uses
--       ADD CONSTRAINT approval_link_uses_approval_id_fkey
--       FOREIGN KEY (approval_id) REFERENCES approval_requests (id) ON DELETE RESTRICT;
--   타입은 이미 맞춰 두었다(`uuid` — `audit_logs.approval_id` 와 같은 축).

CREATE TYPE approval_link_decision AS ENUM ('approve', 'reject');

-- ★ 컬럼 집합의 규율 — **평문 토큰이 없다.**
--   `agent_api_keys` 와 같은 이유: 있으면 언젠가 채워진다. 저장하는 것은 토큰 안의 `jti`
--   (서명된 128비트 난수)의 sha256 뿐이다. 서명 키 없이는 이 값에서 토큰을 만들 수 없다.
--   토큰 **문자열**의 해시가 아니라 `jti` 의 해시인 이유: base64 끝 비트를 바꾼 다른 문자열이
--   같은 바이트로 풀릴 수 있다(가변성). 문자열 해시로 단일 사용을 걸면 그 변종이 "처음 보는
--   토큰" 이 된다. 앱은 비정규 인코딩을 거부하지만, 키를 서명된 값에 두면 그 검사가 빠져도
--   이 테이블이 버틴다.
CREATE TABLE approval_link_uses (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  approval_id    uuid NOT NULL,
  token_id_hash  char(64) NOT NULL CHECK (token_id_hash ~ '^[0-9a-f]{64}$'),
  -- 어느 키로 서명된 링크였는가. 키 유출 사고 때 "그 키로 결정된 approval" 을 추리는 축이다.
  key_id         text NOT NULL CHECK (key_id ~ '^[a-z0-9]{1,16}$'),
  decision       approval_link_decision NOT NULL,
  used_at        timestamptz NOT NULL
);

-- 왜 approval_id 가 유니크인가 — **이것이 "단일 사용" 의 정의다.**
--   토큰 하나가 승인·거절 둘 다를 할 수 있으므로(magic-link.ts 판단), 단일 사용은 토큰이 아니라
--   **approval 단위**여야 한다. 같은 approval 에 링크가 재발급돼도(메일 재전송) 결정은 한 번이다.
--   선조회가 아니라 인덱스가 집행한다 — 동시 두 POST 는 둘 다 "아직 없다" 를 읽는다.
CREATE UNIQUE INDEX approval_link_uses_approval_id_key ON approval_link_uses (approval_id);

-- 왜 token_id_hash 도 유니크인가: 위 인덱스가 사실상 포함하지만(jti 는 한 approval 에 묶여
--   서명된다), 키가 approval 이 아니라 토큰이라는 사실을 스키마에 남긴다. 128비트 난수의
--   충돌이 여기서 걸린다면 그것은 난수원의 사고이고, 조용히 통과해서는 안 된다.
CREATE UNIQUE INDEX approval_link_uses_token_id_hash_key ON approval_link_uses (token_id_hash);

-- 왜 전부 불변인가: 사용 기록은 **일어난 일**이다. "누가 언제 무엇으로 결정했나" 가 사후에
--   바뀌면 audit_logs 의 `approved_by` 와 대조할 근거가 사라진다. 열거하지 않는 이유는
--   policy_versions 와 같다 — 나중에 추가된 컬럼도 기본이 불변이어야 한다.
CREATE TRIGGER approval_link_uses_immutable
  BEFORE UPDATE ON approval_link_uses
  FOR EACH ROW EXECUTE FUNCTION reject_row_update();

-- 왜 DELETE 를 막는가: 지우면 그 approval 의 링크가 **다시 쓸 수 있게 된다.** 단일 사용이
--   행의 존재로 표현되므로 삭제는 곧 재사용 허가다.
CREATE TRIGGER approval_link_uses_no_delete
  BEFORE DELETE ON approval_link_uses
  FOR EACH ROW EXECUTE FUNCTION reject_row_delete();

CREATE TRIGGER approval_link_uses_no_truncate
  AFTER TRUNCATE ON approval_link_uses
  FOR EACH STATEMENT EXECUTE FUNCTION reject_truncate();

COMMENT ON TABLE approval_link_uses IS
  '승인 매직링크 사용 기록. approval 당 1행(유니크)이 단일 사용의 정의다. 평문 토큰은 저장하지 않는다 — 서명된 jti 의 sha256 만.';
COMMENT ON COLUMN approval_link_uses.approval_id IS
  'approval_requests.id. FK 는 배선 워커가 새 마이그레이션으로 건다(파일 머리말).';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'atmark_app') THEN
    RAISE EXCEPTION
      'role atmark_app does not exist; provision the app role before running this migration'
      USING ERRCODE = '42704';
  END IF;
END;
$$;

-- 왜 UPDATE·DELETE 가 없는가: 위 트리거의 1차 방어선. 권한이 없으면 트리거에 닿지도 않는다.
GRANT SELECT, INSERT ON approval_link_uses TO atmark_app;
