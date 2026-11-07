/**
 * src/admin/ops/domains.ts — 고객 도메인의 **소유자 연산**(ADR-0014 단계 4 M3b). 콘솔(`/api/domains*`)과 조직 API(`/org-api/v1/domains*`,
 * 권한 `domains:manage`)가 **같은 함수**를 부른다. 상태 칸은 쓰지 않는다 — admin 롤은 행 만들기 · 수동 확인 칸 · 제거 요청만(GRANT · 저장소
 * `src/domains/store.ts`). 확인 · 전이 · 사가는 틱(`src/domains/lifecycle.ts`)이 한다.
 *
 *   - 목록(member): 조직의 행(제거 포함) + 기능 켜짐 · 요금제 한도 · pending 상한. **기능이 꺼져 있어도 목록 · 한 개 · 제거는 열려 있다** — 허용 목록에서
 *     빠진 조직도 이미 만든 도메인을 보고 끊을 수 있어야 한다(별칭 L-4 와 같은 이유). 추가 · 지금 확인만 403 `feature_not_enabled`.
 *   - 추가(admin): 이름 판정(`judgeCustomDomain` — 거부 사유가 곧 400 코드: apex · IDN · 공용 메일 · atmark.ai · 길이 …) → 조직 도메인 잠금 아래
 *     요금제 한도(살아 있는 행 = pending 포함) 409 `plan_custom_domains_exceeded` · pending 상한(2) 409 `custom_domains_pending_exceeded` ·
 *     같은 조직의 살아 있는 같은 도메인 409 `domain_exists` → pending 행.
 *   - 한 개: 보여 줄 DNS 레코드(`dnsRecordsFor` — **전부 한 번에**, 2026-10 one-shot) · 상태 · 사유 · 다음 확인 · 72시간 만료 · 이 도메인을 대표로
 *     쓰는 에이전트 수. DKIM 토큰이 아직 없으면(즉시 실행이 `waiting`/`busy` 였다) DKIM 줄이 없고 `recordsReady:false` — 콘솔이 다시 읽는다.
 *   - 추가 직후 즉시 실행(`provisionAfterAdd` — 추가 트랜잭션이 **커밋된 뒤** 라우트가 부른다): `ProvisionDomainNow`(틱 롤 풀 · 자체 예산)로 SES identity 를
 *     만들어 DKIM 토큰을 받고, 행을 다시 읽어 응답에 싣는다. 실패해도 추가는 성공이다(예약 틱이 잇는다 — 던지지 않는다).
 *   - 지금 확인(admin, 202): 같은 도메인 60초 1회(행의 `last_manual_check_at`) · 조직 시간당 `MANUAL_CHECKS_PER_ORG_PER_HOUR`(감사 행 `domain.check`
 *     를 센다) → 429 `domain_check_rate_limited`.
 *   - 제거(admin): 제거 요청 1회(트리거가 그 자리에서 removed). `releaseAddresses` 면 그 도메인의 이 조직 활성 주소를 같은 트랜잭션에서 폐기한다
 *     (기본은 남긴다 — 자발적 제거, ADR-0014 D-H). 응답에 이 도메인을 대표로 쓰던 에이전트 수(경고 — 그 에이전트는 "주소 없음" 이 된다).
 *
 * **다른 조직의 id 는 없는 id 와 같은 404 `domain_not_found`** 다(존재를 가리지 않는다). 감사는 호출자(`audited` · `auditedByOrgKey`)가 행위
 * `domain.add` · `domain.check` · `domain.remove`(대상 = 도메인 id — 도메인 이름 칸은 없다, L5)로 한 트랜잭션에 적는다.
 */

import { customDomainLimitOf, CUSTOM_DOMAIN_PENDING_MAX } from '../../billing/plans';
import type { Queryable } from '../../db/client';
import { loadEntitlements } from '../../db/repositories/entitlements';
import {
  CUSTOM_DOMAINS_FEATURE,
  DOMAIN_API_ERRORS,
  dnsRecordsFor,
  MANUAL_CHECK_MIN_INTERVAL_MS,
  MANUAL_CHECKS_PER_ORG_PER_HOUR,
  PENDING_EXPIRY_MS,
  type CustomDomainPendingReason,
  type CustomDomainSesStatus,
  type CustomDomainStatus,
  type CustomDomainSuspendedReason,
  type DnsRecordSpec,
  type DomainOwnerAction,
  type InboundMxStatus,
  type ProvisionDomainNow,
  type ProvisionDomainOutcome,
} from '../../domains/contract';
import type { DomainConnectDiscovery } from '../../domains/dc-discovery';
import { buildApplyUrl, connectRecordsOf, DC_SERVICE_ID, DomainConnectInputError, type DcSigner } from '../../domains/dc-url';
import { judgeCustomDomain } from '../../domains/names';
import { log } from '../../observability/logger';
import {
  insertPendingDomain,
  listOrganizationDomains,
  lockOrganizationDomains,
  requestManualCheck,
  requestRemoval,
  selectRow,
  type DomainRow,
} from '../../domains/store';
import { lockOrganizationAliases } from './addresses';
import { iso } from '../display';
import { AdminInputError, notFound, sqlStateOf, UUID_PATTERN } from './errors';

