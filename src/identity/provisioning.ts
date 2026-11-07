/**
 * src/identity/provisioning.ts — 에이전트 프로비저닝. **원자성이 이 파일의 전부다.**
 *
 * 계획 §4B.1: Agent 행과 Keypair 행은 **같은 트랜잭션에서 생성되거나, 둘 다 생성되지 않는다** — 이미 존재하는 에이전트에 나중에 키를 붙이는
 * 소급 발급 경로가 애초에 존재하지 않게 한다(AC-13 의 전제). 키는 `insertAgent` 뒤 · `activateAgent` 앞에서 붙는다 — `agents.status` 는
 * `'provisioning'` 으로 태어나 **키가 붙은 뒤에만** `'active'` 가 된다.
 *
 * **한 트랜잭션에서 만드는 것** (전부 또는 전무):
 *   `organizations`(없으면) → `agents` → **`agent_keypairs` + `passports`(draft)**
 *   → `agent_addresses`(primary) → `agent_policies`(기본 발신 `allowlist_only` · 수신 `all` — 정책 v2, ADR-0007)
 *   → **`agent_contact_rules`(seed → 발신 allow, 정책 v2)** → `policy_versions`(version 1 — 스냅샷에 목록 포함)
 *   → `sender_relationships`(seed — 레거시 승인 모드가 읽는다, P2 AC-a2)
 *   → agent-scoped 토큰 → `agents.status = 'active'`
 *
 * **부분 성공이 왜 치명적인가:** 주소 없는 에이전트는 Stage 1 이 전건 위조로 읽고,
 * 정책 없는 에이전트는 로더가 던져 `evaluation_error` 가 되며(fail closed 라 안전하지만
 * 아무도 원인을 모른다), 버전 없는 정책은 AC-9 가 답할 근거가 없다. 셋 다 "조용히
 * 망가진 에이전트"이고, 조용한 고장은 이 프로젝트가 막으려는 것이다.
 */

import {
  DEFAULT_INBOUND_MODE,
  DEFAULT_OUTBOUND_MODE,
  type AgentAddressRow,
  type AgentId,
  type AgentPolicyRow,
  type AgentRow,
  type ContactRuleDirection,
  type ContactRuleKind,
  type ContactRuleList,
  type ContactRuleRow,
  type InboundMode,
  type JsonObject,
  type OrganizationRow,
  type OutboundMode,
  type PolicyVersionRow,
} from '../db/schema';
import type { KeyCustody } from '../passport/custody';
import { issueAtProvisioning, type KeypairIssueTransaction } from '../passport/keypair';
import { normalizeAddress } from '../policy/policy-loader';
import { policySnapshotOf } from '../policy/policy-snapshot';
import { addressDomain, AGENT_ADDRESS_DOMAIN, buildAgentAddress, type OperatorReservedAddress } from './address';
import { generateAgentId } from './agent-id';
import {
  DEFAULT_AGENT_TOKEN_CAPABILITIES,
  withoutOperatorReservedExclusions,
  issueAgentToken,
  type AgentTokenCapability,
  type IssuedAgentToken,
} from './agent-token';
import { resolveSeedContacts } from './seed-contacts';

// ---------------------------------------------------------------------------
// 기본 정책
// ---------------------------------------------------------------------------

/**
 * 신규 에이전트의 Stage 4 한도. **눈금은 메시지 수**다(`SendCounters` 규약) — 워밍업 캡(`rules/limits.ts`, 조직 전체·**수신자 수**)과 눈금이
 * 달라 서로 파생시키지 않는다. 둘 다 독립적으로 DENY 를 낸다.
 */
export const DEFAULT_POLICY_LIMITS = {
  per_minute: 5,
  per_hour: 30,
  per_day: 100,
  // `MAX_RECIPIENTS_PER_MESSAGE`(50, `rules/content.ts`)는 설정으로 넘을 수 없는 천장이다.
  // 기본값은 그보다 훨씬 낮게 둔다 — 기본값이 천장에 붙어 있으면 천장이 기본값이 된다.
  recipients_per_message: 10,
} as const satisfies JsonObject;

