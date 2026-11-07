-- 202610131611_owner_actions_operator_actor_validate.sql
-- 202610131610 이 NOT VALID 로 더한 CHECK 둘을 검증한다(SHARE UPDATE EXCLUSIVE — 쓰기를 막지 않는다). 기존 행은 운영자 칸이 비어 있고
-- 세션 · 키 중 하나뿐이라(옛 `owner_actions_one_actor`) 곧바로 통과한다.

SET LOCAL lock_timeout = '5s';

ALTER TABLE owner_actions VALIDATE CONSTRAINT owner_actions_operator_shape;
ALTER TABLE owner_actions VALIDATE CONSTRAINT owner_actions_one_actor;
