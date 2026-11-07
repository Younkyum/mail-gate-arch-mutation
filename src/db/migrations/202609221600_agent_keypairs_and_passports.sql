-- 202609221600_agent_keypairs_and_passports.sql
-- P1c PP-A — agent_keypairs / passports **생성** + 키·식별자 불변 트리거
-- (계획 §4B.1 · §4B.1b · §4B.2 PP-A · §5.0b Layer P2 4번 · §6 P1c 10번)
--
-- **이 마이그레이션 하나가 Passport 트랙 전체에서 비용 대비 가치가 가장 높다** (계획 §5.0b).
-- AC-13("같은 agentId·같은 keypair 로 승격된다")을 참으로 만드는 것이 바로 이것이고,
-- 비용은 SQL 몇 십 줄이다. **그래서 범위를 틀리면 가치도 그만큼 틀린다** — 아래
-- "불변 트리거 4구멍" 섹션이 계획 §4B.1 의 표를 그대로 옮긴 이유다.
--
-- P6 은 이 테이블들을 **만들지 않는다.** `<ts>_passport_documents.sql` 이 여기에
-- 컬럼을 추가할 뿐이다(계획 §6 P1c M10 정정).
--
-- 마이그레이션은 append-only 다. 기존 8장은 한 글자도 건드리지 않았다 — 러너가
-- sha256 을 대조한다(`src/db/migrate.ts`).

-- ---------------------------------------------------------------------------
-- 공용 함수 — 덮어쓰기 금지(write-once)
-- ---------------------------------------------------------------------------

-- 왜 이 함수가 새로 필요한가: `passports.content_hash` 와 `metadata_uri` 는 P1c 에서
--   NULL 로 태어나 **P6 의 게시 시점에 한 번** 채워진다. 그러니 "절대 불변"으로 막으면
--   게시가 불가능하고, "갱신 가능"으로 열면 **이미 발급된 문서의 해시를 사후에 다시
--   쓸 수 있다** — 앵커된 해시와의 대조가 무의미해진다. 필요한 것은 그 사이,
--   **NULL → 값 은 1회 허용, 값 → 다른 값 은 거부**다.
CREATE OR REPLACE FUNCTION reject_column_overwrite() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  col text;
  old_v text;
  new_v text;
BEGIN
  FOREACH col IN ARRAY TG_ARGV LOOP
    EXECUTE format('SELECT ($1).%I::text', col) INTO old_v USING OLD;
    EXECUTE format('SELECT ($1).%I::text', col) INTO new_v USING NEW;
    CONTINUE WHEN old_v IS NULL;
    IF old_v IS DISTINCT FROM new_v THEN
      RAISE EXCEPTION
        'write-once column %.% cannot be overwritten (was %, got %)',
        TG_TABLE_NAME, col, old_v, coalesce(new_v, 'NULL')
        USING ERRCODE = '23514';
    END IF;
  END LOOP;
  RETURN NEW;
END;
$$;

-- ---------------------------------------------------------------------------
-- 열거형
-- ---------------------------------------------------------------------------

-- 왜 값이 하나뿐인 ENUM 인가: 계획 §3.5 가 **ed25519 를 확정**했고 그 근거는 AC-11 의
--   외부 라이브러리 호환성이다(KMS 의 HSM 비수출성을 포기하고 얻은 것이다). text 로
--   두면 오타 하나가 검증 경로 불일치를 만들고, 그 불일치는 서명이 실패할 때까지
--   드러나지 않는다. 알고리즘을 늘리려면 ALTER TYPE 이 필요하고 — 그 순간 사람이
--   §3.5 를 다시 읽게 된다. 그게 이 ENUM 이 하는 일 전부다.
CREATE TYPE keypair_algorithm AS ENUM ('ed25519');

