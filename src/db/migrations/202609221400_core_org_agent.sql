-- 202609221400_core_org_agent.sql
-- P1a — Organization / Agent / AgentAddress (계획 §6 P1a 2번)
--
-- 마이그레이션 네이밍은 타임스탬프 기반이다(계획 r3 M9). 순번(0001_)은 단계 재배치 때
-- 비단조가 되어 Flyway가 out-of-order로 거부한다.

-- ---------------------------------------------------------------------------
-- 공용 함수
-- ---------------------------------------------------------------------------

-- 왜: updated_at 을 애플리케이션이 세팅하면 빠뜨린 경로가 조용히 생긴다. DB에서 강제한다.
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

-- 왜: "불변"을 선언이 아니라 집행으로 만든다. 계획 §4.3(audit 불변성)·§4B.1(키·식별자
--     불변 4구멍)이 전부 이 함수 위에 선다. TG_ARGV[0..] 로 받은 컬럼이 하나라도
--     바뀌면 예외를 던진다.
CREATE OR REPLACE FUNCTION reject_column_update() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  col text;
  old_v text;
  new_v text;
BEGIN
  FOREACH col IN ARRAY TG_ARGV LOOP
    EXECUTE format('SELECT ($1).%I::text', col) INTO old_v USING OLD;
    EXECUTE format('SELECT ($1).%I::text', col) INTO new_v USING NEW;
    IF old_v IS DISTINCT FROM new_v THEN
      RAISE EXCEPTION
        'immutable column %.% cannot be updated (was %, got %)',
        TG_TABLE_NAME, col, coalesce(old_v, 'NULL'), coalesce(new_v, 'NULL')
        USING ERRCODE = '23514';
    END IF;
  END LOOP;
  RETURN NEW;
END;
$$;

-- 왜: 테이블 전체가 불변인 경우(policy_versions)에는 컬럼을 열거하지 않는다. 열거하면
--     나중에 추가된 컬럼이 트리거 밖에 남아 조용히 가변이 된다.
CREATE OR REPLACE FUNCTION reject_row_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'rows in % are immutable and cannot be updated', TG_TABLE_NAME
    USING ERRCODE = '23514';
END;
$$;

-- 왜: DELETE + INSERT 는 UPDATE 거부 트리거를 우회해 같은 효과를 낸다(§4B.1 1번 구멍).
CREATE OR REPLACE FUNCTION reject_row_delete() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'rows in % are append-only and cannot be deleted', TG_TABLE_NAME
    USING ERRCODE = '23514';
END;
$$;

-- 왜 reject_column_update 의 allow-list 쌍이 필요한가:
--   deny-list(막을 컬럼 열거)는 **나중에 추가된 컬럼이 열거 밖에 남아 조용히 가변**이 된다 —
--   기본이 fail-open 이다. 이 함수는 반대로 "바꿔도 되는 컬럼"만 받고 나머지 전부를 막으므로
--   새 컬럼의 기본이 불변이다. 테이블 전체 불변(reject_row_update)과 부분 불변 사이를 메운다.
CREATE OR REPLACE FUNCTION reject_column_update_except() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  col text;
  old_v text;
  new_v text;
BEGIN
  FOR col IN
    SELECT a.attname
    FROM pg_attribute a
    WHERE a.attrelid = TG_RELID
      AND a.attnum > 0
      AND NOT a.attisdropped
  LOOP
    CONTINUE WHEN col = ANY (TG_ARGV);
    EXECUTE format('SELECT ($1).%I::text', col) INTO old_v USING OLD;
    EXECUTE format('SELECT ($1).%I::text', col) INTO new_v USING NEW;
    IF old_v IS DISTINCT FROM new_v THEN
      RAISE EXCEPTION
        'immutable column %.% cannot be updated (was %, got %)',
        TG_TABLE_NAME, col, coalesce(old_v, 'NULL'), coalesce(new_v, 'NULL')
        USING ERRCODE = '23514';
    END IF;
  END LOOP;
  RETURN NEW;
END;
$$;

-- 왜: TRUNCATE 는 **행 트리거를 발화시키지 않는다.** 불변성을 FOR EACH ROW 트리거로만
--   세워 두면 `TRUNCATE audit_logs` 한 줄이 "보존 정책은 무기한 불변"(§5.4)을 지운다.
--   행 단위로는 볼 수 없는 사건이므로 문장 트리거만이 이 경로를 막는다.
CREATE OR REPLACE FUNCTION reject_truncate() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'table % is append-only and cannot be truncated', TG_TABLE_NAME
    USING ERRCODE = '23514';
END;
$$;

-- ---------------------------------------------------------------------------
-- 열거형
-- ---------------------------------------------------------------------------

-- 왜: Stage 0 킬 스위치가 읽는 값이다(계획 §4.2). 값 집합이 열려 있으면 오타 하나가
--     킬 스위치를 조용히 무력화한다.
CREATE TYPE billing_status AS ENUM ('trialing', 'active', 'delinquent', 'suspended');

-- 왜: Stage 0 은 status != 'active' 를 전부 DENY 한다. 'provisioning' 을 명시해
--     "키페어가 아직 안 붙은 에이전트"가 active 로 오해되지 않게 한다(PP-A, §4B.1).
CREATE TYPE agent_status AS ENUM ('provisioning', 'active', 'suspended', 'disabled');