export const DOMAIN_ADD_ACTION: DomainOwnerAction = 'domain.add';
export const DOMAIN_CHECK_ACTION: DomainOwnerAction = 'domain.check';
export const DOMAIN_REMOVE_ACTION: DomainOwnerAction = 'domain.remove';

/** 조직 24시간 도메인 추가 상한(#15 보안 리뷰 L3 — 감사 행 `domain.add` 를 센다, 콘솔 · 조직 키 합). 넘으면 429 `domain_add_rate_limited`. */
export const DOMAIN_ADDS_PER_ORG_PER_DAY = 10;
const DOMAIN_ADD_RATE_LIMITED = 'domain_add_rate_limited';

const HOUR_MS = 3_600_000;

/**
 * 레코드 하나의 확인 상태(콘솔 레코드 카드의 표시) — `ok` 확인됨 · `pending` 기다리는 중(아직 못 찾음 · SES 확인 중) · `failed` 확정 실패
 * (다른 곳을 가리킴 · 실패 판정) · `not_checked` 아직 보지 않음(SES identity 전 · removed).
 */
export type DomainCheckState = 'ok' | 'pending' | 'failed' | 'not_checked';

/** 레코드별 확인 상태 — 소유 확인 TXT · DKIM CNAME · MAIL FROM(MX · SPF) · 수신 MX. 행의 기존 칸에서 접는다(`domainChecksOf`). */
interface DomainChecks {
  readonly ownership: DomainCheckState;
  readonly dkim: DomainCheckState;
  readonly mailFrom: DomainCheckState;
  readonly inboundMx: DomainCheckState;
}

function sesCheckOf(status: CustomDomainSesStatus): DomainCheckState {
  switch (status) {
    case 'success':
      return 'ok';
    case 'failed':
    case 'temporary_failure':
      return 'failed';
    case 'pending':
      return 'pending';
    case 'not_started':
    case 'unknown':
      return 'not_checked';
  }
}

function inboundMxCheckOf(status: InboundMxStatus): DomainCheckState {
  switch (status) {
    case 'ses':
      return 'ok';
    case 'other':
      return 'failed';
    case 'missing':
      return 'pending';
    case 'unknown':
      return 'not_checked';
  }
}

/** 레코드별 확인 상태(순수). removed 는 더 확인하지 않으므로 전부 `not_checked`. 소유 확인은 ownership_lost 정지면 `failed`. */
export function domainChecksOf(
  row: Pick<DomainRow, 'status' | 'suspendedReason' | 'txtVerifiedAt' | 'dkimStatus' | 'mailFromStatus' | 'inboundMxStatus'>,
): DomainChecks {
  if (row.status === 'removed') return { ownership: 'not_checked', dkim: 'not_checked', mailFrom: 'not_checked', inboundMx: 'not_checked' };
  const ownership: DomainCheckState =
    row.status === 'suspended' && row.suspendedReason === 'ownership_lost'
      ? 'failed'
      : row.txtVerifiedAt !== null || row.status === 'verified' || row.status === 'suspended'
        ? 'ok'
        : 'pending';
  return { ownership, dkim: sesCheckOf(row.dkimStatus), mailFrom: sesCheckOf(row.mailFromStatus), inboundMx: inboundMxCheckOf(row.inboundMxStatus) };
}

