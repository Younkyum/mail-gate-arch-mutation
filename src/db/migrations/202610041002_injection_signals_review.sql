-- 202610041002_injection_signals_review.sql
-- ADR-0016 M1·M2 보안 리뷰(PR #17) 반영. 칸 셋 · 제약 셋 교체 · 권한 하나.
--
--   ① H1 — `scheduled_sends.risk_tainted` · `risk_dlp`: 예약을 **만들 때** 위험 신호(오염 맥락 · 발신 DLP 계열)를 행에 고정한다. 발송 때는 그 값과
--      그때의 판정 중 엄한 쪽을 쓴다 — 오염 창(4h)·코드 지문(24h) 밖으로 예약을 미뤄 우회하지 못하게. 불변(`scheduled_sends_immutable_core` 의
--      허용 목록 밖 — 새 칸은 바꿀 수 없다). 옛 행은 false · '{}'(그 행은 이 파일 전에 만든 예약 — 발송 때 판정만 본다).
--      `risk_dlp` CHECK 는 `NOT VALID`(검증 1003).
--   ② M3 — 노출 · 복사 지문의 `sender` 길이 상한(320)을 뺀다. `inbound_messages.from_address` 에는 길이 상한이 없어, 긴 From 의 메일이 지문
--      INSERT 에서 23514 → 수신 소비자 `unstorable` 로 통째로 사라졌고 노출 기록이 503 이었다. 모양(소문자 · 주소)만 같은 규칙으로. `NOT VALID`.
--   ③ M4 — `agent_exposures.reply_to`: 노출된 메일의 Reply-To 주소(공격자가 고르는 값)도 발신자 7일 창에 넣는다. 최대 16 · 소문자. 앱 롤
--      UPDATE(reply_to) — 다시 읽으면 합집합으로 민다. 제약 `NOT VALID`.
--   ④ M1 — 목록(`list_inbox` · `GET /v1/messages/inbound`)도 발신자·제목 노출로 기록한다: `agent_exposures.surface` 에 `message_list`. `NOT VALID`.
-- 잠금: ADD COLUMN(상수 기본값 — 표를 다시 쓰지 않는다) · DROP/ADD CONSTRAINT NOT VALID — 짧은 ACCESS EXCLUSIVE. 5초 안에 못 잡으면 실패한다.
-- 순서: 1000·1001 과 같다(터널 migrate → deploy-compute migrate=false). 옛 코드는 새 칸을 모른다(기본값으로 들어간다 — expand-only).

SET LOCAL lock_timeout = '5s';

ALTER TABLE scheduled_sends ADD COLUMN risk_tainted boolean NOT NULL DEFAULT false;
ALTER TABLE scheduled_sends ADD COLUMN risk_dlp text[] NOT NULL DEFAULT '{}';
ALTER TABLE scheduled_sends ADD CONSTRAINT scheduled_sends_risk_dlp_check CHECK (
  risk_dlp <@ ARRAY['atmark_credential', 'third_party_secret', 'verification_code', 'inbound_copy', 'scan_limit']::text[]
) NOT VALID;
COMMENT ON COLUMN scheduled_sends.risk_tainted IS '예약을 만들 때 오염 맥락이었다(ADR-0016 H1) — 발송 때 위험 보류가 유지된다. 불변.';
COMMENT ON COLUMN scheduled_sends.risk_dlp IS '예약을 만들 때의 발신 DLP 계열(닫힌 다섯 값, 값 없음). 발송 때 그때의 계열과 합친다. 불변.';

ALTER TABLE agent_exposures DROP CONSTRAINT agent_exposures_sender_check;
ALTER TABLE agent_exposures ADD CONSTRAINT agent_exposures_sender_check
  CHECK (sender = lower(sender) AND sender ~ '^[^@[:space:]]+@[^@[:space:]]+$') NOT VALID;
ALTER TABLE inbound_fingerprints DROP CONSTRAINT inbound_fingerprints_sender_check;
ALTER TABLE inbound_fingerprints ADD CONSTRAINT inbound_fingerprints_sender_check
  CHECK (sender = lower(sender) AND sender ~ '^[^@[:space:]]+@[^@[:space:]]+$') NOT VALID;

ALTER TABLE agent_exposures ADD COLUMN reply_to text[] NOT NULL DEFAULT '{}';
ALTER TABLE agent_exposures ADD CONSTRAINT agent_exposures_reply_to_check
  CHECK (cardinality(reply_to) <= 16 AND array_to_string(reply_to, ' ') !~ '[[:upper:][:cntrl:]]') NOT VALID;
COMMENT ON COLUMN agent_exposures.reply_to IS '노출된 메일의 Reply-To 주소(소문자, 최대 16) — 발신자 7일 창에 함께 든다(ADR-0016 리뷰 M4).';

GRANT UPDATE (reply_to) ON agent_exposures TO atmark_app;

ALTER TABLE agent_exposures DROP CONSTRAINT agent_exposures_surface_check;
ALTER TABLE agent_exposures ADD CONSTRAINT agent_exposures_surface_check
  CHECK (surface IN ('message_detail', 'message_list', 'thread', 'attachment_content', 'attachment_url', 'verification_code')) NOT VALID;
