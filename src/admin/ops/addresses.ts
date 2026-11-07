/**
 * src/admin/ops/addresses.ts — 에이전트 **별칭 주소**의 목록·추가·폐기(메일 기본기 2차 A6, 진윤겸 결정 D5 비공개 · D6 요금제별 · D7 추가+폐기,
 * ADR-0013 2차 절). 콘솔 `GET|POST /api/agents/{agentId}/aliases` · `POST …/aliases/{addressId}/retire` 가 부른다(owner·admin).
 *
 * 별칭 = `agent_addresses` 의 대표가 아닌 행(`is_primary = false`). 대표 주소 변경은 범위 밖이다.
 *
 * 한도(한 조직 잠금 `agent_addresses_org:<조직>` 아래에서 센다 — DB 천장 트리거 `agent_addresses_alias_ceiling`(202609270110)과 같은 키):
 *   - **활성 별칭**(폐기 제외) ≤ `min(요금제 aliases_per_agent_max, MAX_ACTIVE_ALIASES_PER_AGENT)` → 넘으면 409 `alias_plan_limit`
 *     (Free = 0 이라 첫 추가부터 409 — 콘솔은 "업그레이드" 로 잠근다).
 *   - **누적 발급**(폐기 포함) ≤ `MAX_ALIASES_ISSUED_PER_AGENT` → 409 `alias_issued_limit`(폐기·재발급으로 주소를 무한히 태우지 못한다).
 *   - **조직 하루(24시간) 발급** ≤ `MAX_ALIASES_PER_ORG_PER_DAY` → 409 `alias_org_daily_limit`.
 *   세 코드가 다르다(AC-A6-1). 강등으로 활성 수가 한도를 넘은 에이전트는 **폐기하지 않는다**(되돌릴 수 없는 잎을 자동으로 만들지 않는다 — 계획 R18):
 *   수신은 그대로, 추가만 409 다. 목록이 `overLimit` 으로 알린다.
 *
 * 폐기: `retired_at` 쓰기 1회(DB 가드 — 시각도 DB 가 적는다) · 대표는 400 `address_primary_not_retirable` · 이미 폐기면 200 `replayed`(감사 없음).
 * 폐기 효력(수신 거부 · Stage 1 · 발신 주소 목록 · 공개 조회 제외)은 각 읽기 SQL 의 `retired_at IS NULL` 이 낸다.
 *
 * 재발급(진윤겸 결정 2026-09-29, ADR-0013 2026-09-29 개정 · 마이그레이션 202609291002): 폐기한 별칭은 **폐기한 조직**이 곧바로(그 조직의 어느
 * 에이전트에게든), **다른 조직**은 `retired_at` 뒤 `ALIAS_REISSUE_HOLD_DAYS` 일이 지나야 다시 발급한다. 활성 행이 있거나 보류 중이면 409
 * `address_taken` 하나로 답한다 — 다른 조직이 막 지운 주소인지 드러내지 않는다. 검사는 주소 잠금(`agent_addresses_address:<주소>`) 아래에서 하고,
 * DB 보류 트리거 `agent_addresses_reissue_hold` 가 같은 잠금으로 한 번 더 막는다(폐기 가드도 같은 잠금을 잡아 폐기·발급 경합이 없다).
 *
 * 투명성: 추가 = `identity.address_assigned`(INSERT 트리거), 폐기 = `identity.address_retired`(tlog v4 트리거). 감사 행은 호출자(`audited`)가 쓴다.
 * 로그·오류 메시지에 주소 원문을 싣지 않는다(오류는 코드만 — 입력을 되풀이하지 않는다).
 */

import type { Queryable } from '../../db/client';
import { loadAgentEntitlements } from '../../db/repositories/entitlements';
import type { AgentId } from '../../db/schema';
import { AGENT_ADDRESS_DOMAIN, addressDomain, AgentAddressError, buildAgentAddress, type OperatorReservedAddress } from '../../identity/address';
import { AdminInputError, notFound, sqlStateOf, UUID_PATTERN } from './errors';