/** 화면 · API 의 도메인 한 행. 토큰은 레코드 값(`records`)으로만 나간다(한 개 보기). 날짜는 ISO. */
export interface DomainView {
  readonly id: string;
  readonly domain: string;
  readonly registrableDomain: string;
  readonly status: CustomDomainStatus;
  readonly suspendedReason: CustomDomainSuspendedReason | null;
  readonly pendingReason: CustomDomainPendingReason | null;
  readonly dkimStatus: CustomDomainSesStatus;
  readonly mailFromStatus: CustomDomainSesStatus;
  readonly inboundMxStatus: InboundMxStatus;
  readonly createdAt: string;
  readonly verifiedAt: string | null;
  readonly suspendedAt: string | null;
  readonly removedAt: string | null;
  readonly lastCheckedAt: string | null;
  /** 다음 확인(틱) — removed 면 `null`. */
  readonly nextCheckAt: string | null;
  /** pending · verifying 이 이 시각까지 다음 단계로 가지 못하면 removed(72시간). 그 밖의 상태는 `null`. */
  readonly expiresAt: string | null;
  /** ownership_lost 정지의 제거 예정(14일). */
  readonly removalDueAt: string | null;
  /** 등록 가능 apex 의 RDAP 만료일(알면). */
  readonly registrationExpiresAt: string | null;
  /** 레코드별 확인 상태(2026-10 콘솔 도메인 화면 — 덧붙인 칸, 위 칸들은 그대로). */
  readonly checks: DomainChecks;
}

export interface DomainDetailView extends DomainView {
  /**
   * 넣어야 할 레코드 전부(2026-10 one-shot — 계약 `dnsRecordsFor` 순서: 소유 TXT `_atmark-challenge.<domain>` → 수신 MX → MAIL FROM MX · SPF →
   * DKIM CNAME 셋 → DMARC TXT(권장, `required:false` — 확인과 무관)). DKIM 토큰이 아직 없으면 DKIM 줄이 빠진다(`recordsReady:false`). removed 면 빈 배열.
   */
  readonly records: readonly DnsRecordSpec[];
  /** 레코드가 다 나왔는가(DKIM 토큰 셋이 행에 있다). 거짓이면 콘솔이 "레코드를 준비하고 있습니다" 를 보이고 잠깐 다시 읽는다. removed 는 참. */
  readonly recordsReady: boolean;
  /** 이 조직에서 대표 주소(마지막 선택)가 이 도메인 주소인 에이전트 수. */
  readonly primaryAgents: number;
  /** 이 조직의 이 도메인 활성 주소 수. */
  readonly liveAddresses: number;
}

export interface DomainListView {
  /** 기능 허용 목록(`org_features`)에 있는가 — 꺼져 있으면 추가 · 지금 확인이 403. */
  readonly enabled: boolean;
  /** 요금제 한도(살아 있는 행 — pending 포함). */
  readonly limit: number;
  readonly pendingMax: number;
  /** 살아 있는 행 수(removed 제외). */
  readonly live: number;
  readonly items: readonly DomainView[];
}

export function domainView(row: DomainRow): DomainView {
  const expiry =
    row.status === 'pending'
      ? new Date(row.createdAt.getTime() + PENDING_EXPIRY_MS)
      : row.status === 'verifying' && row.txtVerifiedAt !== null
        ? new Date(row.txtVerifiedAt.getTime() + PENDING_EXPIRY_MS)
        : null;
  return {
    id: row.id,
    domain: row.domain,
    registrableDomain: row.registrable,
    status: row.status,
    suspendedReason: row.suspendedReason,
    pendingReason: row.pendingReason,
    dkimStatus: row.dkimStatus,
    mailFromStatus: row.mailFromStatus,
    inboundMxStatus: row.inboundMxStatus,
    createdAt: row.createdAt.toISOString(),
    verifiedAt: iso(row.verifiedAt),
    suspendedAt: iso(row.suspendedAt),
    removedAt: iso(row.removedAt),
    lastCheckedAt: iso(row.lastCheckedAt),
    nextCheckAt: row.status === 'removed' ? null : row.nextCheckAt.toISOString(),
    expiresAt: iso(expiry),
    removalDueAt: iso(row.removalDueAt),
    registrationExpiresAt: iso(row.registrationExpiresAt),
    checks: domainChecksOf(row),
  };
}

/** 이 조직이 기능 허용 목록에 있는가. */
export async function customDomainsEnabled(db: Queryable, organizationId: string): Promise<boolean> {
  const result = await db.query('SELECT 1 FROM org_features WHERE organization_id = $1 AND feature = $2', [organizationId, CUSTOM_DOMAINS_FEATURE]);
  return (result.rowCount ?? 0) > 0;
}

