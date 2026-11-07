-- 202610131612_ses_events_recipients.sql
-- 공유 도메인 조직 평판(202610131620)의 **수신자 단위** 집계(PR #94 적대 검토 M-3 · M-4).
--
-- 무엇이 틀렸나: `ses_events` 한 행 = SES 알림 하나다. 수신자 50명에게 간 메일의 delivery 알림 하나도, 한 사람이 같은 메일을 세 번 신고한 것도
-- 각각 "한 건" 으로 셌다 — 분모(전달 시도)는 작게, 신고는 부풀려 셀 수 있었다. 계정 억제 목록(OnAccountSuppressionList) bounce 는 SES 평판에 들지
-- 않는데 분자에 들었다.
--
--   · `recipient_count` — 그 알림의 수신자 수(delivery = 전달된 수신자 · bounce = 반송된 수신자 · complaint = 신고한 수신자). NOT NULL DEFAULT 1
--     (기존 행은 1 — 칸 기본값이라 표를 다시 쓰지 않는다). 집계는 `sum`.
--   · `bounce_subtype` — SES `bounceSubType`(bounce 만 · 모양만). `OnAccountSuppressionList` 는 분자에서 뺀다.
--   · `complaint_recipient_hashes` · `complaint_domain_hashes` — 신고한 수신자 주소 · 그 도메인의 sha256(hex, 소문자). complaint 만. 평판은 **서로 다른
--     신고자 수**와 **서로 다른 신고 도메인 수**(≥ 2)로 센다 — 한 사람이 여러 번 신고해도 한 명이다. 주소 평문은 저장하지 않는다(수신자 주소는 이미
--     `outbound_recipients` 에 있다 — 새로 드러나는 것은 "누가 신고했나" 의 해시뿐). 기존 complaint 행은 NULL — 신고자 1명 · 도메인 0 으로 읽힌다(도메인
--     조건을 채우지 못해 옛 행만으로는 얼지 않는다 — 보수 쪽).
--     신고자는 정규형(소문자 · `+tag` 절단), 도메인은 **계열**(outlook/hotmail/live/msn · yahoo.* · gmail/googlemail — `complaintDomainFamily`)의 해시다.
--   · **보존(재검증 I-1):** 해시는 평판 창(7일)에만 필요하다 — 정의자 `atmark_purge_complaint_hashes()`(인자 없음 · 한 번에 5 000)가 받은 지 8일 넘은 행의
--     해시 둘을 NULL 로 만든다. TTL 스위퍼(EventBridge 5분 · 앱 롤 EXECUTE 하나 — `purge_injection_signals` 와 같은 규율)가 부른다. 색인은
--     202610131614(비트랜잭션 — 해시가 남은 행만 담는 부분 색인). HMAC 대신 보존을 골랐다: 같은 DB 에 수신자 평문(`outbound_recipients`)이 이미 있어
--     키를 둔 해시가 막는 것이 적고, 8일 뒤에는 신고자 흔적이 남지 않는다.
--   · CHECK 셋 NOT VALID → 202610131613 에서 검증.
--
-- 앱 롤은 표 단위 INSERT · SELECT 라 새 칸도 그대로 쓴다. **배포 순서:** 이 파일이 먼저(새 소비자가 이 칸에 쓴다 — deploy §54).
-- 잠금: ses_events ACCESS EXCLUSIVE 잠깐(칸 넷 — 상수 기본값은 표를 다시 쓰지 않는다 · CHECK NOT VALID). 5초.

SET LOCAL lock_timeout = '5s';

ALTER TABLE ses_events ADD COLUMN recipient_count integer NOT NULL DEFAULT 1;
ALTER TABLE ses_events ADD COLUMN bounce_subtype text;
ALTER TABLE ses_events ADD COLUMN complaint_recipient_hashes text[];
ALTER TABLE ses_events ADD COLUMN complaint_domain_hashes text[];

ALTER TABLE ses_events ADD CONSTRAINT ses_events_recipient_count_range CHECK (recipient_count BETWEEN 1 AND 100) NOT VALID;
ALTER TABLE ses_events ADD CONSTRAINT ses_events_bounce_subtype_shape
  CHECK (bounce_subtype IS NULL OR (event_type = 'bounce' AND bounce_subtype ~ '^[A-Za-z]{1,40}$')) NOT VALID;
ALTER TABLE ses_events ADD CONSTRAINT ses_events_complaint_hashes_shape
  CHECK ((complaint_recipient_hashes IS NULL AND complaint_domain_hashes IS NULL)
         OR (event_type = 'complaint'
             AND cardinality(complaint_recipient_hashes) BETWEEN 1 AND 100
             AND cardinality(complaint_domain_hashes) BETWEEN 1 AND 100
             AND array_to_string(complaint_recipient_hashes, ',') ~ '^[0-9a-f]{64}(,[0-9a-f]{64})*$'
             AND array_to_string(complaint_domain_hashes, ',') ~ '^[0-9a-f]{64}(,[0-9a-f]{64})*$')) NOT VALID;

COMMENT ON COLUMN ses_events.recipient_count IS
  '알림의 수신자 수(delivery·bounce·complaint — 202610131612). 그 밖 종류와 이전 행은 1. 공유 도메인 평판은 sum 으로 센다.';
COMMENT ON COLUMN ses_events.bounce_subtype IS
  'SES bounceSubType(bounce 만 — 202610131612). OnAccountSuppressionList 는 공유 도메인 평판 분자에서 뺀다.';
COMMENT ON COLUMN ses_events.complaint_recipient_hashes IS
  '신고한 수신자 주소의 sha256 hex(complaint 만 — 202610131612). 평판은 서로 다른 신고자 수로 센다. 평문 없음.';
COMMENT ON COLUMN ses_events.complaint_domain_hashes IS
  '신고한 수신자 도메인의 sha256 hex(complaint 만 — 202610131612). 평판의 신고 경로는 서로 다른 도메인 ≥ 2 를 요구한다.';

CREATE FUNCTION atmark_purge_complaint_hashes() RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_n integer;
BEGIN
  WITH old AS (
    SELECT e.id FROM public.ses_events e
     WHERE e.complaint_recipient_hashes IS NOT NULL AND e.received_at < pg_catalog.now() - interval '8 days'
     ORDER BY e.received_at
     LIMIT 5000
  )
  UPDATE public.ses_events e SET complaint_recipient_hashes = NULL, complaint_domain_hashes = NULL
    FROM old WHERE e.id = old.id;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END;
$$;
REVOKE ALL ON FUNCTION atmark_purge_complaint_hashes() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION atmark_purge_complaint_hashes() TO atmark_app;

COMMENT ON FUNCTION atmark_purge_complaint_hashes() IS
  '신고자 해시 보존(202610131612 · 재검증 I-1) — 받은 지 8일 넘은 ses_events 의 신고자 · 도메인 해시를 NULL 로(한 번에 5000). TTL 스위퍼가 부른다.';