/** 에이전트당 활성 별칭 천장 — `ENTITLEMENT_CEILINGS.aliasesPerAgentMax` · DB 트리거 `agent_addresses_alias_ceiling` 의 20 과 같다. */
export const MAX_ACTIVE_ALIASES_PER_AGENT = 20;
/** 에이전트당 누적 발급(폐기 포함) 천장 — 코드 상수(D6). DB 트리거와 같다. Scale(활성 20)은 교체 여지가 0 이다(계획 §4 A6 ⚠, 후속 재검토). */
export const MAX_ALIASES_ISSUED_PER_AGENT = 20;
/** 조직당 24시간 발급 천장 — 코드 상수(D6). DB 트리거와 같다. */
export const MAX_ALIASES_PER_ORG_PER_DAY = 20;
/** 다른 조직이 폐기한 주소를 발급할 수 있기까지의 날 수 — DB 보류 트리거 `agent_addresses_reissue_hold`(202609291002)의 30일과 같다. */
export const ALIAS_REISSUE_HOLD_DAYS = 30;

type AddressStatus = 'active' | 'retired';

interface AddressView {
  readonly id: string;
  readonly address: string;
  /**
   * **유효 대표 주소**인가(ADR-0014 2026-10 개정 — `atmark_agent_primary_address`). 고객 도메인 주소를 대표로 고르기 전에는 앵커(`anchor`)와 같다.
   * 대표가 무효(도메인을 잃었다)면 어느 행도 참이 아니다 — 에이전트는 "주소 없음".
   */
  readonly primary: boolean;
  /** @atmark.ai **앵커**(`is_primary` 행 — 폐기할 수 없다). 잠든 앵커는 목록에 아예 나오지 않는다. */
  readonly anchor: boolean;
  readonly status: AddressStatus;
  readonly createdAt: string;
  readonly retiredAt: string | null;
}

interface AddressListView {
  readonly items: readonly AddressView[];
  readonly aliases: {
    /** 활성 별칭 수(대표 제외). */
    readonly active: number;
    /** 적용 한도 = min(요금제, 천장). */
    readonly activeMax: number;
    /** 누적 발급(폐기 포함). */
    readonly issued: number;
    readonly issuedMax: number;
    /** 강등 뒤 활성 수가 한도를 넘었다 — 새 별칭은 409, 기존은 그대로 받는다. */
    readonly overLimit: boolean;
  };
}

interface AddressRow {
  id: string;
  address: string;
  is_primary: boolean;
  created_at: Date;
  retired_at: Date | null;
}

function view(row: AddressRow, effectivePrimary: string | null = null): AddressView {
  return {
    id: row.id,
    address: row.address,
    primary: row.retired_at === null && effectivePrimary !== null && row.address === effectivePrimary,
    anchor: row.is_primary,
    status: row.retired_at === null ? 'active' : 'retired',
    createdAt: row.created_at.toISOString(),
    retiredAt: row.retired_at === null ? null : row.retired_at.toISOString(),
  };
}

async function aliasLimit(db: Queryable, agentId: AgentId, now: Date): Promise<number> {
  const entitlements = await loadAgentEntitlements(db, agentId, now);
  return Math.min(entitlements?.aliasesPerAgentMax ?? 0, MAX_ACTIVE_ALIASES_PER_AGENT);
}

async function counts(db: Queryable, agentId: AgentId): Promise<{ active: number; issued: number }> {
  const result = await db.query<{ active: number; issued: number }>(
    `SELECT count(*) FILTER (WHERE retired_at IS NULL)::int AS active, count(*)::int AS issued
       FROM agent_addresses WHERE agent_id = $1 AND NOT is_primary`,
    [agentId],
  );
  return result.rows[0] ?? { active: 0, issued: 0 };
}

/** 유효 대표 주소(SQL 판정 `atmark_agent_primary_address`). 무효한 고객 선택이면 `null`. */
async function effectivePrimaryAddress(db: Queryable, agentId: AgentId): Promise<string | null> {
  const result = await db.query<{ address: string | null }>('SELECT atmark_agent_primary_address($1) AS address', [agentId]);
  return result.rows[0]?.address ?? null;
}