-- 왜 4값 하나로 통합하는가 (계획 §4B.1b "status 통합과 전이", C2 ⑥):
--   r2 는 `issued_unpublished`(§4B.2)와 `active|suspended|revoked`(§4B.3)를 두 벌로
--   썼고 전이 규칙이 없었다. 전이: draft → published → suspended → published,
--   그리고 published|suspended → revoked (종단).
--
--   **agents.status 와는 축이 다르다.** agents.status 는 에이전트의 운영 상태이고
--   이 값은 신분증 문서의 게시 상태다. **에이전트는 active 인데 passport 는 draft 인
--   상태가 P1~P5 내내 정상이다** (PP-A 가 P1c, 게시는 P6).
CREATE TYPE passport_status AS ENUM ('draft', 'published', 'suspended', 'revoked');

-- ---------------------------------------------------------------------------
-- agent_keypairs
-- ---------------------------------------------------------------------------

-- ★ 이 테이블의 규약 (계획 §4B.1):
--
--     "키 생성 시점 = 에이전트 프로비저닝 트랜잭션 내부. Agent row 와 Keypair row 가
--      같은 트랜잭션에서 생성되거나, 둘 다 생성되지 않는다. 키 재생성 경로 없음."
--
--   그리고 그 이유: **소급 발급 경로가 애초에 존재하지 않게 만든다.**
CREATE TABLE agent_keypairs (
  -- 왜 agent_id 가 PK 인가: 에이전트당 키는 **정확히 하나**다. 별도 id 를 두고
  --   (agent_id) 인덱스만 걸면 "두 번째 키를 INSERT" 라는 회전 경로가 열린다 —
  --   DELETE 트리거와 UPDATE 트리거를 둘 다 우회하면서. PK 가 그 경로를 닫는다.
  agent_id    char(32) PRIMARY KEY REFERENCES agents (id) ON DELETE RESTRICT,

  -- 왜 base64url 43자인가: ed25519 공개키 원시 32바이트의 base64url(패딩 없음) 표현이고,
  --   이것은 JWK 의 `x` 값 **그대로**다(OKP/Ed25519). PP-B 가 did.json 에 실을 때
  --   publicKeyJwk 는 변환 없이 이 값을 쓰고, publicKeyMultibase 는 같은 32바이트를
  --   base58btc 로 다시 인코딩할 뿐이다. DER/PEM 으로 저장하면 두 형식 모두가 파싱을
  --   거치게 되고, 파싱은 실패할 수 있는 단계다.
  public_key  text NOT NULL CHECK (public_key ~ '^[A-Za-z0-9_-]{43}$'),

  algorithm   keypair_algorithm NOT NULL,

  -- ★ 왜 개인키 컬럼이 없는가 — 그리고 앞으로도 없어야 하는가 (계획 §3.5):
  --   개인키는 생성 직후 KMS CMK 로 envelope 암호화되어 Secrets Manager 에 들어가고,
  --   여기에는 **그 참조만** 남는다. 평문 키는 서명 프로세스 메모리에만 존재한다.
  --   이 컬럼 집합이 화이트리스트로 arch 테스트에 박혀 있다(`AGENT_KEYPAIR_COLUMNS`).
  --
  --   형식: `<scheme>://<locator>`. 운영은 `awssm://<secret-arn>`, 로컬 개발은
  --   `devfile://<agentId>`. **스킴을 CHECK 로 닫는 이유**: 닫지 않으면 아무 문자열이나
  --   들어가고, 그중 하나가 언젠가 암호문 자체가 된다("참조 대신 값을 넣으면 편하다").
  --   **길이 상한을 정규식 밖에 두는 이유**: Postgres 의 POSIX 정규식은 반복 횟수
  --   상한이 255 다. `{1,512}` 는 CREATE 는 통과하고 **평가 시점에** "invalid repetition
  --   count(s)" 로 죽는다 — 즉 테이블은 만들어지는데 INSERT 가 전부 실패하는 형태의
  --   고장이다. 마이그레이션은 append-only 라 그 상태는 새 파일로만 고칠 수 있다.
  key_ref     text NOT NULL
                CHECK (key_ref ~ '^(awssm|devfile)://[[:print:]]+$' AND length(key_ref) <= 512),

  created_at  timestamptz NOT NULL DEFAULT now()
);

-- ---- 불변 트리거 — 계획 §4B.1 의 4구멍 (1·2·3번; 4번은 202609221400 의 agents_id_immutable) ----

