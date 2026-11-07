-- 202610021101_anchor_namespace.sql
-- **앵커 이름 비충돌**(ADR-0014 2026-10 개정 — 진윤겸 2026-10-02 "겹치지 않도록 꼭"). 고객 도메인 주소를 대표로 고른 에이전트의 @atmark.ai 앵커는
-- 전용 이름 공간 `ax--` + 암호학적 난수 20자(base32 소문자 `[a-z2-7]`)다 — 에이전트 id 에서 파생하지 않는다(did:web 에 공개된 id 로 역추적되지 않게).
--
--   ⓪ 사전 조회: `ax--` 로 시작하는 주소가 하나라도 있으면 **멈춘다**(아무것도 바꾸지 않는다). 운영 0 이 기대값이다.
--   ① `agent_addresses_anchor_namespace_guard`(BEFORE INSERT, 정의자 아님) — 로컬파트가 `ax--` 로 시작하면:
--        · 소유자 롤이 아니면 **형식 오류**(23514 — "사용 중"이 아니라서 존재가 새지 않는다; 앱은 `buildAgentAddress` 가 먼저 `invalid_character`).
--        · 소유자 롤(= 아래 정의자 함수 · 운영자 셸)이어도 모양이 정확히 `^ax--[a-z2-7]{20}@atmark.ai$` 이고 `is_primary` 여야 한다.
--      잠금을 잡지 않고 행 하나만 보므로 다른 BEFORE INSERT 트리거와의 순서에 기대지 않는다(어느 순서로 돌아도 같은 판정 · 교착 없음).
--   ② `atmark_provision_custom_primary(agent, anchor_local, custom_address)`(정의자 — **`ax--` 를 넣는 유일한 앱 경로**): 주소가 하나도 없는 새
--      에이전트에 한 트랜잭션으로 앵커(대표) + 고객 도메인 별칭 + 선택(`provision`)을 넣는다. 앵커 INSERT 의 이름 충돌(활성 주소 유니크 23505 ·
--      사람 이메일 claim P0A01)은 **P0A10** 으로 바꿔 던진다 — 앱(`src/identity/primary.ts`)은 그 코드만 새 난수로 다시 시도한다(상한 5).
--      고객 별칭 쪽 오류(P0A05 · 23505 · P0A01 · P0A04)는 그대로 나간다(재시도하지 않는다 — 사용자가 고른 주소의 문제다).
--   앵커는 대표라 폐기할 수 없고(202609270110) 그래서 재발급되지도 않는다.
--
-- **운영 무변화.** 기존 주소에 `ax--` 가 없으면(⓪) ① 은 아무 행에도 걸리지 않는다. ② 는 M3b 의 에이전트 만들기가 부른다(기능 허용 목록 비어 있음).
-- 잠금: agent_addresses SHARE ROW EXCLUSIVE(사전 조회 앞에서 · 트랜잭션 끝까지 — 트리거 생성과 같은 세기) · 함수. 5초 안에 못 잡으면 실패한다.

SET LOCAL lock_timeout = '5s';