/**
 * 에이전트의 주소 전부(유효 대표 먼저 · 활성 · 폐기 순) + 별칭 한도. 조직 범위는 호출자(`requireAgentInOrganization`)가 먼저 본다.
 * **잠든 앵커는 빠진다**(ADR-0014 2026-10 개정 — 마지막 대표 선택이 앵커가 아니면 앵커는 보이지 않는다 · 계약 `anchorDormantOf`).
 */
export async function listAddressesOp(db: Queryable, agentId: AgentId, now: Date): Promise<AddressListView> {
  const rows = await db.query<AddressRow>(
    `SELECT x.id::text AS id, x.address, x.is_primary, x.created_at, x.retired_at
       FROM agent_addresses x WHERE x.agent_id = $1
        AND NOT (x.is_primary AND coalesce((SELECT p.address_id <> x.id FROM agent_primary_changes p WHERE p.agent_id = x.agent_id
                                             ORDER BY p.created_at DESC, p.id DESC LIMIT 1), false))
      ORDER BY x.address = atmark_agent_primary_address($1) DESC NULLS LAST, x.is_primary DESC, (x.retired_at IS NULL) DESC, x.created_at, x.id`,
    [agentId],
  );
  const primary = await effectivePrimaryAddress(db, agentId);
  const { active, issued } = await counts(db, agentId);
  const activeMax = await aliasLimit(db, agentId, now);
  return {
    items: rows.rows.map((row) => view(row, primary)),
    aliases: { active, activeMax, issued, issuedMax: MAX_ALIASES_ISSUED_PER_AGENT, overLimit: active > activeMax },
  };
}

/** 삭제한 에이전트에 쓰기 — 409 `agent_deleted`. 읽기(목록 · 로그 · 받은 메일 기록)는 그대로 된다. */
export function agentDeleted(): AdminInputError {
  return new AdminInputError('삭제한 에이전트다 — 바꿀 수 없다.', 'agent_deleted', 409);
}

/**
 * 삭제한 에이전트(`disabled` — 종단, 202610131000)면 409 `agent_deleted` — 주소를 새로 붙이거나(별칭 · 대표 선택) 웹훅 · 신원 게시처럼 **삭제를
 * 거스르는** 쓰기 앞에서 **그 쓰기와 같은 트랜잭션 안에서** 부른다. 없는 에이전트는 호출자의 조직 검사(`requireAgentInOrganization`)가 이미 404 로 걸렀다. DB 트리거
 * `agent_addresses_reject_disabled_agent` 가 주소 INSERT 를 한 번 더 막는다.
 */
export async function requireLiveAgent(db: Queryable, agentId: AgentId): Promise<void> {
  // FOR SHARE — 판정과 커밋 사이에 삭제가 끼지 않는다(보안 리뷰 MED-2). 삭제는 이 행을 NO KEY UPDATE 로 잡으므로 줄 선다. 호출자는 admin 롤
  // (`agents.status` UPDATE 칸이 있어 행 잠금을 잡을 수 있다).
  const result = await db.query<{ status: string }>('SELECT status::text AS status FROM agents WHERE id = $1 FOR SHARE', [agentId]);
  if (result.rows[0]?.status === 'disabled') throw agentDeleted();
}

/** 조직 별칭 잠금 — DB 천장 트리거와 같은 키. 에이전트 만들기(`provisionAgentOp`)도 주소 탐침 수를 셀 때 잡는다. */
export async function lockOrganizationAliases(db: Queryable, organizationId: string): Promise<void> {
  await db.query(`SELECT pg_advisory_xact_lock(hashtextextended('agent_addresses_org:' || $1::text, 0))`, [organizationId]);
}

/** 이미 쓰인 주소로 별칭 추가를 시도한 감사 행위 — 조직 하루 발급 수에 센다(보안 리뷰 L4). `routes/aliases.ts` 가 쓴다. */
export const ALIAS_TAKEN_ACTION = 'agent.alias.taken';
/**
 * 쓸 수 없는 주소로 **에이전트 만들기**를 시도한 감사 행위(재발급 보안 리뷰 M2) — 콘솔·조직 키 둘 다. 대상 없음(에이전트가 생기지 않았다).
 * 별칭 시도와 함께 조직의 하루 주소 탐침 상한에 센다.
 */