/**
 * Stage 6 첨부 총량의 정책 기본값(바이트) — 옛 기본값 10 MiB. 스위치 `ATMARK_POLICY_ATTACHMENT_FOLLOW_PLAN` 이 켜지면 `null`(요금제를 따른다 —
 * `policy-loader.ts` `resolveContentPolicy`)을 쓴다. 꺼져 있는 것이 기본인 이유: 옛 정책 로더는 `null` 을 읽지 못한다(모든 발송 `evaluation_error`).
 */
export const DEFAULT_MAX_ATTACHMENT_BYTES_TOTAL = 10 * 1024 * 1024;

/** Stage 6 MIME **허용목록**(목록에 없으면 거부). 실행 가능한 타입이 없는 것은 설계다. */
export const DEFAULT_ALLOWED_MIME_TYPES = [
  'application/pdf',
  'image/png',
  'image/jpeg',
  'text/plain',
] as const;

// ---------------------------------------------------------------------------
// 요청 · 결과
// ---------------------------------------------------------------------------

/** 조직 지정 — 판별 유니온(`string | null` 이면 `null` 의 뜻이 호출부마다 달라져 조직 중복 생성 경로가 된다). */
export type OrganizationTarget =
  | { readonly kind: 'existing'; readonly id: string }
  | {
      readonly kind: 'create';
      readonly name: string;
      /**
       * **필수다** — 승인 알림의 수신자(`organizations.owner_email`). `existing` 쪽에 없는 이유: 에이전트를 만드는 호출이 기존 조직의 승인
       * 수신자를 고르는 경로가 되면 안 된다.
       */
      readonly ownerEmail: string;
    };

export interface ProvisionAgentRequest {
  readonly organization: OrganizationTarget;
  readonly agentName: string;
  /** `{localPart}@atmark.ai` 의 앞부분. 검증은 `address.ts` 가 한다. */
  readonly addressLocalPart: string;
  /** 사전 허용 상대 최대 20개 (§3.1 층 2). 그대로 **발신 allow 목록**(정책 v2)이 된다 — 콘솔 생성은 빈 목록이다. */
  readonly seedContacts: readonly string[];
  /** Stage 5 예산(센트). 발급 뒤 **토큰으로는 올릴 수 없다**(`agent-token.ts`). */
  readonly monthlyBudgetCents: number;
  /** `policy_versions.created_by`. 누가 이 정책을 만들었는가 — AC-9 의 축 하나. */
  readonly createdBy: string | null;
  /** `null` 이면 기본값. **optional 이 아니다** — 모든 호출자가 무엇을 주는지 적게 한다. */
  readonly tokenCapabilities: readonly AgentTokenCapability[] | null;
  /**
   * `null` 이면 기본값(`allowlist_only` — ADR-0007). optional 이 아니다. 레거시 모드도 받는다(데모) — 콘솔·CLI 표면은 콘솔 이름 넷만 넘긴다
   * (`admin/ops/policy.ts`).
   */
  readonly outboundMode: OutboundMode | null;
  /** 정책 첨부 총량을 "요금제를 따른다"(`null`)로 쓸지(스위치 `ATMARK_POLICY_ATTACHMENT_FOLLOW_PLAN`). 없으면 옛 기본값 10 MiB(좁은 쪽). */
  readonly attachmentFollowsPlan?: boolean;
  /**
   * 운영자 예약 주소(`buildOperatorReservedAddress` 만 만든다). 있으면 이것이 대표 주소이고 `addressLocalPart` 는 그 로컬파트와 같아야 한다.
   * 예약 판정을 건너뛰는 **유일한** 길이다 — DB 는 운영자 허가 행을 따로 요구한다(없으면 42501). 운영자 CLI 만 채운다.
   */
  readonly operatorReservedAddress?: OperatorReservedAddress;
  /**
   * **고객 도메인 대표**(ADR-0014) — 있으면 대표 주소는 `addressLocalPart@customPrimaryDomain` 이고 @atmark.ai 앵커는 `ax--` 난수로 내부에만
   * 둔다(잠듦). 도메인은 정규화된 소문자 값이고 verified 여부는 DB 가드(P0A05)가 본다. 운영자 예약 주소와 함께 쓸 수 없다.
   */
  readonly customPrimaryDomain?: string;
  /** 소유자 발신 승인 `always` 로 태어난다(ADR-0016) — **자가 등록**(`agents:enroll`)이 안전 기본값으로 켠다. 없으면 auto. */
  readonly requireApproval?: boolean;
}

