/**
 * src/db/repositories/policy-source.ts — `PolicySource` 의 Postgres 구현.
 *
 * P1a 가 확정한 인터페이스(`src/policy/policy-loader.ts`)를 **그대로** 구현한다.
 * 조립·정규화·jsonb 좁히기는 로더가 이미 하므로 여기서는 **읽어서 행 그대로 돌려준다** —
 * 여기서 가공하면 소스 구현마다 가공이 달라지고, 그 차이가 곧 정책 판정의 차이다.
 *
 * **한 트랜잭션에서 전부 읽는다** (`REPEATABLE READ READ ONLY`).
 * 이유는 성능이 아니라 **판정의 일관성**이다. 조회가 6번 따로 돌면 그 사이에 정책이
 * 바뀔 수 있고, 그러면 `agent_policies.current_version` 과 `policy_versions.version` 이
 * 어긋난 쌍을 읽는다 — 로더의 `resolvePolicy` 가 그 불일치를 `PolicyShapeError` 로
 * 던지도록 설계돼 있고(fail closed), 그 예외는 **실제 데이터 문제일 때만** 나야 한다.
 * 읽기 창이 벌어져서 나는 예외는 정책 편집과 발송이 겹칠 때마다 정상 발송을 죽인다.
 */

import type { Pool } from 'pg';

import { withTransaction, type Queryable } from '../client';
import {
  toAgentId,
  type AgentAddressRow,
  type AgentPolicyRow,
  type AgentRow,
  type ApprovalRequestRow,
  type OrganizationRow,
  type PolicyVersionRow,
  type SenderRelationshipRow,
  type SuppressionEntryRow,
  type ThreadRow,
} from '../schema';
import { loadOrgEntitlementsRow } from './entitlements';
import { hostedEvidenceSql } from './hosted-evidence';
import { dormantAnchorSql, hasPrimaryChanges } from './primary-changes-probe';
import { selectRow, selectRows } from './rows';
import {
  PolicySourceUnavailableError,
  type ApprovalGrantSource,
  type BoundDomainSource,
  type PolicySource,
  type PolicySourceQuery,
  type PolicySourceResult,
  type SourceSendCounters,
  type ThreadInboundSource,
  type ThreadSource,
} from '../../policy/policy-loader';
import { POLICY_REQUEST_PROVENANCE } from '../../policy/policy-requests';
import { AGENT_ADDRESS_DOMAIN } from '../../identity/address';

/**
 * 카운터에 포함되는 상태.
 *
 * `dispatching` 을 세는 것이 요점이다 — lease 를 잡은 메시지는 **이미 보내기로 확정된**
 * 것이고 SES 호출이 진행 중일 수 있다. 세지 않으면 전송 중인 건들이 한도 밖에 있게 되어,
 * 동시 발송이 많을수록 한도가 느슨해진다. 실패로 끝난 건이 사후에 빠지지 않는 것은
 * 의도된 보수성이다(캡은 시도가 아니라 평판을 보는 값이고, 실패한 시도도 수신 서버에
 * 도달은 했다).
 */
const COUNTED_STATUSES = "('dispatching', 'sent')";

/**
 * 카운터 윈도의 기준 시각 컬럼.
 *
 * `sent_at` 이 있으면 그것이 실제 발송 시각이고, 없으면(= 아직 `dispatching`) 행이
 * 만들어진 시각을 쓴다. `created_at` 만 보면 큐에 오래 있다가 방금 나간 메시지가
 * 분 단위 한도에서 빠져나간다.
 */
const WINDOW_AT = 'coalesce(sent_at, created_at)';

interface CounterRow {
  last_minute: number;
  last_hour: number;
  last_day: number;
}

interface RecipientsRow {
  recipients: number;
}

async function loadAgent(db: Queryable, agentId: string): Promise<AgentRow> {
  const row = await selectRow<AgentRow>(
    db,
    `SELECT id, organization_id, name, status, plan, monthly_budget_cents, created_at, updated_at
       FROM agents WHERE id = $1`,
    [agentId],
  );
  if (row === null) {
    // 에이전트가 없으면 평가할 정책이 없다. 빈 결과를 돌려주지 않는다 — 빈 정책은
    // "제약 없음" 으로 읽힐 여지가 있고, 그 해석 한 번이 이 프로젝트가 막으려는 사고다.
    throw new PolicySourceUnavailableError(`agents 행이 없다 (agentId=${agentId})`);
  }
  // 브랜드 승격은 여기 한 번. DB CHECK 가 같은 패턴을 강제하지만, 그 사실을 타입 쪽에
  // 옮겨 오는 지점이 없으면 `string` 이 `AgentId` 자리로 새는 경로가 리포지토리마다 생긴다.
  return { ...row, id: toAgentId(row.id) };
}