-- 구멍 ②③ + public_key: **행 전체를 불변으로 막는다.**
--   왜 컬럼 열거(reject_column_update)가 아닌가: 열거는 deny-list 이고, deny-list 는
--   **나중에 추가된 컬럼이 열거 밖에 남아 조용히 가변**이 된다(202609221400 주석과 같은
--   논지). 이 테이블에는 갱신되어야 할 컬럼이 **하나도 없으므로** 전체 불변이 정답이고,
--   P6 이 컬럼을 추가하더라도 그 컬럼의 기본이 불변이 된다.
--
--   특히 `key_ref` UPDATE 가 4구멍 중 가장 위험하다: 공개키는 그대로 두고 Secrets
--   Manager 포인터만 교체하면 **겉보기엔 아무것도 안 바뀌었는데 발급된 전 서명이
--   조용히 무효화된다.** 침해 대응 시 가장 자연스러운 동작이라 더 위험하다.
CREATE TRIGGER agent_keypairs_immutable
  BEFORE UPDATE ON agent_keypairs
  FOR EACH ROW EXECUTE FUNCTION reject_row_update();

-- 구멍 ①: DELETE + INSERT 는 UPDATE 거부를 우회해 키 교체와 **같은 효과**를 낸다.
CREATE TRIGGER agent_keypairs_no_delete
  BEFORE DELETE ON agent_keypairs
  FOR EACH ROW EXECUTE FUNCTION reject_row_delete();

-- TRUNCATE 는 행 트리거를 발화시키지 않는다. 문장 트리거만이 이 경로를 막는다.
CREATE TRIGGER agent_keypairs_no_truncate
  BEFORE TRUNCATE ON agent_keypairs
  FOR EACH STATEMENT EXECUTE FUNCTION reject_truncate();

COMMENT ON TABLE agent_keypairs IS
  '에이전트당 keypair 1개. 생성은 프로비저닝 트랜잭션 안에서만, 회전·재발급·삭제 경로 없음 (계획 §4B.1). UPDATE/DELETE/TRUNCATE 를 트리거가 거부한다 — AC-13 이 참이 되는 지점.';
COMMENT ON COLUMN agent_keypairs.public_key IS
  'ed25519 공개키 원시 32바이트의 base64url(패딩 없음) = JWK 의 x 값 그대로.';
COMMENT ON COLUMN agent_keypairs.key_ref IS
  'Secrets Manager 참조만. 개인키·암호문은 어떤 형태로도 이 DB 에 들어가지 않는다 (계획 §3.5, AC-e1).';

-- ---------------------------------------------------------------------------
-- passports
-- ---------------------------------------------------------------------------

