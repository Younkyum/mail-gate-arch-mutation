-- 202610081003_quarantine_notice_risk.sql
-- 위험 등급 알림(ADR-0016 2026-10-08) — 격리 알림 기계를 그대로 쓴다: 에이전트 · **종류**마다 열린 창 하나 · 첫 메일 2분 뒤 · 같은 종류의 직전 집기 15분 뒤 ·
-- 조직 하루 상한(알림기 — 종류 합산) · DMARC 인증된 도메인만 본문에(알림기) · 제목 · 본문 · 주소 없음.
--
--   ① 옛 열린 창 색인 `quarantine_notices_open_key (agent_id)` 를 지운다 — 1002 의 `(agent_id, kind)` 가 대신한다.
--   ② 기록 함수 `quarantine_notice_record()` 를 바꾼다 — 차단 등급(사유 injection_risk · scanner_error)은 **항상** `block` 창에. 위험 등급(`watch_level =
--      'risk'` — 보류 risk_hold 든 전달이든)은 그 에이전트의 `agent_watch_settings.risk_notify`(행이 없으면 켬)가 참일 때만 `risk` 창에(항목 사유
--      risk_hold | risk_delivered). 정책 차단 · 신뢰 발신자 우회(등급 none)는 창을 만들지 않는다. 실패는 여전히 삼킨다(메일 기록이 먼저다).
--   ③ 트리거 조건에 위험 등급을 더한다(같은 이름).
--
-- 잠금: `quarantine_notices` 색인 DROP(짧은 ACCESS EXCLUSIVE — 작은 표) · `inbound_messages` 트리거 교체(짧은 SHARE ROW EXCLUSIVE). 5초.

SET LOCAL lock_timeout = '5s';

DROP INDEX quarantine_notices_open_key;

CREATE OR REPLACE FUNCTION quarantine_notice_record() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  org uuid;
  notice uuid;
  dom text;
  previous timestamptz;
  notice_kind text;
  item_reason text;
BEGIN
  IF NEW.quarantine_reason IN ('injection_risk', 'scanner_error') THEN
    notice_kind := 'block';
    item_reason := NEW.quarantine_reason;
  ELSIF NEW.watch_level = 'risk' THEN
    notice_kind := 'risk';
    item_reason := CASE WHEN NEW.quarantine_reason = 'risk_hold' THEN 'risk_hold' ELSE 'risk_delivered' END;
  ELSE
    RETURN NULL;
  END IF;
  BEGIN
    IF notice_kind = 'risk'
       AND NOT coalesce((SELECT s.risk_notify FROM public.agent_watch_settings s WHERE s.agent_id = NEW.agent_id), true) THEN
      RETURN NULL;
    END IF;
    SELECT a.organization_id INTO org FROM public.agents a WHERE a.id = NEW.agent_id;
    -- 기다리지 않는다(보안 리뷰 L2) — 같은 에이전트의 다른 수신 트랜잭션이 쥐고 있으면 이 메일은 세지 않는다(알림기 대조가 드러낸다).
    IF NOT pg_catalog.pg_try_advisory_xact_lock(pg_catalog.hashtextextended('quarantine_notice:' || NEW.agent_id::text, 0)) THEN
      RAISE WARNING 'quarantine_notice_record: 에이전트 잠금을 못 잡아 계수를 건너뛴다';
      RETURN NULL;
    END IF;
    dom := pg_catalog.lower(NEW.from_domain);
    IF dom IS NULL OR pg_catalog.length(dom) > 253
       OR dom !~ '^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+([a-z]{2,63}|xn--[a-z0-9-]{1,59})$' THEN
      dom := NULL;
    END IF;
    SELECT n.id INTO notice
      FROM public.quarantine_notices n
     WHERE n.agent_id = NEW.agent_id AND n.kind = notice_kind AND n.status = 'pending' AND n.claimed_at IS NULL
     FOR UPDATE;
    IF notice IS NULL THEN
      SELECT max(n.claimed_at) INTO previous
        FROM public.quarantine_notices n WHERE n.agent_id = NEW.agent_id AND n.kind = notice_kind AND n.claimed_at IS NOT NULL;
      INSERT INTO public.quarantine_notices (agent_id, organization_id, kind, next_attempt_at)
      VALUES (NEW.agent_id, org, notice_kind,
              GREATEST(pg_catalog.now() + interval '2 minutes', coalesce(previous + interval '15 minutes', '-infinity'::timestamptz)))
      RETURNING id INTO notice;
    END IF;
    INSERT INTO public.quarantine_notice_items (inbound_message_id, notice_id, sender_domain, sender_authenticated, reason)
    VALUES (NEW.id, notice, dom, coalesce(NEW.from_authenticated, false), item_reason);
    UPDATE public.quarantine_notices
       SET message_count = message_count + 1, last_at = GREATEST(last_at, pg_catalog.now())
     WHERE id = notice;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'quarantine_notice_record: 알림 계수를 건너뛴다(sqlstate=%)', SQLSTATE;
  END;
  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION quarantine_notice_record() FROM PUBLIC;

DROP TRIGGER inbound_messages_quarantine_notice ON inbound_messages;
CREATE TRIGGER inbound_messages_quarantine_notice AFTER INSERT ON inbound_messages
  FOR EACH ROW WHEN (NEW.quarantine_reason IN ('injection_risk', 'scanner_error') OR NEW.watch_level = 'risk')
  EXECUTE FUNCTION quarantine_notice_record();
