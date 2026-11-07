/**
 * test/unit/identity/fixtures.ts — identity 단위 테스트의 공용 더블. `ProvisioningStore` 의 인메모리 구현이고, **호출 순서를 기록하는 것이
 * 요점**이다(순서·트랜잭션 경계는 반환값으로 드러나지 않는다).
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { toAgentId, type AgentAddressRow, type AgentId, type AgentKeypairRow, type AgentPolicyRow, type AgentRow, type ContactRuleRow, type OrganizationRow, type PassportRow, type PolicyVersionRow } from '../../../src/db/schema';
import type {
  InsertAgentAddressInput,
  InsertAgentInput,
  InsertAgentPolicyInput,
  InsertAgentTokenInput,
  InsertContactRuleInput,
  InsertPolicyVersionInput,
  InsertSeedRelationshipInput,
  ProvisioningStore,
  ProvisioningTransaction,
  ProvisionAgentRequest,
} from '../../../src/identity/provisioning';
import { createLocalDevKeyCustody } from '../../../src/passport/custody-local';
import type { KeyCustody } from '../../../src/passport/custody';
import type { InsertAgentKeypairInput, InsertPassportInput } from '../../../src/passport/keypair';

export const EXISTING_ORG_ID = '11111111-1111-4111-8111-111111111111';

export interface RecordedCalls {
  readonly order: string[];
  agents: InsertAgentInput[];
  addresses: InsertAgentAddressInput[];
  policies: InsertAgentPolicyInput[];
  policyVersions: InsertPolicyVersionInput[];
  /** 정책 v2 — seed 가 발신 allow 규칙으로. */
  contactRules: InsertContactRuleInput[];
  seedRelationships: InsertSeedRelationshipInput[];
  tokens: InsertAgentTokenInput[];
  keypairs: InsertAgentKeypairInput[];
  passports: InsertPassportInput[];
  activated: AgentId[];
  /** `withTransaction` 콜백이 던졌는가 — 롤백이 일어나야 하는 조건. */
  rolledBack: boolean;
}

/** 실패를 주입할 지점. `null` 이면 전부 성공한다. */
export type FailurePoint = keyof Pick<
  ProvisioningTransaction,
  | 'insertAgent'
  | 'insertAgentKeypair'
  | 'insertPassport'
  | 'insertAgentAddress'
  | 'insertAgentPolicy'
  | 'insertPolicyVersion'
  | 'insertContactRule'
  | 'insertSeedRelationship'
  | 'insertAgentToken'
  | 'activateAgent'
>;

export interface FakeStore {
  readonly store: ProvisioningStore;
  readonly calls: RecordedCalls;
}

function organizationRow(id: string, name: string): OrganizationRow {
  return {
    id,
    name,
    ses_tenant_id: null,
    billing_status: 'trialing',
    abuse_freeze: false,
    owner_paused: false,
    review_status: 'active',
    sending_started_at: null,
    created_at: new Date('2026-09-22T00:00:00Z'),
    updated_at: new Date('2026-09-22T00:00:00Z'),
  };
}

