-- 202610021103_domain_tick_reputation_grants.sql
-- 확인 틱 롤(`atmark_domain_tick`, ADR-0014 결정 12)의 **평판 동결 읽기**(결정 14 · J6 · 단계 4 `src/domains/reputation.ts`).
--
-- 단계 0(202609291100)이 준 것 — 도메인 상태·확인·사가 칸 · 알림 적기 · 정책 주소(agent_addresses · agents) · 요금제 · 조직 상태 — 으로 수명주기
-- (전이 · 사가 · 양도 · 강등 · 72시간 만료 · 14일 제거 · 정책 동기화)는 모두 된다. 모자란 것은 평판 집계 하나다: 도메인별 7일·24시간 창의
-- 전달 시도 · bounce · complaint(`ses_events` ⋈ `messages.from_domain`)와 계정 전체 전달 시도(7일). 그 질의가 읽는 칸만 준다 — 본문·수신자·주소
-- 해시·SES 메시지 id 는 없다.
--
-- **운영 무변화.** 틱이 꺼져 있다(Scheduler DISABLED · 기능 허용 목록 비어 있음).
-- 잠금: 칼럼 GRANT 둘(짧은 잠금). 5초 안에 못 잡으면 실패한다.

SET LOCAL lock_timeout = '5s';

GRANT SELECT (message_id, event_type, received_at) ON ses_events TO atmark_domain_tick;
GRANT SELECT (id, agent_id, from_domain) ON messages TO atmark_domain_tick;
