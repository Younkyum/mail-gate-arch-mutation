-- 202610021200_org_api_keys_domains_manage.sql
-- 조직 API 키 권한 하나 더(ADR-0014 단계 4 M3b): `domains:manage` — `/org-api/v1/domains*`(목록 · 추가 · 한 개 · 지금 확인 · 제거).
-- CHECK 를 상위 집합으로 바꾼다(권한 셋 · 1~3개). 기존 행은 모두 새 CHECK 를 통과하지만(부분 집합) **NOT VALID** 로 세우고 다음 파일
-- (202610021201)에서 VALIDATE 한다 — 이 파일은 표를 훑지 않는다(ACCESS EXCLUSIVE 를 잠깐만).
--
-- **운영 무변화.** 콘솔·조직 키 발급이 `domains:manage` 를 받을 수 있게 될 뿐이고, 그 키로 부르는 라우트는 기능 허용 목록(`org_features`)이 빈 동안
-- 쓰기를 전부 403 `feature_not_enabled` 로 거부한다.
-- 잠금: org_api_keys ACCESS EXCLUSIVE(제약 교체 — 훑기 없음). 5초 안에 못 잡으면 실패하고 아무것도 바뀌지 않는다.

SET LOCAL lock_timeout = '5s';

ALTER TABLE org_api_keys DROP CONSTRAINT org_api_keys_capabilities_check;
ALTER TABLE org_api_keys ADD CONSTRAINT org_api_keys_capabilities_check CHECK (
  cardinality(capabilities) BETWEEN 1 AND 3
  AND array_position(capabilities, NULL) IS NULL
  AND capabilities <@ ARRAY['agents:read', 'agents:create', 'domains:manage']::text[]
) NOT VALID;
