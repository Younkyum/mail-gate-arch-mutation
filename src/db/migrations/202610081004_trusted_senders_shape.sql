-- 202610081004_trusted_senders_shape.sql
-- 신뢰 발신자 값 모양을 좁힌다(적대적 검증 2026-10-08 — `docs/internal/adversarial/watch-a.md`). 앱 검사(`src/watch/settings.ts`)와 같은 규칙:
--   ① 주소 로컬파트 = RFC 5322 atext(소문자) + `.` — **`*` 없음**(T1-D12 · U-005 · U-006: `*@도메인` · `ce*@` 가 리터럴 주소로 저장돼 와일드카드처럼 읽혔다).
--      ASCII 만(비 ASCII 로컬파트는 소문자 접기 충돌 — 켈빈 기호).
--   ② 도메인 항목은 공용 메일 도메인이 아니다(T1-S01 — `gmail.com` 항목 = DMARC 통과한 gmail 계정 누구나). 그 도메인의 정확한 주소 항목은 된다.
-- 같은 이름으로 다시 세우고(NOT VALID) 검증은 1005. 새 규칙은 **살아 있는 항목에만** 건다 — 지운 행은 기록이라 바뀌지 않는다(불변 트리거). 운영에는 아직 행이 없지만(배포 전),
-- 시험 DB 처럼 옛 규칙으로 들어간 살아 있는 항목이 있으면 먼저 지우기 표시를 한다(removed_by NULL = 이 마이그레이션) — 그래야 검증이 선다.

SET LOCAL lock_timeout = '5s';

UPDATE org_trusted_senders
   SET removed_at = greatest(now(), created_at)
 WHERE removed_at IS NULL
   AND ((kind = 'address' AND value !~ '^[a-z0-9!#$%&''+/=?^_`{|}~.-]{1,64}@')
        OR (kind = 'domain' AND (value IN ('atmark.ai', 'gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'live.com', 'yahoo.com', 'icloud.com',
                                            'me.com', 'aol.com', 'proton.me', 'protonmail.com', 'naver.com', 'daum.net', 'hanmail.net', 'kakao.com', 'nate.com',
                                            'qq.com', '163.com', 'yandex.ru', 'mail.ru')
                                 OR value ~ '^gmx\.[a-z]{2,63}$')));

ALTER TABLE org_trusted_senders
  DROP CONSTRAINT org_trusted_senders_value_kind,
  ADD CONSTRAINT org_trusted_senders_value_kind CHECK (
    removed_at IS NOT NULL OR value = lower(value) AND (
      (kind = 'domain' AND length(value) <= 253
        AND value ~ '^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+([a-z]{2,63}|xn--[a-z0-9-]{1,59})$')
      OR (kind = 'address' AND length(value) <= 320
        AND value ~ '^[a-z0-9!#$%&''+/=?^_`{|}~.-]{1,64}@([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+([a-z]{2,63}|xn--[a-z0-9-]{1,59})$'))) NOT VALID,
  ADD CONSTRAINT org_trusted_senders_not_freemail CHECK (
    removed_at IS NOT NULL OR kind <> 'domain' OR (
      value NOT IN ('atmark.ai', 'gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'live.com', 'yahoo.com', 'icloud.com', 'me.com', 'aol.com',
                    'proton.me', 'protonmail.com', 'naver.com', 'daum.net', 'hanmail.net', 'kakao.com', 'nate.com', 'qq.com', '163.com', 'yandex.ru', 'mail.ru')
      AND value !~ '^gmx\.[a-z]{2,63}$')) NOT VALID;
