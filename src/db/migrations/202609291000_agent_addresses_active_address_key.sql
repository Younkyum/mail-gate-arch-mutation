-- atmark:no-transaction
-- 202609291000_agent_addresses_active_address_key.sql
-- 별칭 재발급(진윤겸 결정 2026-09-29, ADR-0013 2026-09-29 개정) — 주소 유일성을 **활성 행**(`retired_at IS NULL`)으로 좁히는 첫 단계.
-- 한 주소의 활성 행은 여전히 하나다(AC-1 — 두 에이전트가 같은 `from` 을 주장하지 못한다). 폐기 행은 이 색인에 들지 않아, 같은 주소를
-- 다시 발급할 수 있다(누가 · 언제는 202609291002 의 보류 트리거가 정한다).
--
-- **틈이 없는 순서**: 이 파일은 옛 전역 UNIQUE(`agent_addresses_address_key`)가 **살아 있는 동안** 부분 UNIQUE 를 만든다(기존 행은 전역으로
-- 이미 유일하니 빌드는 실패하지 않는다). 옛 색인은 202609291002 가 이 색인이 유효한지 확인한 뒤 같은 트랜잭션에서 지운다 — 어느 순간에도 활성
-- 주소의 유일성을 지키는 색인이 적어도 하나 있다.
--
-- **비트랜잭션 파일이다**(202609260117 머리말과 같다) — 주소 표에 쓰기(프로비저닝·별칭 추가·폐기)를 막지 않고 만든다.

CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS agent_addresses_active_address_key ON agent_addresses (address) WHERE retired_at IS NULL;
