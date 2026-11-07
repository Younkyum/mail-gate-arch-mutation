-- 202610101100_login_lockout.sql
-- 콘솔 로그인 잠금 DoS 수정(2026-10-10 — 런북 deploy §48 · `src/security/login-limits.ts`). **스키마 · 권한 변화 없음** — 원장의 뜻이 바뀌어
-- 설명(COMMENT)만 고친다.
--
--   문제: 링크 로그인을 없앤 뒤(202610101000 과 같은 변경) 계정당 하루 틀린 코드 예산(20 — 모든 IP 의 실패를 합쳐 셌다)이 유일한 길을 막았다.
--         공격자가 피해자 주소로 코드를 요청해 자기 브라우저에서 틀린 코드를 넣으면 피해자가 24시간 로그인하지 못했다.
--   고침(admin 코드): 계정 예산을 없앴다. 실패는 코드(5회 — `code_failures`, 그대로)와 IP 에만 묶는다 — `login_code_attempts` 는 이제
--         **틀린 코드만** 한 행씩 적고(맞는 코드는 세지 않는다), IP 키(`client_key`)당 지난 1시간 30행이면 그 IP 의 코드 verify 는 429.
--         주소에는 발급만 묶는다(`owner_login_links` 계수 — 신뢰 밖 IP 는 신뢰 밖 코드만 세어 15분 2통 · 하루 4통, 신뢰 IP(30일 안 성공)는 15분 5통 · 하루 50통, (주소, IP) 시간당 3통).
--   `pair_key` 칸 · 그 CHECK · admin 의 INSERT(pair_key) 는 남긴다 — 앞 커밋의 admin 으로 되돌릴 때 그 코드가 쓴다(expand-only). 새 코드는 NULL.
--
-- 잠금: COMMENT 는 SHARE UPDATE EXCLUSIVE(쓰기를 막지 않는다). 5초 안에 못 잡으면 실패하고 아무것도 바뀌지 않는다.
-- 롤백 호환: 설명만 바뀐다.

SET LOCAL lock_timeout = '5s';

COMMENT ON TABLE login_code_attempts IS
  '로그인·가입 코드의 틀린 코드 원장(2026-10-10~) — 한 행 = 틀린 코드 하나. 요청자 키(HMAC(로그인 키, ip:소스 IP 버킷))와 시각뿐. IP 당 시간당 30회 상한의 분자(주소와 무관 — 계정 단위 잠금 없음). admin 은 SELECT·INSERT(client_key), 하루 넘은 행은 purge_login_code_attempts() 만 지운다. 앱 롤 권한 0.';

COMMENT ON COLUMN login_code_attempts.pair_key IS
  '(요청자, 브라우저) 쌍 키 — 202609290700~202610101100 사이 admin 이 적던 값. 새 코드는 쓰지 않는다(NULL). 앞 커밋으로 되돌릴 때를 위해 칸 · CHECK · INSERT 권한을 남긴다.';
