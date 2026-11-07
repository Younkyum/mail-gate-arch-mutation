-- 202610021104_ses_events_bounce_type.sql
-- `ses_events.bounce_type` — SES bounce 의 종류(Permanent · Transient · 판정 불가)를 남긴다(진윤겸 결정 2026-10 · #13 보안 리뷰 M3).
--
-- 고객 도메인 평판 동결(ADR-0014 결정 14 · `src/domains/reputation.ts`)은 **영구(hard) bounce 만** 센다 — 사서함 가득 같은 일시 bounce 로 도메인이 얼지
-- 않게. 소비자(`ses-event-consumer` → `ses-event-store`)는 이미 `bounceType` 을 파싱한다(웹훅 위치 계산용) — 그 값을 기록에도 적는다.
--
--   · 칸 추가(NULL 허용 · 기본값 없음 — 표를 다시 쓰지 않는다). **기존 행은 NULL** 이고 평판 계산의 분자에 넣지 않는다(보수 쪽 = 동결을 덜 하는 쪽 —
--     이 칸 이전에는 고객 도메인 행이 0 이라 운영 판정에는 영향이 없다). 분모(전달 시도)에는 그대로 든다.
--   · CHECK `ses_events_bounce_type_shape` — bounce 행만 값을 가질 수 있고 값은 닫힌 셋. `NOT VALID` → 202610021105 에서 검증.
--   · 틱 롤에 그 칸 SELECT(평판 집계). 앱 롤은 표 단위 INSERT · SELECT 라 새 칸도 그대로 쓴다.
--
-- **배포 순서:** 마이그레이션이 먼저(새 소비자가 이 칸에 쓴다 — 칸이 없으면 42703 으로 재전달된다). 터널 migrate → `deploy-compute migrate=false`.
-- 잠금: ses_events ACCESS EXCLUSIVE 잠깐(칸 추가 · CHECK NOT VALID — 표를 훑지 않는다) · GRANT. 5초 안에 못 잡으면 실패한다.

SET LOCAL lock_timeout = '5s';

ALTER TABLE ses_events ADD COLUMN bounce_type text;
ALTER TABLE ses_events ADD CONSTRAINT ses_events_bounce_type_shape
  CHECK (bounce_type IS NULL OR (event_type = 'bounce' AND bounce_type IN ('permanent', 'transient', 'undetermined'))) NOT VALID;

COMMENT ON COLUMN ses_events.bounce_type IS
  'SES bounceType(permanent · transient · undetermined) — bounce 만. 202610021104 이전 행은 NULL. 고객 도메인 평판은 permanent 만 센다(#13 M3).';

GRANT SELECT (bounce_type) ON ses_events TO atmark_domain_tick;