export interface ProvisionedAgent {
  readonly organization: OrganizationRow;
  readonly agent: AgentRow;
  readonly address: AgentAddressRow;
  readonly policy: AgentPolicyRow;
  readonly policyVersion: PolicyVersionRow;
  /** **평문은 여기서 1회만 나온다.** 저장소에는 sha256 해시만 남았다. */
  readonly token: IssuedAgentToken;
}

/** 프로비저닝 입력이 규격을 벗어남. 트랜잭션을 열기 **전에** 던진다. */
export class ProvisioningError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProvisioningError';
  }
}

// ---------------------------------------------------------------------------
// 저장소 — 트랜잭션 경계가 인터페이스에 박혀 있다
// ---------------------------------------------------------------------------

export interface InsertOrganizationInput {
  readonly name: string;
  /** `resolveOwnerEmail` 을 지난 정규형. */
  readonly ownerEmail: string;
}

export interface InsertAgentInput {
  readonly id: AgentId;
  readonly organizationId: string;
  readonly name: string;
  readonly monthlyBudgetCents: number;
}

export interface InsertAgentAddressInput {
  readonly agentId: AgentId;
  readonly address: string;
  readonly domain: string;
  readonly isPrimary: boolean;
}

export interface InsertAgentPolicyInput {
  readonly agentId: AgentId;
  /** **명시적으로 넘긴다** — DB 기본값에 기대면 스냅샷(코드 상수)과 갈라질 수 있다. 한 값을 두 행에 쓴다. */
  readonly outboundMode: OutboundMode;
  /** 정책 v2. 같은 값이 스냅샷에도 쓰인다. */
  readonly inboundMode: InboundMode;
  readonly limits: JsonObject;
  readonly configJson: JsonObject;
  /** 소유자 발신 승인 `always`(ADR-0016). 없으면 false(auto — DB 기본값과 같다). 같은 값이 스냅샷에도 쓰인다. */
  readonly requireApproval?: boolean;
}

/** 연락처 규칙 1행(정책 v2) — 프로비저닝은 seed 를 발신 allow 로만 쓴다. 값은 `resolveSeedContacts` 를 지난 정규형. */
export interface InsertContactRuleInput {
  readonly agentId: AgentId;
  readonly direction: ContactRuleDirection;
  readonly list: ContactRuleList;
  readonly kind: ContactRuleKind;
  readonly value: string;
  readonly createdBy: string | null;
}

/** seed contact 1명 → `sender_relationships(trust_category='seed')` 1행 (§3.1 층 2, AC-a2). */
export interface InsertSeedRelationshipInput {
  readonly agentId: AgentId;
  /** `resolveSeedContacts` 가 정규화한 주소 — 로더의 판정 키와 같은 모양이다. */
  readonly address: string;
}

export interface InsertPolicyVersionInput {
  readonly agentId: AgentId;
  readonly version: number;
  readonly snapshot: JsonObject;
  readonly createdBy: string | null;
}

export interface InsertAgentTokenInput {
  readonly agentId: AgentId;
  /** **해시만 넘긴다.** 이 인터페이스에 평문 필드가 없는 것이 요점이다. */
  readonly tokenHash: string;
  /** 평문의 끝 4자(표시값, 202609250010) — 비밀이 아니다. */
  readonly hint: string;
  readonly capabilities: readonly AgentTokenCapability[];
}

/** 한 트랜잭션 안의 연산들. `withTransaction` 콜백 밖에서는 얻을 수 없다 — 원자성을 규율이 아니라 타입으로 둔다. */
export interface ProvisioningTransaction extends KeypairIssueTransaction {
  findOrganization(id: string): Promise<OrganizationRow | null>;
  insertOrganization(input: InsertOrganizationInput): Promise<OrganizationRow>;
  insertAgent(input: InsertAgentInput): Promise<AgentRow>;
  insertAgentAddress(input: InsertAgentAddressInput): Promise<AgentAddressRow>;
  /**
   * 고객 도메인 대표의 주소들(앵커 · 고객 별칭 · 선택)을 한 번에 — 돌려주는 행은 고객 별칭(유효 대표). 구현이 없으면(테스트 가짜) 고객 도메인 대표
   * 프로비저닝은 거부된다.
   */
  provisionCustomPrimary?(input: { readonly agentId: AgentId; readonly customAddress: string }): Promise<AgentAddressRow>;
  insertAgentPolicy(input: InsertAgentPolicyInput): Promise<AgentPolicyRow>;
  insertPolicyVersion(input: InsertPolicyVersionInput): Promise<PolicyVersionRow>;
  insertContactRule(input: InsertContactRuleInput): Promise<ContactRuleRow>;
  insertSeedRelationship(input: InsertSeedRelationshipInput): Promise<void>;
  insertAgentToken(input: InsertAgentTokenInput): Promise<void>;
  /**
   * `'provisioning'` → `'active'`. **트랜잭션의 마지막 연산이다** — Stage 0 은 `'active'` 가 아닌 에이전트를 전건 DENY 하므로 롤백이 실패해도
   * 발송은 일어나지 않는다(fail closed 이중화).
   */
  activateAgent(agentId: AgentId): Promise<AgentRow>;
}