export const AGENT_CREATE_TAKEN_ACTION = 'agent.create.taken';
/** 주소 탐침으로 세는 감사 행위 — 쓸 수 없는 주소로 시도한 별칭 추가 · 에이전트 만들기. */
const ADDRESS_TAKEN_ACTIONS: readonly string[] = [ALIAS_TAKEN_ACTION, AGENT_CREATE_TAKEN_ACTION];

/** 조직의 지난 24시간 주소 탐침 수(쓸 수 없는 주소로 한 시도 — 별칭·에이전트). 호출자가 조직 잠금을 잡은 뒤 부른다. */
export async function countAddressProbes(db: Queryable, organizationId: string): Promise<number> {
  const result = await db.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM owner_actions o
      WHERE o.organization_id = $1 AND o.action = ANY ($2::text[]) AND o.created_at > now() - interval '24 hours'`,
    [organizationId, [...ADDRESS_TAKEN_ACTIONS]],
  );
  return result.rows[0]?.n ?? 0;
}

/**
 * 조직 하루(24시간) 별칭 발급 상한 — 넘으면 409 `alias_org_daily_limit`. 조직 잠금 아래에서 부른다(별칭 추가 · 고객 도메인 대표로 만들기).
 * **이미 쓰인 주소로 시도한 것도 센다**(감사 행 `agent.alias.taken` · `agent.create.taken`, 보안 리뷰 L4 · 재발급 M2): 409 `address_taken` 은
 * "그 주소가 지금 쓸 수 없다" 를 알려 주므로, 세지 않으면 조직 하나가 다른 조직의 주소를 무한히 탐침한다.
 */
export async function requireOrgDailyAliasCapacity(db: Queryable, organizationId: string): Promise<void> {
  const today = await db.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM agent_addresses d JOIN agents a ON a.id = d.agent_id
      WHERE a.organization_id = $1 AND NOT d.is_primary AND d.created_at > now() - interval '24 hours'`,
    [organizationId],
  );
  if ((today.rows[0]?.n ?? 0) + (await countAddressProbes(db, organizationId)) >= MAX_ALIASES_PER_ORG_PER_DAY) {
    throw new AdminInputError(`조직의 하루 별칭 발급 상한(${String(MAX_ALIASES_PER_ORG_PER_DAY)} — 이미 쓰인 주소 시도 포함)에 닿았다.`, 'alias_org_daily_limit', 409);
  }
}

/**
 * 이 조직이 지금 이 주소를 발급받을 수 있는가 — **주소 잠금을 잡고** 본다(DB 보류 트리거 `agent_addresses_reissue_hold`·폐기 가드와 같은 키,
 * 조직 잠금 다음 · 교착 없음 — 202609291002 머리말). 쓸 수 없음 = 활성 행이 있다(어느 조직이든) · 다른 조직이 보류 기간 안에 폐기했다.
 * 이 조직이 폐기한 주소는 곧바로 쓸 수 있다. 잠금은 트랜잭션 끝까지 가므로 같은 트랜잭션의 INSERT 까지 결과가 바뀌지 않는다.
 */
export async function claimAddress(db: Queryable, organizationId: string, address: string): Promise<boolean> {
  await db.query(`SELECT pg_advisory_xact_lock(hashtextextended('agent_addresses_address:' || $1::text, 0))`, [address]);
  const taken = await db.query(
    `SELECT 1 FROM agent_addresses d JOIN agents a ON a.id = d.agent_id
      WHERE d.address = $1
        AND (d.retired_at IS NULL OR (a.organization_id <> $2 AND d.retired_at > now() - make_interval(days => $3::int)))
      LIMIT 1`,
    [address, organizationId, ALIAS_REISSUE_HOLD_DAYS],
  );
  return (taken.rowCount ?? 0) === 0;
}

/**
 * 별칭 하나 추가 — **호출자의 트랜잭션 안에서**(잠금이 트랜잭션 끝까지 간다). 로컬파트는 대표 주소와 같은 규칙(`buildAgentAddress` — 예약
 * 로컬파트·모양). 도메인은 `atmark.ai` 하나다(고객 도메인은 별도 계획).
 */
