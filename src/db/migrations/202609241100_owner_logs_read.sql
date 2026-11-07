-- 202609241100_owner_logs_read.sql
-- 콘솔 로그 API(`GET /api/logs` · `GET /api/logs/{type}/{id}` — `src/admin/routes/logs.ts`, 계약 v2 §2)의 **읽기 권한과 색인**.
--
-- ① `atmark_admin` 에 **컬럼 단위 SELECT** 만 더한다(ADR-0006 — admin 롤은 GRANT 목록 안에서만 돈다). 테이블 단위로 주지 않는
--    이유: 로그 화면이 보여 줄 칸만 읽으면 된다. 빠지는 칸과 이유 —
--      audit_logs         : agent_id(메시지 행으로 조직을 가른다) · policy_version_id · latency_ms · trace_id(내부 추적) ·
--                           approved_by(승인자 식별 문자열) · bootstrap_grace_remaining.
--      owner_actions      : session_id(세션 식별자 — 감사는 여전히 "누가"를 세션으로 적지만 화면은 행위·대상·시각만).
--      inbound_rejections : ses_message_id · detail(내부 오류 문장) · raw_storage_key(원문 위치) · created_at.
--    `messages`·`inbound_messages`·`outbound_recipients`·`agents`·`agent_addresses` 는 202609230720 이 이미 테이블 단위 SELECT 를
--    주었다(추가 없음). 앱 롤(`atmark_app`)에는 **아무것도 더하지 않는다.**
--    허용 목록은 `src/runtime/role-bootstrap.ts` `RESTRICTED_ROLE_GRANTS` 에도 같은 변경으로 늘렸다(migrate `status` 가 대조).
--
-- ② 색인 — 목록은 **최신순 + (시각, id) 키셋 커서**다. 조직 범위 쿼리는 에이전트마다 LATERAL 로 앞쪽 `limit+1` 행만 읽고
--    합친다(에이전트 수 × 쪽 크기 — 조직 전체 메시지를 정렬하지 않는다). 그러려면 에이전트 안에서 (시각 DESC, id DESC) 가
--    색인 순서여야 하고, 커서 비교 `(시각, id) < ($1, $2)` 가 색인 조건이 된다. 기존 색인은 id 가 없어 동률(같은 트랜잭션의
--    now())에서 정렬을 색인이 끝내지 못한다.
--      - messages (agent_id, created_at DESC, id DESC) WHERE direction = 'outbound'
--      - inbound_messages (agent_id, received_at DESC, id DESC)
--      - owner_actions (organization_id, created_at DESC, id DESC)
--      - inbound_rejections GIN (envelope_recipients) — 거부 행에는 agent_id 가 없다. 이 조직 주소와 겹치는(`&&`) 행만 고른다
--        (조직의 거부 행 전부를 읽고 top-N 정렬 — 거부는 드물다. 다른 조직·unknown_recipient 거부는 읽지 않는다).

-- ---------------------------------------------------------------------------
-- ① atmark_admin — 컬럼 단위 SELECT
-- ---------------------------------------------------------------------------

GRANT SELECT (id, message_id, decision, reasons, policy_version, evaluated_at, resolved_at, resolution_reason, approval_id, created_at)
  ON audit_logs TO atmark_admin;

GRANT SELECT (id, organization_id, action, target_id, created_at)
  ON owner_actions TO atmark_admin;

GRANT SELECT (id, reason, envelope_recipients, spam_verdict, virus_verdict, received_at)
  ON inbound_rejections TO atmark_admin;

-- ---------------------------------------------------------------------------
-- ② 색인
-- ---------------------------------------------------------------------------

CREATE INDEX messages_agent_outbound_log_idx
  ON messages (agent_id, created_at DESC, id DESC) WHERE direction = 'outbound';

CREATE INDEX inbound_messages_agent_log_idx
  ON inbound_messages (agent_id, received_at DESC, id DESC);

CREATE INDEX owner_actions_org_log_idx
  ON owner_actions (organization_id, created_at DESC, id DESC);

-- fastupdate 끔: 거부 행은 드물게 쌓이고(바이러스·MIME·크기·조직 비활성), 읽기가 대기 목록(pending list)을 훑는 비용을 떠안지 않게.
CREATE INDEX inbound_rejections_envelope_recipients_idx
  ON inbound_rejections USING gin (envelope_recipients) WITH (fastupdate = off);
