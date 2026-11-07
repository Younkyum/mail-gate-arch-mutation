-- 202609230730_app_role_org_agent_columns.sql
-- 앱 롤의 `organizations`·`agents` UPDATE 를 **테이블 단위에서 컬럼 단위로** 좁힌다 (ADR-0006 보강 — H1 우회 경로).
--
-- 무엇이 틀렸나: 마이그레이션 4(202609221430)가 `atmark_app` 에 두 테이블의 UPDATE 를 **테이블 단위로** 주었다. 그러면 api
--   Lambda(앱 롤)를 쥔 공격자는 ① `UPDATE organizations SET owner_email = '<공격자>'` ② 콘솔에 로그인 요청 → login-mailer 가
--   링크를 **공격자에게** 보낸다 → 소유자 세션. 로그인 키·링크 행을 앱 롤에서 떼어 낸(202609230700·0720) 것이 이 한 문장으로
--   무력화된다. 202609230710 의 "owner_email 이 바뀌면 세션 폐기" 트리거는 **새 로그인**을 막지 못한다. 같은 권한으로
--   `abuse_freeze`(플랫폼 동결)·`owner_paused`(소유자 정지)·`agents.suspended_by`·`agents.status` 도 바꿀 수 있었다 —
--   운영자·소유자가 건 정지를 api 탈취가 푸는 길이다.
--
-- 앱 롤로 도는 코드(api·워커·inbound — `src/runtime/composition.ts` 가 조립하는 전부)가 실제로 UPDATE 하는 컬럼(grep, 2026-09-23):
--   | 테이블 | 컬럼 | 어디서 |
--   |---|---|---|
--   | organizations | sending_started_at | `src/db/repositories/sending-clock.ts` `markFirstSend`(첫 발송 기준일, IS NULL 일 때 1회) |
--   | agents | (없음) | — `UPDATE agents` 는 `src/admin/ops/agents.ts`(admin 롤·CLI 소유자 롤)와 `src/api/provisioning-store.ts`
--   |        |        |   (프로비저닝 — 운영에서는 CLI 소유자 롤·admin 롤만 부른다)에만 있다. |
-- 그래서 organizations 는 `sending_started_at` 하나만, agents 는 UPDATE 0.
--
-- INSERT 는 그대로 둔다(보고서의 잔여 항목): 운영 앱 코드는 두 테이블에 INSERT 하지 않지만, 통합 테스트 지반
--   (`test/integration/db/support/harness.ts` `seedFixture`)이 앱 롤로 조직·에이전트를 심는다. 새 조직 INSERT 는 공격자에게
--   **자기 조직**만 준다(남의 조직의 owner_email 을 바꾸는 길이 아니다). DELETE·TRUNCATE 는 원래 없다.
--
-- `migrate status` 가 "앱 롤은 이 금지 컬럼들을 UPDATE 할 수 없다" 를 본다(`APP_FORBIDDEN_COLUMN_UPDATES`).

REVOKE UPDATE ON organizations FROM atmark_app;
REVOKE UPDATE ON agents FROM atmark_app;

GRANT UPDATE (sending_started_at) ON organizations TO atmark_app;
