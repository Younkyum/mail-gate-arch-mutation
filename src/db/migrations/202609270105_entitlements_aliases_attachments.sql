-- 202609270105_entitlements_aliases_attachments.sql
-- 메일 기본기 2차 D6 — 엔타이틀먼트 **두 칸**(`.omc/plans/mail-basics.md` §4 D6 · §5, 진윤겸 결정 D6 "요금제별", ADR-0013 2차 절).
--
--   ① 칸 둘 — `aliases_per_agent_max`(에이전트당 활성 별칭, 대표 제외 · 천장 20) · `attachment_bytes_total_max`(메일당 첨부 총량 바이트,
--      MiB 배수 · 천장 25 MiB). **NULL 허용으로 더한다**(확장) — 백필(202609270120)이 모든 행을 채운 뒤 NOT NULL 로 조인다(수축).
--      칸 상한 CHECK 둘은 `NOT VALID`(검증은 202609270106) — 기존 행은 NULL 이라 어차피 통과하지만 규율대로 표를 훑지 않는다.
--   ② 채움 트리거 `org_entitlements_fill_new_limits` — 두 칸을 모르는 쓰기(옛 코드 · 롤백한 billing-sync)가 INSERT 하거나 NULL 인 행을
--      UPDATE 하면 **그 요금제의 카탈로그 값**으로 채운다(해석 `resolveEntitlements` 의 NULL 규칙과 같은 값). 이 트리거가 없으면 수축(NOT NULL)
--      뒤 옛 코드의 INSERT 가 전부 실패한다 — 코드 롤백이 결제 동기화를 멈추게 두지 않는다(§6 롤백).
--   ③ 출처-롤 가드 `org_entitlements_source_by_role`(202609250400) 재정의 — 카탈로그 배열을 **열한 칸**으로(순서 = `LIMIT_COLUMNS`), D-3 칸별
--      지배 비교도 열한 칸. billing 롤이 두 칸을 **바꾸지 않은**(옛 코드) 쓰기는 새 요금제의 카탈로그 값으로 맞춘다 — 값을 바꾼 쓰기는 카탈로그와
--      같아야 한다(AC-D6-4: pro 에 별칭 6 은 거부). 그리고 billing 롤의 원인을 공급자 셋으로 **여기서** 묶는다(아래 ④가 CHECK 를 넓히므로).
--   ④ 출처↔원인 CHECK 를 넓힌다 — 백필(0120)은 **UPDATE** 로 모든 조직에 원인 `backfill` 의 새 버전을 만든다(11칸 잎 — 계획 F18 해법 3).
--      출처는 그대로 둔다(운영자 행은 운영자 행, 공급자 행은 공급자 행 — 뒤의 결제 강등·넘김 규칙이 출처를 본다). 새 CHECK 는 `NOT VALID`,
--      검증은 0106.
--
-- 카탈로그 값(`src/billing/plans.ts` `PLAN_CATALOG`, 단위 테스트 `test/unit/billing/entitlements-late-sql.test.ts` 가 대조):
--   별칭      free 0 · beta 3 · pro 5 · team 10 · scale 20 (천장 20)
--   첨부(MiB) free 5 · beta 10 · pro 10 · team 20 · scale 25 (천장 25)
--
-- 잠금: `org_entitlements` 는 조직 수만큼의 작은 표다. 칸 추가는 기본값이 없어 재작성이 없고, CHECK 는 NOT VALID 라 훑지 않는다.
-- 5초 안에 잠금을 못 잡으면 실패하고 아무것도 바뀌지 않는다.
-- 롤백 호환: 옛 코드는 두 칸을 읽지 않는다(읽기는 `ORG_ENTITLEMENTS_COLUMNS` 가 행 JSON 에서 꺼내 칸이 없어도 된다). 옛 코드의 쓰기는 ②·③이 채운다.
-- **투명성 잎은 이 파일에서 바뀌지 않는다** — 스냅샷에 두 칸을 싣는 것은 202609270115(tlog v4)이고, 그 앞에 새 서열기가 배포돼 있어야 한다
-- (런북 deploy §23).

SET LOCAL lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- ① 칸 둘 + 상한 CHECK(NOT VALID)
-- ---------------------------------------------------------------------------

ALTER TABLE org_entitlements
  ADD COLUMN aliases_per_agent_max      integer,
  ADD COLUMN attachment_bytes_total_max integer;

ALTER TABLE org_entitlements
  ADD CONSTRAINT org_entitlements_aliases_per_agent_max_check
    CHECK (aliases_per_agent_max IS NULL OR aliases_per_agent_max BETWEEN 0 AND 20) NOT VALID,
  ADD CONSTRAINT org_entitlements_attachment_bytes_total_max_check
    CHECK (attachment_bytes_total_max IS NULL
           OR (attachment_bytes_total_max BETWEEN 0 AND 26214400 AND attachment_bytes_total_max % 1048576 = 0)) NOT VALID;