/** 트랜잭션 제공자. 계약: **콜백이 던지면 전부 롤백된다**(구현 쪽 통합 테스트가 "중간 실패 후 `agents` 행 0개"를 실증한다). */
export interface ProvisioningStore {
  withTransaction<T>(run: (tx: ProvisioningTransaction) => Promise<T>): Promise<T>;
}

// ---------------------------------------------------------------------------
// 소유자 이메일
// ---------------------------------------------------------------------------

/**
 * `organizations_owner_email_shape` CHECK 와 **같은 문자 집합**이다. 넓히지 않는다 — 승인 알림의 `To:` 헤더에 그대로 들어가므로 공백·제어문자·
 * `<>`·`"`·`,` 가 표현 불가능해야 헤더 인젝션과 "수신자 둘" 이 원천적으로 없다.
 */
const OWNER_EMAIL_PATTERN = /^[a-z0-9._%+-]{1,64}@[a-z0-9-]+(\.[a-z0-9-]+)+$/;

/** RFC 5321 경로 상한. DB CHECK 와 같다. */
const OWNER_EMAIL_MAX_LENGTH = 254;

/**
 * 소유자 이메일 → 정규형(trim + 소문자). 규격 밖이면 `ProvisioningError`. **에이전트 도메인(`atmark.ai` 와 하위)을 거부한다** — 승인 링크가
 * 에이전트 수신함에 떨어지면 에이전트가 자기 요청을 스스로 승인한다(DB CHECK 도 막지만 여기서 먼저 끊어 원인을 말한다).
 */
export function resolveOwnerEmail(raw: string): string {
  const email = raw.trim().toLowerCase();
  if (email.length < 6 || email.length > OWNER_EMAIL_MAX_LENGTH || !OWNER_EMAIL_PATTERN.test(email)) {
    throw new ProvisioningError(`ownerEmail 형식이 아니다: ${JSON.stringify(raw)}`);
  }
  const domain = email.slice(email.indexOf('@') + 1);
  if (domain === AGENT_ADDRESS_DOMAIN || domain.endsWith(`.${AGENT_ADDRESS_DOMAIN}`)) {
    throw new ProvisioningError(
      `ownerEmail 은 에이전트 도메인(${AGENT_ADDRESS_DOMAIN})일 수 없다 — 에이전트가 자기 승인 요청을 받게 된다: ${email}`,
    );
  }
  return email;
}

// ---------------------------------------------------------------------------
// 프로비저닝
// ---------------------------------------------------------------------------

/** 초기 정책 버전 번호 — `agent_policies.current_version` 기본값과 같아야 한다(다르면 첫 평가부터 `PolicyShapeError`). */
export const INITIAL_POLICY_VERSION = 1;

/**
 * 에이전트 프로비저닝. **입력 검증은 트랜잭션 밖, 삽입은 전부 트랜잭션 안** — 트랜잭션 안에서 던지는 것은 DB 가 거부한 것(주소 중복 등)뿐이다.
 *
 * `custody` 는 **필수 인자다** — 기본값이 있으면 운영에서 개발 보관소로 조용히 떨어지는 경로가 된다(§3.5).
 */