function featureNotEnabled(): AdminInputError {
  return new AdminInputError('이 조직에는 고객 도메인 기능이 켜져 있지 않다.', DOMAIN_API_ERRORS.featureNotEnabled, 403);
}

async function requireFeature(db: Queryable, organizationId: string): Promise<void> {
  if (!(await customDomainsEnabled(db, organizationId))) throw featureNotEnabled();
}

function domainNotFound(): AdminInputError {
  return notFound('도메인이 없다.', 'domain_not_found');
}

/** 경로의 도메인 id — uuid 모양이 아니면 없는 것과 같은 404(형식으로 존재를 가르지 않는다). */
function domainIdOf(raw: unknown): string {
  if (typeof raw !== 'string' || !UUID_PATTERN.test(raw)) throw domainNotFound();
  return raw;
}

/** 이 조직의 행 하나(다른 조직 · 없음 = 같은 404). */
async function rowOfOrganization(db: Queryable, organizationId: string, rawId: unknown, lock = false): Promise<DomainRow> {
  const row = await selectRow(db, domainIdOf(rawId), lock);
  if (row === null || row.organizationId !== organizationId) throw domainNotFound();
  return row;
}

async function domainLimitOf(db: Queryable, organizationId: string): Promise<number> {
  return customDomainLimitOf((await loadEntitlements(db, organizationId, new Date())).planCode);
}

export async function listDomainsOp(db: Queryable, organizationId: string): Promise<DomainListView> {
  const rows = await listOrganizationDomains(db, organizationId);
  return {
    enabled: await customDomainsEnabled(db, organizationId),
    limit: await domainLimitOf(db, organizationId),
    pendingMax: CUSTOM_DOMAIN_PENDING_MAX,
    live: rows.filter((row) => row.status !== 'removed').length,
    items: rows.map(domainView),
  };
}

/** 마지막 대표 선택이 이 도메인 주소인 이 조직 에이전트 수(유효 여부와 무관 — 도메인을 지우면 그 에이전트가 "주소 없음" 이 된다). */
async function primaryAgentsOn(db: Queryable, organizationId: string, domain: string): Promise<number> {
  const result = await db.query<{ n: number }>(
    `SELECT count(*)::int AS n
       FROM (SELECT DISTINCT ON (p.agent_id) p.agent_id, p.address_id
               FROM agent_primary_changes p JOIN agents a ON a.id = p.agent_id
              WHERE a.organization_id = $1
              ORDER BY p.agent_id, p.created_at DESC, p.id DESC) AS last
       JOIN agent_addresses x ON x.id = last.address_id
      WHERE x.domain = $2`,
    [organizationId, domain],
  );
  return result.rows[0]?.n ?? 0;
}

