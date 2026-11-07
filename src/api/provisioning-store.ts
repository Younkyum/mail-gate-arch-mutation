/**
 * src/api/provisioning-store.ts — `ProvisioningStore` 의 Postgres 구현.
 *
 * `src/identity/provisioning.ts` 가 **원자성을 타입으로 못박아 두었다**: 삽입 연산은
 * `withTransaction` 의 콜백 안에서만 얻을 수 있는 핸들 위에만 존재한다. 이 파일은 그
 * 핸들을 실제 커넥션 하나에 묶는다 — 즉 **여기서 풀(pool)을 쓰면 그 설계가 무너진다.**
 * 풀을 쓰면 여섯 번의 INSERT 가 여섯 개의 커넥션에 흩어지고, 그러면 "전부 또는 전무" 가
 * 아니라 "여섯 번의 독립 커밋" 이 된다. **모든 연산이 같은 `PoolClient` 위에서 돈다.**
 *
 * 그 계약을 어기면 `provisioning.ts` 의 모든 주장이 거짓이 되므로, 통합 테스트가
 * "중간 실패 후 `agents` 행 0개" 를 실증한다(§6 P1c Acceptance 의 원자성 테스트).
 */

import type { Pool, PoolClient } from 'pg';

import { withTransaction } from '../db/client';
import {
  toAgentId,
  type AgentAddressRow,
  type AgentKeypairRow,
  type AgentPolicyRow,
  type AgentId,
  type AgentRow,
  type ContactRuleRow,
  type InboundMode,
  type OrganizationRow,
  type OutboundMode,
  type PassportRow,
  type PolicyVersionRow,
} from '../db/schema';
import type {
  InsertAgentAddressInput,
  InsertAgentInput,
  InsertAgentPolicyInput,
  InsertAgentTokenInput,
  InsertContactRuleInput,
  InsertOrganizationInput,
  InsertPolicyVersionInput,
  InsertSeedRelationshipInput,
  ProvisioningStore,
  ProvisioningTransaction,
} from '../identity/provisioning';
import { ProvisioningError } from '../identity/provisioning';
import { MAIL_IDENTITY_CONFLICT_SQLSTATE } from '../domains/contract';
import { provisionCustomPrimary } from '../identity/primary';
import type { InsertAgentKeypairInput, InsertPassportInput } from '../passport/keypair';

async function one<T>(client: PoolClient, text: string, values: unknown[]): Promise<T> {
  const result = await client.query(text, values);
  const row = result.rows[0];
  if (row === undefined) {
    // 트랜잭션 안에서 던진다 → 콜백이 던진다 → `withTransaction` 이 ROLLBACK 한다.
    // 0행을 조용히 넘기면 부분 성공한 에이전트가 남고, 그것이 곧 "조용히 망가진
    // 에이전트" 다(provisioning.ts 머리말).
    throw new Error(`INSERT/UPDATE 가 행을 돌려주지 않았다: ${text.split('\n')[0] ?? text}`);
  }
  return row as T;
}

/** `agents.id` 는 브랜드 타입이다. DB 에서 돌아온 문자열을 그 경계에서 한 번 승격한다. */
function toAgentRow(row: AgentRow): AgentRow {
  return { ...row, id: toAgentId(row.id) };
}

const ORGANIZATION_COLUMNS =
  'id, name, ses_tenant_id, billing_status, abuse_freeze, owner_paused, review_status, sending_started_at, created_at, updated_at';
const AGENT_COLUMNS =
  'id, organization_id, name, status, plan, monthly_budget_cents, created_at, updated_at';
const AGENT_ADDRESS_COLUMNS = 'id, agent_id, address, domain, is_primary, created_at';
const AGENT_POLICY_COLUMNS =
  'agent_id, outbound_mode, inbound_mode, require_approval, limits, config_json, current_version, created_at, updated_at';
const POLICY_VERSION_COLUMNS = 'id, agent_id, version, outbound_mode, inbound_mode, snapshot, created_by, created_at';
const CONTACT_RULE_COLUMNS = 'id, agent_id, direction, list, kind, value, created_at, created_by, removed_at, removed_by';
const AGENT_KEYPAIR_COLUMN_LIST = 'agent_id, public_key, algorithm, key_ref, created_at';
const PASSPORT_COLUMNS =
  'id, agent_id, did, status, controller, metadata_uri, content_hash, version, issued_at, superseded_at';

