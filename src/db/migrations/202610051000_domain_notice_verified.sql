-- 202610051000_domain_notice_verified.sql
-- 도메인 확인 완료 알림(콘솔 탭·도메인 작업 — 진윤겸 요청 2026-10-05): `domain_notices.kind` 에 `verified` 를 더한다.
-- 확인 틱이 verifying → verified(첫 확인) · suspended(ownership_lost · dkim_failed) → verified(자동 복귀)에서 적는다(`src/domains/lifecycle.ts`).
-- 사건 키는 `verified:<에폭초>` · `recovered:<에폭초>` — 확인 회차마다 한 번(복귀하면 다시 보내고, 같은 결정의 재시도는 UNIQUE 가 막는다).
--
--   ① `domain_notices_kind_check` 교체(`NOT VALID` — 검증 1001). 계약 `DOMAIN_NOTICE_KINDS`(src/domains/contract.ts)와 같은 목록 —
--      `test/unit/domains/contract.test.ts` 가 대조한다. 집기 함수 `atmark_claim_domain_notice` 는 종류를 보지 않는다(바꿀 것 없음). 권한 변화 없음.
-- 잠금: DROP/ADD CONSTRAINT NOT VALID — 짧다. 5초 안에 못 잡으면 실패한다.
-- 순서: 옛 코드는 `verified` 를 적지 않는다(expand-only) — 터널 migrate → deploy-compute migrate=false.

SET LOCAL lock_timeout = '5s';

ALTER TABLE domain_notices DROP CONSTRAINT domain_notices_kind_check;
ALTER TABLE domain_notices ADD CONSTRAINT domain_notices_kind_check CHECK (kind IN ('suspended', 'removal_d3', 'removed', 'expiry_warning', 'verified')) NOT VALID;
