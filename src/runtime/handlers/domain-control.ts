/**
 * `atmark-domain-control` — 고객 도메인의 **SES 제어면 · DNS · RDAP**(ADR-0014 결정 3 · 계획 §3.5 C1). **DB 없음 · VPC 밖 · 예약 2.**
 *
 * 부르는 쪽은 확인 틱 하나(admin λ 안 — `runtime/domain-control-invoker.ts`, IAM 은 admin 역할에 이 함수 ARN 하나). 입력은 배치
 * `{ "batch": DomainControlRequest[] }` 이고 결과는 `{ "results": DomainControlResult[] }` — **같은 순서 · 같은 길이**(계약).
 *
 * 규율:
 *   - **엄격 파싱.** 키 집합이 op 마다 정확히 같아야 한다 — 모르는 키(예: `principal`)·빠진 키·틀린 모양은 배치 전체를 **던진다**(호출 실패).
 *     도메인은 `judgeCustomDomain` 을 다시 통과하고 `registrable` 이 그 판정과 같아야 한다(`atmark.ai` · apex · 공용 메일 도메인은 여기서 떨어진다).
 *     주소 목록의 **뜻**이 틀리면(다른 도메인 · 로컬파트 문법 · 예약 · 천장 초과) 그 항목만 `rejected_input`(동기화) / `error`(감사)다.
 *   - **Principal 은 입력에 없다** — identity policy 의 Principal 은 배포 환경변수 `SENDER_ROLE_ARN`(128자 이하 · IAM 역할 ARN 모양) 하나로만
 *     조립한다. 계정 id 도 그 ARN 에서 온다. 어긋나면 기동하지 않는다.
 *   - **변형 호출 전에 identity 의 태그 `atmark:row` 를 이 행과 대조한다**(H1 ②). 다른 행이면 SES 변형 호출 0 — 사가는
 *     `identity_owned_elsewhere`(그 태그 값), 제거·동기화·감사는 `not_owner`. 태그 없는 identity(스파이크 · 콘솔 수동)도 남의 것이다.
 *     `AlreadyExists`/이미 있는 identity 는 태그가 이 행이거나 **`supersededRowId`(채택해도 되는 직전 관리자 행 — 양도의 옛 행 · 선점 인수 ·
 *     넘겨주기, 2026-10 one-shot 에서 뜻을 넓혔다. 틱이 DB `identity_handover_to = 이 행` 으로만 채운다)** 일 때만 채택한다(태그를 이 행으로 바꾸고 남의
 *     정책을 곧바로 지운다). identity 를 지우지 않으므로 DKIM 토큰이 바뀌지 않는다.
 *   - `check` 는 소유 TXT 를 **두 이름**(`_atmark-challenge.<domain>` · `_atmark-challenge.<registrable>`)에 묻고 OR 로 합친다(`dns-lookup.ts`).
 *   - `peek_identity` 는 **읽기 전용**(GetEmailIdentity 하나 · 태그 무관 · 변형 0). 태그 `atmark:row` = 이 행이면 DKIM·MAIL FROM 상태까지, 아니면
 *     토큰만(상태 `unknown` — 다른 행의 진행을 보여 주지 않는다).
 *   - **`too_large` 면 기존 정책을 건드리지 않는다**(지우지도 줄이지도 않는다 — 계약 `identityPolicyChunks`).
 *   - 결과에는 판정 코드 · DKIM 토큰·상태 · 다이제스트만. DNS 원문·정책 원문·도메인명은 로그에도 싣지 않는다. `errorCode` 는 SES 예외 이름 ·
 *     `dns_*` · `rdap_*` 같은 코드 모양 문자열이다.
 *
 * IAM(compute-stack): SES identity 제어면 명령만 허용 · `identity/atmark.ai`·`*.atmark.ai` 의 `ses:*` 와 `SendEmail`·`SendRawEmail` 명시 Deny.
 */

import { createHash } from 'node:crypto';