-- ★ 왜 온체인 대응 필드를 **지금** 넣는가 (계획 §4B.1 r3 행):
--   스펙의 온체인 레코드 5필드 중 r2 규격표에 대응물이 있던 것은 `agentId` 하나뿐이었다.
--   `controller` · `metadata_uri` · `content_hash` · `status` 를 나중에 넣으면 이미
--   발급된 문서에 그 값이 없고, 특히 **해시는 사후 재계산이 불가능하다**.
--   §3.6 이 말한 "비용 0의 미래 대비" 가 실제로 비용 0이 되려면 지금이어야 한다.
CREATE TABLE passports (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id       char(32) NOT NULL REFERENCES agents (id) ON DELETE RESTRICT,

  -- ★ URL 경로 스킴 동결 (ADR-0002 Consequences, 계획 §4B.1).
  --   `did:web:id.atmark.ai:agents:{agentId}` → `https://id.atmark.ai/agents/{agentId}/did.json`.
  --   **이 CHECK 가 동결의 집행이다.** DID 문자열과 agent_id 가 갈라지는 순간 승격
  --   연결(AC-13)이 절단되는데, 문자열 조립은 코드 한 줄이라 조용히 틀릴 수 있다.
  --   DB 가 대조하면 틀린 조립은 INSERT 에서 죽는다.
  did            text NOT NULL
                   CHECK (did = 'did:web:id.atmark.ai:agents:' || agent_id),

  -- P1c 가 만드는 것은 **draft 뿐이다** (§4B.2 PP-A: "서빙·서명·공개 API 없음").
  status         passport_status NOT NULL DEFAULT 'draft',

  -- Phase 1 = Atmark 조직 DID. 고객 이양은 Phase 2 결정으로 미룬다 (계획 §3.5 표).
  --   custody 이양과 앵커 승격은 **독립된 축**이다 — controller 가 바뀌어도
  --   agentId·verificationMethod 는 그대로이므로 기존 서명은 유효하다.
  --   길이 상한이 정규식 밖에 있는 이유는 위 `key_ref` 와 같다(POSIX 반복 상한 255).
  controller     text NOT NULL
                   CHECK (controller ~ '^did:[a-z0-9]+:[[:print:]]+$' AND length(controller) <= 300),

  -- = passport_url (스펙 온체인 레코드의 metadataURI). P6 의 게시 시점에 채워진다.
  metadata_uri   text CHECK (metadata_uri IS NULL OR metadata_uri ~ '^https://'),

  -- ★ **RFC 8785 JCS 로 passport.json 을 정규 직렬화한 뒤 SHA-256, 소문자 hex 64자.**
  --   P1c 는 문서를 만들지 않으므로 값은 아직 없지만 **규칙을 지금 고정**해야 한다 —
  --   나중에 정하면 이미 발급된 문서의 해시를 재계산할 수 없다(§4B.1 credentialHash 행).
  --   정규화 대상은 `passport.json` 문서 전문이며, JWS 서명 바이트가 아니다.
  content_hash   char(64) CHECK (content_hash IS NULL OR content_hash ~ '^[0-9a-f]{64}$'),

  -- 재서명은 행 갱신이 아니라 **새 버전 행 생성**이다(§4B.1b "버전·재서명", audit 와 같은
  --   append 철학). 이전 행에는 superseded_at 을 찍는다.
  version        integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  issued_at      timestamptz NOT NULL DEFAULT now(),
  superseded_at  timestamptz CHECK (superseded_at IS NULL OR superseded_at >= issued_at),

  -- 왜: 게시된 문서인데 해시도 URI 도 없다면 그 서명은 무엇에 대한 것인지 알 수 없다.
  --   P1c 는 draft 만 만들므로 이 CHECK 는 지금 아무것도 막지 않는다 — **P6 을 위해
  --   지금 세워 두는 것**이고, 그게 이 마이그레이션의 성격 전부다.
  CONSTRAINT passports_published_requires_document
    CHECK (status = 'draft' OR (content_hash IS NOT NULL AND metadata_uri IS NOT NULL))
);

-- 같은 에이전트의 같은 버전이 둘이면 "어느 쪽이 v2 인가"에 답이 둘이 된다.
CREATE UNIQUE INDEX passports_agent_version_key ON passports (agent_id, version);

-- 살아 있는(대체되지 않은) 버전은 에이전트당 최대 1개. 둘이면 검증자가 어느 문서를
-- 믿어야 하는지 알 수 없고, 그 모호함은 재서명 워커의 버그로 조용히 생긴다.
CREATE UNIQUE INDEX passports_one_current_per_agent
  ON passports (agent_id) WHERE superseded_at IS NULL;

CREATE INDEX passports_status_idx ON passports (status);

-- ---- 불변 ----

-- 왜 allow-list(reject_column_update_except)인가: deny-list 는 나중에 추가된 컬럼이
--   열거 밖에 남아 **조용히 가변**이 된다. 여기서 갱신될 수 있는 것은 수명주기
--   필드 4개뿐이고(§4B.1b), P6 이 컬럼을 추가하면 그 컬럼의 기본은 불변이다.
--   `id`·`agent_id`·`did`·`version`·`issued_at` 이 불변인 것이 요점이다 — DID 문자열이
--   사후에 바뀌면 이미 배포된 문서가 가리키는 대상이 달라진다.
CREATE TRIGGER passports_lifecycle_columns_only
  BEFORE UPDATE ON passports
  FOR EACH ROW EXECUTE FUNCTION reject_column_update_except(
    'status', 'metadata_uri', 'content_hash', 'superseded_at'
  );

