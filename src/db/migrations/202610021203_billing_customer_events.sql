-- 202610021203_billing_customer_events.sql
-- 결제 이벤트 종류 둘 더(ADR-0014 결정 8 · 계획 §3.15): `customer.created` · `customer.updated` — Paddle 고객 이메일이 바뀌면 sync 가 그 고객에
-- 결속된 조직의 `organizations.billing_email_is_agent`(202609291109)를 다시 판정한다(`atmark_is_agent_mail_identity` — 이메일 평문은 저장하지 않는다).
-- CHECK 를 상위 집합으로 바꾼다 — NOT VALID 로 세우고 202610021204 에서 검증한다(기존 행은 모두 통과).
-- **운영 무변화.** Paddle 알림 목적지에 두 종류를 구독하기 전에는 이 종류의 이벤트가 오지 않는다(진윤겸 할 일 — PR 본문).
-- 잠금: billing_events ACCESS EXCLUSIVE(제약 교체 — 훑기 없음). 5초 안에 못 잡으면 실패하고 아무것도 바뀌지 않는다.

SET LOCAL lock_timeout = '5s';

ALTER TABLE billing_events DROP CONSTRAINT billing_events_event_type_check;
ALTER TABLE billing_events ADD CONSTRAINT billing_events_event_type_check CHECK (event_type IN (
  'subscription.created', 'subscription.activated', 'subscription.updated', 'subscription.trialing', 'subscription.past_due',
  'subscription.paused', 'subscription.resumed', 'subscription.canceled',
  'transaction.completed', 'transaction.payment_failed', 'transaction.past_due',
  'customer.created', 'customer.updated')) NOT VALID;