async function loadOrganization(db: Queryable, organizationId: string): Promise<OrganizationRow> {
  const row = await selectRow<OrganizationRow>(
    db,
    `SELECT id, name, ses_tenant_id, billing_status, abuse_freeze, owner_paused, review_status, sending_started_at, created_at, updated_at
       FROM organizations WHERE id = $1`,
    [organizationId],
  );
  if (row === null) {
    throw new PolicySourceUnavailableError(`organizations 행이 없다 (id=${organizationId})`);
  }
  return row;
}

async function loadPolicy(db: Queryable, agentId: string): Promise<AgentPolicyRow> {
  const row = await selectRow<AgentPolicyRow>(
    db,
    `SELECT agent_id, outbound_mode, inbound_mode, require_approval, limits, config_json, current_version, created_at, updated_at
       FROM agent_policies WHERE agent_id = $1`,
    [agentId],
  );
  if (row === null) {
    throw new PolicySourceUnavailableError(`agent_policies 행이 없다 (agentId=${agentId})`);
  }
  return row;
}

async function loadPolicyVersion(db: Queryable, agentId: string, version: number): Promise<PolicyVersionRow> {
  const row = await selectRow<PolicyVersionRow>(
    db,
    `SELECT id, agent_id, version, outbound_mode, inbound_mode, snapshot, created_by, created_at
       FROM policy_versions WHERE agent_id = $1 AND version = $2`,
    [agentId, version],
  );
  if (row === null) {
    throw new PolicySourceUnavailableError(
      `policy_versions 행이 없다 (agentId=${agentId}, version=${version}). ` +
        'agent_policies.current_version 이 가리키는 스냅샷이 존재하지 않는다.',
    );
  }
  return row;
}

/**
 * **에이전트가 요청해 생긴 발신 허용 주소 규칙**의 id(보안 감사 H-1) — 승인 연산이 규칙 행 `created_by` 에 남긴 요청 표지(`POLICY_REQUEST_PROVENANCE`)로 가린다.
 * 지운 행도 읽는다(스냅샷 id 와 맞춰 보는 쪽은 로더 — 같은 트랜잭션 스냅샷이라 버전과 갈라지지 않는다). 표지를 넓게 읽어도(부분 문자열) 좁히기만 한다.
 */
async function loadAgentRequestedRuleIds(db: Queryable, agentId: string): Promise<readonly string[]> {
  const rows = await selectRows<{ id: string }>(
    db,
    `SELECT id::text AS id FROM agent_contact_rules
      WHERE agent_id = $1 AND direction = 'outbound' AND list = 'allow' AND kind = 'address'
        AND strpos(coalesce(created_by, ''), $2) > 0`,
    [agentId, POLICY_REQUEST_PROVENANCE],
  );
  return rows.map((row) => row.id);
}

async function loadCounters(
  db: Queryable,
  agent: AgentRow,
  now: Date,
): Promise<SourceSendCounters> {
  const perAgent = await selectRow<CounterRow>(
    db,
    `SELECT
       count(*) FILTER (WHERE ${WINDOW_AT} >= $2::timestamptz - interval '1 minute')::int  AS last_minute,
       count(*) FILTER (WHERE ${WINDOW_AT} >= $2::timestamptz - interval '1 hour')::int    AS last_hour,
       count(*) FILTER (WHERE ${WINDOW_AT} >= $2::timestamptz - interval '24 hours')::int  AS last_day
     FROM messages
     WHERE agent_id = $1 AND direction = 'outbound' AND status IN ${COUNTED_STATUSES}`,
    [agent.id, now],
  );

  // **눈금이 다르다.** 위 셋은 메시지 수, 아래는 수신자 수다(`SendCounters` 규약).
  // 여기에 메시지 수를 채우면 워밍업 캡이 조용히 최대 50배 느슨해진다.
  const orgRecipients = await selectRow<RecipientsRow>(
    db,
    `SELECT coalesce(sum(m.recipient_count), 0)::int AS recipients
       FROM messages m
       JOIN agents a ON a.id = m.agent_id
      WHERE a.organization_id = $1
        AND m.direction = 'outbound'
        AND m.status IN ${COUNTED_STATUSES}
        AND coalesce(m.sent_at, m.created_at) >= $2::timestamptz - interval '24 hours'`,
    [agent.organization_id, now],
  );

  return {
    agentLastMinute: perAgent?.last_minute ?? 0,
    agentLastHour: perAgent?.last_hour ?? 0,
    agentLastDay: perAgent?.last_day ?? 0,
    orgRecipientsLastDay: orgRecipients?.recipients ?? 0,
  };
}