/**
 * 스냅샷에서 `outbound_mode` 를 읽는다.
 *
 * `InsertPolicyVersionInput` 에는 그 필드가 없다 — 스냅샷이 **정책 전문**이므로 모드는
 * 이미 그 안에 있고, 밖에 한 번 더 두면 두 값이 갈라질 수 있다(그리고 갈라진 순간
 * `policy_versions.outbound_mode` 와 `snapshot.outbound_mode` 중 어느 쪽이 근거인지
 * 답이 둘이 된다). 모양이 어긋나면 기본값으로 떨어지는 대신 **던진다** — 조용히
 * `allowlist_only` 로 굴러떨어지면 그 에이전트의 감사 근거가 거짓이 된다.
 */
function outboundModeOf(input: InsertPolicyVersionInput): OutboundMode {
  const mode = input.snapshot['outbound_mode'];
  if (typeof mode !== 'string') {
    throw new Error('policy_versions.snapshot 에 outbound_mode 가 없다 — 스냅샷이 정책 전문이 아니다.');
  }
  // DB ENUM(`outbound_mode`)이 값 집합을 닫는다. 여기서 재검증하면 판정이 두 곳이 된다.
  return mode as OutboundMode;
}

/** 스냅샷에서 `inbound_mode` 를 읽는다 — `outboundModeOf` 와 같은 이유로 밖에 한 번 더 두지 않는다(정책 v2). */
function inboundModeOf(input: InsertPolicyVersionInput): InboundMode {
  const mode = input.snapshot['inbound_mode'];
  if (typeof mode !== 'string') {
    throw new Error('policy_versions.snapshot 에 inbound_mode 가 없다 — 스냅샷이 정책 전문이 아니다.');
  }
  return mode as InboundMode;
}