COMMENT ON COLUMN org_entitlements.aliases_per_agent_max IS
  '에이전트당 활성 별칭(대표·폐기 제외) — 요금제 카탈로그, 천장 20(ADR-0013 D6). 강등으로 넘친 기존 별칭은 폐기하지 않는다.';
COMMENT ON COLUMN org_entitlements.attachment_bytes_total_max IS
  '메일당 첨부 총량(바이트, MiB 배수) — Stage 6 은 min(정책, 이 값, 25 MiB)(ADR-0013 D6).';

-- ---------------------------------------------------------------------------
-- ② 채움 트리거 — 두 칸이 비면 그 요금제의 카탈로그 값
-- ---------------------------------------------------------------------------

-- 이름 순서: BEFORE 트리거는 이름 순으로 돈다 — fill(f) → source_by_role(s) → version_forward_only(v). 가드가 채운 값을 본다.
CREATE FUNCTION org_entitlements_fill_new_limits() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.aliases_per_agent_max IS NULL THEN
    NEW.aliases_per_agent_max := CASE NEW.plan_code
      WHEN 'free' THEN 0 WHEN 'beta' THEN 3 WHEN 'pro' THEN 5 WHEN 'team' THEN 10 WHEN 'scale' THEN 20 END;
  END IF;
  IF NEW.attachment_bytes_total_max IS NULL THEN
    NEW.attachment_bytes_total_max := CASE NEW.plan_code
      WHEN 'free' THEN 5242880 WHEN 'beta' THEN 10485760 WHEN 'pro' THEN 10485760 WHEN 'team' THEN 20971520 WHEN 'scale' THEN 26214400 END;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER org_entitlements_fill_new_limits BEFORE INSERT OR UPDATE ON org_entitlements
  FOR EACH ROW EXECUTE FUNCTION org_entitlements_fill_new_limits();

-- ---------------------------------------------------------------------------
-- ③ 출처-롤 가드 재정의 — 카탈로그 열한 칸
-- ---------------------------------------------------------------------------

-- 202609250400 의 규칙은 그대로다(atmark_billing_operator = operator 출처·원인만 · atmark_billing = provider 출처 · 카탈로그 값만 · 넘기지 않은
-- 운영자·백필 행 위에서는 Free 금지 + 칸별 지배). 바뀐 것:
--   - 배열 넷이 열한 칸(`LIMIT_COLUMNS` 순서 — 끝의 둘이 별칭·첨부). beta 배열은 여전히 없다(L9 CHECK 가 provider 출처의 beta 를 거부한다).
--   - billing 롤이 두 칸을 **지금 행과 같게 둔**(옛 코드 — 두 칸을 모른다) 쓰기는 새 요금제의 카탈로그 값으로 맞춘다. INSERT 의 NULL 은 ②가
--     이미 채웠다. 값을 바꾼 쓰기는 카탈로그와 같아야 한다(아래 비교).
--   - billing 롤의 원인은 공급자 셋뿐이다(④가 CHECK 에 `backfill` 을 더하므로 결제 경로가 백필을 사칭하지 못하게 여기서 묶는다).
--   - 지금 적용 한도(applied)의 두 칸이 비었으면(백필 전) 그 행 요금제의 카탈로그 값 — 로더와 같은 해석.
CREATE OR REPLACE FUNCTION org_entitlements_source_by_role() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  free_limits CONSTANT bigint[] := ARRAY[3, 100, 100, 5, 10, 2, 1, 1, 1073741824, 0, 5242880]::bigint[];
  pro_limits CONSTANT bigint[] := ARRAY[10, 1000, 300, 30, 25, 5, 3, 2, 10737418240, 5, 10485760]::bigint[];
  team_limits CONSTANT bigint[] := ARRAY[50, 1000, 1000, 120, 50, 5, 10, 5, 53687091200, 10, 20971520]::bigint[];
  scale_limits CONSTANT bigint[] := ARRAY[200, 1000, 5000, 600, 50, 5, 10, 5, 214748364800, 20, 26214400]::bigint[];
  catalog bigint[];
  applied bigint[];
  wanted bigint[];