export function createFakeStore(failAt: FailurePoint | null = null): FakeStore {
  const calls: RecordedCalls = {
    order: [],
    agents: [],
    addresses: [],
    policies: [],
    policyVersions: [],
    contactRules: [],
    seedRelationships: [],
    tokens: [],
    keypairs: [],
    passports: [],
    activated: [],
    rolledBack: false,
  };

  const failIfRequested = (point: FailurePoint): void => {
    if (failAt === point) throw new Error(`injected failure at ${point}`);
  };

  const tx: ProvisioningTransaction = {
    findOrganization(id) {
      calls.order.push('findOrganization');
      return Promise.resolve(id === EXISTING_ORG_ID ? organizationRow(id, 'Atmark') : null);
    },
    insertOrganization(input) {
      calls.order.push('insertOrganization');
      return Promise.resolve(organizationRow(EXISTING_ORG_ID, input.name));
    },
    insertAgent(input) {
      calls.order.push('insertAgent');
      failIfRequested('insertAgent');
      calls.agents.push(input);
      return Promise.resolve({
        id: input.id,
        organization_id: input.organizationId,
        name: input.name,
        // **`'provisioning'` 으로 태어난다.** 활성화는 트랜잭션 마지막이다.
        status: 'provisioning',
        plan: 'free',
        monthly_budget_cents: input.monthlyBudgetCents,
        created_at: new Date('2026-09-22T00:00:00Z'),
        updated_at: new Date('2026-09-22T00:00:00Z'),
      } satisfies AgentRow);
    },
    insertAgentKeypair(input) {
      calls.order.push('insertAgentKeypair');
      failIfRequested('insertAgentKeypair');
      calls.keypairs.push(input);
      return Promise.resolve({
        agent_id: input.agentId,
        public_key: input.publicKey,
        algorithm: input.algorithm,
        key_ref: input.keyRef,
        created_at: new Date('2026-09-22T00:00:00Z'),
      } satisfies AgentKeypairRow);
    },
    insertPassport(input) {
      calls.order.push('insertPassport');
      failIfRequested('insertPassport');
      calls.passports.push(input);
      return Promise.resolve({
        id: '44444444-4444-4444-8444-444444444444',
        agent_id: input.agentId,
        did: input.did,
        // 컬럼 기본값과 같아야 한다 — `issueAtProvisioning` 이 "draft 만 만든다"를 이 값으로 자기 검증한다.
        status: 'draft',
        controller: input.controller,
        metadata_uri: null,
        content_hash: null,
        version: input.version,
        issued_at: new Date('2026-09-22T00:00:00Z'),
        superseded_at: null,
      } satisfies PassportRow);
    },
    insertAgentAddress(input) {
      calls.order.push('insertAgentAddress');
      failIfRequested('insertAgentAddress');
      calls.addresses.push(input);
      return Promise.resolve({
        id: '22222222-2222-4222-8222-222222222222',
        agent_id: input.agentId,
        address: input.address,
        domain: input.domain,
        is_primary: input.isPrimary,
        created_at: new Date('2026-09-22T00:00:00Z'),
      } satisfies AgentAddressRow);
    },
    insertAgentPolicy(input) {
      calls.order.push('insertAgentPolicy');
      failIfRequested('insertAgentPolicy');
      calls.policies.push(input);
      return Promise.resolve({
        agent_id: input.agentId,
        outbound_mode: input.outboundMode,
        inbound_mode: input.inboundMode,
        require_approval: false,
        limits: input.limits,
        config_json: input.configJson,
        current_version: 1,
        created_at: new Date('2026-09-22T00:00:00Z'),
        updated_at: new Date('2026-09-22T00:00:00Z'),
      } satisfies AgentPolicyRow);
    },
    insertPolicyVersion(input) {
      calls.order.push('insertPolicyVersion');
      failIfRequested('insertPolicyVersion');
      calls.policyVersions.push(input);
      return Promise.resolve({
        id: '33333333-3333-4333-8333-333333333333',
        agent_id: input.agentId,
        version: input.version,
        outbound_mode: input.snapshot['outbound_mode'] as PolicyVersionRow['outbound_mode'],
        inbound_mode: input.snapshot['inbound_mode'] as PolicyVersionRow['inbound_mode'],
        snapshot: input.snapshot,
        created_by: input.createdBy,
        created_at: new Date('2026-09-22T00:00:00Z'),
      } satisfies PolicyVersionRow);
    },
    insertContactRule(input) {
      calls.order.push('insertContactRule');
      failIfRequested('insertContactRule');
      calls.contactRules.push(input);
      return Promise.resolve({
        id: `44444444-4444-4444-8444-${String(calls.contactRules.length).padStart(12, '0')}`,
        agent_id: input.agentId,
        direction: input.direction,
        list: input.list,
        kind: input.kind,
        value: input.value,
        created_at: new Date('2026-09-22T00:00:00Z'),
        created_by: input.createdBy,
        removed_at: null,
        removed_by: null,
      } satisfies ContactRuleRow);
    },
    insertSeedRelationship(input) {
      calls.order.push('insertSeedRelationship');
      failIfRequested('insertSeedRelationship');
      calls.seedRelationships.push(input);
      return Promise.resolve();
    },
    insertAgentToken(input) {
      calls.order.push('insertAgentToken');
      failIfRequested('insertAgentToken');
      calls.tokens.push(input);
      return Promise.resolve();
    },
    activateAgent(agentId) {
      calls.order.push('activateAgent');
      failIfRequested('activateAgent');
      calls.activated.push(agentId);
      const inserted = calls.agents[0];
      return Promise.resolve({
        id: agentId,
        organization_id: inserted?.organizationId ?? EXISTING_ORG_ID,
        name: inserted?.name ?? 'agent',
        status: 'active',
        plan: 'free',
        monthly_budget_cents: inserted?.monthlyBudgetCents ?? 0,
        created_at: new Date('2026-09-22T00:00:00Z'),
        updated_at: new Date('2026-09-22T00:00:00Z'),
      } satisfies AgentRow);
    },
  };

  const store: ProvisioningStore = {
    async withTransaction(run) {
      calls.order.push('withTransaction:begin');
      try {
        const result = await run(tx);
        calls.order.push('withTransaction:commit');
        return result;
      } catch (error) {
        // 실제 구현의 계약: 콜백이 던지면 **전부 롤백된다.**
        calls.rolledBack = true;
        calls.order.push('withTransaction:rollback');
        throw error;
      }
    },
  };

  return { store, calls };
}

export function provisionRequest(
  overrides: Partial<ProvisionAgentRequest> = {},
): ProvisionAgentRequest {
  return {
    organization: { kind: 'existing', id: EXISTING_ORG_ID },
    agentName: 'Atmark Assistant',
    addressLocalPart: 'assistant',
    seedContacts: ['jinyounkyum@gmail.com'],
    monthlyBudgetCents: 5000,
    createdBy: 'owner_provisioning',
    tokenCapabilities: null,
    outboundMode: null,
    ...overrides,
  };
}

/** 단위 테스트용 키 보관소. **OS 임시 디렉터리를 쓴다** — 기본값이면 리포 워킹트리에 개인키 파일이 남는다. */
export function testKeyCustody(): KeyCustody {
  return createLocalDevKeyCustody({
    directory: mkdtempSync(join(tmpdir(), 'atmark-keys-')),
    // `NODE_ENV=production` 러너에서도 개발 경로를 쓴다(운영 가드는 `test/unit/passport/custody.test.ts`).
    env: {},
  });
}

/** 테스트용 고정 `AgentId`. 형식 검증을 실제로 통과하는 값이어야 한다. */
export const OTHER_AGENT_ID: AgentId = toAgentId('0123456789abcdef0123456789abcdef');