export type AddAliasOutcome = { readonly kind: 'added'; readonly item: AddressView } | { readonly kind: 'taken' };

/**
 * 본문의 `domain`(선택) — 없거나 `null` 이면 `atmark.ai`. 고객 도메인이면 모양만 여기서 보고(`buildAgentAddress` — 대문자 · 모양 · 길이), 그 조직이
 * verified 로 가졌는지는 `requireVerifiedDomain` 과 DB 가드(P0A05)가 본다.
 */
export function aliasDomainOf(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw new AdminInputError('domain 은 문자열이다.', 'invalid_domain');
  return value.trim().toLowerCase();
}

/**
 * 이 조직이 지금 고객 도메인 주소를 **발급**받을 수 있는가(키 보관 전에 본다): 기능 허용 목록(`org_features`)에 없으면 403 `feature_not_enabled`
 * (#15 보안 리뷰 L2 — 허용 목록에서 빠진 조직은 새 고객 주소를 만들지 못한다 · 이미 있는 주소의 사용은 관문이 판단한다), 그 도메인을 verified 로
 * 갖지 않았으면 400 `domain_not_verified`(DB 가드 P0A05 와 같은 코드).
 */
export async function requireVerifiedDomain(db: Queryable, organizationId: string, domain: string): Promise<void> {
  const result = await db.query<{ enabled: boolean; verified: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM org_features f WHERE f.organization_id = $1 AND f.feature = 'custom_domains') AS enabled,
            EXISTS (SELECT 1 FROM custom_domains d WHERE d.organization_id = $1 AND d.domain = $2 AND d.status = 'verified') AS verified`,
    [organizationId, domain],
  );
  const row = result.rows[0];
  if (row?.enabled !== true) throw new AdminInputError('이 조직에는 고객 도메인 기능이 켜져 있지 않다.', 'feature_not_enabled', 403);
  if (row.verified !== true) throw new AdminInputError('조직이 확인(verified)한 고객 도메인이 아니다.', 'domain_not_verified');
}

/**
 * 주소 INSERT 하나를 SAVEPOINT 로 감싼다 — 사람 이메일 claim 충돌(P0A01, ADR-0014 결정 7)이면 그 INSERT 만 되돌리고 `null`(호출자는 "쓸 수 없는 주소"
 * 로 감사 행을 커밋한다 — 어떤 주소가 누구의 사람 이메일인지 캐 보는 경로를 두지 않는다). 그 밖의 오류는 그대로 던진다.
 */
async function insertAddressUnlessClaimed(db: Queryable, agentId: AgentId, address: string): Promise<AddressRow | null> {
  await db.query('SAVEPOINT address_claim');
  try {
    const inserted = await db.query<AddressRow>(
      `INSERT INTO agent_addresses (agent_id, address, domain, is_primary) VALUES ($1, $2, $3, false)
       RETURNING id::text AS id, address, is_primary, created_at, retired_at`,
      [agentId, address, addressDomain(address)],
    );
    await db.query('RELEASE SAVEPOINT address_claim');
    const row = inserted.rows[0];
    if (row === undefined) throw new Error('agent_addresses INSERT 가 행을 돌려주지 않았다');
    return row;
  } catch (error) {
    await db.query('ROLLBACK TO SAVEPOINT address_claim');
    if (sqlStateOf(error) === 'P0A01') return null;
    throw error;
  }
}

export async function addAliasOp(
  db: Queryable,
  organizationId: string,
  agentId: AgentId,
  rawLocalPart: unknown,
  now: Date,
  rawDomain: unknown = undefined,
): Promise<AddAliasOutcome> {
  if (typeof rawLocalPart !== 'string') throw new AdminInputError('localPart 가 필요하다.', 'invalid_local_part');
  const domain = aliasDomainOf(rawDomain);
  let address: string;
  try {
    address = domain === null ? buildAgentAddress(rawLocalPart) : buildAgentAddress(rawLocalPart, domain);
  } catch (error) {
    if (error instanceof AgentAddressError) throw new AdminInputError('쓸 수 없는 로컬파트다(모양·예약 이름).', error.reason);
    throw error;
  }
  await lockOrganizationAliases(db, organizationId);
  // 삭제한 에이전트에는 주소를 새로 붙이지 않는다(409 `agent_deleted`) — 조직 잠금 뒤에 본다(삭제 연산도 같은 잠금을 잡는다 — 줄 선다).
  await requireLiveAgent(db, agentId);
  if (domain !== null && domain !== AGENT_ADDRESS_DOMAIN) await requireVerifiedDomain(db, organizationId, domain);
  const limit = await aliasLimit(db, agentId, now);
  const { active, issued } = await counts(db, agentId);
  if (active >= limit) {
    throw new AdminInputError(`이 요금제의 에이전트당 별칭 한도(${String(limit)})에 닿았다.`, 'alias_plan_limit', 409);
  }
  if (issued >= MAX_ALIASES_ISSUED_PER_AGENT) {
    throw new AdminInputError(`에이전트당 별칭 발급 상한(폐기 포함 ${String(MAX_ALIASES_ISSUED_PER_AGENT)})에 닿았다.`, 'alias_issued_limit', 409);
  }
  await requireOrgDailyAliasCapacity(db, organizationId);
  // 던지지 않고 돌려준다 — 호출자가 시도를 감사 행(`agent.alias.taken`)으로 남기고 커밋한 뒤 409 를 낸다(L4). 두 조직이 같은 주소를 동시에 청하면
  // 주소 잠금이 줄 세워 하나만 이긴다.
  if (!(await claimAddress(db, organizationId, address))) return { kind: 'taken' };
  const row = await insertAddressUnlessClaimed(db, agentId, address);
  if (row === null) return { kind: 'taken' };
  return { kind: 'added', item: view(row) };
}

/**
 * **운영자 예약 주소**(`onve@atmark.ai` 등)를 별칭으로 붙인다 — 운영자 CLI(`pnpm admin:reserved-address alias`)만 부른다. 이 파일은 타입만 쓴다
 * (`buildOperatorReservedAddress` 는 `src/admin` 에서 import 하지 않는다 — arch 테스트). 호출자의 트랜잭션 안에서.
 *
 * `addAliasOp` 와 다른 점은 **요금제 별칭 한도를 보지 않는다**는 것 하나다(운영자 주소는 요금제 기능이 아니다). DB 천장(활성 20 · 누적 20 · 조직
 * 하루 20 — `agent_addresses_alias_ceiling`)·재발급 보류·운영자 허가(`agent_addresses_operator_grant_guard` — 그 조직의 허가 행, 없으면 42501)는
 * 그대로 선다. 멱등: 이 에이전트에 이미 활성으로 붙어 있으면 `exists`(INSERT 없음 — 잎도 새로 생기지 않는다). 투명성 잎 `identity.address_assigned`
 * 는 INSERT 트리거가 쓴다(우회 없음).
 */
type AddOperatorAliasOutcome =
  | { readonly kind: 'added'; readonly item: AddressView }
  | { readonly kind: 'exists'; readonly item: AddressView }
  | { readonly kind: 'taken' };

export async function addOperatorReservedAliasOp(
  db: Queryable,
  organizationId: string,
  agentId: AgentId,
  address: OperatorReservedAddress,
): Promise<AddOperatorAliasOutcome> {
  await lockOrganizationAliases(db, organizationId);
  const existing = await db.query<AddressRow>(
    `SELECT id::text AS id, address, is_primary, created_at, retired_at FROM agent_addresses
      WHERE agent_id = $1 AND address = $2 AND retired_at IS NULL`,
    [agentId, address],
  );
  const current = existing.rows[0];
  if (current !== undefined) return { kind: 'exists', item: view(current) };
  if (!(await claimAddress(db, organizationId, address))) return { kind: 'taken' };
  const inserted = await db.query<AddressRow>(
    `INSERT INTO agent_addresses (agent_id, address, domain, is_primary) VALUES ($1, $2, $3, false)
     RETURNING id::text AS id, address, is_primary, created_at, retired_at`,
    [agentId, address, addressDomain(address)],
  );
  const row = inserted.rows[0];
  if (row === undefined) throw new Error('agent_addresses INSERT 가 행을 돌려주지 않았다');
  return { kind: 'added', item: view(row) };
}

type RetireOutcome = { readonly kind: 'retired' | 'replayed'; readonly item: AddressView };

/** 별칭 하나 폐기 — 쓰기 1회. 에이전트 범위(주소 id 와 에이전트 id 를 둘 다 건다 — 다른 에이전트의 주소는 404). */
export async function retireAliasOp(db: Queryable, agentId: AgentId, rawAddressId: unknown): Promise<RetireOutcome> {
  if (typeof rawAddressId !== 'string' || !UUID_PATTERN.test(rawAddressId)) throw new AdminInputError('addressId 는 주소 id(소문자 uuid)다.', 'invalid_address_id');
  // 조직 잠금 먼저(발급 · 대표 선택 가드와 같은 키 — ADR-0014 2026-10 개정 · #13 보안 리뷰): "유효 대표인가" 판정과 폐기가 대표 선택 커밋과 줄을 선다
  // (잠금 없이 보면 선택 커밋 직전의 판정으로 새 대표를 폐기해 대표가 NULL 이 된다).
  const organization = await db.query<{ organization_id: string }>('SELECT organization_id::text AS organization_id FROM agents WHERE id = $1', [agentId]);
  const organizationId = organization.rows[0]?.organization_id;
  if (organizationId === undefined) throw notFound('주소가 없다.', 'address_not_found');
  await lockOrganizationAliases(db, organizationId);
  const current = await db.query<AddressRow>(
    `SELECT id::text AS id, address, is_primary, created_at, retired_at FROM agent_addresses WHERE id = $1 AND agent_id = $2 FOR UPDATE`,
    [rawAddressId, agentId],
  );
  const row = current.rows[0];
  if (row === undefined) throw notFound('주소가 없다.', 'address_not_found');
  if (row.is_primary) throw new AdminInputError('대표 주소는 폐기할 수 없다.', 'address_primary_not_retirable');
  if (row.retired_at !== null) return { kind: 'replayed', item: view(row) };
  // 지금 **유효 대표**인 별칭(고객 도메인 주소를 대표로 골랐다)은 폐기하지 않는다(ADR-0014 2026-10 개정) — 먼저 다른 주소를 대표로 고른다.
  if ((await effectivePrimaryAddress(db, agentId)) === row.address) {
    throw new AdminInputError('지금 대표 주소인 별칭은 폐기할 수 없다 — 먼저 다른 주소를 대표로 고른다.', 'address_is_primary', 409);
  }
  // 값은 DB 가드가 now() 로 덮는다 — 여기서 보내는 값은 "폐기한다" 는 표시일 뿐이다.
  const updated = await db.query<AddressRow>(
    `UPDATE agent_addresses SET retired_at = now() WHERE id = $1 AND agent_id = $2 AND retired_at IS NULL
     RETURNING id::text AS id, address, is_primary, created_at, retired_at`,
    [rawAddressId, agentId],
  );
  const retired = updated.rows[0];
  if (retired === undefined) throw new Error('agent_addresses 폐기가 행을 돌려주지 않았다');
  return { kind: 'retired', item: view(retired) };
}

/** 조직에서 활성 별칭이 요금제 한도를 넘는 에이전트 수(강등 뒤 — 콘솔 요금제 화면의 초과 배너). */
export async function countAgentsOverAliasLimit(db: Queryable, organizationId: string, limit: number): Promise<number> {
  const result = await db.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM (
       SELECT d.agent_id FROM agent_addresses d JOIN agents a ON a.id = d.agent_id
        WHERE a.organization_id = $1 AND NOT d.is_primary AND d.retired_at IS NULL
        GROUP BY d.agent_id HAVING count(*) > $2) over_limit`,
    [organizationId, limit],
  );
  return result.rows[0]?.n ?? 0;
}