import {
  CUSTOM_DOMAIN_REMOVAL_STEPS,
  CUSTOM_DOMAIN_SAGA_STEPS,
  customDomainAddressCeiling,
  DOMAIN_TICK_PENDING_BUDGET,
  DOMAIN_TICK_RECHECK_BUDGET,
  IDENTITY_MANAGED_TAG,
  IDENTITY_MANAGED_TAG_VALUE,
  IDENTITY_POLICY_NAME_PREFIX,
  IDENTITY_ROW_TAG,
  identityPolicyChunks,
  identityPolicyDocument,
  MAIL_FROM_LABEL,
  SENDER_ROLE_ARN_MAX_LENGTH,
  CHALLENGE_TOKEN_SHAPE,
  type CustomDomainSesStatus,
  type DomainControlRequest,
  type DomainControlResult,
  type IdentityPolicyFrame,
} from '../../domains/contract';
import { createDnsLookup, type DnsLookup } from '../../domains/dns-lookup';
import { judgeCustomDomain } from '../../domains/names';
import { rdapExpiration, type RdapExpiryResult } from '../../domains/rdap';
import { buildAgentAddress } from '../../identity/address';
import { createSesIdentityControl, type SesIdentityControl, type SesIdentitySnapshot } from '../../mail/transport/ses-identity';
import { log } from '../../observability/logger';
import { requireEnv, requireProductionRuntime, RUNTIME_ENV, RuntimeConfigError } from '../config';

export const DOMAIN_CONTROL_ROUTE_ID = 'domain-control';

/** DB 연결 예산에 더하는 값 — DB 가 없다(`compute-stack.ts` 연결 예산 · `BILLING_WEBHOOK_POOL_MAX` 와 같은 자리). */
export const DOMAIN_CONTROL_POOL_MAX = 0;

/** 배치 하나의 상한 — 틱 예산 P + R(계약). 넘으면 던진다. */
export const DOMAIN_CONTROL_MAX_BATCH = DOMAIN_TICK_PENDING_BUDGET + DOMAIN_TICK_RECHECK_BUDGET;

/**
 * SES 리전 — 계약의 `identityPolicyDocument` 가 Resource 에 `ap-northeast-2` 를 고정한다. `ses-transport.ts` 의 같은 상수를 import 하지 않는다 —
 * 그 파일은 발송 명령을 싣는다(이 번들에 `SendEmail` 이 들어오지 않게 — `test/unit/runtime/bundle.test.ts`).
 */
export const DOMAIN_CONTROL_REGION = 'ap-northeast-2';

/** RDAP 한 번의 시간 상한 — λ 타임아웃(12초)·호출 상한(10초) 안. */
export const DOMAIN_CONTROL_RDAP_TIMEOUT_MS = 5_000;
/** RDAP 조회 전체(리다이렉트·끝점 포함)의 마감 — 호출 상한 10초 안(보안 리뷰 L4). */
export const DOMAIN_CONTROL_RDAP_DEADLINE_MS = 8_000;

/** 발송 역할 ARN 모양 — 같은 계정의 IAM 역할(경로 없음). 계정 id 를 여기서 뽑는다. */
const SENDER_ROLE_ARN_PATTERN = /^arn:aws:iam::(\d{12}):role\/[A-Za-z0-9+=,.@_-]{1,64}$/;

const ROW_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const ERROR_CODE_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

/** 입력이 계약 밖이다 — 배치 전체를 거부한다(호출 실패로 드러난다). 메시지에 값을 싣지 않는다. */
export class DomainControlInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DomainControlInputError';
  }
}

export interface DomainControlDependencies {
  readonly ses: SesIdentityControl;
  readonly dns: DnsLookup;
  readonly rdap: (registrable: string) => Promise<RdapExpiryResult>;
  /** identity policy 의 Principal — 환경변수에서만. */
  readonly senderRoleArn: string;
  readonly accountId: string;
  readonly region: string;
  /** 고객 identity 에 붙이는 구성 세트(`atmark-default`). */
  readonly configurationSet: string;
}

// ---------------------------------------------------------------------------
// 입력 — 엄격 파싱
// ---------------------------------------------------------------------------

const BASE_KEYS = ['op', 'rowId', 'domain', 'registrable'] as const;
const OP_KEYS: Readonly<Record<DomainControlRequest['op'], readonly string[]>> = {
  check: ['token'],
  saga_step: ['step', 'supersededRowId'],
  remove_step: ['step'],
  sync_policy: ['addresses'],
  audit_policy: ['addresses', 'expectedDigest'],
  check_expiry: [],
  peek_identity: [],
};
const SAGA_STEPS = CUSTOM_DOMAIN_SAGA_STEPS.filter((step) => step !== 'none' && step !== 'done');
const REMOVAL_STEPS = CUSTOM_DOMAIN_REMOVAL_STEPS.filter((step) => step !== 'none' && step !== 'done');

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sameKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value).sort();
  const want = [...expected].sort();
  return keys.length === want.length && keys.every((key, i) => key === want[i]);
}

