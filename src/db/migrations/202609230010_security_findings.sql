-- 202609230010_security_findings.sql
-- P4 — injection 스캐너 판정을 수신 경로에 꽂는다 (계획 §6 P4 "SecurityFinding 기록 · injection_risk ·
--       quarantine · 스캐너 버전 스탬프", §3.4 3조의 `inbound.injection_risk`).
--
-- 두 가지를 더한다:
--   ① `inbound_messages` 에 판정 세 컬럼(scanner_version · injection_risk · quarantined).
--   ② `security_findings` — 룰 적중의 **좌표**만. 매칭 원문은 없다.
--
-- ---------------------------------------------------------------------------
-- ★ fail-closed 를 DB 에 새긴다
-- ---------------------------------------------------------------------------
--
-- 스캐너가 던지면 소비자는 판정 없이(`injection_risk IS NULL`) 기록하고 격리한다. 스캔하지 못한 메일을
-- 에이전트에게 보여주면 "스캐너 장애 = injection 통과" 가 된다. 아래 CHECK 가 그 문장을 한 줄로 집행한다:
-- **판정이 없으면 격리돼 있다.** 코드가 뒤집혀 판정 없는 행을 `quarantined = false` 로 쓰면 INSERT 가 죽는다.
--
-- 그리고 이 마이그레이션 **이후의 INSERT 는 스캔 시도 없이 들어올 수 없다**(BEFORE INSERT 트리거 —
-- `scanner_version` 필수). 이전 행(P3a 시절)은 `scanner_version IS NULL` 로 남고, 격리된 상태로 백필된다.
--
-- ---------------------------------------------------------------------------
-- 재스캔 판단 (스캐너 버전이 오르면 과거 메일은?)
-- ---------------------------------------------------------------------------
--
-- **지금은 기록만 한다 — 재스캔하지 않는다.** 이유:
--   - 수신 시점 판정은 "에이전트에게 무엇이 보였는가" 의 사실이다. 재스캔으로 그것을 덮어쓰면(UPDATE)
--     사후에 "그때는 격리였다/아니었다" 가 바뀐다 — `inbound_messages` 는 표시 스레드 외 불변이다.
--   - 판정의 유일한 소비자(P3b Stage 7, Sender Trust 의 injection_history)는 "최신 메일" 과 "이 발신자의
--     과거 판정" 을 읽는다. 과거 메일이 새 룰에 걸린다는 사실은 가치가 있지만, 그 반영은 **판정을 올리는
--     방향으로만**, 새 행으로 해야 한다 — 그 설계(예: `inbound_rescans` + 유효 판정 = max)는 GATE 뒤다.
--   - 대신 **"어느 버전으로 판정했는가" 는 반드시 남는다**: 행의 `scanner_version` 과 findings 의
--     `scanner_version`. findings 의 유니크 키에 버전이 들어 있으므로 재스캔 도구는 새 버전 findings 를
--     충돌 없이 **덧붙일** 수 있다(append-only 를 깨지 않는다).

-- ---------------------------------------------------------------------------
-- ① inbound_messages — 판정 세 컬럼
-- ---------------------------------------------------------------------------

ALTER TABLE inbound_messages
  -- 판정을 **시도한** 스캐너(`INJECTION_SCANNER_VERSION`). 던졌어도 채운다 — "어느 스캐너가 실패했나".
  --   NULL = 이 마이그레이션 이전(P3a) 행.
  ADD COLUMN scanner_version text
    CHECK (scanner_version IS NULL OR (length(scanner_version) BETWEEN 1 AND 200 AND scanner_version !~ '[[:space:][:cntrl:]]')),
  -- 스캐너 판정. **NULL = 판정 없음**(스캐너 예외, 또는 P3a 행). 'none' 과 다르다 — 소비자는 NULL 을
  --   'none' 으로 읽으면 안 된다(P3b 조회 포트가 그대로 NULL 을 넘긴다).
  ADD COLUMN injection_risk injection_risk,
  -- 에이전트 컨텍스트에서 가린다. 백필 기본값 true — 스캔한 적 없는 이전 행은 격리 쪽이다.
  ADD COLUMN quarantined boolean NOT NULL DEFAULT true;

-- 기본값은 백필용이었다. 새 INSERT 는 명시해야 한다 — 기본값이 남아 있으면 "빠뜨린 컬럼" 이 조용히 채워진다.
ALTER TABLE inbound_messages ALTER COLUMN quarantined DROP DEFAULT;

ALTER TABLE inbound_messages
  -- ★ fail-closed: 판정 없음 ⇒ 격리.
  ADD CONSTRAINT inbound_messages_unscanned_is_quarantined CHECK (injection_risk IS NOT NULL OR quarantined),
  -- 판정이 있으면 그 판정을 낸 버전이 있다.
  ADD CONSTRAINT inbound_messages_verdict_has_version CHECK (injection_risk IS NULL OR scanner_version IS NOT NULL),
  -- 임계(`QUARANTINE_FROM`)는 스캐너 모듈의 값이라 DB 에 복제하지 않는다. 다만 'high' 가 격리되지 않는
  --   임계는 어떤 버전에서도 뜻이 없다 — 그 한 점만 DB 가 한 번 더 막는다.
  ADD CONSTRAINT inbound_messages_high_is_quarantined CHECK (injection_risk IS DISTINCT FROM 'high' OR quarantined);

-- ★ 이 마이그레이션 이후의 수신 행은 스캔 시도를 거쳐야 한다. CHECK 로는 "이전 행" 과 "새 행" 을 가를 수
--   없으므로(둘 다 NULL 일 수 있다) INSERT 시점 트리거로 건다.
CREATE OR REPLACE FUNCTION reject_unscanned_inbound() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.scanner_version IS NULL THEN
    RAISE EXCEPTION 'inbound_messages rows must carry scanner_version (scan attempted before insert)'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER inbound_messages_require_scan
  BEFORE INSERT ON inbound_messages
  FOR EACH ROW EXECUTE FUNCTION reject_unscanned_inbound();

-- 격리되지 않은 메일 목록(에이전트 컨텍스트 조회, P3b/P5)용.
CREATE INDEX inbound_messages_agent_visible_idx
  ON inbound_messages (agent_id, received_at DESC) WHERE NOT quarantined;

-- (UPDATE 불변은 이미 걸려 있다: `inbound_messages_immutable_except_display` 는 allow-list 트리거라
--  새 컬럼의 기본이 불변이다. 판정은 사후에 바뀌지 않는다.)

-- ---------------------------------------------------------------------------
-- ② security_findings — 룰 적중의 좌표 (append-only)
-- ---------------------------------------------------------------------------

-- ★ **매칭 원문을 싣지 않는다.** 스캐너 결과(`SecurityFinding`)에도 원문이 없고, 그 규율을 DB 까지 끈다:
--   모든 문자열 컬럼이 **모양 CHECK**(공백 없는 식별자)로 묶여 있어 본문 조각이 들어갈 자리가 없다.
--   원문이 필요하면 `inbound_messages.parsed_storage_key`(S3) + (field, start_offset, end_offset) 로 찾는다.
--
-- 왜 field·view·family 를 열거형이 아니라 모양 CHECK 로 두는가: 스캐너는 다른 작업자가 키운다(필드·축이
--   늘 수 있다). 열거형이면 새 값 하나가 INSERT 실패 → 소비자 `failed` → 무한 재전달(poison pill)이 된다.
--   모양 CHECK 는 "본문이 못 들어온다" 는 보장만 남기고 어휘는 스캐너에 맡긴다.
CREATE TABLE security_findings (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  inbound_message_id  uuid NOT NULL REFERENCES inbound_messages (id) ON DELETE RESTRICT,
  -- 이 적중을 낸 스캐너. 재스캔이 새 버전 findings 를 덧붙일 수 있게 유니크 키에 들어간다.
  scanner_version     text NOT NULL
                        CHECK (length(scanner_version) BETWEEN 1 AND 200 AND scanner_version !~ '[[:space:][:cntrl:]]'),
  -- 스캐너 결과 배열 속 순서(원문 좌표 순).
  ordinal             integer NOT NULL CHECK (ordinal >= 0),
  rule_id             text NOT NULL CHECK (rule_id ~ '^[a-z0-9][a-z0-9_.:-]{0,99}$'),
  -- 축(`RuleFamily`).
  family              text NOT NULL CHECK (family ~ '^[a-z0-9_]{1,64}$'),
  -- 어느 필드(`ScanField`)의 몇 번째(첨부 파일명이면 첨부 순서, 아니면 0).
  field               text NOT NULL CHECK (field ~ '^[a-z0-9_]{1,64}$'),
  field_index         integer NOT NULL CHECK (field_index >= 0),
  -- 어느 보기(`ScanView`)에서 적중했나.
  view                text NOT NULL CHECK (view ~ '^[a-z0-9_]{1,64}$'),
  -- **원문 필드 문자열의 UTF-16 좌표.** 원문 자체가 아니다.
  start_offset        integer NOT NULL CHECK (start_offset >= 0),
  end_offset          integer NOT NULL CHECK (end_offset >= start_offset),
  weight              numeric NOT NULL CHECK (weight >= 0),
  damped              boolean NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT security_findings_ordinal_key UNIQUE (inbound_message_id, scanner_version, ordinal)
);

CREATE TRIGGER security_findings_no_update
  BEFORE UPDATE ON security_findings
  FOR EACH ROW EXECUTE FUNCTION reject_row_update();

CREATE TRIGGER security_findings_no_delete
  BEFORE DELETE ON security_findings
  FOR EACH ROW EXECUTE FUNCTION reject_row_delete();

CREATE TRIGGER security_findings_no_truncate
  AFTER TRUNCATE ON security_findings
  FOR EACH STATEMENT EXECUTE FUNCTION reject_truncate();

GRANT SELECT, INSERT ON security_findings TO atmark_app;

COMMENT ON TABLE security_findings IS
  'injection 스캐너 룰 적중의 좌표(룰·축·필드·위치·가중치·버전). 매칭 원문 없음 — 문자열 컬럼은 전부 모양 CHECK. append-only.';
COMMENT ON COLUMN inbound_messages.injection_risk IS
  'NULL = 판정 없음(스캐너 예외 또는 P4 이전 행). none 으로 읽지 말 것. 판정 없음 ⇒ quarantined (CHECK).';
