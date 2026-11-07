-- atmark:no-transaction
-- 202609291001_agent_addresses_address_idx.sql
-- 별칭 재발급(ADR-0013 2026-09-29 개정) — 주소로 **폐기 행까지** 찾는 조회(202609291002 의 보류 트리거 · 콘솔 별칭 추가의 "쓸 수 있나" 검사)를
-- 받치는 보통 색인. 옛 전역 UNIQUE 가 하던 "주소 → 행" 찾기를 이어받는다(부분 UNIQUE 는 활성 행만 든다). 옛 색인을 지우기 전에 만든다.
--
-- **비트랜잭션 파일이다**(202609260117 머리말과 같다).

CREATE INDEX CONCURRENTLY IF NOT EXISTS agent_addresses_address_idx ON agent_addresses (address);