async function loadSuppressions(
  db: Queryable,
  organizationId: string,
  recipients: readonly string[],
  now: Date,
): Promise<readonly SuppressionEntryRow[]> {
  if (recipients.length === 0) return [];
  // 만료 판정은 **소스의 일**이다(로더 규약). 만료된 항목을 엔진까지 올리면 Stage 2 가
  // 영구 거부를 내고, soft bounce 한 번이 정상 수신자를 영구 차단한다.
  return selectRows<SuppressionEntryRow>(
    db,
    `SELECT id, organization_id, address, domain, source, reason, expires_at, created_at
       FROM suppression_entries
      WHERE organization_id = $1
        AND address = ANY($2::text[])
        AND (expires_at IS NULL OR expires_at > $3::timestamptz)`,
    [organizationId, [...recipients], now],
  );
}

interface BoundDomainRow {
  domain: string;
  status: BoundDomainSource['status'] | null;
  suspended_reason: BoundDomainSource['suspended_reason'];
  sending_started_at: Date | null;
  recipients_last_day: number;
}

/**
 * `loadBoundCustomDomains` 의 문장 — $1 조직 · $2 고객 도메인 배열 · $3 지금. 통합 테스트(`test/integration/policy/domain-gate.test.ts`)가 이 문장의
 * 실행 계획이 부분 색인 `messages_custom_from_domain_created_idx` 를 쓰는지 본다(L7 — 계획 §3.7).
 */
export const BOUND_CUSTOM_DOMAINS_SQL = `SELECT d.domain, cd.status, cd.suspended_reason, cd.sending_started_at,
            coalesce((SELECT sum(m.recipient_count)
                        FROM messages m JOIN agents a ON a.id = m.agent_id
                       WHERE m.from_domain = d.domain AND m.from_domain <> '${AGENT_ADDRESS_DOMAIN}'
                         AND a.organization_id = $1
                         AND m.direction = 'outbound' AND m.status IN ${COUNTED_STATUSES}
                         AND coalesce(m.sent_at, m.created_at) >= $3::timestamptz - interval '24 hours'), 0)::int AS recipients_last_day
       FROM unnest($2::text[]) AS d(domain)
       LEFT JOIN LATERAL (
         SELECT c.status, c.suspended_reason, c.sending_started_at
           FROM custom_domains c
          WHERE c.organization_id = $1 AND c.domain = d.domain
          ORDER BY (c.status <> 'removed') DESC, c.removed_at DESC NULLS LAST, c.created_at DESC, c.id
          LIMIT 1
       ) cd ON true
      ORDER BY d.domain`;

