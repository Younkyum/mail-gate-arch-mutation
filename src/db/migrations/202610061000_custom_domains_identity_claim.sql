-- 202610061000_custom_domains_identity_claim.sql
-- 고객 도메인 **한 번에 설정**(2026-10 one-shot · `docs/internal/plans/custom-domains-oneshot.md` §2 · §4.1) — 도메인당 **identity 관리자(steward)
-- 하나**를 DB 가 정한다. SES identity 를 pending 에서(소유 증명 전) 만들게 되면서 "증명 전 경쟁" 이 생기므로, 상태 값(5개 · 투명성 잎)은 그대로 두고
-- 직교 축 칸 셋을 더한다.
--
--   ① 칸: `identity_claimed_at`(관리권을 얻은 시각 — 쓰기 1회) · `identity_released_at`(놓은 시각 — 쓰기 1회, 클레임 뒤) ·
--      `identity_handover_to`(넘겨받은 행 — 놓는 바로 그 UPDATE 에서만). 활성 관리자 = claimed ∧ ¬released ∧ ¬identity_deleted.
--      도메인당 활성 관리자 하나는 부분 UNIQUE `custom_domains_identity_claim_key`(202610061001, 비트랜잭션)가 지킨다.
--   ② 가드 `custom_domains_identity_claim_guard`(BEFORE INSERT · UPDATE — 이름 순서상 다른 BEFORE 가드보다 먼저 돈다):
--        · INSERT — 세 칸은 NULL 로만(새 행은 관리자가 아니다).
--        · **자동 클레임** — pending → verifying 전이에서 클레임이 없으면 `now()` 를 채운다. 옛 틱(클레임을 모르는 코드)도 아래 CHECK 를 어기지
--          않게 하고, 새 틱은 같은 트랜잭션에서 옛 관리자를 먼저 놓아 준 뒤 전이한다(놓지 않았으면 색인 23505 — 지금 `enterVerifying` 이 잡는 코드).
--        · claimed 는 쓰기 1회 · removed 행(또는 removed 로 나가는 UPDATE)에서는 클레임하지 않는다(소유자 롤 예외 — 아래 백필).
--        · released 는 클레임 뒤 쓰기 1회.
--        · handover_to 는 released 를 적는 **같은 UPDATE** 에서만, 대상은 **같은 도메인 · 다른 행 · removed 아님 · 클레임한 적 없음**(쓰기 1회 클레임이라
--          옛 관리자에게 되돌려 줄 수 없다 — 사슬은 앞으로만 간다). domain-control 은 틱이 넘긴 `supersededRowId`(이 사슬에서 고른 직전 관리자)를
--          믿고 identity 를 채택하므로, 이 칸은 DB 가 지킨다(202610021102 `supersede_guard` 와 같은 역할).
--   ③ CHECK(NOT VALID → 202610061002 에서 VALIDATE):
--        · `custom_domains_steward_shape` — verifying · verified · suspended 행은 활성 관리자다(verified 조건 "이 행이 관리자" 의 DB 보장).
--        · `custom_domains_identity_claim_shape` — released ⇒ claimed · handover ⇒ released · released 인데 handover 가 없으면 removed(포기 —
--          제거 사가가 남의 identity 를 만났을 때)뿐.
--        · FK `custom_domains_identity_handover_to_fkey`.
--   ④ 백필 — 지금 identity 를 가질 수 있는 행(verifying+ · 제거 사가가 남은 자기 태그 행, 대체되지 않은 것)을 관리자로. 운영의 `agent.younkyum.me`
--      (verifying · identity 생성됨)가 여기서 관리자가 된다. 투명성 잎 트리거는 상태 · 사유 · 수신 MX 변화에만 돈다(202609291130) — 잎 0.
--      **사전 질의(적용 전 · 터널 · 읽기 — deploy §43 1단계와 같은 SQL, 술어는 아래 백필 UPDATE 와 한 글자도 다르지 않다)**:
--        -- ① 백필 대상 수(배포 기록에 남긴다 — 적용 뒤 첫 틱의 `identities_held` 와 같아야 한다)
--        SELECT count(*) FROM custom_domains
--         WHERE identity_deleted_at IS NULL
--           AND (status IN ('verifying', 'verified', 'suspended')
--                OR (status = 'removed' AND removal_step <> 'done' AND superseded_by IS NULL AND ses_identity_row_tag = id));
--        -- ② 같은 도메인에 백필 대상이 둘 이상 = 0행이어야 한다(아니면 202610061001 색인이 INVALID 로 남는다 — 운영자가 먼저 정리)
--        SELECT domain, count(*) FROM custom_domains
--         WHERE identity_deleted_at IS NULL
--           AND (status IN ('verifying', 'verified', 'suspended')
--                OR (status = 'removed' AND removal_step <> 'done' AND superseded_by IS NULL AND ses_identity_row_tag = id))
--         GROUP BY domain HAVING count(*) > 1;
--   ⑤ 권한 — 틱 롤만 세 칸 UPDATE(`role-bootstrap.ts` `CUSTOM_DOMAIN_TICK_UPDATE_COLUMNS` 와 같다). admin(콘솔 · 조직 API)은 없다.
--
-- **expand-only** — 옛 compute(클레임을 모르는 틱)와 함께 돈다: 자동 클레임 덕분에 pending → verifying 은 그대로 되고, 옛 제거 사가는
-- `identity_deleted_at` 으로 관리권을 풀어 준다. 단 옛 코드의 **양도**(옛 행을 놓지 않고 removed)는 새 행의 자동 클레임이 23505 로 막혀 되돌려진다
-- (옛 틱이 잡는 코드 — 아무것도 바뀌지 않는다). 새 compute 배포 뒤에 풀린다.
-- 잠금: custom_domains 칸 추가(ACCESS EXCLUSIVE 잠깐 — 기본값 없음 · 재작성 없음) · 트리거 · CHECK/FK NOT VALID · 행 수 개의 UPDATE. 5초 안에 못 잡으면
-- 실패하고 아무것도 바뀌지 않는다.

