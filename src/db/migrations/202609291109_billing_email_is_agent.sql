-- 202609291109_billing_email_is_agent.sql
-- 고객 도메인(ADR-0014 결정 8 · 계획 §3.15) — Paddle 청구 이메일이 에이전트 주소인지의 **표시 칸** 하나. 판정 함수(`atmark_is_agent_mail_identity`)는
-- 202609291110 이 만든다. 이 파일을 따로 둔 이유(재리뷰 M2a): `ADD COLUMN` 은 organizations 에 ACCESS EXCLUSIVE 를 잡는다 — 기본값이 상수라 표를
-- 다시 쓰지 않아 몇 ms 뿐이지만, 같은 트랜잭션에 백필·트리거가 붙으면 그 잠금을 파일 끝까지 쥔다. 로그인·가입·발송이 모두 organizations 를 읽는다.
--
-- 잠금: organizations ACCESS EXCLUSIVE(칸 하나 · GRANT). 5초 안에 못 잡으면 실패하고 아무것도 바뀌지 않는다.

SET LOCAL lock_timeout = '5s';

ALTER TABLE organizations ADD COLUMN billing_email_is_agent boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN organizations.billing_email_is_agent IS
  'Paddle 고객 이메일이 에이전트 주소다(billing-sync 가 atmark_is_agent_mail_identity 로 판정 — 이메일 평문은 저장하지 않는다). 켜지면 포털 세션 409(ADR-0014).';

GRANT UPDATE (billing_email_is_agent) ON organizations TO atmark_billing;