/**
 * 살아 있는 주소의 **고객 도메인**마다 한 행(ADR-0014 · 계획 §3.7 M10 — `BoundDomainSource`).
 *
 * - **고객 도메인 주소가 없으면 질의하지 않는다**(빈 배열). 지금 모든 주소는 `atmark.ai` 라 이 함수는 운영에서 SQL 을 보내지 않는다 — 새 코드가
 *   `custom_domains` 마이그레이션보다 먼저 떠도(배포 순서 §6 ③) 42P01 이 나지 않는다. 고객 도메인 주소는 그 표의 verified 행이 있어야만 생긴다
 *   (주소 트리거 `agent_addresses_verified_domain_guard`).
 * - 행 고르기: **같은 조직**에서 `status <> 'removed'` 인 행(유니크 색인이 최대 1행을 보장), 없으면 가장 최근 removed 행, 그것도 없으면 `missing`.
 *   다른 조직의 행은 보지 않는다 — 도메인이 다른 조직으로 넘어가도 옛 조직의 주소는 `blocked` 다(ADR-0014 결정 D-H).
 * - 24시간 수신자 수는 **조직 필터**로 센다(`messages.from_domain` + 부분 색인 `messages_custom_from_domain_created_idx`, L7) — 도메인 이름만으로
 *   세면 옛 조직이 같은 도메인으로 보낸 메일이 새 조직의 캡을 먹는다. 세는 상태·창은 조직 카운터와 같다(`COUNTED_STATUSES` · `WINDOW_AT`).
 *   `created_at` 하한(예: 25시간 — critic minor 10)은 **두지 않는다**: 승인 릴리스(대기 최대 7일 + 창 48시간)·예약 발송은 오래전에 만든 메시지를
 *   창 안에 보내므로, 하한을 두면 그 수신자가 빠져 캡이 느슨해진다. 색인은 `from_domain` 등식으로 그 도메인의 행만 좁힌다(단계 3 이 EXPLAIN 확인).
 */
async function loadBoundCustomDomains(
  db: Queryable,
  organizationId: string,
  addresses: readonly AgentAddressRow[],
  now: Date,
): Promise<readonly BoundDomainSource[]> {
  const domains = [...new Set(addresses.map((row) => row.domain).filter((domain) => domain !== AGENT_ADDRESS_DOMAIN))].sort();
  if (domains.length === 0) return [];
  const rows = await selectRows<BoundDomainRow>(
    db,
    BOUND_CUSTOM_DOMAINS_SQL,
    [organizationId, domains, now],
  );
  return rows.map((row) => ({
    domain: row.domain,
    status: row.status ?? 'missing',
    suspended_reason: row.status === null ? null : row.suspended_reason,
    sending_started_at: row.status === null ? null : row.sending_started_at,
    recipients_last_day: row.recipients_last_day,
  }));
}

/**
 * 이번 수신자들에 걸릴 수 있는 관계 행 (§3.4 2조). **스코프 매칭의 최종 판정은 로더가 한다**
 * (`matchRelationships`) — 여기서는 인덱스를 타는 좁히기만 한다.
 *
 * 주소가 있는 관계(`recipient`·`thread`)가 **Atmark 주소**를 가리키면 그 주소의 지금 활성 행이 생긴 뒤에 맺은 것만 싣는다(별칭 재발급 보안
 * 리뷰 M3 · `hosted-evidence.ts`) — 예전 주인에게 승인받은 "승인 없이 보내는 상대" 가 재발급된 주소의 새 주인에게 이어지지 않게. 도메인 관계는
 * 소유자가 도메인 범위를 확인한 넓은 허가라 그대로다(규칙과 같은 소유자 의도 — ADR).
 */
async function loadRelationships(
  db: Queryable,
  agentId: string,
  recipients: readonly string[],
  threadId: string | null,
): Promise<readonly SenderRelationshipRow[]> {
  if (recipients.length === 0) return [];
  const domains = [...new Set(recipients.map((address) => address.slice(address.lastIndexOf('@') + 1)))];
  const rows = await selectRows<SenderRelationshipRow>(
    db,
    `SELECT id, agent_id, scope, address, domain, thread_id, trust_category,
            granted_via_approval_id, granted_by, domain_scope_confirmed_by, created_at
       FROM sender_relationships
      WHERE agent_id = $1
        AND (   (scope = 'recipient' AND address = ANY($2::text[]))
             OR (scope = 'domain'    AND domain  = ANY($3::text[]))
             OR (scope = 'thread'    AND $4::uuid IS NOT NULL AND thread_id = $4::uuid AND address = ANY($2::text[])))
        AND ${hostedEvidenceSql('sender_relationships.address', 'sender_relationships.created_at')}`,
    [agentId, [...recipients], domains, threadId],
  );
  return rows.map((row) => ({ ...row, agent_id: toAgentId(row.agent_id) }));
}

/**
 * 릴리스 중인 승인 요청 + 그 요청이 덮는 수신자. **상태를 판정하지 않는다** — `pending` 이든
 * `expired` 든 그대로 돌려주고, grant 로 인정할지는 로더(`resolveApprovalGrant`)가 정한다.
 * 판정이 소스와 로더에 나뉘면 한쪽만 느슨해진 날을 아무도 모른다.
 */
