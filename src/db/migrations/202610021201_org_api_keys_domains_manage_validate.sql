-- 202610021201_org_api_keys_domains_manage_validate.sql
-- 202610021200 이 NOT VALID 로 세운 권한 CHECK 를 검증한다(기존 행은 부분 집합이라 통과한다). SHARE UPDATE EXCLUSIVE — 읽기·쓰기를 막지 않는다.

SET LOCAL lock_timeout = '5s';

ALTER TABLE org_api_keys VALIDATE CONSTRAINT org_api_keys_capabilities_check;
