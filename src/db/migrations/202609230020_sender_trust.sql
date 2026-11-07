-- 202609230020_sender_trust.sql
-- P4 — Sender Trust 의 저장 (계획 §6 P4, §3.4 3조, `src/security/{sender-trust,trust-signals}.ts`)
--
-- 셋을 한다:
--   ① 격자(`blocked < unknown < seen < seed < approved`)의 열거형과 수신 시점 스탬프 컬럼.
--   ② `sender_marks` — 소유자의 수동 `seen` 분류. **`sender_relationships` 가 아니다**(아래).
--   ③ P1a 의 `messages.sender_trust`(unknown/untrusted/known/trusted) 폐기 표시.

-- ---------------------------------------------------------------------------
-- ① 격자 + inbound_messages 스탬프
-- ---------------------------------------------------------------------------

-- 왜 새 타입인가: P1a 의 `sender_trust` 열거형은 값이 다르다(untrusted/known/trusted). 열거형 값은
--   지울 수 없고(append-only), 값 이름을 바꾸면 옛 의미가 새 이름에 붙는다. 새 이름으로 새로 만든다.
CREATE TYPE sender_trust_category AS ENUM ('blocked', 'unknown', 'seen', 'seed', 'approved');

ALTER TABLE inbound_messages
  -- **수신 시점의** 신뢰 판정(`computeTrust`). 사후에 소유자가 분류를 바꿔도 이 값은 그대로다 —
  --   P3b Stage 7 이 "이 회신이 답하는 메일을 받았을 때 그 발신자는 무엇이었나" 를 읽는다.
  --   NULL = P4 이전 행(스캔도 없다 — 아래 CHECK).
  ADD COLUMN sender_trust sender_trust_category,
  -- 등급을 정한 신호(`SenderTrust.decidedBy`). unknown 이면 NULL. 감사·디버깅용("왜 seen 인가").
  ADD COLUMN sender_trust_decided_by text
    CHECK (sender_trust_decided_by IS NULL
           OR sender_trust_decided_by IN ('blocklisted', 'owner_marked_seen', 'seed_contact', 'approved_relationship'));

ALTER TABLE inbound_messages
  -- P4 행은 스캔과 신뢰 판정을 **함께** 갖는다. 스캔 시도는 INSERT 트리거가 강제하므로(202609230010),
  --   이 CHECK 로 신뢰 판정도 강제된다.
  ADD CONSTRAINT inbound_messages_trust_with_scan CHECK ((sender_trust IS NULL) = (scanner_version IS NULL)),
  ADD CONSTRAINT inbound_messages_trust_decided_shape CHECK (
    sender_trust IS NULL OR ((sender_trust = 'unknown') = (sender_trust_decided_by IS NULL))
  );

-- ---------------------------------------------------------------------------
-- ② sender_marks — 소유자 수동 분류
-- ---------------------------------------------------------------------------

