-- 202609290600_example_reserved_local_parts.sql
-- 예시 예약 로컬파트(2026-09-28) — 홈 히어로·OG·문서 스크린샷·문서 본문의 예시 에이전트 주소를 아무도 발급받을 수 없게 한다.
--
-- `atmark_reserved_local_parts()` 는 `src/identity/address.ts` `RESERVED_LOCAL_PARTS` 와 **같은 순서·같은 값**(통합 테스트가 대조).
-- 앞 54개는 0900 그대로, 뒤 5개가 새 이름이다(TS 의 `EXAMPLE_RESERVED_LOCAL_PARTS` — `help-desk` 는 이미 앞에 있어 한 번만).
-- 기존 행이 새 목록에 걸리면 CHECK 를 `NOT VALID` 로 되돌린다(0750·0900 과 같은 규칙 — "검증됨" 표시가 거짓이 되지 않게).
-- 운영 DB 에는 이 이름들의 주소가 없음을 확인했다(2026-09-28).
CREATE OR REPLACE FUNCTION atmark_reserved_local_parts() RETURNS text[]
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT ARRAY[
    'postmaster', 'abuse', 'hostmaster', 'webmaster', 'noc', 'security',
    'dmarc', 'noreply', 'no-reply', 'bounce', 'mailer-daemon', 'notify',
    'blocked-test',
    'admin', 'support', 'billing', 'help', 'info', 'login', 'console', 'atmark', 'team', 'sales', 'hello', 'root',
    'system', 'approve', 'api', 'mail', 'www',
    'administrator', 'ssladmin', 'ssl-admin', 'sslwebmaster',
    'it', 'domains', 'privacy', 'legal', 'contact', 'signup', 'verify', 'trust', 'compliance', 'operator', 'accounts',
    'payments', 'helpdesk', 'help-desk', 'security-team', 'dpo', 'press', 'careers', 'jobs', 'abuse-report',
    'scout', 'invoices', 'recruiting', 'research', 'ops-pager'
  ]::text[]
$$;

-- 0900 과 같은 판정 — 위반 없으면 VALIDATE, 있으면 검증된 제약을 NOT VALID 로 다시 세운다(새 행은 계속 검사된다).
--   migrate `status` 의 `reservedLocalPartCheckValidated` 가 결과를 보고한다.
DO $$
DECLARE
  offenders integer;
  validated boolean;
BEGIN
  SELECT count(*) INTO offenders FROM agent_addresses
   WHERE split_part(address, '@', 1) = ANY (atmark_reserved_local_parts());
  SELECT k.convalidated INTO validated FROM pg_constraint k
   WHERE k.conrelid = 'agent_addresses'::regclass AND k.conname = 'agent_addresses_not_reserved_local_part';
  IF offenders = 0 THEN
    IF validated IS DISTINCT FROM true THEN
      ALTER TABLE agent_addresses VALIDATE CONSTRAINT agent_addresses_not_reserved_local_part;
    END IF;
  ELSE
    IF validated THEN
      ALTER TABLE agent_addresses DROP CONSTRAINT agent_addresses_not_reserved_local_part;
      ALTER TABLE agent_addresses ADD CONSTRAINT agent_addresses_not_reserved_local_part
        CHECK (NOT (split_part(address, '@', 1) = ANY (atmark_reserved_local_parts()))) NOT VALID;
    END IF;
    RAISE WARNING 'agent_addresses 에 예약 로컬파트 주소가 % 개 있다 — CHECK 는 NOT VALID 로 남는다(새 행은 검사된다). docs/runbooks/deploy.md §12 참고', offenders;
  END IF;
END
$$;
