-- 202609241030_contact_rules_value_check_fix.sql
-- 202609241010 의 값 모양 CHECK 보정 — **NULL 이 CHECK 를 통과하던 구멍**.
--
-- 무엇이 틀렸나: `CHECK (atmark_contact_rule_kind(value) = kind)`. 모양 밖 값(대문자 `A@example.com`·`@example.com`·점 없는
-- `example`)에 함수가 NULL 을 돌려주면 `NULL = kind` 는 NULL 이고, **CHECK 는 NULL 을 통과로 본다.** 앱 검증(`contact-rules.ts`)이
-- 먼저 거르지만 "DB 가 같은 규칙을 한 번 더" 라는 두 번째 벽이 모양 밖 값 앞에서 비어 있었다(`test/integration/admin/admin-policy-v2.test.ts`
-- "DB 가드" 가 잡았다). 모양 밖 값은 어떤 매칭에도 걸리지 않으므로(차단이면 조용히 안 막는 규칙) 조용한 무효값이다.
--
-- `IS NOT DISTINCT FROM` — 함수가 NULL 이면 거짓(`kind` 는 NOT NULL). 기존 행은 이전(1010)이 모양 검사를 통과한 값만 넣었으므로
-- 검증(VALIDATE)이 그대로 선다.

ALTER TABLE agent_contact_rules
  DROP CONSTRAINT agent_contact_rules_value_kind,
  ADD CONSTRAINT agent_contact_rules_value_kind CHECK (atmark_contact_rule_kind(value) IS NOT DISTINCT FROM kind);
