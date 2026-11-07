-- 202610021111_tlog_primary_leaf_validate.sql
-- 202610021110 이 `NOT VALID` 로 다시 세운 CHECK 셋의 기존 행 검증(ADR-0014 2026-10 개정). 모두 옛 목록의 상위 집합이거나(종류 · 원천) 새 종류·원천에만
-- 걸리는 조건(신원 원천)이라 기존 잎·outbox 행은 통과한다. VALIDATE 는 SHARE UPDATE EXCLUSIVE — 서열기의 INSERT 를 막지 않는다.
--
-- 잠금: SHARE UPDATE EXCLUSIVE 셋. 5초 안에 못 잡으면 실패한다.

SET LOCAL lock_timeout = '5s';

-- 서열기와 같은 순서(outbox → 잎).
ALTER TABLE tlog_outbox VALIDATE CONSTRAINT tlog_outbox_source_table_check;
ALTER TABLE tlog_leaves VALIDATE CONSTRAINT tlog_leaves_kind_check;
ALTER TABLE tlog_leaves VALIDATE CONSTRAINT tlog_leaves_identity_source;
