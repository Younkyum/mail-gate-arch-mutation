-- 202609241000_outbound_mode_blocklist_only.sql
-- 정책 v2(계약 `.omc/handoffs/v2-contract.md` §1 · ADR-0007) — 발신 모드에 `blocklist_only`(콘솔 "블랙리스트 · Blocklist")를 더한다.
--
-- **이 파일은 이 한 줄뿐이다.** `ALTER TYPE … ADD VALUE` 로 더한 값은 그 트랜잭션이 커밋되기 전에는 쓸 수 없다(Postgres 제약).
-- 러너(`db/migrate.ts`)는 파일 하나를 트랜잭션 하나로 돌리므로, 새 값을 쓰는 나머지(목록 테이블·이전·기본값)는 다음 파일
-- `202609241010_policy_v2.sql` 에 있다.
--
-- 기존 다섯 값은 그대로다. `approval_required`·`reply_only` 는 **레거시**(엔진 분기는 남고 콘솔·API·CLI 로는 새로 고를 수 없다),
-- `unrestricted` 는 콘솔 "전체 · All" 로 열린다(Phase 1 의 400 거부 해제).

ALTER TYPE outbound_mode ADD VALUE IF NOT EXISTS 'blocklist_only';