SET LOCAL lock_timeout = '5s';

ALTER TABLE custom_domains
  ADD COLUMN identity_claimed_at timestamptz,
  ADD COLUMN identity_released_at timestamptz,
  ADD COLUMN identity_handover_to uuid;

ALTER TABLE custom_domains
  ADD CONSTRAINT custom_domains_identity_handover_to_fkey FOREIGN KEY (identity_handover_to) REFERENCES custom_domains (id) ON DELETE RESTRICT NOT VALID;

COMMENT ON COLUMN custom_domains.identity_claimed_at IS
  'identity 관리권을 얻은 시각(쓰기 1회 — 틱 클레임 · pending → verifying 자동 클레임 · 넘겨받기). 활성 관리자 = claimed ∧ ¬released ∧ ¬identity_deleted, 도메인당 하나.';
COMMENT ON COLUMN custom_domains.identity_released_at IS
  'identity 관리권을 놓은 시각(쓰기 1회). handover_to 가 있으면 그 행이 관리권을 받았다(채택 대기) · 없으면 removed 행의 포기.';
COMMENT ON COLUMN custom_domains.identity_handover_to IS
  '관리권을 넘겨받은 행(같은 도메인 · 클레임한 적 없는 살아 있는 행). 틱의 채택 대상(supersededRowId) 사슬 — DB 가드가 지킨다.';