export async function provisionAgent(
  store: ProvisioningStore,
  request: ProvisionAgentRequest,
  custody: KeyCustody,
): Promise<ProvisionedAgent> {
  const agentName = request.agentName.trim();
  if (agentName.length === 0 || agentName.length > 200) {
    throw new ProvisioningError(
      `agentName 길이는 1~200 이어야 한다 (agents.name CHECK): ${JSON.stringify(request.agentName)}`,
    );
  }
  if (!Number.isInteger(request.monthlyBudgetCents) || request.monthlyBudgetCents < 0) {
    throw new ProvisioningError(
      `monthlyBudgetCents 는 0 이상의 정수여야 한다: ${JSON.stringify(request.monthlyBudgetCents)}`,
    );
  }

  const outboundMode = request.outboundMode ?? DEFAULT_OUTBOUND_MODE;

  // 조직을 새로 만들 때만 소유자 이메일을 본다 — 트랜잭션 **밖에서** 던진다.
  const organization: OrganizationTarget =
    request.organization.kind === 'create'
      ? { ...request.organization, ownerEmail: resolveOwnerEmail(request.organization.ownerEmail) }
      : request.organization;

  const address = resolveAddress(request);
  const seedContacts = resolveSeedContacts(request.seedContacts);
  // 자기 주소를 allowlist 에 넣으면 스스로에게 보내는 루프가 열린다(R22). 거부 쪽이라 판정형(`+tag` 절단)으로 넓게 본다(`bot+x@` 도 막는다).
  if (seedContacts.some((contact) => normalizeAddress(contact) === address)) {
    throw new ProvisioningError(`seed contact 에 자기 주소를 넣을 수 없다: ${address}`);
  }

  return store.withTransaction(async (tx) =>
    runProvisioning(tx, custody, request, { organization, agentName, address, seedContacts, outboundMode }),
  );
}

/** 대표 주소 — 운영자 예약 주소가 있으면 그것(로컬파트가 맞는지만 본다), 없으면 공통 판정(`buildAgentAddress` — 예약 로컬파트 거부). */
function resolveAddress(request: ProvisionAgentRequest): string {
  const reserved = request.operatorReservedAddress;
  if (request.customPrimaryDomain !== undefined) {
    if (reserved !== undefined) throw new ProvisioningError('운영자 예약 주소와 고객 도메인 대표는 함께 쓸 수 없다');
    if (request.customPrimaryDomain === AGENT_ADDRESS_DOMAIN) throw new ProvisioningError('customPrimaryDomain 은 고객 도메인이다(atmark.ai 아님)');
    return buildAgentAddress(request.addressLocalPart, request.customPrimaryDomain);
  }
  if (reserved === undefined) return buildAgentAddress(request.addressLocalPart);
  if (request.addressLocalPart.trim().toLowerCase() !== reserved.slice(0, reserved.indexOf('@'))) {
    throw new ProvisioningError(`addressLocalPart 가 운영자 예약 주소의 로컬파트와 다르다: ${JSON.stringify(request.addressLocalPart)}`);
  }
  return reserved;
}

interface ValidatedInput {
  readonly organization: OrganizationTarget;
  readonly agentName: string;
  readonly address: string;
  readonly seedContacts: readonly string[];
  readonly outboundMode: OutboundMode;
}