async function liveAddressesOn(db: Queryable, organizationId: string, domain: string): Promise<number> {
  const result = await db.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM agent_addresses x JOIN agents a ON a.id = x.agent_id
      WHERE a.organization_id = $1 AND x.domain = $2 AND x.retired_at IS NULL`,
    [organizationId, domain],
  );
  return result.rows[0]?.n ?? 0;
}

async function detailOf(db: Queryable, row: DomainRow): Promise<DomainDetailView> {
  return {
    ...domainView(row),
    records: row.status === 'removed' ? [] : dnsRecordsFor(row.domain, row.challengeToken, row.dkimTokens),
    recordsReady: row.status === 'removed' || row.dkimTokens.length === 3,
    primaryAgents: await primaryAgentsOn(db, row.organizationId, row.domain),
    liveAddresses: await liveAddressesOn(db, row.organizationId, row.domain),
  };
}

export async function getDomainOp(db: Queryable, organizationId: string, rawId: unknown): Promise<DomainDetailView> {
  return detailOf(db, await rowOfOrganization(db, organizationId, rawId));
}

/**
 * 도메인 하나 추가 — **호출자의 트랜잭션 안에서**(조직 도메인 잠금이 트랜잭션 끝까지 간다 — DB 천장 트리거와 같은 키). 결과는 한 개 보기 모양.
 */
export async function addDomainOp(db: Queryable, input: { readonly organizationId: string; readonly rawDomain: unknown; readonly createdByUserId: string | null }): Promise<DomainDetailView> {
  if (typeof input.rawDomain !== 'string') throw new AdminInputError('domain 이 필요하다(문자열).', 'invalid_domain');
  await requireFeature(db, input.organizationId);
  const verdict = judgeCustomDomain(input.rawDomain);
  // 거부 사유가 곧 코드다(계약 `DomainNameRejection` — apex · IDN · 공용 메일 · atmark.ai · 길이 …). 입력을 되풀이하지 않는다.
  if (!verdict.ok) throw new AdminInputError('쓸 수 없는 도메인이다(서브도메인만 · 공용 메일 · 플랫폼 도메인 · 길이 · 모양).', verdict.reason);
  await lockOrganizationDomains(db, input.organizationId);
  // 추가 · 제거를 되풀이해 pending 행(SES 호출 0 이지만 TXT 확인 · 틱 예산)을 쌓지 못하게 — 조직 잠금 아래 지난 24시간 추가 감사 행을 센다.
  const added = await db.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM owner_actions WHERE organization_id = $1 AND action = $2 AND created_at > now() - interval '24 hours'`,
    [input.organizationId, DOMAIN_ADD_ACTION],
  );
  if ((added.rows[0]?.n ?? 0) >= DOMAIN_ADDS_PER_ORG_PER_DAY) {
    throw new AdminInputError(`이 조직의 도메인 추가는 24시간에 ${String(DOMAIN_ADDS_PER_ORG_PER_DAY)}번까지다.`, DOMAIN_ADD_RATE_LIMITED, 429);
  }
  const rows = await listOrganizationDomains(db, input.organizationId);
  const live = rows.filter((row) => row.status !== 'removed');
  if (live.some((row) => row.domain === verdict.domain)) throw new AdminInputError('이 조직에 이미 있는 도메인이다.', 'domain_exists', 409);
  const limit = await domainLimitOf(db, input.organizationId);
  if (live.length >= limit) {
    throw new AdminInputError(`이 요금제의 도메인 한도(${String(limit)} — 확인 중 포함)에 닿았다.`, DOMAIN_API_ERRORS.planLimitExceeded, 409);
  }
  if (live.filter((row) => row.status === 'pending').length >= CUSTOM_DOMAIN_PENDING_MAX) {
    throw new AdminInputError(`소유 증명을 기다리는 도메인은 ${String(CUSTOM_DOMAIN_PENDING_MAX)}개까지다.`, DOMAIN_API_ERRORS.pendingLimitExceeded, 409);
  }
  let id: string;
  try {
    id = await insertPendingDomain(db, {
      organizationId: input.organizationId,
      domain: verdict.domain,
      registrable: verdict.registrable,
      createdByUserId: input.createdByUserId,
    });
  } catch (error) {
    // 동결 톰스톤(같은 도메인 · apex 가 평판 · 운영자 동결을 지닌 채 제거됐다 — 42501)은 다른 거부와 같은 중립 409 다(어느 조직의 동결인지 말하지 않는다).
    if (sqlStateOf(error) === '42501') throw new AdminInputError('이 도메인은 지금 추가할 수 없다 — 운영자에게 문의하라.', 'domain_unavailable', 409);
    throw error;
  }
  const row = await selectRow(db, id);
  if (row === null) throw new Error('방금 만든 도메인 행을 읽지 못했다');
  return detailOf(db, row);
}

/** 추가 응답 — 한 개 보기 + 즉시 실행 결과(`provision` — 조직 API 가 "다시 읽을지" 를 알게. 즉시 실행을 조립하지 않았으면 `unavailable`). */
interface DomainAddedView {
  readonly item: DomainDetailView;
  readonly provision: ProvisionDomainOutcome;
}

/**
 * 추가 직후 즉시 실행 — **추가 트랜잭션이 커밋된 뒤**(호출자 = 라우트) 부른다. 즉시 실행은 틱 롤 풀로 그 행을 다시 읽어 판단하므로 커밋 전에는
 * 행을 보지 못한다. 결과가 행을 바꿨으면(`provisioned` · `peeked`) 같은 조직 범위로 다시 읽어 레코드(DKIM 포함)를 싣는다. **던지지 않는다** —
 * 추가는 이미 커밋됐다: 포트가 던져도(계약 위반) · 다시 읽기가 실패해도 처음 읽은 한 개 보기를 그대로 돌려준다(예약 틱 · 콘솔 다시 읽기가 잇는다).
 */