CREATE FUNCTION custom_domains_identity_claim_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE
  is_owner boolean := pg_has_role(current_user, (SELECT c.relowner FROM pg_catalog.pg_class c WHERE c.oid = TG_RELID), 'USAGE');
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.identity_claimed_at IS NOT NULL OR NEW.identity_released_at IS NOT NULL OR NEW.identity_handover_to IS NOT NULL THEN
      RAISE EXCEPTION 'custom_domains: 새 행은 identity 관리자가 아니다' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  -- 자동 클레임 — 증명한 행이 verifying 으로 들어서는 순간(옛 틱 호환). 다른 활성 관리자가 있으면 색인이 23505 로 막는다.
  IF OLD.status = 'pending' AND NEW.status = 'verifying' AND OLD.identity_claimed_at IS NULL AND NEW.identity_claimed_at IS NULL THEN
    NEW.identity_claimed_at := now();
  END IF;
  IF NEW.identity_claimed_at IS DISTINCT FROM OLD.identity_claimed_at THEN
    IF OLD.identity_claimed_at IS NOT NULL OR NEW.identity_claimed_at IS NULL THEN
      RAISE EXCEPTION 'custom_domains: identity_claimed_at 은 한 번만 적는다(id=%)', OLD.id USING ERRCODE = '23514';
    END IF;
    IF (OLD.status = 'removed' OR NEW.status = 'removed') AND NOT is_owner THEN
      RAISE EXCEPTION 'custom_domains: removed 행은 identity 관리권을 얻지 못한다(id=%)', OLD.id USING ERRCODE = '23514';
    END IF;
  END IF;
  IF NEW.identity_released_at IS DISTINCT FROM OLD.identity_released_at THEN
    IF OLD.identity_released_at IS NOT NULL OR NEW.identity_released_at IS NULL OR NEW.identity_claimed_at IS NULL THEN
      RAISE EXCEPTION 'custom_domains: identity_released_at 은 클레임 뒤 한 번만 적는다(id=%)', OLD.id USING ERRCODE = '23514';
    END IF;
  END IF;
  IF NEW.identity_handover_to IS DISTINCT FROM OLD.identity_handover_to THEN
    IF OLD.identity_handover_to IS NOT NULL OR OLD.identity_released_at IS NOT NULL OR NEW.identity_released_at IS NULL THEN
      RAISE EXCEPTION 'custom_domains: identity_handover_to 는 관리권을 놓는 UPDATE 에서만 한 번 적는다(id=%)', OLD.id USING ERRCODE = '23514';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM public.custom_domains s
       WHERE s.id = NEW.identity_handover_to
         AND s.id <> OLD.id
         AND s.domain = OLD.domain
         AND s.status <> 'removed'
         AND s.identity_claimed_at IS NULL
    ) THEN
      RAISE EXCEPTION 'custom_domains: 넘겨받는 행은 같은 도메인 · 다른 행 · removed 아님 · 클레임한 적 없음이어야 한다(id=%)', OLD.id USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER custom_domains_identity_claim_guard BEFORE INSERT OR UPDATE ON custom_domains
  FOR EACH ROW EXECUTE FUNCTION custom_domains_identity_claim_guard();

ALTER TABLE custom_domains
  ADD CONSTRAINT custom_domains_steward_shape CHECK (
    status NOT IN ('verifying', 'verified', 'suspended') OR (identity_claimed_at IS NOT NULL AND identity_released_at IS NULL)
  ) NOT VALID;

ALTER TABLE custom_domains
  ADD CONSTRAINT custom_domains_identity_claim_shape CHECK (
    (identity_released_at IS NULL OR identity_claimed_at IS NOT NULL)
    AND (identity_handover_to IS NULL OR identity_released_at IS NOT NULL)
    AND (identity_released_at IS NULL OR identity_handover_to IS NOT NULL OR status = 'removed')
    AND (identity_handover_to IS NULL OR identity_handover_to <> id)
  ) NOT VALID;

-- ④ 백필 — 소유자 롤(이 마이그레이션)만 removed 행에 클레임을 적을 수 있다(가드 예외).
UPDATE custom_domains
   SET identity_claimed_at = coalesce(txt_verified_at, now())
 WHERE identity_claimed_at IS NULL
   AND identity_deleted_at IS NULL
   AND (status IN ('verifying', 'verified', 'suspended')
        OR (status = 'removed' AND removal_step <> 'done' AND superseded_by IS NULL AND ses_identity_row_tag = id));

-- ⑤ 권한
GRANT UPDATE (identity_claimed_at, identity_released_at, identity_handover_to) ON custom_domains TO atmark_domain_tick;
