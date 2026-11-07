-- 202609270131_outbound_attachments_hardening.sql
-- 메일 기본기 2차 A2 — 2차 보안 리뷰 반영(M1 · M2 · L7). 202609270130 은 고치지 않고 위에 얹는다.
--
--   ① M1 파일명 ↔ 선언 MIME 확장자(pdf → .pdf · png → .png · jpeg → .jpg|.jpeg · text/plain → .txt) · RFC 2047 encoded-word(`=?…?B|Q?`) 금지.
--      받는 쪽 클라이언트는 파일명 확장자로 여는 앱을 고른다 — 선언 MIME·매직 검사를 지난 바이트가 다른 앱으로 열리지 못하게 DB 도 막는다
--      (앱 `normalizeAttachmentFilename` 이 먼저 — 확장자가 없으면 붙이고, 다르면 400). `NOT VALID`, 검증은 202609270132.
--   ② M2 영구본은 **첨부 id 단위**(`outbound/attachments/{attachmentId}` — 한 번 복사, 여러 메일이 참조). 결속 행의 영구 키 CHECK 를 그 모양으로
--      바꾼다 — 0130 모양(`{messageId}/{position}`)은 배포 전 개발 DB 에만 있는 행이라 함께 받는다(`NOT VALID` → 0132 검증).
--      그리고 **첨부 하나의 결속 ≤ 50**(트리거 — 관문 전 복사 · 결속으로 저장소를 불리지 못한다, 앱 409 `attachment_link_limit` 이 먼저).
--   ③ L7 조직 하루(24시간) 업로드 바이트 ≤ 1 GiB — 하루 천장 트리거를 다시 만든다(조직 잠금 → 에이전트 잠금, 앱과 같은 순서·키).
-- 잠금: 새 표 둘(작다 — 배포 전)에 CHECK NOT VALID · 트리거. 5초 lock_timeout.

SET LOCAL lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- ① 파일명 ↔ MIME · encoded-word 금지
-- ---------------------------------------------------------------------------

ALTER TABLE outbound_attachments
  ADD CONSTRAINT outbound_attachments_filename_extension_check CHECK (
    filename !~* '=\?[^?]*\?[bq]\?'
    AND CASE mime_type
          WHEN 'application/pdf' THEN lower(filename) ~ '.\.pdf$'
          WHEN 'image/png' THEN lower(filename) ~ '.\.png$'
          WHEN 'image/jpeg' THEN lower(filename) ~ '.\.jpe?g$'
          WHEN 'text/plain' THEN lower(filename) ~ '.\.txt$'
          ELSE false
        END) NOT VALID;

-- ---------------------------------------------------------------------------
-- ② 영구 키 = 첨부 id 단위 · 첨부 하나의 결속 ≤ 50
-- ---------------------------------------------------------------------------

ALTER TABLE message_attachments DROP CONSTRAINT message_attachments_permanent_key_check;
ALTER TABLE message_attachments
  ADD CONSTRAINT message_attachments_permanent_key_check CHECK (
    permanent_key = 'outbound/attachments/' || attachment_id::text
    OR permanent_key = 'outbound/attachments/' || message_id::text || '/' || position::text) NOT VALID;

CREATE FUNCTION message_attachments_link_ceiling() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  links integer;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('message_attachments_links:' || NEW.attachment_id::text, 0));
  SELECT count(*) INTO links FROM public.message_attachments l WHERE l.attachment_id = NEW.attachment_id;
  IF links >= 50 THEN
    RAISE EXCEPTION 'message_attachments: attachment % already linked to % messages (max 50)', NEW.attachment_id, links USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER message_attachments_link_ceiling BEFORE INSERT ON message_attachments
  FOR EACH ROW EXECUTE FUNCTION message_attachments_link_ceiling();

-- ---------------------------------------------------------------------------
-- ③ 하루 천장 — 에이전트 100개·200 MiB(0130 그대로) + 조직 1 GiB(L7)
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION outbound_attachments_daily_ceiling() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  org uuid;
  uploads integer;
  total bigint;
  org_total bigint;
BEGIN
  SELECT a.organization_id INTO org FROM public.agents a WHERE a.id = NEW.agent_id;
  IF org IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('outbound_attachments_org:' || org::text, 0));
    SELECT coalesce(sum(o.bytes), 0) INTO org_total
      FROM public.outbound_attachments o JOIN public.agents a ON a.id = o.agent_id
     WHERE a.organization_id = org AND o.created_at > now() - interval '24 hours';
    IF org_total + NEW.bytes > 1073741824 THEN
      RAISE EXCEPTION 'outbound_attachments: organization % would exceed 1 GiB of uploads in 24 hours', org USING ERRCODE = '23514';
    END IF;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('outbound_attachments:' || NEW.agent_id, 0));
  SELECT count(*), coalesce(sum(a.bytes), 0) INTO uploads, total
    FROM public.outbound_attachments a
   WHERE a.agent_id = NEW.agent_id AND a.created_at > now() - interval '24 hours';
  IF uploads >= 100 THEN
    RAISE EXCEPTION 'outbound_attachments: agent % already uploaded % attachments in 24 hours (max 100)', NEW.agent_id, uploads
      USING ERRCODE = '23514';
  END IF;
  IF total + NEW.bytes > 209715200 THEN
    RAISE EXCEPTION 'outbound_attachments: agent % would exceed 200 MiB of uploads in 24 hours', NEW.agent_id
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