export async function provisionAfterAdd(
  db: Queryable,
  organizationId: string,
  added: DomainDetailView,
  provision: ProvisionDomainNow | undefined,
): Promise<DomainAddedView> {
  if (provision === undefined) return { item: added, provision: 'unavailable' };
  let outcome: ProvisionDomainOutcome;
  try {
    outcome = await provision(added.id);
  } catch {
    log('warn', 'domain.provision_threw', { route_id: 'admin', detail: `domain_id=${added.id}` });
    return { item: added, provision: 'unavailable' };
  }
  if (outcome !== 'provisioned' && outcome !== 'peeked') return { item: added, provision: outcome };
  try {
    return { item: await getDomainOp(db, organizationId, added.id), provision: outcome };
  } catch {
    log('warn', 'domain.provision_reread_failed', { route_id: 'admin', detail: `domain_id=${added.id}` });
    return { item: added, provision: outcome };
  }
}

/** 지금 확인 — 202 의 몸통(id · 다음 확인 = 지금). */
interface DomainCheckView {
  readonly id: string;
  readonly nextCheckAt: string;
}

function checkRateLimited(detail: string): AdminInputError {
  return new AdminInputError(detail, DOMAIN_API_ERRORS.checkRateLimited, 429);
}

export async function checkDomainOp(db: Queryable, organizationId: string, rawId: unknown, now: Date): Promise<DomainCheckView> {
  const id = domainIdOf(rawId);
  await requireFeature(db, organizationId);
  // 조직 시간당 상한 — 조직 도메인 잠금 아래에서 지난 1시간 감사 행(`domain.check`)을 센다(콘솔 · 조직 키 합).
  await lockOrganizationDomains(db, organizationId);
  const recent = await db.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM owner_actions WHERE organization_id = $1 AND action = $2 AND created_at > $3`,
    [organizationId, DOMAIN_CHECK_ACTION, new Date(now.getTime() - HOUR_MS)],
  );
  if ((recent.rows[0]?.n ?? 0) >= MANUAL_CHECKS_PER_ORG_PER_HOUR) {
    throw checkRateLimited(`이 조직의 지금 확인은 시간당 ${String(MANUAL_CHECKS_PER_ORG_PER_HOUR)}번까지다.`);
  }
  const outcome = await requestManualCheck(db, organizationId, id, MANUAL_CHECK_MIN_INTERVAL_MS);
  if (outcome === 'not_found') throw domainNotFound();
  if (outcome === 'rate_limited') throw checkRateLimited(`같은 도메인은 ${String(MANUAL_CHECK_MIN_INTERVAL_MS / 1000)}초에 한 번 확인한다.`);
  return { id, nextCheckAt: now.toISOString() };
}

export interface DomainRemovalView {
  readonly item: DomainView;
  /** 이미 removed 였다(감사 없음). */
  readonly replayed: boolean;
  /** 제거 직전 이 도메인 주소를 대표로 고른 에이전트 수 — 그 에이전트는 이제 "주소 없음"(자동으로 @atmark.ai 로 옮기지 않는다). */
  readonly primaryAgents: number;
  /** `releaseAddresses` 로 폐기한 주소 수. */
  readonly releasedAddresses: number;
}

/**
 * 제거 — **호출자의 트랜잭션 안에서**. 잠금 순서는 대표 선택 가드 · 발급과 같다: 조직(`agent_addresses_org:`) → 도메인 행 → 주소 행.
 * `releaseAddresses` 면 그 도메인의 이 조직 활성 주소를 먼저 폐기한다(대표로 쓰이던 주소 포함 — 도메인과 함께 놓는 것이다).
 */
export async function removeDomainOp(db: Queryable, organizationId: string, rawId: unknown, releaseAddresses: boolean): Promise<DomainRemovalView> {
  const id = domainIdOf(rawId);
  await lockOrganizationAliases(db, organizationId);
  const row = await rowOfOrganization(db, organizationId, id, true);
  if (row.status === 'removed') return { item: domainView(row), replayed: true, primaryAgents: 0, releasedAddresses: 0 };
  const primaryAgents = await primaryAgentsOn(db, organizationId, row.domain);
  let releasedAddresses = 0;
  if (releaseAddresses) {
    // 폐기 가드가 시각을 now() 로 덮는다(쓰기 1회) · 앵커(is_primary)는 고객 도메인에 있을 수 없다(P0A06).
    const released = await db.query(
      `UPDATE agent_addresses x SET retired_at = now()
         FROM agents a
        WHERE a.id = x.agent_id AND a.organization_id = $1 AND x.domain = $2 AND x.retired_at IS NULL AND NOT x.is_primary`,
      [organizationId, row.domain],
    );
    releasedAddresses = released.rowCount ?? 0;
  }
  if ((await requestRemoval(db, organizationId, id)) === 'not_found') throw domainNotFound();
  const after = await selectRow(db, id);
  if (after === null) throw new Error('제거한 도메인 행을 읽지 못했다');
  return { item: domainView(after), replayed: false, primaryAgents, releasedAddresses };
}

/** `releaseAddresses` 본문 칸 — 없으면 거짓(주소를 남긴다). */
export function releaseAddressesOf(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value !== 'boolean') throw new AdminInputError('releaseAddresses 는 불리언이다.', 'invalid_body');
  return value;
}

// ---------------------------------------------------------------------------
// Domain Connect(동기 흐름 · 서명 — `src/domains/dc-url.ts`)
// ---------------------------------------------------------------------------

/** Domain Connect 의존성 — 조립이 `DOMAIN_CONNECT_ENABLED` 일 때만 채운다(없으면 `supported:false`). */
export interface DomainConnectDependencies {
  readonly discovery: DomainConnectDiscovery;
  readonly signer: DcSigner;
}

/**
 * Domain Connect 두 단계(리드 결정 2026-10-05 — **발급은 단추를 누를 때만**):
 *   - `GET /api/domains/{id}/connect` → `DomainConnectInfo` — 단추를 보일지만(업체 발견 결과 · 5분 캐시). 서명 · URL · 감사 · 횟수 없음.
 *   - `POST /api/domains/{id}/connect` → `DomainConnectIssued` — 서명된 적용 URL 하나 + 레코드 요약(8줄 — 마지막 DMARC 는 권장). 감사 `domain.connect_issued` · 조직 시간당 10.
 * 템플릿은 하나(소유 TXT · 수신 MX · MAIL FROM MX · SPF · DKIM CNAME 셋 — 동의 한 번).
 */
type DomainConnectInfo = { readonly supported: false } | { readonly supported: true; readonly providerName: string };
type DomainConnectIssued =
  | { readonly supported: false }
  | { readonly supported: true; readonly providerName: string; readonly applyUrl: string; readonly records: readonly DnsRecordSpec[] };

const DOMAIN_CONNECT_ERRORS = {
  unavailable: 'domain_connect_phase_unavailable',
  /** 이 서브도메인에 이미 다른 메일 서버(MX)가 있다 — 템플릿의 MX 가 그 메일을 덮어쓰므로 자동으로 넣지 않는다(보안 리뷰 M3). */
  existingMail: 'domain_connect_existing_mail',
  /** 조직 시간당 서명 URL 발급 상한(`DOMAIN_CONNECTS_PER_ORG_PER_HOUR`). */
  rateLimited: 'domain_connect_rate_limited',
} as const;

/** 서명 URL 발급 감사 행위(`owner_actions` — 대상 = 도메인 id. URL · 토큰 값은 어디에도 적지 않는다). */
export const DOMAIN_CONNECT_ACTION = 'domain.connect_issued';
/** 조직 시간당 서명 URL 발급 상한(감사 행 `domain.connect_issued` 를 센다 — 발급은 단추를 누를 때만). */
const DOMAIN_CONNECTS_PER_ORG_PER_HOUR = 10;

async function connectsLastHour(db: Queryable, organizationId: string, now: Date): Promise<number> {
  const result = await db.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM owner_actions WHERE organization_id = $1 AND action = $2 AND created_at > $3`,
    [organizationId, DOMAIN_CONNECT_ACTION, new Date(now.getTime() - HOUR_MS)],
  );
  return result.rows[0]?.n ?? 0;
}