async function loadApprovalGrant(
  db: Queryable,
  approvalId: string | null,
): Promise<ApprovalGrantSource | null> {
  if (approvalId === null) return null;
  const request = await selectRow<ApprovalRequestRow>(
    db,
    `SELECT id, agent_id, subject, status, created_at, expires_at, decided_at, decided_by, granted_scope
       FROM approval_requests WHERE id = $1`,
    [approvalId],
  );
  if (request === null) return null;
  const recipients = await selectRow<{ recipients: string[] | null }>(
    db,
    `SELECT array_agg(DISTINCT r) AS recipients
       FROM approval_request_items i, unnest(i.recipients) AS r
      WHERE i.approval_id = $1`,
    [approvalId],
  );
  return {
    request: { ...request, agent_id: toAgentId(request.agent_id) },
    recipients: recipients?.recipients ?? [],
  };
}

/**
 * 시도가 **주장한** 스레드의 사실 (P3b). 판정하지 않고 읽기만 한다 — 회신으로 인정할지는 로더(`resolveThreadReply`).
 *
 * - **에이전트 범위로 읽는다**(`agent_id = $2`). 남의 에이전트 스레드 id 는 `null` 이 된다(로더도 한 번 더 대조).
 * - **권한용 `thread_id` 만 본다.** `display_thread_id` 는 이 파일 어디에도 없다 — 약한 증거(검증 안 된 헤더·
 *   제목 폴백)로 묶인 메일이 "이 스레드의 참여자" 가 되면 그것이 곧 승인 우회다(`mail/thread/resolve.ts`).
 * - **인증 수신만 센다**(`from_authenticated` = DMARC pass). 사칭된 From 은 참여자도 "답하는 메일" 도 아니다.
 *
 * `sender_marks` 는 읽지 않는다(202609230020 — 수신 신뢰는 발신 허가가 아니다). 신뢰는 수신 시점에
 * `inbound_messages.sender_trust` 로 이미 스탬프됐고, 여기서는 그 값을 옮길 뿐이다.
 */
async function loadThread(db: Queryable, threadId: string | null, agentId: string, now: Date): Promise<ThreadSource | null> {
  if (threadId === null) return null;
  const thread = await selectRow<ThreadRow>(
    db,
    `SELECT id, agent_id, started_by, starter_address, subject_normalized, created_at, last_message_at
       FROM threads WHERE id = $1::uuid AND agent_id = $2`,
    [threadId, agentId],
  );
  if (thread === null) return null;

  // **수신 정책이 격리한 메일(`policy_blocked`)은 스레드 사실이 아니다**(202609241040 — 검증 L4). 소유자가 받지 않기로 한 상대의
  // 메일이 "이 스레드의 인증된 발신자"·"답하는 메일" 이 되면, 에이전트가 본 적도 없는 메일이 회신 권한(레거시 스레드 문)을 연다.
  // Atmark 주소 발신자는 그 주소의 지금 활성 행이 생긴 뒤에 받은 메일만 스레드 사실이다(별칭 재발급 보안 리뷰 M3) — 예전 주인이 이 스레드에
  // 쓴 메일이 재발급된 주소의 새 주인에게 회신 권한(참여자 · 답하는 메일)을 넘기지 않게.
  const senders = await selectRows<{ from_address: string }>(
    db,
    `SELECT DISTINCT from_address FROM inbound_messages
      WHERE agent_id = $1 AND thread_id = $2::uuid AND from_authenticated
        AND quarantine_reason IS DISTINCT FROM 'policy_blocked'
        AND ${hostedEvidenceSql('inbound_messages.from_address', 'inbound_messages.received_at')}`,
    [agentId, threadId],
  );
  // 최신 인증 수신에는 **거는 칸**(격리 · injection)이 실려 있다 — 재발급 컷오프로 걸러 내면 별칭을 폐기하는 것만으로 더 깨끗한 옛 행이
  // 최신이 되어 막힘이 풀린다(재발급 보안 재검토 LOW-1). 권한은 위 `senders`(컷오프 적용)가 준다 — 여기는 거르지 않는다.
  const latest = await selectRow<ThreadInboundSource>(
    db,
    `SELECT id, from_address, injection_risk, sender_trust, quarantined, received_at, attachment_count
       FROM inbound_messages
      WHERE agent_id = $1 AND thread_id = $2::uuid AND from_authenticated
        AND quarantine_reason IS DISTINCT FROM 'policy_blocked'
      ORDER BY received_at DESC, created_at DESC, id DESC
      LIMIT 1`,
    [agentId, threadId],
  );
  // ADR-0016 리뷰 H2 — 이 스레드의 발신 중 `once`(위험 보류) 승인으로 나간 것이 있는가. 있으면 로더가 이 스레드를 외부 스레드로 친다.
  // 재검증 N3 — 그 발신 뒤 **7일**만(오염 스레드 창과 같은 길이). 시각은 나간 때, 아직 안 나갔으면 승인한 때(그것도 없으면 행을 만든 때).
  const once = await selectRow<{ once: boolean }>(
    db,
    `SELECT EXISTS (
       SELECT 1 FROM messages m
         JOIN approval_request_items i ON i.message_id = m.id
         JOIN approval_requests r ON r.id = i.approval_id
        WHERE m.agent_id = $1 AND m.thread_id = $2::uuid AND m.direction = 'outbound' AND r.granted_scope = 'once'
          AND coalesce(m.sent_at, r.decided_at, m.created_at) > $3::timestamptz - interval '7 days') AS once`,
    [agentId, threadId, now],
  );
  return {
    thread: { ...thread, agent_id: toAgentId(thread.agent_id) },
    authenticatedSenders: senders.map((row) => row.from_address),
    latestAuthenticatedInbound: latest,
    onceApproved: once?.once === true,
  };
}