-- ⓪ 사전 조회 — 조회와 가드 생성 사이에 `ax--` 행이 끼어들지 못하게 먼저 표를 잠근다(SHARE ROW EXCLUSIVE — 쓰기를 막고 읽기는 둔다, #13 보안 리뷰 L3).
--    가드 트리거를 만드는 문장도 같은 잠금을 잡으므로 이 파일의 잠금 세기는 늘지 않는다(먼저 잡을 뿐).
LOCK TABLE agent_addresses IN SHARE ROW EXCLUSIVE MODE;

DO $$
DECLARE
  offenders integer;
BEGIN
  SELECT count(*) INTO offenders FROM agent_addresses WHERE split_part(address, '@', 1) LIKE 'ax--%';
  IF offenders > 0 THEN
    RAISE EXCEPTION '앵커 이름 공간(ax--)과 겹치는 주소가 % 개 있다 — 이 마이그레이션은 아무것도 바꾸지 않고 멈춘다(런북 custom-domains §3)', offenders;
  END IF;
END
$$;

-- ① 이름 공간 가드
CREATE FUNCTION agent_addresses_anchor_namespace_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF split_part(NEW.address, '@', 1) NOT LIKE 'ax--%' THEN
    RETURN NEW;
  END IF;
  IF NOT pg_has_role(current_user, (SELECT c.relowner FROM pg_catalog.pg_class c WHERE c.oid = TG_RELID), 'USAGE') THEN
    RAISE EXCEPTION 'agent_addresses: 로컬파트 형식이 올바르지 않다' USING ERRCODE = '23514';
  END IF;
  IF NOT NEW.is_primary OR NEW.address !~ '^ax--[a-z2-7]{20}@atmark\.ai$' THEN
    RAISE EXCEPTION 'agent_addresses: ax-- 는 대표 앵커(ax-- + base32 20자 @atmark.ai)에만 쓴다' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER agent_addresses_anchor_namespace_guard BEFORE INSERT ON agent_addresses
  FOR EACH ROW EXECUTE FUNCTION agent_addresses_anchor_namespace_guard();

-- ② 고객 도메인 대표 프로비저닝(정의자)
CREATE FUNCTION atmark_provision_custom_primary(p_agent_id char(32), p_anchor_local text, p_custom_address text)
RETURNS TABLE (anchor_id uuid, custom_id uuid, change_id uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_anchor uuid;
  v_custom uuid;
  v_change uuid;
BEGIN
  IF p_anchor_local IS NULL OR p_anchor_local !~ '^ax--[a-z2-7]{20}$' THEN
    RAISE EXCEPTION 'atmark_provision_custom_primary: 앵커 로컬파트 모양이 아니다' USING ERRCODE = '22023';
  END IF;
  IF p_custom_address IS NULL OR p_custom_address !~ '^[^@]+@[^@]+$' OR split_part(p_custom_address, '@', 2) = 'atmark.ai' THEN
    RAISE EXCEPTION 'atmark_provision_custom_primary: 고객 도메인 주소가 아니다' USING ERRCODE = '22023';
  END IF;
  IF EXISTS (SELECT 1 FROM public.agent_addresses x WHERE x.agent_id = p_agent_id) THEN
    RAISE EXCEPTION 'atmark_provision_custom_primary: 주소가 이미 있는 에이전트다(새 에이전트만)' USING ERRCODE = '23514';
  END IF;
  BEGIN
    INSERT INTO public.agent_addresses (agent_id, address, domain, is_primary)
    VALUES (p_agent_id, p_anchor_local || '@atmark.ai', 'atmark.ai', true)
    RETURNING id INTO v_anchor;
  EXCEPTION
    WHEN unique_violation OR SQLSTATE 'P0A01' THEN
      RAISE EXCEPTION 'atmark_provision_custom_primary: 앵커 이름이 겹쳤다 — 새 난수로 다시' USING ERRCODE = 'P0A10';
  END;
  INSERT INTO public.agent_addresses (agent_id, address, domain, is_primary)
  VALUES (p_agent_id, p_custom_address, split_part(p_custom_address, '@', 2), false)
  RETURNING id INTO v_custom;
  INSERT INTO public.agent_primary_changes (agent_id, address_id, cause)
  VALUES (p_agent_id, v_custom, 'provision')
  RETURNING id INTO v_change;
  RETURN QUERY SELECT v_anchor, v_custom, v_change;
END;
$$;

REVOKE ALL ON FUNCTION atmark_provision_custom_primary(char, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION atmark_provision_custom_primary(char, text, text) TO atmark_admin;

COMMENT ON FUNCTION atmark_provision_custom_primary(char, text, text) IS
  '고객 도메인 대표로 새 에이전트의 주소를 만든다(ADR-0014 2026-10 개정): ax-- 앵커 + 고객 별칭 + provision 선택. 앵커 이름 충돌 = P0A10(앱이 새 난수로 재시도).';