function connectRateLimited(): AdminInputError {
  return new AdminInputError(
    `이 조직의 DNS 자동 입력 링크는 시간당 ${String(DOMAIN_CONNECTS_PER_ORG_PER_HOUR)}번까지다.`,
    DOMAIN_CONNECT_ERRORS.rateLimited,
    429,
  );
}

/** 이 행의 서브도메인에 이미 다른 메일이 오는가 — 확인 대기 사유 `subdomain_has_mail` 또는 마지막 MX 판정 `other`. */
function hasExistingMail(row: Pick<DomainRow, 'pendingReason' | 'inboundMxStatus'>): boolean {
  return row.pendingReason === 'subdomain_has_mail' || row.inboundMxStatus === 'other';
}

/**
 * GET · POST 공통 판정 — 404(다른 조직 · 없음) → 403 기능 → 409 불가(pending · verifying ∧ DKIM 토큰 셋일 때만) → 409 `domain_connect_existing_mail`.
 * 입력은 id 뿐이고 URL 의 모든 값은 행에서 온다(서명 오라클 아님).
 */
async function connectableRow(db: Queryable, organizationId: string, rawId: unknown): Promise<DomainRow> {
  const row = await rowOfOrganization(db, organizationId, rawId);
  await requireFeature(db, organizationId);
  const available = (row.status === 'pending' || row.status === 'verifying') && row.dkimTokens.length === 3;
  if (!available) throw new AdminInputError('이 도메인의 지금 상태에서는 레코드를 자동으로 넣을 수 없다.', DOMAIN_CONNECT_ERRORS.unavailable, 409);
  if (hasExistingMail(row)) {
    throw new AdminInputError('이 서브도메인에는 다른 메일 서버가 있어 자동으로 넣지 않는다(MX 를 덮어쓴다).', DOMAIN_CONNECT_ERRORS.existingMail, 409);
  }
  return row;
}

