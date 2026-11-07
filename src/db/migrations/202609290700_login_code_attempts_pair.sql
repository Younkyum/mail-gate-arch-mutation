-- 202609290700_login_code_attempts_pair.sql
-- 로그인·가입 코드 보안 재확인(2026-09-28 L-N1) — 코드 verify 시도 원장에 **(요청자, 브라우저) 쌍 키**를 더한다.
--
--   문제: 요청자 상한(15분 30회)이 소스 IP 하나에만 걸려 있어, 한 NAT·회사 출구 IP 뒤의 사람들이 30회를 **나눠 썼다** — 한 사람의 오타나
--         같은 출구의 공격자가 그 IP 의 모든 사람의 코드 입력을 15분 막았다.
--   고침: 두 겹으로 센다(`admin/session.ts` `recordCodeAttempt`).
--     ① 쌍 상한 — `pair_key` = HMAC(로그인 키, 'pair:' ‖ 소스 IP ‖ '\n' ‖ 브라우저 결속)당 15분 30회(`LOGIN_CODE_ATTEMPTS_PER_PAIR`).
--        결속 = 로그인 논스 쿠키(`browserBindingOf`) 또는 가입 논스 쿠키(`signupBindingOf`)의 해시 — 한 사람의 오타는 그 브라우저만 막는다.
--     ② IP 천장 — `client_key`(지금과 같은 키)당 15분 300회(`LOGIN_CODE_ATTEMPTS_PER_CLIENT`). 논스는 클라이언트가 마음대로 새로 만들 수
--        있으므로(쿠키일 뿐) 쌍 상한만으로는 한 IP 의 총량이 묶이지 않는다 — 이 천장이 그 바닥이다.
--     잠금은 언제나 IP 키 → 쌍 키 순서(advisory, 교착 없음). 두 상한 모두 **주소와 무관**하다(열거 신호 없음).
--   한 시도 = 여전히 **한 행**(두 키를 함께 적는다). 계수는 IP 키 색인(`login_code_attempts_client_idx`)으로 창 안 ≤ 300 행을 읽고 그중 쌍
--   키가 같은 것을 함께 센다 — 새 색인이 필요 없다.
--
-- 칸은 NULL 을 받는다: 이 파일이 돈 뒤 새 코드가 배포되기 전까지 옛 admin 은 `client_key` 만 적고(롤백 호환), 그 전의 행도 NULL 이다.
--   그런 행은 IP 천장에만 들어간다(쌍 상한에는 안 들어간다 — 더 느슨한 쪽이라 막히는 사람이 늘지 않는다). 하루 뒤 보존 함수가 다 지운다.
-- 잠금: `login_code_attempts` ACCESS EXCLUSIVE — 칸 더하기는 기본값이 없어 표를 다시 쓰지 않고, CHECK 는 `NOT VALID` 라 훑지 않는다
--   (하루치 작은 표). 5초 안에 못 잡으면 실패하고 아무것도 바뀌지 않는다. 검증은 202609290701.
-- 권한 — admin: INSERT(pair_key) 한 칸 더. SELECT 는 표 단위로 이미 있다. 앱 롤·login-mailer 는 여전히 0(`APP_FORBIDDEN_LOGIN_TABLES`).
--   허용 목록 `RESTRICTED_ROLE_GRANTS`(admin) · 가드 목록 `REQUIRED_GUARDS` 를 같은 변경에서 늘렸다.

SET LOCAL lock_timeout = '5s';

ALTER TABLE login_code_attempts ADD COLUMN pair_key text;
ALTER TABLE login_code_attempts
  ADD CONSTRAINT login_code_attempts_pair_key_shape CHECK (pair_key ~ '^[0-9a-f]{64}$') NOT VALID;

COMMENT ON COLUMN login_code_attempts.pair_key IS
  '(요청자, 브라우저) 쌍 키 — HMAC(로그인 키, pair:소스 IP\n브라우저 결속). 쌍당 15분 30회 상한의 분자(IP 천장 300 은 client_key). 202609290700 이전·롤백 중 옛 코드의 행은 NULL(IP 천장에만 든다).';

COMMENT ON TABLE login_code_attempts IS
  '로그인·가입 코드 verify 시도 원장 — 요청자 키(HMAC(로그인 키, ip:소스 IP)) · 쌍 키(요청자 × 브라우저 결속) · 시각뿐. 쌍당 15분 30회 · IP 당 15분 300회 상한의 분자. admin 은 SELECT·INSERT(client_key, pair_key), 하루 넘은 행은 purge_login_code_attempts() 만 지운다. 앱 롤 권한 0.';

GRANT INSERT (pair_key) ON login_code_attempts TO atmark_admin;