function transactionOn(client: PoolClient): ProvisioningTransaction {
  return {
    async findOrganization(id: string): Promise<OrganizationRow | null> {
      const result = await client.query(
        `SELECT ${ORGANIZATION_COLUMNS} FROM organizations WHERE id = $1`,
        [id],
      );
      return (result.rows[0] as OrganizationRow | undefined) ?? null;
    },

    insertOrganization(input: InsertOrganizationInput): Promise<OrganizationRow> {
      // `owner_email` 은 `resolveOwnerEmail` 을 지난 값이다. DB CHECK(`organizations_owner_email_shape`)가
      // 같은 형태를 한 번 더 막는다 — 호출부가 정규화를 빠뜨리면 여기서 INSERT 가 실패한다(롤백).
      //
      // **쓰기만 하고 RETURNING 하지 않는다.** `owner_email` 을 읽는 코드는 알림 모듈
      // (`src/notify/approval-notifier.ts`) 하나뿐이어야 한다 — 승인 알림의 수신자가 나오는 곳이
      // 한 군데라는 것이 그 경로의 정적 보증이다(`test/arch/gate-chokepoint.arch.test.ts`).
      return one<OrganizationRow>(
        client,
        `INSERT INTO organizations (name, owner_email) VALUES ($1, $2) RETURNING ${ORGANIZATION_COLUMNS}`,
        [input.name, input.ownerEmail],
      ).catch((error: unknown) => {
        // 소유자 주소가 에이전트 주소이거나 에이전트 전용 도메인에 있다(P0A01, ADR-0014 · 202609291110) — 500 이 아니라 입력 오류.
        if (typeof error === 'object' && error !== null && (error as { code?: unknown }).code === MAIL_IDENTITY_CONFLICT_SQLSTATE) {
          throw new ProvisioningError('owner_email 은 에이전트 주소일 수 없다(에이전트 전용 도메인 포함).');
        }
        throw error;
      });
    },

    async insertAgent(input: InsertAgentInput): Promise<AgentRow> {
      // `status` 를 넘기지 않는다 — 컬럼 기본값이 `'provisioning'` 이고, `'active'` 는
      // `activateAgent` 만이 만든다. 여기서 활성으로 태어나면 키(P1c)가 붙기 전의
      // 에이전트가 발송 가능한 상태가 된다.
      const row = await one<AgentRow>(
        client,
        `INSERT INTO agents (id, organization_id, name, monthly_budget_cents)
         VALUES ($1, $2, $3, $4) RETURNING ${AGENT_COLUMNS}`,
        [input.id, input.organizationId, input.name, input.monthlyBudgetCents],
      );
      return toAgentRow(row);
    },

    /**
     * ★ **`agent_keypairs` 에 대한 유일한 쓰기 문장이다** (§4B.1, AC-13).
     *
     * `INSERT` 하나뿐이고 `UPDATE`/`DELETE` 는 이 리포 `src/**` 어디에도 없다 —
     * `test/arch/keypair-immutability.arch.test.ts` 가 그 부재를 단언하고,
     * DB 는 트리거(`agent_keypairs_immutable`/`_no_delete`)와 권한(앱 롤에 UPDATE·
     * DELETE 미부여) **두 층**으로 같은 것을 막는다.
     *
     * `ON CONFLICT` 가 없는 것이 의도다. `agent_id` 가 PK 이므로 두 번째 INSERT 는
     * 23505 로 죽는다 — 그리고 **죽는 것이 옳다.** `ON CONFLICT DO UPDATE` 는 키 교체,
     * `DO NOTHING` 은 "키가 안 붙었는데 성공했다"는 조용한 거짓말이다.
     */
    insertAgentKeypair(input: InsertAgentKeypairInput): Promise<AgentKeypairRow> {
      return one<AgentKeypairRow>(
        client,
        `INSERT INTO agent_keypairs (agent_id, public_key, algorithm, key_ref)
         VALUES ($1, $2, $3::keypair_algorithm, $4) RETURNING ${AGENT_KEYPAIR_COLUMN_LIST}`,
        [input.agentId, input.publicKey, input.algorithm, input.keyRef],
      );
    },

    /**
     * draft passport 1행. **`status` 를 넘기지 않는다** — 컬럼 기본값이 `'draft'` 이고
     * 그 근거는 마이그레이션 주석에 있다(§4B.2: PP-A 는 서빙·서명을 하지 않는다).
     * 여기서 값을 지정하면 "PP-A 가 만드는 것은 draft 뿐" 이라는 사실의 근거가 둘이 된다.
     */
    insertPassport(input: InsertPassportInput): Promise<PassportRow> {
      return one<PassportRow>(
        client,
        `INSERT INTO passports (agent_id, did, controller, version)
         VALUES ($1, $2, $3, $4) RETURNING ${PASSPORT_COLUMNS}`,
        [input.agentId, input.did, input.controller, input.version],
      );
    },

    /**
     * 고객 도메인 대표(ADR-0014 2026-10 개정 · M3b) — 앵커(`ax--` 난수 · 잠듦) + 고객 별칭 + 선택(`provision`)을 정의자 함수 하나로
     * (`provisionCustomPrimary` — 앵커 이름 충돌 P0A10 은 SAVEPOINT 로 그 시도만 되돌리고 새 난수로). 돌려주는 행은 **고객 별칭**(유효 대표)이다 —
     * 잠든 앵커의 주소는 이 함수 밖으로 나가지 않는다.
     */
    async provisionCustomPrimary(input: { readonly agentId: AgentId; readonly customAddress: string }): Promise<AgentAddressRow> {
      const provisioned = await provisionCustomPrimary(client, input);
      return one<AgentAddressRow>(client, `SELECT ${AGENT_ADDRESS_COLUMNS} FROM agent_addresses WHERE id = $1`, [provisioned.customId]);
    },

    insertAgentAddress(input: InsertAgentAddressInput): Promise<AgentAddressRow> {
      return one<AgentAddressRow>(
        client,
        `INSERT INTO agent_addresses (agent_id, address, domain, is_primary)
         VALUES ($1, $2, $3, $4) RETURNING ${AGENT_ADDRESS_COLUMNS}`,
        [input.agentId, input.address, input.domain, input.isPrimary],
      );
    },

    insertAgentPolicy(input: InsertAgentPolicyInput): Promise<AgentPolicyRow> {
      // **`outbound_mode` 를 명시한다 (P2).** P1 은 DB 기본값에 기댔고 스냅샷은 코드 상수를 썼다 —
      // 두 기본값이 한 번이라도 갈라지면 정책 행과 판정 근거가 다른 모드를 말한다. 이제 한 값
      // (`provisionAgent` 가 정한 것)이 두 행에 쓰인다. DB 기본값은 이 경로 밖의 INSERT 를 위한 것이다.
      return one<AgentPolicyRow>(
        client,
        `INSERT INTO agent_policies (agent_id, outbound_mode, inbound_mode, limits, config_json, current_version, require_approval)
         VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6, $7) RETURNING ${AGENT_POLICY_COLUMNS}`,
        [
          input.agentId,
          input.outboundMode,
          input.inboundMode,
          JSON.stringify(input.limits),
          JSON.stringify(input.configJson),
          1,
          input.requireApproval === true,
        ],
      );
    },

    async insertContactRule(input: InsertContactRuleInput): Promise<ContactRuleRow> {
      // 값·종류는 DB CHECK(`agent_contact_rules_value_kind`)가 한 번 더 본다. `ON CONFLICT` 없음 — 새 에이전트의 목록은
      // `resolveSeedContacts` 가 중복을 이미 뺐다. 충돌은 버그이고 롤백이 맞다.
      const row = await one<ContactRuleRow>(
        client,
        `INSERT INTO agent_contact_rules (agent_id, direction, list, kind, value, created_by)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING ${CONTACT_RULE_COLUMNS}`,
        [input.agentId, input.direction, input.list, input.kind, input.value, input.createdBy],
      );
      return { ...row, agent_id: toAgentId(row.agent_id) };
    },

    async insertSeedRelationship(input: InsertSeedRelationshipInput): Promise<void> {
      // `granted_by = 'owner_provisioning'` (§3.1 층 2). seed 는 DB CHECK 가 `recipient` 스코프·승인 id
      // 없음으로 고정한다. `ON CONFLICT` 가 없다 — `resolveSeedContacts` 가 중복을 이미 제거했고,
      // 새 에이전트에 기존 관계가 있을 수 없다. 충돌하면 그건 버그이고 롤백이 맞다.
      await client.query(
        `INSERT INTO sender_relationships (agent_id, scope, address, trust_category, granted_by)
         VALUES ($1, 'recipient', $2, 'seed', 'owner_provisioning')`,
        [input.agentId, input.address],
      );
    },

    insertPolicyVersion(input: InsertPolicyVersionInput): Promise<PolicyVersionRow> {
      return one<PolicyVersionRow>(
        client,
        `INSERT INTO policy_versions (agent_id, version, outbound_mode, inbound_mode, snapshot, created_by)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6) RETURNING ${POLICY_VERSION_COLUMNS}`,
        [
          input.agentId,
          input.version,
          outboundModeOf(input),
          inboundModeOf(input),
          JSON.stringify(input.snapshot),
          input.createdBy,
        ],
      );
    },

    async insertAgentToken(input: InsertAgentTokenInput): Promise<void> {
      // `expires_at` 은 `null` — 무기한이다. P1b 의 demo 토큰이 그렇다
      // (`AgentTokenRecord.expiresAt` 주석). 만료 정책은 P1c 의 발급 API 가 정한다.
      await client.query(
        `INSERT INTO agent_api_keys (agent_id, token_hash, capabilities, expires_at, hint)
         VALUES ($1, $2, $3::agent_token_capability[], NULL, $4)`,
        [input.agentId, input.tokenHash, [...input.capabilities], input.hint],
      );
    },

    async activateAgent(agentId: AgentId): Promise<AgentRow> {
      const row = await one<AgentRow>(
        client,
        `UPDATE agents SET status = 'active' WHERE id = $1 RETURNING ${AGENT_COLUMNS}`,
        [agentId],
      );
      return toAgentRow(row);
    },
  };
}

export function createPostgresProvisioningStore(pool: Pool): ProvisioningStore {
  return {
    withTransaction<T>(run: (tx: ProvisioningTransaction) => Promise<T>): Promise<T> {
      return withTransaction(pool, (client) => run(transactionOn(client)));
    },
  };
}