BEGIN
  IF current_user = 'atmark_billing_operator' THEN
    IF NEW.source <> 'operator' OR NEW.cause <> 'operator' THEN
      RAISE EXCEPTION 'org_entitlements: atmark_billing_operator 는 operator 출처·원인만 쓴다(받은 %/%)', NEW.source, NEW.cause
        USING ERRCODE = '42501';
    END IF;
  ELSIF current_user = 'atmark_billing' THEN
    IF NEW.source <> 'provider' THEN
      RAISE EXCEPTION 'org_entitlements: atmark_billing 은 provider 출처만 쓴다(받은 %)', NEW.source USING ERRCODE = '42501';
    END IF;
    IF NEW.cause NOT IN ('provider_event', 'grace_expired', 'reconcile') THEN
      RAISE EXCEPTION 'org_entitlements: atmark_billing 은 공급자 원인만 쓴다(받은 %)', NEW.cause USING ERRCODE = '42501';
    END IF;
    catalog := CASE NEW.plan_code WHEN 'free' THEN free_limits WHEN 'pro' THEN pro_limits WHEN 'team' THEN team_limits
                                  WHEN 'scale' THEN scale_limits END;
    -- 옛 billing-sync(두 칸을 모른다)의 UPDATE — 두 칸이 지금 행 그대로다. 새 요금제의 카탈로그 값으로 맞춘다(새 코드는 늘 카탈로그 값을 쓴다).
    IF catalog IS NOT NULL AND TG_OP = 'UPDATE'
       AND NEW.aliases_per_agent_max IS NOT DISTINCT FROM OLD.aliases_per_agent_max
       AND NEW.attachment_bytes_total_max IS NOT DISTINCT FROM OLD.attachment_bytes_total_max THEN
      NEW.aliases_per_agent_max := catalog[10];
      NEW.attachment_bytes_total_max := catalog[11];
    END IF;
    wanted := ARRAY[NEW.max_agents, NEW.org_daily_recipients, NEW.agent_per_day_max, NEW.agent_per_minute_max,
                    NEW.recipients_per_message_max, NEW.tokens_per_agent_max, NEW.webhook_endpoints_per_agent_max,
                    NEW.org_api_keys_max, NEW.inbound_storage_bytes, NEW.aliases_per_agent_max, NEW.attachment_bytes_total_max]::bigint[];
    IF catalog IS NOT NULL AND wanted IS DISTINCT FROM catalog THEN
      RAISE EXCEPTION 'org_entitlements: atmark_billing 은 요금제 % 의 카탈로그 한도만 쓴다(조직 %)', NEW.plan_code, NEW.organization_id
        USING ERRCODE = '42501';
    END IF;
    IF TG_OP = 'UPDATE' AND OLD.source IN ('default', 'operator') AND NOT OLD.provider_override_allowed THEN
      IF NEW.plan_code = 'free' THEN
        RAISE EXCEPTION 'org_entitlements: 공급자는 운영자·백필 행을 Free 로 떨어뜨리지 못한다(조직 %)', OLD.organization_id USING ERRCODE = '42501';
      END IF;
      IF OLD.grace_until IS NOT NULL AND OLD.grace_until <= now() THEN
        applied := free_limits;
      ELSE
        applied := ARRAY[OLD.max_agents, OLD.org_daily_recipients, OLD.agent_per_day_max, OLD.agent_per_minute_max,
                         OLD.recipients_per_message_max, OLD.tokens_per_agent_max, OLD.webhook_endpoints_per_agent_max,
                         OLD.org_api_keys_max, OLD.inbound_storage_bytes,
                         coalesce(OLD.aliases_per_agent_max, CASE OLD.plan_code
                           WHEN 'free' THEN 0 WHEN 'beta' THEN 3 WHEN 'pro' THEN 5 WHEN 'team' THEN 10 WHEN 'scale' THEN 20 END),
                         coalesce(OLD.attachment_bytes_total_max, CASE OLD.plan_code
                           WHEN 'free' THEN 5242880 WHEN 'beta' THEN 10485760 WHEN 'pro' THEN 10485760 WHEN 'team' THEN 20971520
                           WHEN 'scale' THEN 26214400 END)]::bigint[];
      END IF;
      FOR i IN 1 .. 11 LOOP
        IF wanted[i] < applied[i] THEN
          RAISE EXCEPTION 'org_entitlements: 공급자 요금제가 운영자·백필 행의 한도를 칸별로 넘지 못한다(조직 % · 칸 %) — admin:plan --release-to-provider',
            OLD.organization_id, i USING ERRCODE = '42501';
        END IF;
      END LOOP;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

-- ---------------------------------------------------------------------------
-- ④ 출처↔원인 CHECK — 백필 원인을 모든 출처에 허용(NOT VALID, 검증은 0106)
-- ---------------------------------------------------------------------------

ALTER TABLE org_entitlements DROP CONSTRAINT org_entitlements_source_cause;
ALTER TABLE org_entitlements ADD CONSTRAINT org_entitlements_source_cause CHECK (
  (source = 'default' AND cause = 'backfill')
  OR (source = 'operator' AND cause IN ('operator', 'review', 'backfill'))
  OR (source = 'provider' AND cause IN ('provider_event', 'grace_expired', 'reconcile', 'backfill'))) NOT VALID;

-- ---------------------------------------------------------------------------
-- ⑤ 권한 — 쓰는 두 롤이 새 두 칸을 쓴다(허용 목록 `RESTRICTED_ROLE_GRANTS` 의 `ENTITLEMENT_WRITE_COLUMNS`). 앱·admin 은 표 단위 SELECT 그대로.
-- ---------------------------------------------------------------------------

GRANT INSERT (aliases_per_agent_max, attachment_bytes_total_max), UPDATE (aliases_per_agent_max, attachment_bytes_total_max)
  ON org_entitlements TO atmark_billing;
GRANT INSERT (aliases_per_agent_max, attachment_bytes_total_max), UPDATE (aliases_per_agent_max, attachment_bytes_total_max)
  ON org_entitlements TO atmark_billing_operator;