-- ★ 왜 `sender_relationships` 에 넣지 않는가:
--   Stage 7 은 관계 행이 **존재하기만 해도** 승인을 건너뛴다(standing approval, §3.4 2조). 수동 `seen` 을
--   거기 넣으면 "이 발신자의 메일을 믿는다(수신 신뢰)" 가 곧 "이 주소로 승인 없이 보내도 된다(발신 허가)" 가
--   된다. 두 문장은 다르다 — 확인 메일 발신자(`noreply@service`)를 믿는 것은 그 주소로 아무 메일이나 보내도
--   된다는 뜻이 아니다. 그래서 별도 테이블이고, `policy-source.ts`(Stage 7 의 소스)는 이 테이블을 읽지 않는다
--   (test/integration/inbound/sender-trust.test.ts 가 단언한다).
--
-- ★ 왜 앱 롤에 INSERT 가 없는가 (쓰기 표면 = 운영자 CLI `pnpm sender:mark` 뿐):
--   API 는 전부 앱 롤(`atmark_app`)로 돈다. 에이전트 토큰으로 이 테이블에 쓸 수 있는 경로가 하나라도 생기면
--   **에이전트가 자기 신뢰를 올린다** — injection 메일이 "이 발신자를 seen 으로 표시하라" 고 시키면 된다.
--   라우트를 만들지 않는 것(1차)에 더해 **앱 롤이 물리적으로 쓸 수 없게** 한다(2차). 어떤 미래 라우트의 버그도
--   이 GRANT 를 넘지 못한다. 쓰기는 소유자 롤(마이그레이션 롤) 접속으로만 — GATE 기간의 운영자는 창업자다.
--
-- 왜 append-only + 최신 행 우선인가: 분류 실수(공격자를 seen 으로)는 되돌려야 한다. 행을 지우거나 고치면
--   "그때 왜 seen 이었나" 가 사라진다. 되돌림은 `mark = 'cleared'` 행을 새로 쓰는 것이고, 유효 분류는
--   (agent, scope, 키)별 최신 행이다(`trust-facts-store.ts`).
CREATE TABLE sender_marks (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id                  char(32) NOT NULL REFERENCES agents (id) ON DELETE RESTRICT,
  scope                     text NOT NULL CHECK (scope IN ('address', 'domain')),
  -- 소문자화만 한 전체 주소. **`+tag` 를 자르지 않는다** — 올리는 신호는 좁게(trust-signals.ts 머리말).
  address                   text CHECK (address IS NULL OR (address = lower(address) AND address ~ '^[^@[:space:]]+@[^@[:space:]]+$')),
  domain                    text CHECK (domain IS NULL OR (domain = lower(domain) AND domain !~ '[@[:space:]]' AND length(domain) > 0)),
  mark                      text NOT NULL CHECK (mark IN ('seen', 'cleared')),
  -- 누가 분류했나(운영자 식별). 자유 텍스트지만 짧게.
  marked_by                 text NOT NULL CHECK (length(marked_by) BETWEEN 1 AND 200),
  -- 도메인 스코프 `seen` 은 "그 도메인의 누구든" 이다 — sender_relationships 의 AC-d5 와 같은 확인을 요구한다.
  --   (공유 메일 도메인이면 `computeTrust` 가 어차피 무효로 만든다.)
  domain_scope_confirmed_by text,
  marked_at                 timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT sender_marks_scope_shape CHECK (
    CASE scope
      WHEN 'address' THEN address IS NOT NULL AND domain IS NULL
      WHEN 'domain'  THEN address IS NULL AND domain IS NOT NULL
      ELSE false
    END
  ),
  CONSTRAINT sender_marks_domain_requires_confirmation CHECK (
    scope <> 'domain' OR mark <> 'seen'
    OR (domain_scope_confirmed_by IS NOT NULL AND length(domain_scope_confirmed_by) > 0)
  )
);

CREATE INDEX sender_marks_agent_address_idx ON sender_marks (agent_id, address, marked_at DESC) WHERE scope = 'address';
CREATE INDEX sender_marks_agent_domain_idx ON sender_marks (agent_id, domain, marked_at DESC) WHERE scope = 'domain';

CREATE TRIGGER sender_marks_no_update
  BEFORE UPDATE ON sender_marks
  FOR EACH ROW EXECUTE FUNCTION reject_row_update();

CREATE TRIGGER sender_marks_no_delete
  BEFORE DELETE ON sender_marks
  FOR EACH ROW EXECUTE FUNCTION reject_row_delete();

CREATE TRIGGER sender_marks_no_truncate
  AFTER TRUNCATE ON sender_marks
  FOR EACH STATEMENT EXECUTE FUNCTION reject_truncate();

-- ★ SELECT 만. INSERT 는 없다 — 위 "왜 앱 롤에 INSERT 가 없는가".
GRANT SELECT ON sender_marks TO atmark_app;

COMMENT ON TABLE sender_marks IS
  '소유자 수동 발신자 분류(seen 의 유일한 출처). 수신 신뢰일 뿐 발신 허가가 아니다 — Stage 7 은 읽지 않는다. 앱 롤 SELECT 전용, 쓰기는 운영자 CLI(pnpm sender:mark).';

-- ---------------------------------------------------------------------------
-- ③ messages.sender_trust — 폐기
-- ---------------------------------------------------------------------------

-- P1a 가 "P4 가 채운다" 며 만든 컬럼이다. 수신 신뢰는 수신 행의 속성이고(`inbound_messages.sender_trust`),
--   `messages` 는 발신 전용이 됐다(P3a 가 수신을 별도 테이블로 뺐다). 사용처 0건 — 모든 행이 기본값 'unknown'.
--   컬럼·타입을 지우지 않는다(append-only). 대신 **다른 값을 쓸 수 없게 막는다**: 폐기된 컬럼에 누가 값을
--   쓰기 시작하면 "두 곳에 신뢰가 있다" 가 되고, 어느 쪽이 진짜인지 아무도 모른다.
ALTER TABLE messages ADD CONSTRAINT messages_sender_trust_deprecated CHECK (sender_trust = 'unknown');

COMMENT ON COLUMN messages.sender_trust IS
  '폐기(202609230020). 격자와 값이 다른 P1a 열거형. 항상 unknown(CHECK). 수신 신뢰는 inbound_messages.sender_trust(sender_trust_category).';