/** 트랜잭션 **안**의 전부 — 이 함수 밖으로 새는 삽입이 없다는 것이 원자성의 실체다. */
async function runProvisioning(
  tx: ProvisioningTransaction,
  custody: KeyCustody,
  request: ProvisionAgentRequest,
  input: ValidatedInput,
): Promise<ProvisionedAgent> {
  const organization = await resolveOrganization(tx, input.organization);

  // `agentId` 는 트랜잭션 안에서 태어난다 — "발급됐지만 저장되지 않은 agentId" 가 로그로 새지 않게(§11B B5).
  const agentId = generateAgentId();

  await tx.insertAgent({
    id: agentId,
    organizationId: organization.id,
    name: input.agentName,
    monthlyBudgetCents: request.monthlyBudgetCents,
  });

  // ★ PP-A (§4B.1) — keypair 생성 → custody 보관 → `agent_keypairs` → `passports`(draft). **이 자리에서만** 일어난다(소급 발급 경로 부재).
  //   반환값을 쓰지 않는다(B5) — draft passport 의 `did` 는 어떤 외부 표면에도 내보내지 않으므로 `ProvisionedAgent` 에 passport 필드가 없다.
  await issueAtProvisioning(tx, custody, agentId);

  // 고객 도메인 대표: 앵커 + 고객 별칭 + 선택이 정의자 함수 하나로 — 돌려받는 행은 고객 별칭(유효 대표)이다. 그 밖에는 대표 주소 행 하나
  // (첫 주소는 항상 primary — primary 없는 에이전트의 발신 주소는 비결정적이다).
  let addressRow: AgentAddressRow;
  if (request.customPrimaryDomain !== undefined) {
    if (tx.provisionCustomPrimary === undefined) throw new ProvisioningError('이 저장소는 고객 도메인 대표를 만들지 못한다');
    addressRow = await tx.provisionCustomPrimary({ agentId, customAddress: input.address });
  } else {
    addressRow = await tx.insertAgentAddress({ agentId, address: input.address, domain: addressDomain(input.address), isPrimary: true });
  }

  const limits: JsonObject = { ...DEFAULT_POLICY_LIMITS };
  // **목록은 여기 없다**(정책 v2 — `agent_contact_rules`). 콘텐츠 가드만.
  const configJson: JsonObject = {
    max_attachment_bytes_total: request.attachmentFollowsPlan === true ? null : DEFAULT_MAX_ATTACHMENT_BYTES_TOTAL,
    allowed_mime_types: [...DEFAULT_ALLOWED_MIME_TYPES],
  };

  const policy = await tx.insertAgentPolicy({
    agentId,
    outboundMode: input.outboundMode,
    inboundMode: DEFAULT_INBOUND_MODE,
    limits,
    configJson,
    ...(request.requireApproval === true ? { requireApproval: true } : {}),
  });

  // **seed contacts 가 곧 발신 allow 목록이다**(§3.1 층 2). 규칙 행이 버전보다 먼저다 — 스냅샷이 그 행들(id 포함)을 싣는다.
  const rules: ContactRuleRow[] = [];
  for (const seed of input.seedContacts) {
    rules.push(
      await tx.insertContactRule({
        agentId,
        direction: 'outbound',
        list: 'allow',
        kind: 'address',
        value: seed,
        createdBy: request.createdBy,
      }),
    );
  }

  // 스냅샷은 목록을 포함한 **정책 전문**이다(§4.3) — 참조만 남기면 AC-9("왜 이 메일이 나갔는가")의 근거가 사후에 변한다.
  const policyVersion = await tx.insertPolicyVersion({
    agentId,
    version: INITIAL_POLICY_VERSION,
    snapshot: policySnapshotOf({
      outboundMode: input.outboundMode,
      inboundMode: DEFAULT_INBOUND_MODE,
      limits,
      configJson,
      rules,
      requireApproval: request.requireApproval === true,
    }),
    createdBy: request.createdBy,
  });

  // seed → standing relationship(AC-a2). 레거시 승인 모드와 전환 공지(`api/seed-contact-store.ts`)가 읽는다 — v2 모드는 allow 목록을 읽는다.
  for (const seed of input.seedContacts) {
    await tx.insertSeedRelationship({ agentId, address: seed });
  }

  // 운영자 예약 주소 에이전트(support@ 등)의 첫 토큰에는 `policy:request` 가 없다(보안 감사 M-1 — 정책은 운영자가 런북으로만 바꾼다).
  const capabilities = request.tokenCapabilities ?? DEFAULT_AGENT_TOKEN_CAPABILITIES;
  const token = issueAgentToken(agentId, request.operatorReservedAddress === undefined ? capabilities : withoutOperatorReservedExclusions(capabilities));

  await tx.insertAgentToken({
    agentId,
    tokenHash: token.tokenHash,
    hint: token.hint,
    capabilities: token.capabilities,
  });

  // 마지막 — `insertAgent` 의 반환은 `'provisioning'` 시점이므로 이 반환을 내보낸다.
  const activated = await tx.activateAgent(agentId);

  return {
    organization,
    agent: activated,
    address: addressRow,
    policy,
    policyVersion,
    token,
  };
}

async function resolveOrganization(
  tx: ProvisioningTransaction,
  target: OrganizationTarget,
): Promise<OrganizationRow> {
  if (target.kind === 'create') {
    return tx.insertOrganization({ name: target.name, ownerEmail: target.ownerEmail });
  }

  const existing = await tx.findOrganization(target.id);
  if (existing === null) {
    // FK 도 막지만 여기서 끊어야 오류가 "무엇이 없었는가"를 말한다.
    throw new ProvisioningError(`조직을 찾을 수 없다: ${target.id}`);
  }
  return existing;
}
