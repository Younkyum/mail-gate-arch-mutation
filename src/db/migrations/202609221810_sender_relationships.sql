-- 202609221810_sender_relationships.sql
-- P2 — SenderRelationship (standing approval, 계획 §3.4 설계 2조) · seed contacts (§3.1 층 2)
--       · 신규 에이전트 기본 outbound_mode = approval_required (§3.1 층 1, AC-a1)
--
-- ★ 이 테이블이 "승인의 상환" 이다. 승인 1회 → 관계 1행 → 이후 같은 상대로의 발송은 승인 없이
--   통과한다. 정상 워크로드에서 승인 횟수 = 신규 상대 수(AC-d2)가 되는 것은 이 행 덕분이다.

CREATE TYPE relationship_scope AS ENUM ('recipient', 'thread', 'domain');

-- 왜 2값뿐인가: 계획 §4.2 Stage 7 은 "관계 존재(seed/approved/inbound-established)" 를 든다.
--   'inbound_established' 는 인바운드(P3)가 만드는 값이다 — 만드는 코드가 없는 값을 지금 두면
--   누군가 손으로 넣는 경로만 생긴다. P3 가 ALTER TYPE ... ADD VALUE 로 더한다(append-only).
CREATE TYPE trust_category AS ENUM ('seed', 'approved');

CREATE TABLE sender_relationships (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id                  char(32) NOT NULL REFERENCES agents (id) ON DELETE RESTRICT,
  scope                     relationship_scope NOT NULL DEFAULT 'recipient',
  -- 판정 키. 로더의 normalizeAddress 결과(소문자 + `+tag` 절단)와 같은 모양이어야 매칭된다.
  address                   text CHECK (address IS NULL OR (address = lower(address) AND address ~ '^[^@[:space:]]+@[^@[:space:]]+$')),
  domain                    text CHECK (domain IS NULL OR (domain = lower(domain) AND domain !~ '[@[:space:]]' AND length(domain) > 0)),
  thread_id                 uuid,
  trust_category            trust_category NOT NULL,
  -- 왜: 'approved' 관계는 **어느 승인이 이 관계를 만들었는가** 에 답해야 한다(AC-9 의 연장).
  granted_via_approval_id   uuid REFERENCES approval_requests (id) ON DELETE RESTRICT,
  -- 'owner_provisioning'(seed) 또는 승인 결정자.
  granted_by                text NOT NULL CHECK (length(granted_by) > 0),
  -- ★ AC-d5: 'domain' 스코프는 **소유자 확인 파라미터 없이 만들 수 없다.**
  --   API 가 400 을 내는 것(confirm_scope: "domain")은 1차 방어선이고, 이 컬럼과 아래 CHECK 가
  --   2차다. 도메인 스코프는 "그 회사 누구에게든" 이다 — 한 명을 허락하려던 클릭이 조직 전체를
  --   여는 것은 이 제품이 막으려는 "의도하지 않은 발송" 의 확대판이다.
  domain_scope_confirmed_by text,
  created_at                timestamptz NOT NULL DEFAULT now(),

  -- 스코프마다 키의 모양이 정확히 하나다. 'recipient' 에 domain 이 같이 있으면 판정이 어느 쪽을
  --   따르는지 답이 둘이 된다.
  CONSTRAINT sender_relationships_scope_shape CHECK (
    CASE scope
      WHEN 'recipient' THEN address IS NOT NULL AND domain IS NULL AND thread_id IS NULL
      WHEN 'thread'    THEN address IS NOT NULL AND domain IS NULL AND thread_id IS NOT NULL
      WHEN 'domain'    THEN address IS NULL AND domain IS NOT NULL AND thread_id IS NULL
      ELSE false
    END
  ),

  CONSTRAINT sender_relationships_domain_requires_confirmation CHECK (
    scope <> 'domain' OR (domain_scope_confirmed_by IS NOT NULL AND length(domain_scope_confirmed_by) > 0)
  ),

  -- 왜: seed 는 소유자가 프로비저닝 때 **주소 하나하나를** 적은 것이다(§3.1 층 2, 최대 20개).
  --   승인 없이 들어온 관계이므로 가장 좁은 스코프만 허용한다 — seed 로 도메인을 여는 경로가 있으면
  --   20개 상한이 무의미해진다.
  CONSTRAINT sender_relationships_trust_shape CHECK (
    (trust_category = 'seed' AND scope = 'recipient' AND granted_via_approval_id IS NULL)
    OR (trust_category = 'approved' AND granted_via_approval_id IS NOT NULL)
  )
);

-- 왜 부분 유니크 3개인가: 스코프마다 키가 다르다. 같은 상대를 두 번 승인해도(동시 승인 2건)
--   관계는 1행이다 — 앱은 ON CONFLICT DO NOTHING 으로 쓴다.
CREATE UNIQUE INDEX sender_relationships_recipient_key
  ON sender_relationships (agent_id, address) WHERE scope = 'recipient';
CREATE UNIQUE INDEX sender_relationships_thread_key
  ON sender_relationships (agent_id, thread_id, address) WHERE scope = 'thread';
CREATE UNIQUE INDEX sender_relationships_domain_key
  ON sender_relationships (agent_id, domain) WHERE scope = 'domain';

-- 왜 UPDATE 를 막는가: 관계의 스코프를 사후에 'recipient' → 'domain' 으로 넓히는 한 줄이
--   AC-d5 의 확인 절차를 우회한다. 관계를 바꾸는 것은 새 행을 만드는 것이다.
--   (폐기는 P5 대시보드의 일이다. 그때 revoked_at 컬럼과 함께 이 트리거를 allow-list 로 바꾼다.)
CREATE TRIGGER sender_relationships_immutable_update
  BEFORE UPDATE ON sender_relationships
  FOR EACH ROW EXECUTE FUNCTION reject_row_update();

CREATE TRIGGER sender_relationships_no_delete
  BEFORE DELETE ON sender_relationships
  FOR EACH ROW EXECUTE FUNCTION reject_row_delete();

CREATE TRIGGER sender_relationships_no_truncate
  AFTER TRUNCATE ON sender_relationships
  FOR EACH STATEMENT EXECUTE FUNCTION reject_truncate();

GRANT SELECT, INSERT ON sender_relationships TO atmark_app;

COMMENT ON TABLE sender_relationships IS
  'standing approval (계획 §3.4 2조) + seed contacts (§3.1 층 2). 승인은 상대방당 1회로 상환된다. domain 스코프는 소유자 확인 없이 존재할 수 없다(AC-d5).';

-- ---------------------------------------------------------------------------
-- 신규 에이전트의 기본 모드 (§3.1 층 1 · §4.4 · AC-a1)
-- ---------------------------------------------------------------------------

-- 왜 지금인가: P1 이 allowlist_only 를 기본으로 둔 근거는 "approval_required 분기가 없다" 였다
--   (202609221410 주석). 분기가 생겼으므로 근거가 사라졌다.
-- 왜 기존 행을 건드리지 않는가: DEFAULT 는 **이후의 INSERT** 에만 작용한다. 이미 allowlist_only 로
--   운영 중인 에이전트를 조용히 승인 모드로 바꾸면 그 에이전트의 다음 발송이 전부 승인 대기가 되고,
--   그 변경은 policy_versions 에 새 버전으로 남지 않는다 — AC-9 가 답할 수 없는 정책 변경이다.
ALTER TABLE agent_policies ALTER COLUMN outbound_mode SET DEFAULT 'approval_required';