/**
 * 이 에이전트가 지금까지 내보낸 outbound 수 — bootstrap_grace 의 분자(§3.1 층 3).
 *
 * **별도 카운터 테이블을 두지 않는다.** 카운터를 따로 증가시키면 `messages` 와 갈라질 수 있고
 * (증가 후 롤백, 이중 증가), 갈라진 카운터는 grace 를 조용히 늘리거나 줄인다. 발송의 진실은
 * `messages` 에 있고 여기서 센다. 세는 상태는 워밍업 카운터와 같다(`COUNTED_STATUSES`) —
 * lease 를 잡은 순간 이미 나가기로 확정된 것이고, 직렬화 구간 안에서 세므로 동시 시도가 같은
 * 잔여를 두 번 쓰지 못한다(R22 와 같은 논리).
 */
async function loadOutboundSentCount(db: Queryable, agentId: string): Promise<number> {
  const row = await selectRow<{ sent: number }>(
    db,
    `SELECT count(*)::int AS sent FROM messages
      WHERE agent_id = $1 AND direction = 'outbound' AND status IN ${COUNTED_STATUSES}`,
    [agentId],
  );
  return row?.sent ?? 0;
}

/**
 * 이번 달 누적 사용액(센트).
 *
 * **P1 에는 usage ledger 테이블이 없다**(계획 §6 P5). 0 은 "모른다" 가 아니라
 * **"아직 아무것도 기록되지 않았다"** 는 참값이다 — 기록 경로 자체가 존재하지 않기
 * 때문이다. P5 에서 원장이 생기면 이 함수 하나가 바뀐다.
 *
 * 0 을 돌려주는 것이 fail open 이 아닌 이유: Stage 5 는
 * `monthToDate + thisAttempt > monthlyBudget` 로 거부하고, `thisAttemptCostCents` 는
 * 호출자가 준다. 예산이 0(기본값)인 에이전트는 비용이 1센트라도 붙는 순간 거부된다.
 */
function monthToDateSpentCents(): number {
  return 0;
}

