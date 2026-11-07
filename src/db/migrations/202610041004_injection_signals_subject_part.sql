-- 202610041004_injection_signals_subject_part.sql
-- ADR-0016 M1·M2 재검증(PR #17, N1 — 리드 결정) 반영. 제약 하나 교체.
--
--   N1 — 목록·스레드 보기(제목·발신자 면)는 상세(`body`)와 **다른 행 키** `part = 'subject'` 로 기록한다. 같은 키였을 때 목록 폴링이 상세 행의
--   `last_at` 을 매번 밀어, 첫 페이지에 미인증 메일 한 통만 있어도 에이전트 4시간 창이 닫히지 않았다(재검증 Q8). 제목 행은 다시 읽어도 `last_at` 을
--   밀지 않는다(창은 처음 본 때 기준 — 앱이 `ON CONFLICT … WHERE` 로 등급이 오를 때만 고친다). `NOT VALID`(검증 1005).
-- 잠금: DROP/ADD CONSTRAINT NOT VALID — 짧은 ACCESS EXCLUSIVE. 5초 안에 못 잡으면 실패한다.
-- 순서: 1000~1003 과 같다(터널 migrate → deploy-compute migrate=false). 옛 코드는 `subject` 를 쓰지 않는다(expand-only).

SET LOCAL lock_timeout = '5s';

ALTER TABLE agent_exposures DROP CONSTRAINT agent_exposures_part_check;
ALTER TABLE agent_exposures ADD CONSTRAINT agent_exposures_part_check
  CHECK (part ~ '^(body|subject|verification_code|attachment:(0|[1-9][0-9]{0,3}))$') NOT VALID;