function requireString(value: unknown, what: string): string {
  if (typeof value !== 'string') throw new DomainControlInputError(`${what} 가 문자열이 아니다`);
  return value;
}

function parseRequest(raw: unknown, index: number): DomainControlRequest {
  const at = `batch[${String(index)}]`;
  if (!isRecord(raw)) throw new DomainControlInputError(`${at} 가 객체가 아니다`);
  const op = raw['op'];
  if (typeof op !== 'string' || !Object.hasOwn(OP_KEYS, op)) throw new DomainControlInputError(`${at}.op 가 계약 밖이다`);
  const typedOp = op as DomainControlRequest['op'];
  // ★ 키 집합이 정확히 같아야 한다 — `principal` 같은 칸이 끼면 던진다(Principal 은 환경변수로만).
  if (!sameKeys(raw, [...BASE_KEYS, ...OP_KEYS[typedOp]])) throw new DomainControlInputError(`${at} 의 키 집합이 ${typedOp} 계약과 다르다`);
  const rowId = requireString(raw['rowId'], `${at}.rowId`);
  if (!ROW_ID_PATTERN.test(rowId)) throw new DomainControlInputError(`${at}.rowId 가 uuid 가 아니다`);
  const domain = requireString(raw['domain'], `${at}.domain`);
  const registrable = requireString(raw['registrable'], `${at}.registrable`);
  const verdict = judgeCustomDomain(domain);
  if (!verdict.ok || verdict.domain !== domain || verdict.registrable !== registrable) {
    throw new DomainControlInputError(`${at} 의 도메인이 고객 도메인 판정을 지나지 못한다`);
  }
  const base = { rowId, domain, registrable };
  switch (typedOp) {
    case 'check': {
      const token = requireString(raw['token'], `${at}.token`);
      if (!CHALLENGE_TOKEN_SHAPE.test(token)) throw new DomainControlInputError(`${at}.token 모양이 틀리다`);
      return { op: 'check', ...base, token };
    }
    case 'saga_step': {
      const step = raw['step'];
      if (typeof step !== 'string' || !(SAGA_STEPS as readonly string[]).includes(step)) throw new DomainControlInputError(`${at}.step 이 계약 밖이다`);
      const superseded = raw['supersededRowId'];
      if (superseded !== null && (typeof superseded !== 'string' || !ROW_ID_PATTERN.test(superseded) || superseded === rowId)) {
        throw new DomainControlInputError(`${at}.supersededRowId 가 다른 행의 uuid 또는 null 이 아니다`);
      }
      return { op: 'saga_step', ...base, step: step as Extract<DomainControlRequest, { op: 'saga_step' }>['step'], supersededRowId: superseded };
    }
    case 'remove_step': {
      const step = raw['step'];
      if (typeof step !== 'string' || !(REMOVAL_STEPS as readonly string[]).includes(step)) throw new DomainControlInputError(`${at}.step 이 계약 밖이다`);
      return { op: 'remove_step', ...base, step: step as Extract<DomainControlRequest, { op: 'remove_step' }>['step'] };
    }
    case 'sync_policy':
    case 'audit_policy': {
      const addresses = raw['addresses'];
      if (!Array.isArray(addresses) || addresses.some((address) => typeof address !== 'string')) {
        throw new DomainControlInputError(`${at}.addresses 가 문자열 배열이 아니다`);
      }
      if (typedOp === 'sync_policy') return { op: 'sync_policy', ...base, addresses: addresses as string[] };
      const expectedDigest = raw['expectedDigest'];
      if (expectedDigest !== null && (typeof expectedDigest !== 'string' || !DIGEST_PATTERN.test(expectedDigest))) {
        throw new DomainControlInputError(`${at}.expectedDigest 가 sha256 hex 또는 null 이 아니다`);
      }
      return { op: 'audit_policy', ...base, addresses: addresses as string[], expectedDigest };
    }
    case 'check_expiry':
      return { op: 'check_expiry', ...base };
    case 'peek_identity':
      return { op: 'peek_identity', ...base };
  }
}