// ---------------------------------------------------------------------------
// 대표 주소 선택(ADR-0014 2026-10 개정 · M3b)
// ---------------------------------------------------------------------------

interface PrimaryChoiceView {
  /** 고른 주소 행. */
  readonly addressId: string;
  /** 지금의 유효 대표(고른 주소와 같다 — 가드가 살아 있는 대상만 받는다). */
  readonly address: string | null;
  /** 이미 그 주소가 마지막 선택이었다(쓰기 · 감사 없음). */
  readonly replayed: boolean;
}

/**
 * 대표 주소 고르기 — **호출자의 트랜잭션 안에서**. 대상 = 이 에이전트의 앵커(언제나 — "@atmark.ai 주소 켜기") 또는 같은 조직이 verified 로 가진
 * 고객 도메인의 활성 별칭. 판정은 DB 가드(`agent_primary_changes_guard`)가 한다: atmark.ai 별칭 · 폐기된 주소 → P0A08(400 `primary_not_eligible`),
 * 확인되지 않은 도메인 → P0A05(400 `domain_not_verified`), 속도 상한(에이전트 5 · 조직 50 / 24시간) → P0A09(429), 운영자 예약 앵커 → 42501(403).
 * 재생: 마지막 선택이 이미 그 주소면(선택이 없고 대상이 앵커여도) 쓰지 않고 `replayed`(상한을 먹지 않는다). 다른 에이전트의 주소 · 없는 주소는 404.
 */
