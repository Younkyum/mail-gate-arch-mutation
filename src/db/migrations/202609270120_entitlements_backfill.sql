-- 202609270120_entitlements_backfill.sql
-- 메일 기본기 2차 D6 — 엔타이틀먼트 두 칸의 **백필(UPDATE)** 과 수축(NOT NULL)(`.omc/plans/mail-basics.md` §4 D6 해법 3 · §5).
--
-- **202609270115(tlog v4) 뒤여야 한다** — 그래야 이 UPDATE 가 만드는 outbox 스냅샷이 11칸이고, 모든 조직이 **11칸 `billing.entitlement` 잎 하나**를
-- 새로 갖는다. 그러면 검증기 판 4 의 접기 대조(마지막 잎 = 지금 행)가 모든 조직에서 11칸으로 성립한다(위험 R16).
--
--   ① 감사 행 — 조직마다 하나(원인 `backfill` · 행위자 `migration:202609270120` · 이전 요금제 = 지금 요금제 · 버전 = 지금 + 1). 지연 트리거
--      `org_entitlements_audited` 가 커밋 때 버전마다 짝을 본다(202609250300 백필과 같은 관례).
--   ② 행 UPDATE — 두 칸 = 그 행 요금제의 **카탈로그 값**(운영자 덮어쓰기 행도 — 두 칸은 이제 처음 생기는 값이다) · 원인 `backfill` ·
--      version + 1. **출처는 그대로**(운영자 행은 운영자 행 — 결제 강등·넘김 규칙이 출처를 본다, 0105 ④가 CHECK 를 넓혔다). 유예·제어 칸 그대로.
--      `updated_at` 은 DB 가 적는다(가드 트리거) — 잎의 `at` 은 이 마이그레이션의 시각이다(과거 시각을 꾸미지 않는다).
--   ③ 수축 — 두 칸 `SET NOT NULL`. 표가 작아(조직 수) ACCESS EXCLUSIVE 아래 한 번 훑는 것이 짧다. 채움 트리거(0105 ②)가 남아 있어 두 칸을 모르는
--      옛 코드의 INSERT 도 통과한다(롤백 호환).
--
-- **다음 버전을 쓸 수 없는 행**은 건너뛴다 — `billing_audit` 에 그 조직의 `version + 1` 감사 행이 이미 있으면(앞 트랜잭션이 미리 적어 둔 행 —
-- 감사 짝 트리거가 받지 않는 행이다) UNIQUE `billing_audit_version_key` 때문에 그 행은 어떤 경로로도 다음 버전을 쓰지 못한다. 운영에서는
-- 생기지 않아야 하는 모양이고(쓰기는 감사 행과 한 트랜잭션), 로컬 테스트 DB 에는 그 거부를 시험한 조직이 남는다. 그런 행이 하나라도 남으면
-- `SET NOT NULL` 대신 경고를 남기고 칸을 NULL 허용으로 둔다(202609230750 의 예약 로컬파트 CHECK 와 같은 관례 — 마이그레이션을 멈추지 않는다).
-- 해석은 NULL = 카탈로그 값이고, 그 조직의 마지막 잎은 9칸 그대로라 검증기 판 4 의 접기 대조(비어 있는 행 ↔ 9칸 잎)도 성립한다.
--
-- 카탈로그 값은 `src/billing/plans.ts` `PLAN_CATALOG` 와 같다(단위 테스트 `test/unit/billing/entitlements-late-sql.test.ts`).
-- 잠금: `org_entitlements` 행 전부(UPDATE) · 표(SET NOT NULL). 5초 안에 못 잡으면 실패하고 아무것도 바뀌지 않는다 — 결제 동기화가 행을 쥔
-- 순간이면 다시 돌린다. 서열기 스케줄은 멈춰 있어야 한다(런북 deploy §23 3단계) — 멈추지 않아도 안전하지만 잔량 확인이 깔끔하다.

SET LOCAL lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- ① 감사 행(버전마다 하나 — 행 UPDATE 보다 먼저 써도 된다: 짝 검사는 커밋 때)
-- ---------------------------------------------------------------------------

INSERT INTO billing_audit (organization_id, from_plan, to_plan, cause, actor, note, entitlement_version)
SELECT e.organization_id, e.plan_code, e.plan_code, 'backfill', 'migration:202609270120',
       'mail basics 2: aliases_per_agent_max and attachment_bytes_total_max added from the plan catalog', e.version + 1
  FROM org_entitlements e
 WHERE NOT EXISTS (SELECT 1 FROM billing_audit b WHERE b.organization_id = e.organization_id AND b.entitlement_version = e.version + 1);

-- ---------------------------------------------------------------------------
-- ② 행 UPDATE — 두 칸 = 카탈로그 · 원인 backfill · version + 1
-- ---------------------------------------------------------------------------

UPDATE org_entitlements e
   SET aliases_per_agent_max = p.aliases_per_agent_max,
       attachment_bytes_total_max = p.attachment_bytes_total_max,
       cause = 'backfill',
       version = e.version + 1
  FROM (VALUES
    -- plan_code, aliases_per_agent_max, attachment_bytes_total_max(바이트 = MiB × 1,048,576)
    ('free', 0, 5242880),
    ('beta', 3, 10485760),
    ('pro', 5, 10485760),
    ('team', 10, 20971520),
    ('scale', 20, 26214400)
  ) AS p (plan_code, aliases_per_agent_max, attachment_bytes_total_max)
 WHERE p.plan_code = e.plan_code
   -- ①이 감사 행을 쓴 행만(= 이 트랜잭션에 version + 1 감사 행이 있다).
   AND EXISTS (SELECT 1 FROM billing_audit b
                WHERE b.organization_id = e.organization_id AND b.entitlement_version = e.version + 1
                  AND b.actor = 'migration:202609270120' AND b.created_at = now());

-- 감사 짝 검사(지연 제약 트리거)를 지금 끝낸다 — 대기 중인 트리거 사건이 있으면 아래 ALTER TABLE 이 거부된다(55006).
SET CONSTRAINTS org_entitlements_audited IMMEDIATE;

-- ---------------------------------------------------------------------------
-- ③ 수축 — NOT NULL
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  stuck integer;
BEGIN
  SELECT count(*) INTO stuck FROM org_entitlements WHERE aliases_per_agent_max IS NULL OR attachment_bytes_total_max IS NULL;
  IF stuck = 0 THEN
    ALTER TABLE org_entitlements ALTER COLUMN aliases_per_agent_max SET NOT NULL;
    ALTER TABLE org_entitlements ALTER COLUMN attachment_bytes_total_max SET NOT NULL;
  ELSE
    RAISE WARNING 'org_entitlements 에 다음 버전을 쓸 수 없는 행(미리 적힌 감사 행)이 % 개 있다 — 두 칸은 NULL 허용으로 남는다(해석 = 카탈로그 값). docs/runbooks/deploy.md §23 참고', stuck;
  END IF;
END;
$$;