-- 위 allow-list 가 열어 준 두 컬럼은 **1회 쓰기**다. NULL → 값은 게시이고,
-- 값 → 다른 값은 "이미 발급된 문서의 해시를 다시 쓰는" 행위다. 후자를 막는다.
CREATE TRIGGER passports_document_fields_write_once
  BEFORE UPDATE ON passports
  FOR EACH ROW EXECUTE FUNCTION reject_column_overwrite('content_hash', 'metadata_uri');

-- 문서를 **삭제하지 않는다**는 것이 §4B.1b 의 핵심 원칙이다: 삭제는 검증자에게
-- "이 DID 는 존재한 적 없다"로 읽히고, 그것은 사칭보다 나쁜 실패 모드다.
CREATE TRIGGER passports_no_delete
  BEFORE DELETE ON passports
  FOR EACH ROW EXECUTE FUNCTION reject_row_delete();

CREATE TRIGGER passports_no_truncate
  BEFORE TRUNCATE ON passports
  FOR EACH STATEMENT EXECUTE FUNCTION reject_truncate();

COMMENT ON TABLE passports IS
  '신분증 문서의 상태·버전. P1c 는 draft 만 만든다(서빙·서명 없음, 계획 §4B.2). 어떤 상태에서도 행을 삭제하지 않는다 (§4B.1b).';
COMMENT ON COLUMN passports.did IS
  'did:web:id.atmark.ai:agents:{agentId}. URL 경로 스킴은 영구 동결 — ADR-0002 Consequences (리팩터 금지 구역).';
COMMENT ON COLUMN passports.content_hash IS
  'RFC 8785 JCS 정규 직렬화 후 SHA-256 (소문자 hex 64자). 대상은 passport.json 문서 전문. 규칙은 P1c 에서 동결됐다 — 사후 변경은 이미 발급된 문서의 해시를 재계산 불가능하게 만든다 (계획 §4B.1).';
COMMENT ON COLUMN passports.status IS
  'agents.status 와 축이 다르다. 에이전트가 active 인데 passport 가 draft 인 상태는 P1~P5 내내 정상이다 (계획 §4B.3 r4).';

-- ---------------------------------------------------------------------------
-- 권한 — 위 트리거들이 장식이 되지 않게 하는 부분
-- ---------------------------------------------------------------------------

-- 왜 여기에도 롤 검사가 있는가: 이 마이그레이션은 202609221430 보다 **뒤에** 적용되지만,
--   새 DB 를 만들 때 누군가 파일을 골라 돌리는 경로가 있다. 권한 부여를 조용히 건너뛴
--   마이그레이션은 불변식이 집행되지 않는 DB 를 만들어 놓고 성공을 보고한다 — fail closed.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'atmark_app') THEN
    RAISE EXCEPTION
      'role atmark_app does not exist; provision the app role before running PP-A migration'
      USING ERRCODE = '42704';
  END IF;
END;
$$;

-- 왜 UPDATE 도 DELETE 도 주지 않는가: **앱이 키를 바꿀 업무상 이유가 0이다.**
--   권한이 1차 방어선이고 트리거는 권한이 잘못 부여됐을 때의 2차 방어선이다
--   (202609221430 의 TRUNCATE 주석과 같은 논지). 앱 롤에서의 UPDATE/DELETE 는
--   트리거에 **도달조차 하지 않고** 42501 로 죽는다.
GRANT SELECT, INSERT ON agent_keypairs TO atmark_app;

-- 왜 passports 에도 UPDATE 가 없는가: P1c 가 만드는 것은 draft 뿐이고 전이는 P6 의
--   일이다. P6 이 자기 마이그레이션에서 필요한 만큼만 열면 된다 — 지금 열어 두면
--   "쓰지 않는 권한"이 P6 까지 7~10개월간 켜져 있게 된다.
GRANT SELECT, INSERT ON passports TO atmark_app;