export async function setAgentPrimaryOp(
  db: Queryable,
  organizationId: string,
  agentId: AgentId,
  rawAddressId: unknown,
  anchor = false,
): Promise<PrimaryChoiceView> {
  if (!anchor && (typeof rawAddressId !== 'string' || !UUID_PATTERN.test(rawAddressId))) {
    throw new AdminInputError('addressId 는 주소 id(소문자 uuid)다 — @atmark.ai 주소를 켜려면 {anchor: true}.', 'invalid_address_id');
  }
  // 조직 잠금 — 가드와 같은 키(먼저 잡아 재생 판정과 INSERT 사이에 다른 선택이 끼지 않게).
  await lockOrganizationAliases(db, organizationId);
  await requireLiveAgent(db, agentId);
  // `anchor` — 잠든 앵커는 목록에 나오지 않아 id 를 모른다("@atmark.ai 주소 켜기"). 서버가 그 에이전트의 앵커를 고른다.
  const target = anchor
    ? await db.query<{ id: string; is_primary: boolean; domain: string }>(
        'SELECT id::text AS id, is_primary, domain FROM agent_addresses WHERE agent_id = $1 AND is_primary AND retired_at IS NULL',
        [agentId],
      )
    : await db.query<{ id: string; is_primary: boolean; domain: string }>(
        'SELECT id::text AS id, is_primary, domain FROM agent_addresses WHERE id = $1 AND agent_id = $2',
        [rawAddressId, agentId],
      );
  const row = target.rows[0];
  if (row === undefined) throw notFound('주소가 없다.', 'address_not_found');
  // 고객 도메인 주소를 대표로 고르는 것도 고객 주소 사용의 시작이다 — 허용 목록에서 빠진 조직은 403(#15 L2). 앵커로 되돌리기는 언제나 된다.
  if (!row.is_primary && row.domain !== AGENT_ADDRESS_DOMAIN) await requireVerifiedDomain(db, organizationId, row.domain);
  const last = await db.query<{ address_id: string }>(
    'SELECT address_id::text AS address_id FROM agent_primary_changes WHERE agent_id = $1 ORDER BY created_at DESC, id DESC LIMIT 1',
    [agentId],
  );
  const lastChoice = last.rows[0]?.address_id ?? null;
  if (lastChoice === row.id || (lastChoice === null && row.is_primary)) {
    return { addressId: row.id, address: await effectivePrimaryAddress(db, agentId), replayed: true };
  }
  try {
    await db.query(`INSERT INTO agent_primary_changes (agent_id, address_id, cause) VALUES ($1, $2, 'owner')`, [agentId, row.id]);
  } catch (error) {
    if (sqlStateOf(error) === '42501') throw new AdminInputError('이 에이전트의 대표 주소는 운영자만 바꾼다.', 'primary_change_forbidden', 403);
    throw error;
  }
  return { addressId: row.id, address: await effectivePrimaryAddress(db, agentId), replayed: false };
}
