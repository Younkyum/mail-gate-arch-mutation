-- 202610081210_drafts_integrity_quota.sql
-- 초안 무결성 · 저장 상한(배포 전 보안 리뷰 — 2026-10-08, 묶음 B 표 `drafts`). **번호가 12xx 인 이유:** 표가 `202610081200` 에서 생긴다 — 묶음 D 의 11xx 로는
-- 표보다 앞서 돈다(새 DB 에서 실패). 묶음 B 는 끝났고 12xx 의 다음 빈 번호를 쓴다.
--
--   ① 보내는 중(`send_idempotency_key` 를 잡은) 초안은 버리지 못한다 — 앱 저장소의 WHERE 와 같은 규칙을 DB 가 한 번 더(관문이 평가하는 동안 "버렸다" 와
--      "보냈다" 가 함께 서지 않게).
--   ② 같은 에이전트의 것만 가리킨다 — `sent_message_id`(messages) · `in_reply_to`(inbound_messages) · `attachment_ids`(outbound_attachments, 전부 있어야 한다).
--      FK 는 행이 있는지만 본다 — 다른 에이전트의 메일 · 첨부를 초안에 묶어 보낼 때 남의 것을 끌어오는 길을 닫는다.
--   ③ 에이전트당 **살아 있는 초안 본문 합계 100 MiB**(보내지 않았고 버리지 않은 초안의 `content_bytes`) — 넘으면 P0001 · HINT `draft_storage_limit`
--      (앱 → 429). 줄이는 고치기는 늘 된다. 계수는 초안 상한과 같은 에이전트 잠금 아래.
--
-- 정의자(SECURITY DEFINER) 트리거 함수 — 앱 롤에 messages · 첨부 표 읽기 권한을 넓히지 않는다. 잠금: `drafts` 트리거 추가(짧은 SHARE ROW EXCLUSIVE). 5초.

SET LOCAL lock_timeout = '5s';

CREATE FUNCTION drafts_integrity() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  live bigint;
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.send_idempotency_key IS NOT NULL AND OLD.discarded_at IS NULL AND NEW.discarded_at IS NOT NULL THEN
    RAISE EXCEPTION 'a draft being sent cannot be discarded' USING ERRCODE = '23514';
  END IF;
  IF NEW.sent_message_id IS NOT NULL AND (TG_OP = 'INSERT' OR NEW.sent_message_id IS DISTINCT FROM OLD.sent_message_id)
     AND NOT EXISTS (SELECT 1 FROM public.messages m WHERE m.id = NEW.sent_message_id AND m.agent_id = NEW.agent_id) THEN
    RAISE EXCEPTION 'drafts.sent_message_id must be a message of the same agent' USING ERRCODE = '23514';
  END IF;
  IF NEW.in_reply_to IS NOT NULL AND (TG_OP = 'INSERT' OR NEW.in_reply_to IS DISTINCT FROM OLD.in_reply_to)
     AND NOT EXISTS (SELECT 1 FROM public.inbound_messages m WHERE m.id = NEW.in_reply_to AND m.agent_id = NEW.agent_id) THEN
    RAISE EXCEPTION 'drafts.in_reply_to must be a received email of the same agent' USING ERRCODE = '23514';
  END IF;
  IF cardinality(NEW.attachment_ids) > 0 AND (TG_OP = 'INSERT' OR NEW.attachment_ids IS DISTINCT FROM OLD.attachment_ids)
     AND (SELECT count(DISTINCT a.id) FROM public.outbound_attachments a WHERE a.id = ANY (NEW.attachment_ids) AND a.agent_id = NEW.agent_id)
         <> cardinality(NEW.attachment_ids) THEN
    RAISE EXCEPTION 'drafts.attachment_ids must be attachments of the same agent' USING ERRCODE = '23514';
  END IF;
  IF NEW.discarded_at IS NULL AND NEW.sent_message_id IS NULL
     AND (TG_OP = 'INSERT' OR NEW.content_bytes > OLD.content_bytes) THEN
    PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('drafts:' || NEW.agent_id, 0));
    SELECT coalesce(sum(d.content_bytes), 0) INTO live FROM public.drafts d
     WHERE d.agent_id = NEW.agent_id AND d.id <> NEW.id AND d.discarded_at IS NULL AND d.sent_message_id IS NULL;
    IF live + NEW.content_bytes > 104857600 THEN
      RAISE EXCEPTION 'draft storage limit reached for agent' USING ERRCODE = 'P0001', HINT = 'draft_storage_limit';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION drafts_integrity() FROM PUBLIC;

CREATE TRIGGER drafts_integrity BEFORE INSERT OR UPDATE ON drafts
  FOR EACH ROW EXECUTE FUNCTION drafts_integrity();