-- ---------------------------------------------------------------------------
-- organizations
-- ---------------------------------------------------------------------------

CREATE TABLE organizations (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name                text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  ses_tenant_id       text,
  -- 왜: Stage 0 — billing_status ∈ {suspended, delinquent} 이면 DENY (§4.2).
  billing_status      billing_status NOT NULL DEFAULT 'trialing',
  -- 왜: Stage 0 — abuse 알람(§5.4)이 자동으로 켜는 조직 단위 정지 플래그.
  abuse_freeze        boolean NOT NULL DEFAULT false,
  -- 왜: 워밍업 램프의 기준일(§3.3 M7). DNS 설정일이 아니라 **최초 SES 발송 성공 시점**에
  --     null 일 때만 1회 세팅된다. 기본값을 두면 램프가 한 통도 안 보낸 채 소진된다.
  sending_started_at  timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER organizations_set_updated_at
  BEFORE UPDATE ON organizations
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMENT ON COLUMN organizations.sending_started_at IS
  '워밍업 기준일. ses-transport.ts 의 최초 성공 경로에서 null 일 때만 1회 세팅한다 (계획 §3.3 M7).';

-- ---------------------------------------------------------------------------
-- agents
-- ---------------------------------------------------------------------------

CREATE TABLE agents (
  -- 왜: agents.id = agentId 다 (§4B.1). 별도 내부 PK를 두면 내부 키와 공개 식별자 중
  --     하나가 조인 키로 새어 나갈 표면이 생기고 AC-13의 "동일성"이 자명하지 않게 된다.
  --     16바이트 난수의 소문자 hex 32자 — did:web 경로 세그먼트에 안전하고 온체인
  --     bytes32 에 제로패딩으로 무손실 매핑된다.
  id               char(32) PRIMARY KEY
                     CHECK (id ~ '^[0-9a-f]{32}$'),
  organization_id  uuid NOT NULL REFERENCES organizations (id) ON DELETE RESTRICT,
  name             text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  -- 왜: Stage 0 킬 스위치. 신규 에이전트는 'provisioning' 으로 태어나고, 키페어가 같은
  --     트랜잭션에서 붙은 뒤에만 'active' 가 된다(PP-A 원자성, §6 P1c 10번).
  status           agent_status NOT NULL DEFAULT 'provisioning',
  plan             text NOT NULL DEFAULT 'free',
  -- 왜: Stage 5 예산. 센트 단위 정수 — 부동소수 통화는 감사 불가능한 차이를 만든다.
  monthly_budget_cents integer NOT NULL DEFAULT 0 CHECK (monthly_budget_cents >= 0),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX agents_organization_id_idx ON agents (organization_id);

CREATE TRIGGER agents_set_updated_at
  BEFORE UPDATE ON agents
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- 왜: §4B.1 불변 트리거 4구멍 중 4번 — agents.id 가 바뀌면 DID 문자열과 불일치하고
--     앵커 승격의 연결이 절단된다. 나머지 3구멍(agent_keypairs 의 DELETE/key_ref/
--     algorithm)은 P1c 의 <ts>_agent_keypairs_and_passports.sql 이 닫는다.
CREATE TRIGGER agents_id_immutable
  BEFORE UPDATE ON agents
  FOR EACH ROW EXECUTE FUNCTION reject_column_update('id');

COMMENT ON COLUMN agents.id IS
  'agentId 그 자체 ([0-9a-f]{32}). 별도 내부 PK 없음 (계획 §4B.1). UPDATE 는 트리거가 거부한다.';

-- ---------------------------------------------------------------------------
-- agent_addresses
-- ---------------------------------------------------------------------------

CREATE TABLE agent_addresses (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id    char(32) NOT NULL REFERENCES agents (id) ON DELETE RESTRICT,
  -- 왜: Stage 1(identity binding, AC-1)이 ctx.from_address ∈ agent.addresses 를 판정하는
  --     테이블이다. 비교가 대소문자에 흔들리면 위조 판정이 흔들린다 → 소문자로 못박는다.
  address     text NOT NULL CHECK (address = lower(address) AND address ~ '^[^@[:space:]]+@[^@[:space:]]+$'),
  domain      text NOT NULL CHECK (domain = lower(domain)),
  is_primary  boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now(),
  -- 왜: domain 은 address 의 파생값이다. 두 값이 어긋나면 도메인 단위 정책이
  --     실제 발신 주소와 다른 것을 보게 된다.
  CONSTRAINT agent_addresses_domain_matches_address
    CHECK (domain = split_part(address, '@', 2))
);

-- 왜: AC-1 의 뿌리. 한 주소는 정확히 하나의 에이전트에 속한다. 전역 유니크가 아니면
--     두 에이전트가 같은 from 을 주장할 수 있고 Stage 1 이 둘 다 통과시킨다.
CREATE UNIQUE INDEX agent_addresses_address_key ON agent_addresses (address);
CREATE INDEX agent_addresses_agent_id_idx ON agent_addresses (agent_id);

-- 왜: 대표 주소는 에이전트당 최대 1개. 둘이면 "이 에이전트의 주소"가 비결정적이 된다.
CREATE UNIQUE INDEX agent_addresses_one_primary_per_agent
  ON agent_addresses (agent_id) WHERE is_primary;
