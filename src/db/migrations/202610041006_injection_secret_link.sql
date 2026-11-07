-- 202610041006_injection_secret_link.sql
-- ADR-0016 재검증(PR #17) — 진윤겸 결정: 받은 메일의 **비밀 링크**(재설정·공유·추적 링크 — 구분하지 않는다)가 든 발송은 승인 대기를 유지하되, 사유를
-- 인증 코드와 나눈다. DLP 계열에 `secret_link`, 위험 보류 사유에 `dlp_secret_link`.
--
--   ① `messages.outbound_dlp` · `scheduled_sends.risk_dlp` CHECK 에 `secret_link` 를 더한다(교체, `NOT VALID` — 검증 1007).
--   ② `approval_requests_risk_hold_once()` 의 위험 보류 사유 집합에 `dlp_secret_link` 를 더한다(`src/policy/types.ts` `RiskHoldReason` 과 같은 집합 —
--      통합 테스트가 대조한다). 빠지면 비밀 링크 보류를 `recipient` 범위로 승인해 상시 관계가 생긴다.
-- 잠금: DROP/ADD CONSTRAINT NOT VALID · CREATE OR REPLACE FUNCTION — 짧다. 5초 안에 못 잡으면 실패한다.
-- 순서: 1000~1005 와 같다(터널 migrate → deploy-compute migrate=false). 옛 코드는 `secret_link` 를 쓰지 않는다(expand-only).

SET LOCAL lock_timeout = '5s';

ALTER TABLE messages DROP CONSTRAINT messages_outbound_dlp_check;
ALTER TABLE messages ADD CONSTRAINT messages_outbound_dlp_check CHECK (
  outbound_dlp IS NULL
  OR outbound_dlp <@ ARRAY['atmark_credential', 'third_party_secret', 'verification_code', 'secret_link', 'inbound_copy', 'scan_limit']::text[]
) NOT VALID;

ALTER TABLE scheduled_sends DROP CONSTRAINT scheduled_sends_risk_dlp_check;
ALTER TABLE scheduled_sends ADD CONSTRAINT scheduled_sends_risk_dlp_check CHECK (
  risk_dlp <@ ARRAY['atmark_credential', 'third_party_secret', 'verification_code', 'secret_link', 'inbound_copy', 'scan_limit']::text[]
) NOT VALID;

-- 위험 보류 사유 — `src/policy/types.ts` `RiskHoldReason`(통합 테스트가 같은 집합인지 대조한다).
CREATE OR REPLACE FUNCTION approval_requests_risk_hold_once() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF OLD.status = 'pending' AND NEW.status = 'approved' AND NEW.granted_scope IS DISTINCT FROM 'once' AND EXISTS (
       SELECT 1
         FROM public.approval_request_items i
         JOIN public.audit_logs a ON a.id = i.audit_id
        WHERE i.approval_id = NEW.id
          AND a.reasons && ARRAY['tainted_context', 'dlp_atmark_credential', 'dlp_third_party_secret', 'dlp_verification_code',
                                 'dlp_secret_link', 'dlp_inbound_copy', 'dlp_scan_limit']::text[]) THEN
    RAISE EXCEPTION 'approval % is a risk hold — it can only be approved once (granted_scope once)', NEW.id USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION approval_requests_risk_hold_once() FROM PUBLIC;
