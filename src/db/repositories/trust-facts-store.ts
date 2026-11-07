/**
 * src/db/repositories/trust-facts-store.ts — `TrustFactsPort` 의 Postgres 구현 (계획 §6 P4, §4B.4).
 *
 * `security/trust-signals.ts` 가 정한 포트를 **그대로** 채운다. 판정(`computeTrust`)도, 신호 변환
 * (`collectTrustSignals`)도 여기서 하지 않는다 — 사실만 읽는다.
 *
 * ## 에이전트 범위 — 두 겹
 *
 * 모든 조회가 `agent_id = $1`(억제는 그 에이전트의 조직)로 묶인다. 수집기가 행마다 `agentId` 를 **한 번 더**
 * 대조하지만(trust-signals.ts "포트가 사실을 넘치게 줘도 여기서 다시 거른다"), 그것은 두 번째 겹이다 —
 * 첫 겹이 새면 다른 에이전트의 관계·분류가 이 발신자의 신뢰 후보로 올라온다. 두 겹 각각을 테스트가 따로 끈다.
 *
 * ## 한 트랜잭션에서 읽는다 (`REPEATABLE READ READ ONLY`)
 *
 * `policy-source.ts` 와 같은 이유 — 조회 사이에 분류가 `cleared` 로 바뀌면서 관계가 생기는 식의 어긋난 쌍을
 * 읽지 않는다.
 *
 * ## 판단 기록
 *
 * - **주소 키.** 올리는 사실(관계·분류)은 소문자화만 한 **전체 주소**로 찾는다(수집기가 정확 일치를 본다).
 *   관계 행은 2026-09-23(`202609230640_exact_allow_relationships.sql`)부터 **소문자 정확 형태**로 저장된다. 그 전에
 *   `normalizeAddress`(태그 절단)로 저장된 옛 행이 남아 있어 태그 절단형으로도 한 번 더 가져온다 — 넘치게 주는 것은
 *   괜찮다(수집기가 정확 일치로 거른다). 막는 사실(억제)은 태그 절단형으로 찾는다.
 * - **injection 이력은 인증된(DMARC pass) 과거 메일만 센다.** 사칭된 From 으로 injection 메일을 보내 진짜
 *   발신자의 신뢰를 영구히 깎는 경로(신뢰 DoS)를 열지 않는다. 사칭 메일은 "이 발신자가 보낸 것" 이 아니다.
 *   `+tag` 변형은 같은 발신자로 본다(막는 신호는 넓게).
 * - **판정 없는 과거 메일**(스캐너 예외: `scanner_version` 있고 `injection_risk` NULL)은 `medium` 으로 센다 —
 *   판정할 수 없던 메일은 신뢰의 근거가 아니다. **P4 이전 행**(`scanner_version` NULL)은 세지 않는다: 스캔한
 *   적이 없는 것은 "injection 이력" 이 아니라 "관측 없음" 이고, 이 격자는 이력으로 신뢰를 올리지 않으므로
 *   빼도 올라가는 경로가 없다.
 * - **Atmark 주소 상대의 올리는 근거는 그 주소의 지금 활성 행이 생긴 뒤의 것만** 센다(`hostedEvidenceSql` — 별칭 재발급 보안 리뷰 M3, ADR-0013
 *   2026-09-29 개정): 관계 · 소유자 분류 · 받은/보낸 이력. 폐기·보류 중이면 하나도 세지 않는다. 막는 근거(차단 · 억제 · injection 이력)는
 *   그대로다. 다른 도메인의 상대는 바뀌지 않는다.
 * - **blocklist 는 `agent_contact_rules` 의 block 목록 — 발신·수신 두 방향의 합**(정책 v2). 주소 값은 판정형(`+tag` 절단)으로
 *   넘긴다 — 관문의 `resolveOutboundRules` 와 같은 모양이다. 모드는 보지 않는다(신뢰 신호는 "소유자가 막은 상대인가" 다).
 */

import type { Pool } from 'pg';

import { withTransaction, type Queryable } from '../client';
import type { InjectionRisk, SuppressionSource } from '../schema';
import { normalizeAddress } from '../../policy/policy-loader';
import type { RelationshipFact, SuppressionFact, TrustFacts, TrustFactsPort } from '../../security/trust-signals';
import { hostedEvidenceSql } from './hosted-evidence';
import { loadEffectiveSeenMarks } from './sender-marks-store';

const ADDRESS = /^[^@\s<>]+@[^@\s<>]+$/;

const EMPTY_FACTS: TrustFacts = {
  relationships: [],
  ownerClassifications: [],
  blocklist: [],
  suppressions: [],
  priorInjectionRisks: [],
  inbound: { count: 0, authenticatedCount: 0, firstAt: null },
  outbound: { sentCount: 0, firstAt: null },
};