/** 업체 발견(5분 캐시) — 미지원이면 로그 한 줄과 `null`. */
async function discoverProvider(dc: DomainConnectDependencies, row: DomainRow) {
  const discovered = await dc.discovery.discover(row.registrable, DC_SERVICE_ID);
  if (discovered.supported) return discovered;
  log('info', 'domain.connect_unsupported', { route_id: 'admin', outcome: discovered.reason });
  return null;
}

/** `GET` — 단추를 보일지만. 플래그 꺼짐(`dc` 없음) · 업체 미지원이면 `{supported:false}`. 쓰기 · 서명 없음. 옛 콘솔의 쿼리 `phase` 는 보지 않는다. */
export async function domainConnectInfoOp(
  db: Queryable,
  organizationId: string,
  rawId: unknown,
  dc: DomainConnectDependencies | undefined,
): Promise<DomainConnectInfo> {
  const row = await connectableRow(db, organizationId, rawId);
  if (dc === undefined) return { supported: false };
  const discovered = await discoverProvider(dc, row);
  if (discovered === null) return { supported: false };
  return { supported: true, providerName: discovered.providerName };
}

/**
 * `POST` — 서명 URL 하나. 공통 판정 → 429 상한(잠금 없는 앞선 확인 — 서명 전에 거른다. 확정은 라우트가 감사와 한 트랜잭션에서 하는
 * `recordConnectIssued`) → 플래그 꺼짐 · 업체 미지원이면 `{supported:false}`(감사 없음) → 서명. 행 값이 템플릿 모양에 맞지 않으면
 * (`DomainConnectInputError` — 깨진 토큰 · apex) `{supported:false}` 로 접는다(로그만).
 */
export async function domainConnectIssueOp(
  db: Queryable,
  organizationId: string,
  rawId: unknown,
  dc: DomainConnectDependencies | undefined,
  now: Date = new Date(),
): Promise<DomainConnectIssued> {
  const row = await connectableRow(db, organizationId, rawId);
  if ((await connectsLastHour(db, organizationId, now)) >= DOMAIN_CONNECTS_PER_ORG_PER_HOUR) throw connectRateLimited();
  if (dc === undefined) return { supported: false };
  const discovered = await discoverProvider(dc, row);
  if (discovered === null) return { supported: false };
  try {
    const applyUrl = await buildApplyUrl({ urlSyncUX: discovered.urlSyncUX, row, signer: dc.signer });
    return { supported: true, providerName: discovered.providerName, applyUrl, records: connectRecordsOf(row) };
  } catch (error) {
    if (!(error instanceof DomainConnectInputError)) throw error;
    log('warn', 'domain.connect_row_invalid', { route_id: 'admin', outcome: error.code, detail: `domain_id=${row.id}` });
    return { supported: false };
  }
}

/**
 * 발급 확정 — 호출자(`audited`)의 트랜잭션 안에서 조직 도메인 잠금 아래 지난 1시간 발급 수를 다시 센다(동시 요청이 상한을 넘지 못하게). 상한이면 429
 * (감사 행 없음 · URL 은 나가지 않는다). 감사 행은 호출자가 적는다(행위 `domain.connect_issued` · 대상 = 도메인 id · 행위자 = 세션 — 값 없음).
 */
export async function recordConnectIssued(db: Queryable, organizationId: string, now: Date): Promise<void> {
  await lockOrganizationDomains(db, organizationId);
  if ((await connectsLastHour(db, organizationId, now)) >= DOMAIN_CONNECTS_PER_ORG_PER_HOUR) throw connectRateLimited();
}
