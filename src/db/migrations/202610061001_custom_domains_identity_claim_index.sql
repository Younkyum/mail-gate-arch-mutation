-- atmark:no-transaction
-- 202610061001_custom_domains_identity_claim_index.sql
-- 도메인당 **활성 identity 관리자 하나**(202610061000 · one-shot §2.3) — 부분 UNIQUE. 틱의 클레임(도메인 진입 잠금 아래)이 23505 를 받으면 진 쪽이다.
-- 술어는 store.ts `STEWARD_PREDICATE` · migrate status `REQUIRED_GUARDS` 와 같다.
--
-- **비트랜잭션 파일이다**(202609291122 머리말과 같다) — 쓰기를 막지 않고 만든다. 백필(1000)이 같은 도메인에 활성 관리자 둘을 만들었다면 여기서
-- 실패하고 색인이 INVALID 로 남는다 — 사전 질의(deploy 런북: 같은 도메인의 verifying+ · 제거 사가 중 자기 태그 행이 둘 이상 = 0)를 먼저 본다.
-- INVALID 로 남으면 `DROP INDEX CONCURRENTLY custom_domains_identity_claim_key` 뒤 원인을 고치고 다시 적용한다(IF NOT EXISTS 는 INVALID 색인을 건너뛴다).

CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS custom_domains_identity_claim_key ON custom_domains (domain)
  WHERE identity_claimed_at IS NOT NULL AND identity_released_at IS NULL AND identity_deleted_at IS NULL;
