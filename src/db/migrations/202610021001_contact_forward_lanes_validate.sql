-- 202610021001_contact_forward_lanes_validate.sql
-- 202610021000 이 `NOT VALID` 로 더한 `contact_forwards_lane_check` 의 기존 행 검증. `VALIDATE CONSTRAINT` 는 SHARE UPDATE EXCLUSIVE 라 수신 소비자의
-- INSERT · 전달 워커의 UPDATE 를 막지 않는다. 기존 행은 기본값 `'support'` 라 통과한다. 실패하면 이 트랜잭션만 되돌아가고 제약은 NOT VALID 로 남는다
-- (새 행·UPDATE 에는 여전히 선다 — migrate status 의 `unvalidatedGuards` 가 이름으로 알린다).

SET LOCAL lock_timeout = '5s';

ALTER TABLE contact_forwards VALIDATE CONSTRAINT contact_forwards_lane_check;
