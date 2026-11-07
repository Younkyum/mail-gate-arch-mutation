-- 202609301540_operator_reserved_abuse_postmaster.sql
-- **`abuse@atmark.ai` · `postmaster@atmark.ai` 를 사람에게**(2026-09-30, 마케팅 계획 — 도메인 평판 가드레일). RFC 2142 역할 주소라 예약 로컬파트이고,
-- 지금까지는 inbound 가 에이전트를 찾지 못해 `unknown_recipient` 로 거부했다 — 스팸 신고·차단 해제 협의·바운스 문의가 아무에게도 닿지 않았다.
-- 이 파일은 두 주소를 **운영자 발급 가능 목록**(202609301500 `atmark_operator_assignable_addresses()`)에 더한다. 운영자가 지원 에이전트
-- ("Atmark Support", 조직 Chronostasis — 진윤겸이 MCP 로 읽는 수신함)에 **별칭**으로 붙인다(`pnpm admin:reserved-address grant` → `alias`, deploy §33).
--
--   ① 목록 = `support@`·`onve@`·`claude@`·**`abuse@`·`postmaster@`** — TS `OPERATOR_ASSIGNABLE_ADDRESSES`(`src/identity/address.ts`)와 같은 값·같은
--      순서(통합 테스트). 끝에 붙인다(기존 셋의 자리는 그대로).
--   ② CHECK 는 **바꾸지 않는다.** `agent_addresses_not_reserved_local_part`(1500)·`operator_address_grants_address_shape`(1500)는 이 함수를 부르므로
--      목록이 넓어지면 두 CHECK 도 함께 넓어진다. 넓히기만 하므로 기존 행은 여전히 통과한다 — `NOT VALID`/VALIDATE 쌍(1500/1501)이 필요 없다.
--      허가 가드 트리거(`agent_addresses_operator_grant_guard`)도 같은 함수를 읽는다 — 두 주소도 **그 조직의 운영자 허가 행**이 있어야 INSERT 된다(42501).
--   ③ 닫힌 채로 실패 — 두 주소를 이미 쥔 행(활성 · 30일 안 퇴역)이 있으면 55000 으로 멈춘다(1500 ④-b 와 같은 판정). 예약 CHECK 가 막아 왔으므로
--      정상이면 0행이다. 있다면 CHECK 를 우회한 쓰기다 — 목록을 넓히는 순간 허가 없이 쥔 행이 "합법"으로 보이게 되므로 배포를 세우고 사람이 본다.
--
--   ④ **대표 주소가 될 수 없다**(보안 검토 L5) — `agent_addresses_role_address_not_primary`: `NOT (is_primary AND address IN ('abuse@atmark.ai', 'postmaster@atmark.ai'))`.
--      두 주소는 별칭으로만 붙는다. 대표 주소면 그 에이전트의 발신 기본값 · passport · 투명성 로그 신원이 역할 주소가 되고, 수신 전용 가드(IAM Deny · 발송
--      전처리)와 어긋난다. 허가 가드 트리거는 대표 여부를 보지 않으므로(운영자 허가 행만 본다) 표 CHECK 가 마지막 문이다. **`NOT VALID`** — 위 ③ 이 두 주소를
--      쥔 행이 0 임을 이미 확인하므로 기존 행은 통과하지만, 검증(표 전체 읽기)은 202609301541 로 나눈다(1500/1501 · 1530/1531 과 같은 쌍).
--
-- **보내지는 않는다(수신 전용).** 두 주소는 발신 주소가 될 수 없다: 발송 역할 IAM Deny `SesDenyReceiveOnlyFromAddress`(compute-stack) · 발송 전처리
-- (`src/api/outbound-service.ts` — `from` 이 수신 전용 주소면 400) · 회신 기본 발신 주소는 대표 주소로 떨어진다(`reply-target-store.ts`).
--
-- 잠금: 함수 교체(표 잠금 없음) · DO 블록의 읽기(ACCESS SHARE). 5초 안에 못 잡으면 실패한다(다시 돌리면 된다).
-- **순서**: migrate(이 파일) → `AtmarkCompute`(IAM Deny · 문의 라우팅 · 회신 기본값) → 운영자 명령. docs/runbooks/deploy.md §33.

SET LOCAL lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- ③ 닫힌 채로 실패 — `abuse@`·`postmaster@` 를 이미 쥔 행이 있으면 여기서 멈춘다
-- ---------------------------------------------------------------------------
-- "쥐고 있다" = 활성이거나 30일 안에 퇴역한 행(`agent_addresses_reissue_hold` 의 다른 조직 재발급 보류 기간과 같다).
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM agent_addresses
     WHERE address IN ('abuse@atmark.ai', 'postmaster@atmark.ai')
       AND (retired_at IS NULL OR retired_at > now() - interval '30 days')
  ) THEN
    RAISE EXCEPTION 'abuse@/postmaster@ already held — run deploy §33 pre-check ②' USING ERRCODE = '55000';
  END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- ① 운영자 발급 가능 주소 — 끝에 둘을 더한다
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION atmark_operator_assignable_addresses() RETURNS text[]
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT ARRAY['support@atmark.ai', 'onve@atmark.ai', 'claude@atmark.ai', 'abuse@atmark.ai', 'postmaster@atmark.ai']::text[]
$$;

-- ---------------------------------------------------------------------------
-- ④ 대표 주소 금지 — NOT VALID(검증은 202609301541)
-- ---------------------------------------------------------------------------

ALTER TABLE agent_addresses
  ADD CONSTRAINT agent_addresses_role_address_not_primary
  CHECK (NOT (is_primary AND address IN ('abuse@atmark.ai', 'postmaster@atmark.ai'))) NOT VALID;
