-- 202609222000_approval_link_uses_fk.sql
-- P2 배선 — `approval_link_uses.approval_id` 가 실재하는 승인 요청만 가리키게 한다.
--
-- 202609221900 이 남긴 의도된 미완이다(그 파일 머리말): 두 마이그레이션이 병렬로 쓰이는 동안
-- 상대의 확정을 전제하지 않으려고 FK 를 비워 두었다. 이제 두 테이블이 다 있으므로 잇는다.
--
-- 왜 필요한가: 사용 기록은 "이 approval 의 링크는 이미 쓰였다" 는 **상태**다. 존재하지 않는
--   approval 을 가리키는 행은 아무것도 막지 않으면서 유니크 인덱스의 자리만 차지한다 — 그리고 나중에
--   그 uuid 로 요청이 만들어지면(앱은 uuid 를 스스로 만든다) **쓴 적 없는 링크가 이미 쓰인 것**이 된다.
--
-- 왜 ON DELETE RESTRICT 인가: approval_requests 는 DELETE 가 트리거로 막혀 있다. 그래도 RESTRICT 를
--   적는 이유는 그 트리거가 빠지는 날 사용 기록이 조용히 따라 지워지지(CASCADE) 않게 하기 위해서다 —
--   사용 기록이 지워지면 링크가 다시 쓸 수 있게 된다(202609221900 의 no_delete 트리거와 같은 논리).
--
-- ★ 왜 NOT VALID 인가 — **새 행은 전부 검사되고, 기존 행만 검증을 건너뛴다.**
--   202609221900 과 이 파일 사이에 쓰인 행은 전부 테스트가 무작위 uuid 로 넣은 것이다(FK 가 없던 시기의
--   `approval-link-uses.test.ts`). 운영에는 행이 없다(P2 는 배포 전이다). 그 행들은 지울 수 없다 —
--   `approval_link_uses_no_delete` 트리거가 막고, 그 트리거를 여기서 끄는 것은 단일 사용의 정의를
--   마이그레이션이 한 번 무시하는 선례가 된다. 그래서 검증만 미룬다. 운영 DB 에서는 다음 한 줄이
--   0행 위에서 즉시 끝난다(배포 절차에서 실행):
--     ALTER TABLE approval_link_uses VALIDATE CONSTRAINT approval_link_uses_approval_id_fkey;
ALTER TABLE approval_link_uses
  ADD CONSTRAINT approval_link_uses_approval_id_fkey
  FOREIGN KEY (approval_id) REFERENCES approval_requests (id) ON DELETE RESTRICT
  NOT VALID;

COMMENT ON COLUMN approval_link_uses.approval_id IS
  'approval_requests.id (FK, 202609222000). 새 행은 검사된다 — NOT VALID 는 FK 이전의 테스트 잔여 행만 건너뛴다.';