/** 풀 하나를 받아 `PolicySource` 를 만든다. worker-2·3 은 이 함수만 쓰면 된다. */
export function createPostgresPolicySource(pool: Pool): PolicySource {
  return {
    async load(query: PolicySourceQuery): Promise<PolicySourceResult> {
      return withTransaction(
        pool,
        async (client) => {
          const agent = await loadAgent(client, query.agentId);
          const organization = await loadOrganization(client, agent.organization_id);
          // 요금제 한도(ADR-0011) — 같은 스냅샷 안에서. 행이 없으면 null(로더가 Free 로 읽는다).
          const entitlements = await loadOrgEntitlementsRow(client, organization.id);
          const policy = await loadPolicy(client, agent.id);
          const policyVersion = await loadPolicyVersion(client, agent.id, policy.current_version);
          const agentRequestedRuleIds = await loadAgentRequestedRuleIds(client, agent.id);
          const pointer = await hasPrimaryChanges(pool, client);
          const dormant = pointer ? dormantAnchorSql('a') : 'false';
          const addressRows = await selectRows<AgentAddressRow & { usable: boolean; reissued: boolean }>(
            client,
            // 메일 기본기 2차 A6 — 폐기한 별칭은 발신 주소가 아니다(Stage 1 identity `denied` · `sendingAddresses` · `get_my_policy` 에서 빠진다).
            // 칸은 행 JSON 에서 읽는다 — 202609270110 전 스키마(새 코드가 먼저 돈 몇 분 · 옛 스키마 스크래치 테스트)에서도 42703 없이 돈다.
            // `usable` = 지금 이 주소로 보낼 수 있는가(ADR-0014 개정 — 대표 주소 포인터 모델). 폐기된 주소 · **잠든 앵커**(202610021100 — 마지막
            // 대표 선택이 앵커가 아닌 에이전트의 `is_primary` 행: 고객 도메인 주소를 대표로 골랐다)는 거짓이다(계약 `anchorDormantOf` 와 같은 술어).
            // 쓸 수 없는 이 에이전트의 주소는 Stage 1 이 `from_forgery` 가 아니라 `from_inactive` 로 막는다(위반 아님). **단, 지금 다른 행이 그 주소를
            // 활성으로 쥐고 있지 않을 때만**(보안 리뷰 M1): 30일 보류 뒤 재발급된 주소(같은 조직 · 다른 조직)를 옛 에이전트가 From 으로 쓰면 그것은
            // 남의 주소 사칭이다 — `reissued` 면 inactive 에 넣지 않아 Stage 1 이 `from_forgery`(위반)로 막는다. 잠든 앵커는 자기 행이 활성이므로
            // `reissued` 는 **다른 행**만 본다(`o.id <> a.id`). 선택 표가 없는 스키마에서는 잠든 앵커가 있을 수 없다(`hasPrimaryChanges`).
            `SELECT a.id, a.agent_id, a.address, a.domain, a.is_primary, a.created_at,
                    (to_jsonb(a) ->> 'retired_at') IS NULL AND NOT ${dormant} AS usable,
                    EXISTS (SELECT 1 FROM agent_addresses o WHERE o.address = a.address AND o.id <> a.id AND (to_jsonb(o) ->> 'retired_at') IS NULL) AS reissued
               FROM agent_addresses a WHERE a.agent_id = $1 ORDER BY a.created_at`,
            [agent.id],
          );
          const addresses: AgentAddressRow[] = addressRows
            .filter((row) => row.usable)
            .map(({ usable: _usable, reissued: _reissued, ...row }) => row);
          const inactiveAddresses = addressRows.filter((row) => !row.usable && !row.reissued).map((row) => row.address);
          // 유효 대표(ADR-0014 2026-10 개정) — 기본 From 고르기만 쓴다(관문 판정 밖). 선택 표가 없으면 앵커(= 예전 대표).
          const primaryAddress = pointer
            ? ((await selectRows<{ address: string | null }>(client, 'SELECT atmark_agent_primary_address($1) AS address', [agent.id]))[0]?.address ?? null)
            : (addresses.find((row) => row.is_primary)?.address ?? null);
          const suppressions = await loadSuppressions(
            client,
            organization.id,
            query.recipients,
            query.now,
          );
          const counters = await loadCounters(client, agent, query.now);
          const customDomains = await loadBoundCustomDomains(client, organization.id, addresses, query.now);
          const relationships = await loadRelationships(client, agent.id, query.recipients, query.threadId);
          const approvalGrant = await loadApprovalGrant(client, query.releaseApprovalId);
          const outboundSentCount = await loadOutboundSentCount(client, agent.id);
          const thread = await loadThread(client, query.threadId, agent.id, query.now);

          return {
            organization,
            entitlements,
            agent,
            addresses,
            inactiveAddresses,
            primaryAddress,
            policy,
            policyVersion,
            agentRequestedRuleIds,
            suppressions,
            counters,
            customDomains,
            monthToDateSpentCents: monthToDateSpentCents(),
            relationships,
            approvalGrant,
            outboundSentCount,
            thread,
          };
        },
        'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY',
      );
    },
  };
}