/** 배치 `{ batch: [...] }` — 키 집합 정확히 `{batch}` · 1 ≤ 길이 ≤ 15. */
export function parseDomainControlBatch(event: unknown): readonly DomainControlRequest[] {
  if (!isRecord(event) || !sameKeys(event, ['batch'])) throw new DomainControlInputError('입력은 정확히 { batch } 여야 한다');
  const batch = event['batch'];
  if (!Array.isArray(batch) || batch.length === 0 || batch.length > DOMAIN_CONTROL_MAX_BATCH) {
    throw new DomainControlInputError(`batch 는 1~${String(DOMAIN_CONTROL_MAX_BATCH)}개 배열이어야 한다`);
  }
  return batch.map(parseRequest);
}

/**
 * 동기화·감사의 주소 목록이 이 도메인의 정당한 발급 주소 모양인가 — 모두 `<로컬파트>@<domain>`(정규형 그대로 · 로컬파트 문법 · 도메인별 예약 밖)이고
 * 수가 도메인 천장 이하. 어기면 `false`(그 항목만 거부 — 계약 `rejected_input`).
 */
export function addressesAcceptable(domain: string, addresses: readonly string[]): boolean {
  if (addresses.length > customDomainAddressCeiling(domain)) return false;
  const suffix = `@${domain}`;
  return addresses.every((address) => {
    if (!address.endsWith(suffix)) return false;
    const local = address.slice(0, -suffix.length);
    try {
      return buildAgentAddress(local, domain) === address;
    } catch {
      return false;
    }
  });
}

// ---------------------------------------------------------------------------
// 정책 — 이름 · 정규화 다이제스트
// ---------------------------------------------------------------------------

