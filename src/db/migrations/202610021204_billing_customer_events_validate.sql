-- 202610021204_billing_customer_events_validate.sql
-- 202610021203 이 NOT VALID 로 세운 이벤트 종류 CHECK 를 검증한다(기존 행은 부분 집합). SHARE UPDATE EXCLUSIVE — 읽기·쓰기를 막지 않는다.

SET LOCAL lock_timeout = '5s';

ALTER TABLE billing_events VALIDATE CONSTRAINT billing_events_event_type_check;