function likeEscape(value: string): string {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`);
}

async function loadBlocklist(db: Queryable, agentId: string): Promise<string[]> {
  const result = await db.query<{ kind: 'address' | 'domain'; value: string }>(
    `SELECT kind, value FROM agent_contact_rules
      WHERE agent_id = $1 AND list = 'block' AND removed_at IS NULL ORDER BY direction, value`,
    [agentId],
  );
  return result.rows.map((row) => (row.kind === 'address' ? normalizeAddress(row.value) : row.value));
}

export function createPostgresTrustFacts(pool: Pool): TrustFactsPort {
  return {
    async loadTrustFacts(agentId: string, sender: string): Promise<TrustFacts> {
      const exact = sender.trim().toLowerCase();
      // 주소 모양이 아니면 수집기가 올리는 신호도 막는 신호도 만들지 않는다 — 읽을 것이 없다.
      if (!ADDRESS.test(exact)) return { ...EMPTY_FACTS, blocklist: [] };
      const wide = normalizeAddress(exact);
      const at = wide.lastIndexOf('@');
      const wideLocal = wide.slice(0, at);
      const domain = exact.slice(exact.lastIndexOf('@') + 1);

      return withTransaction(
        pool,
        async (client) => {
          const blocklist = await loadBlocklist(client, agentId);

          const relationships = await client.query<{
            agent_id: string;
            scope: RelationshipFact['scope'];
            trust_category: RelationshipFact['trustCategory'];
            address: string | null;
            domain: string | null;
            thread_id: string | null;
            granted_via_approval_id: string | null;
          }>(
            `SELECT agent_id, scope, trust_category, address, domain, thread_id, granted_via_approval_id
               FROM sender_relationships
              WHERE agent_id = $1
                AND (address = ANY($2::text[]) OR (scope = 'domain' AND domain = $3))
                AND ${hostedEvidenceSql('$4::text', 'sender_relationships.created_at')}`,
            [agentId, [exact, wide], domain, exact],
          );

          const ownerClassifications = await loadEffectiveSeenMarks(client, agentId, exact, domain);

          const suppressions = await client.query<{ address: string; source: SuppressionSource; expires_at: Date | null }>(
            `SELECT s.address, s.source, s.expires_at
               FROM suppression_entries s
               JOIN agents a ON a.organization_id = s.organization_id
              WHERE a.id = $1 AND s.address = $2`,
            [agentId, wide],
          );

          const risks = await client.query<{ risk: InjectionRisk }>(
            `SELECT DISTINCT coalesce(injection_risk, 'medium'::injection_risk) AS risk
               FROM inbound_messages
              WHERE agent_id = $1
                AND from_domain = $2
                AND (from_address = $3 OR from_address = $4 OR from_address LIKE $5 ESCAPE '\\')
                AND from_authenticated
                AND scanner_version IS NOT NULL
                AND injection_risk IS DISTINCT FROM 'none'`,
            [agentId, domain, exact, wide, `${likeEscape(wideLocal)}+%@${likeEscape(domain)}`],
          );

          // 수신 정책이 격리한 메일(`policy_blocked`)은 세지 않는다(202609241040 — 검증 L4). 소유자가 받지 않기로 한 상대가 보낸
          // 메일이 "많이·오래 받아 온 상대" 라는 올리는 사실이 되면, 막힌 채로 쌓은 이력이 신뢰가 된다.
          // 받기 등급(2026-10-08 적대적 검증 S-001) — **숨은 메일 전부**(격리 · 판정 없음 · 위험 보류 · 정책 차단)를 세지 않는다. 풀리지 않은 메일이 보낸 사람의
          // 수신 이력을 올리면 공격자가 차단되는 메일을 거듭 보내 "오래 받아 온 상대" 가 된다. 소유자가 풀어 준 메일(quarantined=false)은 센다.
          const inbound = await client.query<{ count: number; authenticated: number; first_at: Date | null }>(
            `SELECT count(*)::int AS count, count(*) FILTER (WHERE from_authenticated)::int AS authenticated,
                    min(received_at) AS first_at
               FROM inbound_messages
              WHERE agent_id = $1 AND from_address = $2 AND NOT quarantined
                AND ${hostedEvidenceSql('$2::text', 'inbound_messages.received_at')}`,
            [agentId, exact],
          );

          const outbound = await client.query<{ count: number; first_at: Date | null }>(
            `SELECT count(*)::int AS count, min(m.sent_at) AS first_at
               FROM outbound_recipients r
               JOIN messages m ON m.id = r.message_id
              WHERE m.agent_id = $1 AND m.direction = 'outbound' AND m.status = 'sent' AND r.address = ANY($2::text[])
                AND ${hostedEvidenceSql('$3::text', 'coalesce(m.sent_at, m.created_at)')}`,
            [agentId, [exact, wide], exact],
          );

          return {
            relationships: relationships.rows.map((row) => ({
              agentId: row.agent_id,
              scope: row.scope,
              trustCategory: row.trust_category,
              address: row.address,
              domain: row.domain,
              threadId: row.thread_id,
              grantedViaApprovalId: row.granted_via_approval_id,
            })),
            ownerClassifications,
            blocklist,
            suppressions: suppressions.rows.map(
              (row): SuppressionFact => ({ address: row.address, source: row.source, expiresAt: row.expires_at }),
            ),
            priorInjectionRisks: risks.rows.map((row) => row.risk),
            inbound: {
              count: inbound.rows[0]?.count ?? 0,
              authenticatedCount: inbound.rows[0]?.authenticated ?? 0,
              firstAt: inbound.rows[0]?.first_at ?? null,
            },
            outbound: { sentCount: outbound.rows[0]?.count ?? 0, firstAt: outbound.rows[0]?.first_at ?? null },
          };
        },
        'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY',
      );
    },
  };
}