/**
 * 정책 문서의 의미 비교용 정규형. **원소 하나짜리 배열은 그 원소와 같다**(IAM 의미가 같다) — SES 는 저장할 때 `["a"]` 를 `"a"` 로 바꿔
 * 돌려준다(2026-10-06 운영 e2e 실측: 주소 하나인 도메인이 감사마다 drift → operator 정지). 원소가 둘 이상인 배열은 순서를 그대로 둔다.
 */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return value.length === 1 ? canonicalJson(value[0]) : `[${value.map(canonicalJson).join(',')}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function canonicalPolicy(text: string): string {
  try {
    return canonicalJson(JSON.parse(text) as unknown);
  } catch {
    // JSON 이 아닌 원문은 그대로(정규화할 수 없다 — 기대 문서와 같을 수 없으니 drift 로 읽힌다).
    return `raw:${text}`;
  }
}

/** 정책 집합(이름 → 원문)의 정규화 다이제스트 — 이름순 · 문서는 키 정렬 JSON. 빈 집합도 값이 있다. */
export function policySetDigest(policies: Readonly<Record<string, string>>): string {
  const entries = Object.keys(policies)
    .sort()
    .map((name) => [name, canonicalPolicy(policies[name] ?? '')]);
  return createHash('sha256').update(JSON.stringify(entries)).digest('hex');
}

/** 이 행의 기대 정책(이름 → 문서). `too_large` 면 `null`. */
export function desiredPolicies(frame: IdentityPolicyFrame, rowId: string, addresses: readonly string[]): Record<string, string> | null {
  const chunks = identityPolicyChunks(frame, addresses);
  if (chunks.kind === 'too_large') return null;
  return Object.fromEntries(chunks.chunks.map((chunk, i) => [`${IDENTITY_POLICY_NAME_PREFIX}${rowId}-${String(i)}`, identityPolicyDocument(frame, chunk)]));
}

// ---------------------------------------------------------------------------
// 실행
// ---------------------------------------------------------------------------

function errorCodeOf(error: unknown): string {
  const name = error instanceof Error ? error.name : '';
  return ERROR_CODE_PATTERN.test(name) ? name : 'unknown';
}

function sesStatusOf(raw: string | null): CustomDomainSesStatus {
  switch (raw) {
    case 'SUCCESS':
      return 'success';
    case 'PENDING':
      return 'pending';
    case 'FAILED':
      return 'failed';
    case 'TEMPORARY_FAILURE':
      return 'temporary_failure';
    case 'NOT_STARTED':
      return 'not_started';
    default:
      return 'unknown';
  }
}

function ownerOf(snapshot: SesIdentitySnapshot): string | null {
  return snapshot.tags[IDENTITY_ROW_TAG] ?? null;
}

/** 정책 집합을 기대값으로 맞춘다 — 남는 이름(남이 붙인 것 포함)을 **먼저** 지우고(닫힌 쪽), 다른 것만 고치고, 없는 것을 만든다. */
async function applyPolicies(ses: SesIdentityControl, domain: string, current: Readonly<Record<string, string>>, desired: Readonly<Record<string, string>>): Promise<void> {
  for (const name of Object.keys(current).sort()) {
    if (!Object.hasOwn(desired, name)) await ses.deletePolicy(domain, name);
  }
  for (const [name, document] of Object.entries(desired)) {
    const existing = current[name];
    if (existing === undefined) await ses.createPolicy(domain, name, document);
    else if (canonicalPolicy(existing) !== canonicalPolicy(document)) await ses.updatePolicy(domain, name, document);
  }
}

/** 이 행의 정책 이름 접두사(`atmark-sender-<rowId>-`). */
function rowPolicyPrefix(rowId: string): string {
  return `${IDENTITY_POLICY_NAME_PREFIX}${rowId}-`;
}

function ownPolicies(rowId: string, policies: Readonly<Record<string, string>>): Record<string, string> {
  return Object.fromEntries(Object.entries(policies).filter(([name]) => name.startsWith(rowPolicyPrefix(rowId))));
}

/** 이 행의 이름이 아닌 정책을 전부 지운다(양도 채택 직후 · 정책 단계 — 보안 리뷰 M3). */
async function purgeForeignPolicies(ses: SesIdentityControl, domain: string, rowId: string, policies: Readonly<Record<string, string>>): Promise<void> {
  for (const name of Object.keys(policies).sort()) {
    if (!name.startsWith(rowPolicyPrefix(rowId))) await ses.deletePolicy(domain, name);
  }
}

type SagaResult = Extract<DomainControlResult, { op: 'saga_step' }>;

function sagaResult(rowId: string, outcome: SagaResult['outcome'], snapshot: SesIdentitySnapshot | null, extra: Partial<Pick<SagaResult, 'ownerRowTag' | 'policyDigest' | 'errorCode'>> = {}): SagaResult {
  return {
    op: 'saga_step',
    rowId,
    outcome,
    ownerRowTag: extra.ownerRowTag ?? null,
    dkimTokens: outcome === 'advanced' && snapshot !== null ? snapshot.dkimTokens : [],
    dkimStatus: outcome === 'advanced' && snapshot !== null ? sesStatusOf(snapshot.dkimStatus) : 'unknown',
    mailFromStatus: outcome === 'advanced' && snapshot !== null ? sesStatusOf(snapshot.mailFromStatus) : 'unknown',
    policyDigest: extra.policyDigest ?? null,
    errorCode: extra.errorCode ?? null,
  };
}

async function runSagaStep(deps: DomainControlDependencies, request: Extract<DomainControlRequest, { op: 'saga_step' }>): Promise<SagaResult> {
  const { ses } = deps;
  const { rowId, domain } = request;
  const rowTags = { [IDENTITY_ROW_TAG]: rowId, [IDENTITY_MANAGED_TAG]: IDENTITY_MANAGED_TAG_VALUE };
  let snapshot = await ses.getIdentity(domain);
  if (request.step === 'identity') {
    if (snapshot === null) {
      try {
        await ses.createIdentity(domain, rowTags);
      } catch (error) {
        // 경합 — 그 사이 누가 만들었다. 아래 채택 규칙(태그)으로 판정한다.
        if (errorCodeOf(error) !== 'AlreadyExistsException') throw error;
      }
      snapshot = await ses.getIdentity(domain);
      if (snapshot === null) return sagaResult(rowId, 'error', null, { errorCode: 'identity_not_found' });
    }
    const owner = ownerOf(snapshot);
    if (owner === rowId) return sagaResult(rowId, 'advanced', snapshot);
    if (request.supersededRowId !== null && owner === request.supersededRowId) {
      // 양도 채택 — 옛 행(대체된 행)의 identity 를 이 행으로 옮긴다. 태그는 `atmark:row` 하나만 바꾼다(IAM 이 관리 표시 변경을 막는다).
      //   ★ 옛 행의 정책(옛 조직의 주소 — 보안 리뷰 M3)은 **곧바로** 지운다: 새 행의 정책 동기화 전까지 옛 주소로 나가는 길이 남지 않게.
      await ses.tagIdentity(`arn:aws:ses:${deps.region}:${deps.accountId}:identity/${domain}`, { [IDENTITY_ROW_TAG]: rowId });
      await purgeForeignPolicies(ses, domain, rowId, snapshot.policies);
      return sagaResult(rowId, 'advanced', { ...snapshot, tags: { ...snapshot.tags, [IDENTITY_ROW_TAG]: rowId }, policies: ownPolicies(rowId, snapshot.policies) });
    }
    return sagaResult(rowId, 'identity_owned_elsewhere', null, { ownerRowTag: owner });
  }
  // 나머지 단계 — identity 가 이 행의 것일 때만 변형한다.
  if (snapshot === null) return sagaResult(rowId, 'error', null, { errorCode: 'identity_not_found' });
  const owner = ownerOf(snapshot);
  if (owner !== rowId) return sagaResult(rowId, 'identity_owned_elsewhere', null, { ownerRowTag: owner });
  switch (request.step) {
    case 'mail_from':
      await ses.putMailFrom(domain, `${MAIL_FROM_LABEL}.${domain}`);
      return sagaResult(rowId, 'advanced', (await ses.getIdentity(domain)) ?? snapshot);
    case 'config_set':
      await ses.putConfigurationSet(domain, deps.configurationSet);
      return sagaResult(rowId, 'advanced', snapshot);
    case 'policy': {
      // 사가의 정책 단계는 주소를 모른다(계약 — 주소 0개면 정책을 만들지 않는다 = 발신 불가 상태). 이 행의 이름이 아닌 정책(옛 행·수동)은 지우고
      //   남은 집합의 다이제스트를 돌려준다 — 주소가 생기면 틱이 `sync_policy` 로 맞춘다.
      await purgeForeignPolicies(ses, domain, rowId, snapshot.policies);
      return sagaResult(rowId, 'advanced', snapshot, { policyDigest: policySetDigest(ownPolicies(rowId, snapshot.policies)) });
    }
  }
}

async function runOne(deps: DomainControlDependencies, request: DomainControlRequest): Promise<DomainControlResult> {
  const { ses } = deps;
  const frame: IdentityPolicyFrame = { senderRoleArn: deps.senderRoleArn, accountId: deps.accountId, domain: request.domain };
  switch (request.op) {
    case 'check': {
      const [txt, mx] = await Promise.all([deps.dns.checkChallenge(request.domain, request.registrable, request.token), deps.dns.checkMx(request.domain, request.registrable)]);
      return { op: 'check', rowId: request.rowId, txt: txt.verdict, mx: mx.verdict, errorCode: txt.errorCode ?? mx.errorCode };
    }
    case 'saga_step':
      try {
        return await runSagaStep(deps, request);
      } catch (error) {
        return sagaResult(request.rowId, 'error', null, { errorCode: errorCodeOf(error) });
      }
    case 'remove_step':
      try {
        const snapshot = await ses.getIdentity(request.domain);
        // 없다 = 이미 지워졌다(멱등). pending·만료 행은 identity 를 가진 적이 없다.
        if (snapshot === null) return { op: 'remove_step', rowId: request.rowId, outcome: 'advanced', errorCode: null };
        // ★ 다른 행(또는 태그 없음)이 소유한 identity 는 절대 지우지 않는다.
        if (ownerOf(snapshot) !== request.rowId) return { op: 'remove_step', rowId: request.rowId, outcome: 'not_owner', errorCode: null };
        if (request.step === 'policy') {
          for (const name of Object.keys(snapshot.policies).sort()) await ses.deletePolicy(request.domain, name);
        } else {
          await ses.deleteIdentity(request.domain);
        }
        return { op: 'remove_step', rowId: request.rowId, outcome: 'advanced', errorCode: null };
      } catch (error) {
        return { op: 'remove_step', rowId: request.rowId, outcome: 'error', errorCode: errorCodeOf(error) };
      }
    case 'sync_policy': {
      if (!addressesAcceptable(request.domain, request.addresses)) {
        return { op: 'sync_policy', rowId: request.rowId, outcome: 'rejected_input', policyDigest: null, errorCode: 'rejected_input' };
      }
      try {
        const snapshot = await ses.getIdentity(request.domain);
        if (snapshot === null) return { op: 'sync_policy', rowId: request.rowId, outcome: 'error', policyDigest: null, errorCode: 'identity_not_found' };
        if (ownerOf(snapshot) !== request.rowId) return { op: 'sync_policy', rowId: request.rowId, outcome: 'not_owner', policyDigest: null, errorCode: null };
        const desired = desiredPolicies(frame, request.rowId, request.addresses);
        // ★ 20개를 넘는다 — 기존 정책을 그대로 둔다(지우지도 줄이지도 않는다).
        if (desired === null) return { op: 'sync_policy', rowId: request.rowId, outcome: 'too_large', policyDigest: null, errorCode: null };
        await applyPolicies(ses, request.domain, snapshot.policies, desired);
        return { op: 'sync_policy', rowId: request.rowId, outcome: 'synced', policyDigest: policySetDigest(desired), errorCode: null };
      } catch (error) {
        return { op: 'sync_policy', rowId: request.rowId, outcome: 'error', policyDigest: null, errorCode: errorCodeOf(error) };
      }
    }
    case 'audit_policy': {
      const failed = (errorCode: string): DomainControlResult => ({ op: 'audit_policy', rowId: request.rowId, outcome: 'error', dkimStatus: 'unknown', errorCode });
      if (!addressesAcceptable(request.domain, request.addresses)) return failed('rejected_input');
      try {
        const snapshot = await ses.getIdentity(request.domain);
        if (snapshot === null) return failed('identity_not_found');
        const dkimStatus = sesStatusOf(snapshot.dkimStatus);
        if (ownerOf(snapshot) !== request.rowId) return { op: 'audit_policy', rowId: request.rowId, outcome: 'not_owner', dkimStatus, errorCode: null };
        const desired = desiredPolicies(frame, request.rowId, request.addresses);
        if (desired === null) return failed('too_large');
        // 판정 기준은 **언제나 주소로 조립한 기대 정책**이다(보안 리뷰 M4 — 행에 적힌 다이제스트가 낡거나 틀려도 SES 원문을 그것에 맞추지 않는다).
        //   행의 다이제스트가 기대와 다르면 그것은 따로 알린다(틱이 다시 동기화할 신호 — 판정은 바꾸지 않는다).
        const desiredDigest = policySetDigest(desired);
        if (request.expectedDigest !== null && request.expectedDigest !== desiredDigest) {
          log('warn', 'domain_control.expected_digest_mismatch', { route_id: DOMAIN_CONTROL_ROUTE_ID, outcome: 'mismatch' });
        }
        if (policySetDigest(snapshot.policies) === desiredDigest) return { op: 'audit_policy', rowId: request.rowId, outcome: 'clean', dkimStatus, errorCode: null };
        await applyPolicies(ses, request.domain, snapshot.policies, desired);
        return { op: 'audit_policy', rowId: request.rowId, outcome: 'drift', dkimStatus, errorCode: null };
      } catch (error) {
        return failed(errorCodeOf(error));
      }
    }
    case 'check_expiry': {
      const result = await deps.rdap(request.registrable);
      if (result.kind === 'ok') return { op: 'check_expiry', rowId: request.rowId, outcome: 'ok', expiresAt: result.expiresAt.toISOString(), errorCode: null };
      if (result.kind === 'unsupported') return { op: 'check_expiry', rowId: request.rowId, outcome: 'unsupported', expiresAt: null, errorCode: null };
      return { op: 'check_expiry', rowId: request.rowId, outcome: 'error', expiresAt: null, errorCode: result.code };
    }
    case 'peek_identity':
      // 읽기 전용(GetEmailIdentity 하나 · 태그 무관). 관리자 아닌 행에는 토큰만 — 상태는 unknown.
      try {
        const snapshot = await ses.getIdentity(request.domain);
        if (snapshot === null) {
          return { op: 'peek_identity', rowId: request.rowId, outcome: 'absent', ownerIsRow: false, dkimTokens: [], dkimStatus: 'unknown', mailFromStatus: 'unknown', errorCode: null };
        }
        const ownerIsRow = ownerOf(snapshot) === request.rowId;
        return {
          op: 'peek_identity',
          rowId: request.rowId,
          outcome: 'found',
          ownerIsRow,
          dkimTokens: snapshot.dkimTokens,
          dkimStatus: ownerIsRow ? sesStatusOf(snapshot.dkimStatus) : 'unknown',
          mailFromStatus: ownerIsRow ? sesStatusOf(snapshot.mailFromStatus) : 'unknown',
          errorCode: null,
        };
      } catch (error) {
        return { op: 'peek_identity', rowId: request.rowId, outcome: 'error', ownerIsRow: false, dkimTokens: [], dkimStatus: 'unknown', mailFromStatus: 'unknown', errorCode: errorCodeOf(error) };
      }
  }
}

/** 배치 하나 — 안에서 병렬, 결과는 요청과 같은 순서·같은 길이. */
export async function runDomainControlBatch(deps: DomainControlDependencies, batch: readonly DomainControlRequest[]): Promise<readonly DomainControlResult[]> {
  return Promise.all(batch.map((request) => runOne(deps, request)));
}

// ---------------------------------------------------------------------------
// 조립 · 핸들러
// ---------------------------------------------------------------------------

/** 환경 → 의존성. 발송 역할 ARN 이 모양·길이 밖이면 **기동하지 않는다**. */
export function composeDomainControl(env: NodeJS.ProcessEnv): DomainControlDependencies {
  requireProductionRuntime(env);
  const senderRoleArn = requireEnv(env, RUNTIME_ENV.senderRoleArn);
  const match = SENDER_ROLE_ARN_PATTERN.exec(senderRoleArn);
  if (senderRoleArn.length > SENDER_ROLE_ARN_MAX_LENGTH || match === null) {
    throw new RuntimeConfigError(`${RUNTIME_ENV.senderRoleArn} 가 ${String(SENDER_ROLE_ARN_MAX_LENGTH)}자 이하의 IAM 역할 ARN 이 아니다.`);
  }
  const region = requireEnv(env, RUNTIME_ENV.region);
  // identity policy 의 Resource 는 계약이 ap-northeast-2 로 고정한다 — 다른 리전에서 돌면 정책과 identity 가 어긋난다.
  if (region !== DOMAIN_CONTROL_REGION) throw new RuntimeConfigError(`${RUNTIME_ENV.region} 가 ${DOMAIN_CONTROL_REGION} 이 아니다.`);
  return {
    ses: createSesIdentityControl(region),
    dns: createDnsLookup(),
    rdap: (registrable) =>
      rdapExpiration(registrable, { timeoutMs: DOMAIN_CONTROL_RDAP_TIMEOUT_MS, deadlineMs: DOMAIN_CONTROL_RDAP_DEADLINE_MS, userAgent: 'atmark-domain-control/1.0' }),
    senderRoleArn,
    accountId: match[1] ?? '',
    region,
    configurationSet: requireEnv(env, RUNTIME_ENV.sesConfigurationSet),
  };
}

export function createDomainControlHandler(compose: () => DomainControlDependencies) {
  let deps: DomainControlDependencies | undefined;
  return async (event: unknown): Promise<{ readonly results: readonly DomainControlResult[] }> => {
    const started = Date.now();
    deps ??= compose();
    const batch = parseDomainControlBatch(event);
    const results = await runDomainControlBatch(deps, batch);
    const failures = results.filter((result) => result.errorCode !== null).length;
    // 도메인명·주소·원문 없음 — 건수와 op 분포만.
    log(failures > 0 ? 'warn' : 'info', 'domain_control.batch', {
      route_id: DOMAIN_CONTROL_ROUTE_ID,
      outcome: failures > 0 ? 'partial' : 'ok',
      detail: `items=${String(results.length)} errors=${String(failures)} ops=${[...new Set(batch.map((request) => request.op))].sort().join(',')}`,
      latency_ms: Date.now() - started,
    });
    return { results };
  };
}

export const handler = createDomainControlHandler(() => composeDomainControl(process.env));
