/**
 * src/admin/ops/agents.ts — 조직·에이전트·토큰·kill-switch 연산. CLI(`pnpm admin:*`)와 관리 API 가 **같은 함수**를 부른다.
 *
 * 가드(두 표면 동일 — `test/integration/admin/admin-guard-parity.test.ts`):
 *   - **프로비저닝 원자성** — `provisionAgent`(src/identity/provisioning.ts) 그대로: 에이전트 · keypair · draft passport · 주소 ·
 *     정책(콘솔 세션의 소유자 생성은 발신 `unrestricted`(전체) · 수신 `all` — 2026-10-13 결정 B, 그 밖의 길은 발신 `allowlist_only`) ·
 *     seed(= 발신 allow 목록) · 버전 1 · 토큰이 한 트랜잭션.
 *   - **DID 비노출(B5)** — 돌려주는 모양(`AgentView`)에 DID·URL 필드가 **없다**(신원 상태 글자와 공개키 지문은 싣는다 — 콘솔 v4 E9).
 *   - **토큰 1회 노출** — 평문은 반환값에만 있다. DB 에는 sha256 만(`agent_api_keys` 에 평문 컬럼이 없다).
 *   - **폐기 시각 불변** — 이미 폐기된 행의 `revoked_at` 은 덮지 않는다(`WHERE revoked_at IS NULL`).
 *   - kill-switch 해제는 `suspended → active` 만 — `provisioning`·`disabled` 를 올리는 길이 없다(PP-A 원자성 우회 방지).
 *   - **정지한 주체가 푼다**(검증 H3): 소유자(콘솔)는 소유자 정지만 풀고, 운영자 정지(`suspended_by='operator'`)는
 *     운영자 CLI 만 푼다. 조직 단위도 둘로 나뉜다 — 소유자 정지 `owner_paused`(콘솔) · 플랫폼 동결 `abuse_freeze`(CLI).
 *   - **토큰 활성 상한**(`MAX_ACTIVE_TOKENS_PER_AGENT`, `ops/tokens.ts`) — 발급(`issueAgentTokenOp`)이 에이전트 잠금 아래에서 센다.
 *   - **조직당 에이전트 상한** — 요금제(`org_entitlements.max_agents`, ADR-0011)가 **비활성 제외** 수를, 그 3배가 비활성 포함 총합을
 *     묶는다(절대 천장 `MAX_AGENTS_PER_ORG`). 셀프서브 프로비저닝이 주소 공간을 무한히 가져가지 못하게. 운영자 검토 전 조직(셀프 가입)은
 *     요금제와 무관하게 `MAX_AGENTS_PER_PENDING_ORG`(비활성 포함).
 */

import type { Pool } from 'pg';

import { createPostgresProvisioningStore } from '../../api/provisioning-store';
import { agentTotalCeiling } from '../../billing/plans';
import { withTransaction, type Queryable } from '../../db/client';
import { loadEntitlements } from '../../db/repositories/entitlements';
import { type AgentId, type AgentStatus, type InboundMode, type OutboundMode, type PassportStatus } from '../../db/schema';
import { AgentAddressError, buildAgentAddress, type OperatorReservedAddress } from '../../identity/address';
import {
  AGENT_TOKEN_CAPABILITIES,
  DEFAULT_AGENT_TOKEN_CAPABILITIES,
  issueAgentToken,
  type AgentTokenCapability,
} from '../../identity/agent-token';
import { provisionAgent, ProvisioningError, resolveOwnerEmail } from '../../identity/provisioning';
import { SeedContactError } from '../../identity/seed-contacts';
import type { KeyCustody } from '../../passport/custody';
import { consoleInboundModeOf, consoleOutboundModeOf, type ConsoleMode } from '../../policy/mode-names';
import { publicKeyFingerprint } from '../../tlog/leaf';
import { INVISIBLE_OR_CONTROL_CHARACTERS } from '../display';
import {
  agentDeleted,
  claimAddress,
  countAddressProbes,
  lockOrganizationAliases,
  MAX_ACTIVE_ALIASES_PER_AGENT,
  MAX_ALIASES_PER_ORG_PER_DAY,
  requireOrgDailyAliasCapacity,
  requireVerifiedDomain,
} from './addresses';
import { AdminInputError, notFound, sqlStateOf } from './errors';
import { insertAgentTokenRow, lockActiveAgentToken, lockAgentTokens, readAgentTokenOp, requireTokenCapacity, type TokenView } from './tokens';
import { transactionPool } from './transaction';

/** seed 상한·형식 거부를 같은 코드로(`seed_limit`·`invalid_seed`). */
function seedError(error: SeedContactError, suffix = ''): AdminInputError {
  const limit = /최대/.test(error.message);
  return new AdminInputError(`${error.message}${suffix}`, limit ? 'seed_limit' : 'invalid_seed');
}

/** 데모·CLI 와 같은 기본 월 예산(센트). */
export const DEFAULT_BUDGET_CENTS = 10_000;

/**
 * 조직당 에이전트 **절대 천장**(ADR-0011) — 요금제(`org_entitlements.max_agents`)가 무엇이든 넘지 않는다. 요금제 한도는 **비활성
 * (`disabled`)을 뺀** 수를 묶고, 비활성을 포함한 총합은 `agentTotalCeiling`(요금제 × 3, 이 천장 이하)이 묶는다 — 주소는 전역 UNIQUE
 * 이고 삭제(비활성)한 에이전트의 주소도 다시 발급될 수 있어(같은 조직 곧바로 · 다른 조직 30일 뒤) 삭제·다시 만들기로 주소를 끝없이 가져가지 못하게 총합을 묶는다. `ENTITLEMENT_CEILINGS.maxAgents` 와 같은 값이다
 * (`test/unit/billing/plans.test.ts`). 콘솔(셀프서브)·조직 키·CLI 가 같은 연산이라 같은 상한이다.
 */
export const MAX_AGENTS_PER_ORG = 1000;

/**
 * 운영자 검토가 끝나지 않은 조직(`review_status` 가 `pending_review`·`rejected` — 셀프 가입, `signup-contract.md` §5)의 에이전트
 * 상한. 활성 전에는 외부 발송이 막혀 있지만 주소는 전역 UNIQUE 이고 회수되지 않는다 — 누구나 가입할 수 있는 조직이 주소 공간을
 * 10개씩 가져가지 않게 좁힌다. 콘솔과 CLI 가 같은 연산이라 같은 상한이다.
 */
export const MAX_AGENTS_PER_PENDING_ORG = 2;

export const ORGANIZATION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 운영자 CLI 가 넘긴 조직 id 모양(대소문자 무관 uuid) — 아니면 400 `invalid_organization`. */
function requireOrganizationId(organizationId: string): void {
  if (!ORGANIZATION_ID_PATTERN.test(organizationId)) throw new AdminInputError('조직 id(uuid)가 아니다.', 'invalid_organization');
}

// ---------------------------------------------------------------------------
// 조직
// ---------------------------------------------------------------------------

/** 조직 한 행. 소유자 이메일은 필수 — 승인 알림과 로그인 링크의 유일한 수신자다. (CLI 전용 — 관리 API 는 조직을 만들지 않는다.) */
export async function createOrganizationOp(pool: Pool, input: { readonly name: string; readonly ownerEmail: string }): Promise<{ id: string; name: string; ownerEmail: string }> {
  const name = input.name.trim();
  if (name.length < 1 || name.length > 200) throw new AdminInputError('조직 이름은 1~200자 (organizations.name CHECK).', 'invalid_name');
  let ownerEmail: string;
  try {
    ownerEmail = resolveOwnerEmail(input.ownerEmail);
  } catch (error) {
    if (error instanceof ProvisioningError) throw new AdminInputError(error.message, 'invalid_owner_email');
    throw error;
  }
  const organization = await createPostgresProvisioningStore(pool).withTransaction((tx) => tx.insertOrganization({ name, ownerEmail }));
  return { id: organization.id, name: organization.name, ownerEmail };
}

// ---------------------------------------------------------------------------
// 에이전트 조회
// ---------------------------------------------------------------------------

/** 관리 화면·CLI 가 보는 에이전트 모양. **DID·URL 필드가 없다**(B5 — draft 의 DID 를 새지 않는다). */
export interface AgentView {
  readonly id: AgentId;
  readonly name: string;
  readonly address: string | null;
  readonly status: AgentStatus;
  /** 정지한 주체 — `status = 'suspended'` 일 때만 값이 있다(DB CHECK). 소유자는 `operator` 정지를 풀 수 없다. */
  readonly suspendedBy: Suspender | null;
  /** 콘솔 이름(`all|allowlist|blocklist|none`, 레거시 발신은 `legacy` — `ops/policy.ts` 매핑표). 정책이 없으면 `null`. */
  readonly outboundMode: ConsoleMode | 'legacy' | null;
  readonly inboundMode: ConsoleMode | null;
  readonly activeTokens: number;
  /**
   * 그 에이전트의 폐기되지 않은 토큰 중 **가장 최근 사용 시각**(202609241400, US-007) — 분 단위. 어느 토큰도 쓰인 적이
   * 없으면 `null`("사용 기록 없음", 두 언어는 콘솔이 렌더). 토큰이 여러 개면 최댓값 하나로 뭉친다 — `activeTokens` 가
   * 이미 개수로 뭉치는 것과 같은 이유(토큰별 상세는 이 화면의 범위 밖).
   */
  readonly lastUsedAt: string | null;
  readonly createdAt: string;
  /**
   * 현재 passport 의 상태(콘솔 v4 E9 — 목록의 `신원` 열). passport 행이 없으면 `null`. 상태 글자는 DID 가 아니다 — B5 는 DID·URL
   * 규칙이고 그 둘은 여기 없다.
   */
  readonly identityStatus: PassportStatus | null;
  /**
   * 공개키 지문 `hex(SHA-256(원시 32바이트 공개키))` — 신원 블록 잎의 `key_fp` · `/identity-blocks` `card.keyFingerprint` 와 같은 값
   * (카드 아트·색의 씨앗, D8). 키가 없거나 모양이 아니면 `null`. 공개키는 공개 값이고 draft 에서도 블록 API 로 이미 나간다.
   */
  readonly keyFingerprint: string | null;
}

interface AgentViewRow {
  id: AgentId;
  name: string;
  address: string | null;
  status: AgentStatus;
  suspended_by: Suspender | null;
  outbound_mode: OutboundMode | null;
  inbound_mode: InboundMode | null;
  active_tokens: number;
  last_used_at: Date | null;
  created_at: Date;
  identity_status: PassportStatus | null;
  public_key: string | null;
  /** 커서용 마이크로초 시각(UTC) — `Date` 는 ms 라 keyset 비교에 쓸 수 없다. 화면 모양에는 싣지 않는다. */
  created_at_us: string;
}

const AGENT_VIEW_SQL = `
  SELECT a.id, a.name, ad.address, a.status, a.suspended_by, v.outbound_mode, v.inbound_mode, a.created_at,
         to_char(a.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at_us,
         (SELECT count(*) FROM agent_api_keys k
           WHERE k.agent_id = a.id AND k.revoked_at IS NULL AND (k.expires_at IS NULL OR k.expires_at > now()))::int AS active_tokens,
         (SELECT max(k.last_used_at) FROM agent_api_keys k
           WHERE k.agent_id = a.id AND k.revoked_at IS NULL) AS last_used_at,
         (SELECT pp.status::text FROM passports pp WHERE pp.agent_id = a.id AND pp.superseded_at IS NULL) AS identity_status,
         (SELECT kp.public_key FROM agent_keypairs kp WHERE kp.agent_id = a.id) AS public_key
    FROM agents a
    -- 유효 대표 주소(ADR-0014 2026-10 개정 — 마지막 선택 · 무효면 NULL = "주소 없음"). 잠든 앵커는 여기 나오지 않는다.
    LEFT JOIN LATERAL (SELECT atmark_agent_primary_address(a.id) AS address) ad ON true
    LEFT JOIN agent_policies p ON p.agent_id = a.id
    LEFT JOIN policy_versions v ON v.agent_id = a.id AND v.version = p.current_version`;

/** 공개키(base64url) → 지문. 모양이 아니면 `null`(목록 하나가 행 하나 때문에 500 이 되지 않게). */
function keyFingerprintOf(publicKey: string | null): string | null {
  if (publicKey === null) return null;
  try {
    return publicKeyFingerprint(publicKey);
  } catch {
    return null;
  }
}

function toAgentView(row: AgentViewRow): AgentView {
  return {
    id: row.id,
    name: row.name,
    address: row.address,
    status: row.status,
    suspendedBy: row.suspended_by,
    outboundMode: row.outbound_mode === null ? null : consoleOutboundModeOf(row.outbound_mode),
    inboundMode: row.inbound_mode === null ? null : consoleInboundModeOf(row.inbound_mode),
    activeTokens: row.active_tokens,
    lastUsedAt: row.last_used_at === null ? null : row.last_used_at.toISOString(),
    createdAt: row.created_at.toISOString(),
    identityStatus: row.identity_status,
    keyFingerprint: keyFingerprintOf(row.public_key),
  };
}

/** 목록 선택지 — `excludeDeleted`: 삭제한(`disabled`) 에이전트를 뺀다(콘솔 목록 — 삭제한 에이전트는 딥링크·로그로만 본다). */
interface AgentListOptions {
  readonly excludeDeleted?: boolean;
}

export async function listAgentsOp(db: Queryable, organizationId: string, options: AgentListOptions = {}): Promise<AgentView[]> {
  const result = await db.query<AgentViewRow>(
    `${AGENT_VIEW_SQL} WHERE a.organization_id = $1 AND NOT ($2::boolean AND a.status = 'disabled') ORDER BY a.created_at, a.id`,
    [organizationId, options.excludeDeleted === true],
  );
  return result.rows.map(toAgentView);
}

// ---------------------------------------------------------------------------
// 에이전트 목록 쪽 나누기(확장성 P1 R-9) — 콘솔 `GET /api/agents?limit&cursor&q` · 조직 키 `GET /org-api/v1/agents`
// ---------------------------------------------------------------------------

const AGENT_PAGE_DEFAULT_LIMIT = 50;
const AGENT_PAGE_MAX_LIMIT = 100;
const AGENT_QUERY_MAX_LENGTH = 64;

/** 쪽 요청 — `cursor` 는 앞 쪽 마지막 행의 `(created_at 마이크로초, id)`. */
interface AgentPageQuery {
  readonly limit: number;
  readonly cursor: { readonly createdAt: string; readonly id: AgentId } | null;
  readonly q: string | null;
}

interface AgentPage {
  readonly items: AgentView[];
  /** 다음 쪽이 **있을 때만** 값. 불투명 base64url — 모양만 검사한다(조직 범위는 SQL 이 건다 — 남의 커서도 자기 조직만 읽는다). */
  readonly nextCursor: string | null;
}

const PAGE_QUERY_KEYS = ['limit', 'cursor', 'q'] as const;
const CURSOR_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
const CURSOR_AGENT_ID = /^[0-9a-f]{32}$/;
const CURSOR_TOKEN = /^[A-Za-z0-9_-]{1,200}$/;

export function encodeAgentCursor(createdAt: string, id: string): string {
  return Buffer.from(JSON.stringify({ c: createdAt, i: id }), 'utf8').toString('base64url');
}

/** 커서 → 값. 모양이 아니면 400 `invalid_cursor`(무엇이 틀렸는지 싣지 않는다). */
export function decodeAgentCursor(raw: string): { createdAt: string; id: AgentId } {
  const invalid = (): AdminInputError => new AdminInputError('cursor 가 앞 응답의 nextCursor 가 아니다.', 'invalid_cursor');
  if (!CURSOR_TOKEN.test(raw)) throw invalid();
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    throw invalid();
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw invalid();
  const record = parsed as Record<string, unknown>;
  const keys = Object.keys(record).sort().join(',');
  const c = record['c'];
  const i = record['i'];
  if (keys !== 'c,i' || typeof c !== 'string' || typeof i !== 'string' || !CURSOR_INSTANT.test(c) || !CURSOR_AGENT_ID.test(i)) throw invalid();
  // 모양은 맞지만 없는 날짜(2월 30일 등)는 DB 가 거부한다(→ 500) — 여기서 되돌려 같은 값인지 본다.
  const parsedAt = Date.parse(c);
  if (Number.isNaN(parsedAt) || new Date(parsedAt).toISOString().slice(0, 23) !== c.slice(0, 23)) throw invalid();
  return { createdAt: c, id: i as AgentId };
}

/**
 * 쿼리 → 쪽 요청. `limit`·`cursor`·`q` 가 **하나도 없으면** `null`(콘솔은 옛 배열 모양 — 열린 옛 탭·기존 호출). `always` 면 없어도 기본 쪽
 * (조직 키 표면은 늘 봉투다). 그 밖의 쿼리 키는 보지 않는다(캐시 무력화 `_=` 등).
 */
export function resolveAgentPageQuery(query: Readonly<Record<string, string>>, always = false): AgentPageQuery | null {
  if (!always && PAGE_QUERY_KEYS.every((key) => query[key] === undefined)) return null;
  let limit = AGENT_PAGE_DEFAULT_LIMIT;
  const rawLimit = query['limit'];
  if (rawLimit !== undefined) {
    if (!/^[0-9]{1,3}$/.test(rawLimit) || Number(rawLimit) < 1 || Number(rawLimit) > AGENT_PAGE_MAX_LIMIT) {
      throw new AdminInputError(`limit 은 1~${String(AGENT_PAGE_MAX_LIMIT)} 정수다.`, 'invalid_limit');
    }
    limit = Number(rawLimit);
  }
  const rawCursor = query['cursor'];
  const cursor = rawCursor === undefined || rawCursor === '' ? null : decodeAgentCursor(rawCursor);
  let q: string | null = null;
  const rawQ = query['q'];
  if (rawQ !== undefined) {
    const trimmed = rawQ.trim();
    const length = [...trimmed].length;
    if (length < 1 || length > AGENT_QUERY_MAX_LENGTH || INVISIBLE_OR_CONTROL_CHARACTERS.test(trimmed)) {
      throw new AdminInputError(`q 는 1~${String(AGENT_QUERY_MAX_LENGTH)}자 검색어다(제어·보이지 않는 문자 없이).`, 'invalid_query');
    }
    q = trimmed;
  }
  return { limit, cursor, q };
}

/** `ILIKE` 패턴 — `\`·`%`·`_` 는 글자 그대로(이스케이프 문자 `\`). */
function containsPattern(q: string): string {
  return `%${q.replace(/[\\%_]/g, (character) => `\\${character}`)}%`;
}

/**
 * 조직 에이전트 한 쪽 — 정렬 `created_at, id`(옛 배열과 같은 순서) · keyset 커서 · 이름 또는 주소 local part 부분 일치(대소문자 무시).
 * `limit + 1` 행을 읽어 다음 쪽 유무를 안다(정확히 `limit` 개로 끝나면 `nextCursor = null`). **조직 조건이 늘 첫 조건**이다.
 */
export async function listAgentsPageOp(db: Queryable, organizationId: string, page: AgentPageQuery, options: AgentListOptions = {}): Promise<AgentPage> {
  const result = await db.query<AgentViewRow>(
    `${AGENT_VIEW_SQL}
      WHERE a.organization_id = $1
        AND NOT ($6::boolean AND a.status = 'disabled')
        AND ($2::timestamptz IS NULL OR (a.created_at, a.id) > ($2::timestamptz, $3::text))
        AND ($4::text IS NULL OR a.name ILIKE $4 ESCAPE '\\' OR split_part(ad.address, '@', 1) ILIKE $4 ESCAPE '\\')
      ORDER BY a.created_at, a.id
      LIMIT $5`,
    [
      organizationId,
      page.cursor?.createdAt ?? null,
      page.cursor?.id ?? null,
      page.q === null ? null : containsPattern(page.q),
      page.limit + 1,
      options.excludeDeleted === true,
    ],
  );
  const rows = result.rows.slice(0, page.limit);
  const last = rows.at(-1);
  const more = result.rows.length > page.limit;
  return { items: rows.map(toAgentView), nextCursor: more && last !== undefined ? encodeAgentCursor(last.created_at_us, last.id) : null };
}

export async function getAgentOp(db: Queryable, agentId: AgentId): Promise<AgentView | null> {
  const result = await db.query<AgentViewRow>(`${AGENT_VIEW_SQL} WHERE a.id = $1`, [agentId]);
  const row = result.rows[0];
  return row === undefined ? null : toAgentView(row);
}

/** 에이전트의 조직. 없으면 `null`. 관리 API 의 조직 범위 검사가 쓴다. */
export async function agentOrganizationOf(db: Queryable, agentId: AgentId): Promise<string | null> {
  const result = await db.query<{ organization_id: string }>('SELECT organization_id FROM agents WHERE id = $1', [agentId]);
  return result.rows[0]?.organization_id ?? null;
}

// ---------------------------------------------------------------------------
// 프로비저닝
// ---------------------------------------------------------------------------

interface ProvisionRequest {
  readonly organizationId: string;
  readonly name: string;
  readonly localPart: string;
  readonly seeds: readonly string[];
  readonly budgetCents: number;
  readonly createdBy: string;
  /** 정책 첨부 총량 = "요금제를 따른다"(null) — 스위치 `ATMARK_POLICY_ATTACHMENT_FOLLOW_PLAN`. 없으면 옛 기본값 10 MiB(메일 기본기 2차 · 보안 리뷰 M3). */
  readonly attachmentFollowsPlan?: boolean;
  /**
   * 운영자 예약 주소(`support@atmark.ai` 등) — 운영자 CLI(`pnpm admin:reserved-address provision`)만 채운다. 이 파일은 타입만 쓴다(만드는 함수
   * `buildOperatorReservedAddress` 는 `src/admin` 에서 import 하지 않는다 — arch 테스트). DB 가 그 조직의 운영자 허가 행을 따로 요구한다.
   */
  readonly operatorReservedAddress?: OperatorReservedAddress;
  /**
   * 고객 도메인을 대표로(ADR-0014 2026-10 개정 · M3b — 만들 때 고른다). 있으면 대표 주소 = `localPart@customPrimaryDomain` 이고 @atmark.ai 앵커는
   * 내부에만(잠듦). 그 조직의 verified 도메인이어야 한다(400 `domain_not_verified` — 키 보관 전에 본다). 고객 대표 행은 별칭 한도에 1 로 센다.
   */
  readonly customPrimaryDomain?: string;
  /** 소유자 발신 승인 `always` 로 태어난다(자가 등록 — ADR-0016 2026-10-08). 없으면 auto. */
  readonly requireApproval?: boolean;
  /** 첫 토큰 권한(자가 등록은 `ENROLLED_AGENT_TOKEN_CAPABILITIES`). 없으면 기본 권한. */
  readonly tokenCapabilities?: readonly AgentTokenCapability[];
  /**
   * 발신 모드. **없으면 `allowlist_only`(빈 목록 — 좁은 쪽으로 떨어진다).** 콘솔 세션의 소유자 생성만 `OWNER_CREATED_OUTBOUND_MODE`(전체)를 명시한다
   * (2026-10-13 진윤겸 결정 B — `routes/agents.ts` `handleCreateAgent`). 조직 API 키 · 운영자 CLI · 자가 등록 · 예약 주소는 `allowlist_only` 를 명시한다.
   */
  readonly outboundMode?: OutboundMode;
}

interface ProvisionResult {
  readonly organizationId: string;
  readonly agent: AgentView;
  readonly policyVersion: number;
  /** **평문 1회.** 호출자가 한 번 보여 주고 버린다. */
  readonly token: string;
}

/** 조직의 에이전트 수 — 비활성 제외(요금제 한도) · 전부(총합 천장·검토 전 상한). */
interface AgentCounts {
  readonly nonDisabled: number;
  readonly total: number;
}

export async function countAgents(db: Queryable, organizationId: string): Promise<AgentCounts> {
  const result = await db.query<{ non_disabled: number; total: number }>(
    `SELECT count(*) FILTER (WHERE status <> 'disabled')::int AS non_disabled, count(*)::int AS total FROM agents WHERE organization_id = $1`,
    [organizationId],
  );
  return { nonDisabled: result.rows[0]?.non_disabled ?? 0, total: result.rows[0]?.total ?? 0 };
}

/**
 * 에이전트 하나를 더 만들 수 있는가 — 조직 잠금(`agent_provision:`) 아래에서 부른다. 셋 중 하나라도 닿으면 409:
 *   ① 검토 전 조직: 비활성 포함 `MAX_AGENTS_PER_PENDING_ORG`(요금제와 무관 — 가입 직후의 주소 공간 제한) → `agent_limit`.
 *   ② 요금제: 비활성 제외 `min(ent.maxAgents, MAX_AGENTS_PER_ORG)` → `agent_limit`(상세에 요금제 코드).
 *   ③ 총합: 비활성 포함 `agentTotalCeiling(ent)`(요금제 × 3, 절대 천장 이하) → `agent_total_limit`. 비활성으로 요금제 한도를 비울 수는
 *      있지만(강등 해소, B7) 주소를 무한히 쌓을 수는 없다.
 */
export async function requireAgentCapacity(db: Queryable, organizationId: string, now: Date): Promise<void> {
  const review = await db.query<{ review_status: string }>('SELECT review_status::text AS review_status FROM organizations WHERE id = $1', [organizationId]);
  const reviewStatus = review.rows[0]?.review_status ?? null;
  const counts = await countAgents(db, organizationId);
  // 조직이 없으면(null) 활성과 같게 센다 — 없는 조직은 provisionAgent 가 거부한다.
  if (reviewStatus !== null && reviewStatus !== 'active') {
    if (counts.total >= MAX_AGENTS_PER_PENDING_ORG) {
      throw new AdminInputError(
        `운영자 검토가 끝나지 않은 조직은 에이전트를 ${String(MAX_AGENTS_PER_PENDING_ORG)}개까지 만들 수 있다(비활성 포함). ` +
          '검토가 끝나 활성화되면 요금제 한도까지 늘어난다.',
        'agent_limit',
        409,
      );
    }
    return;
  }
  const entitlements = await loadEntitlements(db, organizationId, now);
  const planLimit = Math.min(entitlements.maxAgents, MAX_AGENTS_PER_ORG);
  if (counts.nonDisabled >= planLimit) {
    throw new AdminInputError(
      `요금제(${entitlements.planCode})의 에이전트 한도는 ${String(planLimit)}개다(삭제한 에이전트 제외). 쓰지 않는 에이전트를 삭제하면 ` +
        '자리가 난다(`POST /api/agents/{id}/delete`).',
      'agent_limit',
      409,
    );
  }
  const totalCeiling = agentTotalCeiling({ maxAgents: planLimit });
  if (counts.total >= totalCeiling) {
    throw new AdminInputError(
      `삭제한 것 포함 에이전트는 ${String(totalCeiling)}개까지다(요금제 한도의 3배 — 삭제·다시 만들기로 주소를 끝없이 가져가지 못하게).`,
      'agent_total_limit',
      409,
    );
  }
}

/** 프로비저닝 결과 — 만들었다 · 주소를 지금 쓸 수 없다(호출자가 `agent.create.taken` 감사 행을 커밋하고 409 — 재발급 보안 리뷰 M2). */
export type ProvisionOutcome = ({ readonly kind: 'created' } & ProvisionResult) | { readonly kind: 'taken' };

/**
 * 주소를 쓸 수 없을 때의 응답 — 예전(주소 INSERT 의 23505 → 라우터의 409 `conflict`)과 **같은 몸통**이다. 사용 중 · 다른 조직의 폐기 뒤 보류를
 * 가르지 않는다.
 */
export function addressConflict(): AdminInputError {
  return new AdminInputError('이미 있는 값이다(예: 주소가 이미 쓰이고 있다).', 'conflict', 409);
}

/**
 * 프로비저닝 한 건. **상한 검사와 삽입이 한 트랜잭션**이다 — 조직 단위 advisory 잠금 아래에서 세고, 같은 트랜잭션의
 * 세이브포인트에서 `provisionAgent` 가 돈다. 잠금 없이 세면 동시 요청 N 개가 모두 "아직 9개" 를 보고 상한을 넘는다.
 *
 * **주소는 키 보관(custody) 전에 본다**(재발급 보안 리뷰 M2). 예전에는 주소 INSERT 의 23505 가 트랜잭션을 되돌려 감사 행이 남지 않았고(조직
 * 하루 주소 탐침 상한 · 조직 키 분당 생성 상한 어디에도 안 셌다), 그 전에 키 생성·보관이 이미 돌았다. 이제: 조직 별칭 잠금 → 하루 주소 탐침
 * 상한(쓸 수 없는 주소로 한 시도 — 별칭·에이전트 합, `MAX_ALIASES_PER_ORG_PER_DAY`, 넘으면 409 `address_probe_limit`) → 주소 잠금 아래 가용성
 * (`claimAddress` — 활성 행 · 다른 조직의 30일 보류) → 쓸 수 없으면 `{kind:'taken'}` 을 **돌려준다**(던지지 않는다 — 호출자가 감사 행을
 * 커밋한다). 로컬파트 모양이 틀리면 여기서 보지 않고 예전처럼 프로비저닝이 `invalid_local_part` 로 거부한다.
 */
export async function provisionAgentOp(pool: Pool, request: ProvisionRequest, custody: KeyCustody): Promise<ProvisionOutcome> {
  requireOrganizationId(request.organizationId);
  return withTransaction(pool, async (client) => {
    await client.query(`SELECT pg_advisory_xact_lock(hashtextextended('agent_provision:' || $1::text, 0))`, [request.organizationId]);
    await requireAgentCapacity(client, request.organizationId, new Date());
    const tx = transactionPool(client);
    const custom = request.customPrimaryDomain;
    const address = request.operatorReservedAddress ?? candidateAddress(request.localPart, custom);
    if (address !== null) {
      await lockOrganizationAliases(tx, request.organizationId);
      if ((await countAddressProbes(tx, request.organizationId)) >= MAX_ALIASES_PER_ORG_PER_DAY) {
        throw new AdminInputError(
          `조직의 하루 주소 시도 상한(${String(MAX_ALIASES_PER_ORG_PER_DAY)} — 쓸 수 없는 주소로 한 시도)에 닿았다.`,
          'address_probe_limit',
          409,
        );
      }
      if (custom !== undefined) await requireCustomPrimaryCapacity(tx, request.organizationId, custom);
      if (!(await claimAddress(tx, request.organizationId, address))) return { kind: 'taken' };
    }
    try {
      return { kind: 'created', ...(await provisionInTransaction(tx, request, custody)) };
    } catch (error) {
      // 사람 이메일 claim 과 겹친 주소(P0A01 — 고객 도메인 주소 · 앵커가 아닌 쪽)는 "쓸 수 없는 주소" 와 같은 중립 409(감사 행을 커밋한다 —
      // 어떤 주소가 누구의 사람 이메일인지 가르지 않는다). 프로비저닝 트랜잭션은 이 트랜잭션의 세이브포인트라 이미 되돌려졌다.
      if (sqlStateOf(error) === 'P0A01') return { kind: 'taken' };
      throw error;
    }
  });
}

/**
 * 고객 도메인 대표의 문(키 보관 전 — 주소 잠금 전): 그 조직의 verified 도메인 · 요금제 별칭 한도 ≥ 1(고객 대표 행은 별칭으로 센다) · 조직 하루 별칭
 * 발급(쓸 수 없는 주소 시도 포함, `addAliasOp` 와 같은 식). DB 천장 트리거가 같은 것을 한 번 더 막는다.
 */
async function requireCustomPrimaryCapacity(db: Queryable, organizationId: string, domain: string): Promise<void> {
  await requireVerifiedDomain(db, organizationId, domain);
  const entitlements = await loadEntitlements(db, organizationId, new Date());
  if (Math.min(entitlements.aliasesPerAgentMax, MAX_ACTIVE_ALIASES_PER_AGENT) < 1) {
    throw new AdminInputError('이 요금제는 별칭을 쓸 수 없다 — 고객 도메인 대표 주소는 별칭 한도에 하나로 센다.', 'alias_plan_limit', 409);
  }
  await requireOrgDailyAliasCapacity(db, organizationId);
}

/** 가용성을 볼 주소. 모양이 틀리면 `null` — 그 거부는 프로비저닝의 몫이다(예전과 같은 코드·순서). */
function candidateAddress(localPart: string, customDomain?: string): string | null {
  try {
    return customDomain === undefined ? buildAgentAddress(localPart) : buildAgentAddress(localPart, customDomain);
  } catch (error) {
    if (error instanceof AgentAddressError) return null;
    throw error;
  }
}

async function provisionInTransaction(pool: Pool, request: ProvisionRequest, custody: KeyCustody): Promise<ProvisionResult> {
  let provisioned;
  try {
    provisioned = await provisionAgent(
      createPostgresProvisioningStore(pool),
      {
        organization: { kind: 'existing', id: request.organizationId },
        agentName: request.name,
        addressLocalPart: request.localPart,
        seedContacts: request.seeds,
        monthlyBudgetCents: request.budgetCents,
        createdBy: request.createdBy,
        tokenCapabilities: request.tokenCapabilities ?? null,
        // 명시가 없으면 허용 목록(빈 목록). 전체는 콘솔 세션의 소유자 생성만 명시한다(2026-10-13 결정 B · 적대 검증 I08).
        outboundMode: request.outboundMode ?? 'allowlist_only',
        attachmentFollowsPlan: request.attachmentFollowsPlan === true,
        ...(request.operatorReservedAddress === undefined ? {} : { operatorReservedAddress: request.operatorReservedAddress }),
        ...(request.customPrimaryDomain === undefined ? {} : { customPrimaryDomain: request.customPrimaryDomain }),
        ...(request.requireApproval === true ? { requireApproval: true } : {}),
      },
      custody,
    );
  } catch (error) {
    if (error instanceof SeedContactError) throw seedError(error);
    if (error instanceof AgentAddressError) throw new AdminInputError(error.message, 'invalid_local_part');
    if (error instanceof ProvisioningError) throw new AdminInputError(error.message, 'invalid_request');
    throw error;
  }
  // B5 — DID·URL 은 싣지 않는다(`AgentView` 에 그 필드가 없다). 모양은 목록과 같은 SQL 로 같은 트랜잭션에서 읽는다(신원 상태 draft ·
  // 키 지문 · 활성 토큰 1 · 마지막 사용 없음).
  const agent = await getAgentOp(pool, provisioned.agent.id);
  if (agent === null) throw new Error('방금 만든 에이전트 행을 읽지 못했다');
  return {
    organizationId: provisioned.organization.id,
    agent,
    policyVersion: provisioned.policyVersion.version,
    token: provisioned.token.plaintext,
  };
}

// ---------------------------------------------------------------------------
// 토큰
// ---------------------------------------------------------------------------

/**
 * 토큰 권한. **생략(`undefined`)만 기본값(`DEFAULT_AGENT_TOKEN_CAPABILITIES` — `webhooks:manage` 를 뺀 넷)** 이다 — 명시한 빈 목록(`[]`, CLI `--capabilities ""`)은 `invalid_capability` 로
 * 거부한다(2026-09-25 핫픽스: 예전에는 `[]` 가 기본값으로 떨어져 "권한 없는 토큰" 을 원한 요청이 전권 토큰을 받았다 — fail-open).
 */
export function resolveCapabilities(listed: readonly string[] | undefined): readonly AgentTokenCapability[] {
  if (listed === undefined) return DEFAULT_AGENT_TOKEN_CAPABILITIES;
  if (listed.length === 0) throw new AdminInputError('capabilities 가 비었다 — 생략하면 기본 권한, 좁히려면 하나 이상 적는다.', 'invalid_capability');
  for (const capability of listed) {
    if (!(AGENT_TOKEN_CAPABILITIES as readonly string[]).includes(capability)) {
      throw new AdminInputError(`알 수 없는 권한: ${capability} (가능: ${AGENT_TOKEN_CAPABILITIES.join(', ')})`, 'invalid_capability');
    }
  }
  return [...new Set(listed)] as AgentTokenCapability[];
}

/** HTTP 본문의 `capabilities` — 없거나 `null` 이면 기본 권한, 문자열 배열이 아니면·비었으면 `invalid_capability`. */
export function capabilitiesFromBody(value: unknown): readonly AgentTokenCapability[] {
  if (value === undefined || value === null) return resolveCapabilities(undefined);
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new AdminInputError('capabilities 는 문자열 배열이다.', 'invalid_capability');
  }
  return resolveCapabilities(value as string[]);
}

const DAY_MS = 86_400_000;

/** API 의 `expiresDays` — 1~3650 정수. 없으면 만료 없음(프로비저닝 토큰과 같다). */
export function expiryFromDays(days: unknown, now: Date): Date | null {
  if (days === undefined || days === null) return null;
  if (typeof days !== 'number' || !Number.isInteger(days) || days < 1 || days > 3650) {
    throw new AdminInputError('expiresDays 는 1~3650 정수다.', 'invalid_expiry');
  }
  return new Date(now.getTime() + days * DAY_MS);
}

/** 토큰을 붙일 수 있는 에이전트인가 — 없으면 404, provisioning 이면 409. 상태를 돌려준다. */
export async function requireTokenableAgent(db: Queryable, agentId: AgentId): Promise<AgentStatus> {
  const agent = await db.query<{ status: AgentStatus }>('SELECT status FROM agents WHERE id = $1', [agentId]);
  const status = agent.rows[0]?.status;
  if (status === undefined) throw notFound(`에이전트가 없다: ${agentId}`, 'agent_not_found');
  // 프로비저닝이 끝나지 않은(키가 안 붙은) 에이전트에 토큰을 붙이지 않는다.
  if (status === 'provisioning') throw new AdminInputError(`에이전트 ${agentId} 는 아직 provisioning 이다.`, 'agent_provisioning', 409);
  // 삭제한 에이전트(`disabled` — 종단)에 새 토큰을 붙이지 않는다 — 삭제가 토큰을 전부 폐기한 뜻이 사라진다.
  if (status === 'disabled') throw agentDeleted();
  return status;
}


/**
 * 토큰을 새로 만드는 트랜잭션의 첫 잠금 — 에이전트 행 `FOR SHARE` 아래에서 상태를 다시 본다(삭제한 에이전트면 409 `agent_deleted`). 트랜잭션 밖의
 * `requireTokenableAgent` 와 INSERT 사이에 삭제가 커밋되는 경합을 닫는다(보안 리뷰 HIGH-1). **토큰 잠금보다 먼저** 잡는다 — 삭제(`deleteAgentOp`)가
 * 에이전트 행 → 토큰 잠금 순서라 같은 순서여야 교착이 없다. DB 트리거 `agent_api_keys_reject_disabled_agent` 가 한 번 더 막는다.
 */
async function lockLiveAgentForTokens(db: Queryable, agentId: AgentId): Promise<void> {
  const result = await db.query<{ status: AgentStatus }>('SELECT status FROM agents WHERE id = $1 FOR SHARE', [agentId]);
  if (result.rows[0]?.status === 'disabled') throw agentDeleted();
}

export interface IssuedToken {
  readonly token: string;
  readonly capabilities: readonly AgentTokenCapability[];
  readonly expiresAt: Date | null;
  /** 새 행의 화면 모양(해시 없음 · 끝 4자 · 이름). */
  readonly item: TokenView;
}

/**
 * 토큰 하나 더(분실·교체 대비 · 콘솔 v4 새 토큰). 기존 토큰은 그대로 산다. **활성 상한**(`MAX_ACTIVE_TOKENS_PER_AGENT`)을 에이전트
 * 잠금 아래에서 세고 넘으면 409 `token_limit` — 잠금·검사·INSERT 가 한 트랜잭션이다(콘솔은 감사 트랜잭션의 세이브포인트).
 */
export async function issueAgentTokenOp(
  pool: Pool,
  agentId: AgentId,
  options: { readonly capabilities: readonly AgentTokenCapability[]; readonly expiresAt: Date | null; readonly label?: string | null },
): Promise<IssuedToken> {
  await requireTokenableAgent(pool, agentId);
  const token = issueAgentToken(agentId, options.capabilities);
  const item = await withTransaction(pool, async (client) => {
    await lockLiveAgentForTokens(client, agentId);
    await lockAgentTokens(client, agentId);
    await requireTokenCapacity(client, agentId);
    return insertAgentTokenRow(client, {
      agentId,
      tokenHash: token.tokenHash,
      hint: token.hint,
      capabilities: token.capabilities,
      expiresAt: options.expiresAt,
      label: options.label ?? null,
    });
  });
  // 열에 실제로 적힌 권한(운영자 예약 주소 에이전트는 `policy:request` 가 빠진다 — `insertAgentTokenRow`).
  return { token: token.plaintext, capabilities: item.capabilities, expiresAt: options.expiresAt, item };
}

interface AgentTokenRotation {
  /** 새 토큰 평문 — **이 응답 한 번뿐**. */
  readonly token: string;
  /** 새 토큰의 화면 모양. */
  readonly item: TokenView;
  /** 폐기한 옛 토큰의 화면 모양. */
  readonly revoked: TokenView;
}

/**
 * 토큰 **한 개 교체** — 그 토큰 폐기 + 같은 이름·권한의 새 토큰 발급이 **한 트랜잭션**(콘솔은 감사 트랜잭션의 세이브포인트). 조직 키 교체
 * (`supersedeOrgKeyOp`)와 같은 모델. 다른 토큰은 그대로 산다.
 *   - 새 토큰의 만료: `expiresAt` 이 `Date` 면 그 값, `null` 이면 무기한, `undefined` 면 옛 토큰과 **같은 수명**(만든 때 → 만료)을 지금부터
 *     센다 — 90일 토큰을 교체하면 새 90일 토큰이다(남은 기간이 아니다: 교체는 대개 만료가 다가와서 한다). 옛 토큰이 무기한이면 무기한.
 *     HTTP 라우트(`handleRotateToken`)는 `expiresDays` 생략과 `null` 을 **둘 다 `undefined`(같은 수명)** 로 넘긴다(조직 키 교체와 같다) —
 *     콘솔 표면에서 이 함수의 `null`(무기한으로 바꾸기)은 쓰이지 않는다.
 *   - 활성 토큰만(폐기·만료 → 409 `token_not_active`) · 남의 토큰·없는 토큰 → 404 `token_not_found`(`lockActiveAgentToken`).
 *   - 폐기 뒤 INSERT 라 활성 수는 늘지 않는다 — 요금제 상한을 다시 보지 않는다(강등 뒤에도 교체는 된다). DB 천장 5 는 그대로 집행된다.
 */
export async function supersedeAgentTokenOp(
  pool: Pool,
  agentId: AgentId,
  tokenId: string,
  expiresAt: Date | null | undefined,
): Promise<AgentTokenRotation> {
  await requireTokenableAgent(pool, agentId);
  return withTransaction(pool, async (client) => {
    await lockLiveAgentForTokens(client, agentId);
    // 새 발급과 같은 잠금 — 폐기와 INSERT 사이에 다른 발급이 끼지 않게.
    await lockAgentTokens(client, agentId);
    const old = await lockActiveAgentToken(client, agentId, tokenId);
    await client.query('UPDATE agent_api_keys SET revoked_at = now() WHERE id = $2::uuid AND agent_id = $1 AND revoked_at IS NULL', [agentId, tokenId]);
    const token = issueAgentToken(agentId, old.capabilities);
    const item = await insertAgentTokenRow(client, {
      agentId,
      tokenHash: token.tokenHash,
      hint: token.hint,
      capabilities: token.capabilities,
      expiresAt: expiresAt === undefined ? old.renewedExpiresAt : expiresAt,
      label: old.label,
    });
    const revoked = await readAgentTokenOp(client, agentId, tokenId);
    if (revoked === null) throw new Error('방금 폐기한 토큰 행을 읽지 못했다');
    return { token: token.plaintext, item, revoked };
  });
}

type TokenRotation = 'rotate' | 'revoke-all';

interface RotationResult {
  readonly revoked: number;
  /** `revoke-all` 이면 `null` — 에이전트는 지금 인증할 수 없다. */
  readonly issued: IssuedToken | null;
}

/**
 * `revoke-all` — 살아 있는 토큰 전부 폐기(행은 지우지 않는다). `rotate` — 전부 폐기 + 새 토큰 1개를 **한 트랜잭션**으로.
 * 이미 폐기된 행의 `revoked_at` 은 덮지 않는다. `confirm` 은 쓰기 직전(CLI 운영 확인).
 */
export async function revokeAgentTokensOp(
  pool: Pool,
  agentId: AgentId,
  action: TokenRotation,
  options: { readonly capabilities: readonly AgentTokenCapability[]; readonly expiresAt: Date | null; readonly label?: string | null },
  confirm: () => Promise<void> = () => Promise.resolve(),
): Promise<RotationResult> {
  await requireTokenableAgent(pool, agentId);
  await confirm();
  const token = action === 'revoke-all' ? null : issueAgentToken(agentId, options.capabilities);
  const { revoked, item } = await withTransaction(pool, async (client) => {
    if (token !== null) await lockLiveAgentForTokens(client, agentId);
    // 새 발급과 같은 잠금 — 폐기와 INSERT 사이에 다른 발급이 끼어 "교체 뒤 토큰 2개" 가 되지 않게.
    await lockAgentTokens(client, agentId);
    const result = await client.query('UPDATE agent_api_keys SET revoked_at = now() WHERE agent_id = $1 AND revoked_at IS NULL', [agentId]);
    const inserted =
      token === null
        ? null
        : await insertAgentTokenRow(client, {
            agentId,
            tokenHash: token.tokenHash,
            hint: token.hint,
            capabilities: token.capabilities,
            expiresAt: options.expiresAt,
            label: options.label ?? null,
          });
    return { revoked: result.rowCount ?? 0, item: inserted };
  });
  return {
    revoked,
    issued: token === null || item === null ? null : { token: token.plaintext, capabilities: item.capabilities, expiresAt: options.expiresAt, item },
  };
}

// ---------------------------------------------------------------------------
// kill-switch — Stage 0 이 읽는 값만 바꾼다
// ---------------------------------------------------------------------------

/**
 * **플랫폼 동결**(`organizations.abuse_freeze` → Stage 0 `org_abuse_freeze`). **운영자 CLI 전용** — 관리 API(소유자 세션)는
 * 이 함수를 부르지 않는다. 동결 대상 조직의 소유자가 자기 동결을 풀 수 있으면 동결이 아니다(검증 H3).
 */
export async function setOrganizationFreezeOp(db: Queryable, organizationId: string, on: boolean): Promise<void> {
  requireOrganizationId(organizationId);
  const result = await db.query('UPDATE organizations SET abuse_freeze = $2 WHERE id = $1 RETURNING id', [organizationId, on]);
  if (result.rowCount !== 1) throw notFound(`조직이 없다: ${organizationId}`, 'organization_not_found');
}

/** 운영자 행위 감사의 사유 상한(DB CHECK `owner_actions_operator_shape` 와 같다). */
export const OPERATOR_ACTION_REASON_MAX = 600;

/**
 * **운영자 행위 감사 1행**(202610131610) — `owner_actions` 의 셋째 행위자(`operator_actor` · `operator_reason`). 운영자 CLI(소유자 롤)만 쓴다 —
 * admin · 앱 롤은 가드 트리거가 42501 로 끊는다. 행은 그 조직의 투명성 로그 `owner.action` 잎(`c.operator`)이 된다. 행위와 **같은 트랜잭션**에서 부른다.
 */
export async function recordOperatorActionOp(
  db: Queryable,
  input: { readonly organizationId: string; readonly action: string; readonly targetId: string | null; readonly actor: string; readonly reason: string },
): Promise<void> {
  requireOrganizationId(input.organizationId);
  await db.query(
    'INSERT INTO owner_actions (organization_id, action, target_id, operator_actor, operator_reason) VALUES ($1, $2, $3, $4, $5)',
    [input.organizationId, input.action, input.targetId, input.actor, input.reason.slice(0, OPERATOR_ACTION_REASON_MAX)],
  );
}

/** 조직 동결 · 해제 사유 상한(감사 칸보다 짧게 — 운영자가 적는 한 줄). */
export const ORG_FREEZE_REASON_MAX = 500;
/** 켜기(비상 경로)에 사유가 없을 때 감사에 적는 값. */
export const DEFAULT_ORG_FREEZE_REASON = 'operator kill-switch';

/**
 * **감사되는 플랫폼 동결 · 해제**(202610131610 — 운영자 CLI `admin:kill-switch --org` · 운영자 웹 `admin:web` 이 같은 함수를 부른다). 한 트랜잭션에서
 * 조직 행 잠금(FOR NO KEY UPDATE — 평판 자동 판정과 줄 선다) → 지금 값과 비교 → 다를 때만 `setOrganizationFreezeOp` + `recordOperatorActionOp`
 * (`org.abuse_freeze` · `org.abuse_unfreeze`, 행위자 = 운영자, 사유). **해제는 사유 필수** — 공유 도메인 평판 자동 동결(`src/mail/events/platform-reputation.ts`)
 * 을 푸는 길이고, 감사된 해제 시각 이후의 사건만 다음 판정이 센다(감사 없는 해제는 창이 그대로라 곧바로 다시 언다). 켜기는 사유가 없으면
 * `DEFAULT_ORG_FREEZE_REASON`. 소유자 롤 풀만(운영자 행위자 감사의 가드 트리거).
 */
export async function setOrganizationFreezeAuditedOp(
  pool: Pool,
  input: { readonly organizationId: string; readonly on: boolean; readonly actor: string; readonly reason: string | null },
): Promise<{ readonly changed: boolean }> {
  requireOrganizationId(input.organizationId);
  const reason = (input.reason ?? '').trim();
  if (!input.on && reason === '') throw new AdminInputError('조직 동결 해제에는 사유가 필요하다(감사 · 조직의 투명성 로그에 남는다).', 'reason_required');
  if (reason.length > ORG_FREEZE_REASON_MAX) throw new AdminInputError(`사유는 ${String(ORG_FREEZE_REASON_MAX)}자 이하.`, 'invalid_reason');
  if (INVISIBLE_OR_CONTROL_CHARACTERS.test(reason)) throw new AdminInputError('사유는 한 줄(제어 · 보이지 않는 문자 없음).', 'invalid_reason');
  return withTransaction(pool, async (client) => {
    const tx = transactionPool(client);
    const current = await tx.query<{ abuse_freeze: boolean }>('SELECT abuse_freeze FROM organizations WHERE id = $1 FOR NO KEY UPDATE', [input.organizationId]);
    const row = current.rows[0];
    if (row === undefined) throw notFound(`조직이 없다: ${input.organizationId}`, 'organization_not_found');
    if (row.abuse_freeze === input.on) return { changed: false };
    await setOrganizationFreezeOp(tx, input.organizationId, input.on);
    await recordOperatorActionOp(tx, {
      organizationId: input.organizationId,
      action: input.on ? 'org.abuse_freeze' : 'org.abuse_unfreeze',
      targetId: input.organizationId,
      actor: input.actor,
      reason: reason === '' ? DEFAULT_ORG_FREEZE_REASON : reason,
    });
    return { changed: true };
  });
}

interface OrganizationPause {
  readonly changed: boolean;
}

/**
 * **소유자 조직 정지**(`organizations.owner_paused` → Stage 0 `org_owner_paused`). 콘솔의 조직 kill-switch 가 부른다.
 * 플랫폼 동결(`abuse_freeze`)은 건드리지 않는다 — 소유자가 정지를 풀어도 동결은 그대로다.
 */
export async function setOwnerPauseOp(db: Queryable, organizationId: string, on: boolean): Promise<OrganizationPause> {
  requireOrganizationId(organizationId);
  const exists = await db.query<{ owner_paused: boolean }>('SELECT owner_paused FROM organizations WHERE id = $1 FOR UPDATE', [organizationId]);
  const current = exists.rows[0];
  if (current === undefined) throw notFound(`조직이 없다: ${organizationId}`, 'organization_not_found');
  if (current.owner_paused === on) return { changed: false };
  await db.query('UPDATE organizations SET owner_paused = $2 WHERE id = $1', [organizationId, on]);
  return { changed: true };
}

function concurrentChange(agentId: AgentId): AdminInputError {
  return new AdminInputError(`에이전트 ${agentId} 의 상태가 그 사이 바뀌었다 — 다시 확인하라.`, 'concurrent_change', 409);
}

/** 정지한 주체 — `agents.suspended_by`. 콘솔(소유자 세션)은 `owner`, 운영자 CLI 는 `operator`. */
type Suspender = 'owner' | 'operator';

interface AgentSuspension {
  readonly status: AgentStatus;
  readonly suspendedBy: Suspender | null;
  readonly changed: boolean;
}

/**
 * 에이전트 발송 정지·재개 — `active ↔ suspended` 만. 조건부 UPDATE — 확인 사이에 상태가 바뀌었으면 0행이고 그때는
 * 아무것도 바꾸지 않는다.
 *
 * **누가 푸는가**(검증 H3):
 *   - 해제(`on=false`)는 **정지한 주체만** 한다. 소유자가 운영자 정지를 풀면 409 `operator_suspension`,
 *     운영자 CLI 가 소유자 정지를 풀면 409 `owner_suspension`(소유자의 결정은 소유자가 거둔다).
 *   - 정지(`on=true`)가 이미 정지된 에이전트에 오면: 운영자는 **정지를 넘겨받는다**(`owner` → `operator`) — 그러지 않으면
 *     소유자 정지 위에 건 운영자 정지가 "이미 그 상태" 로 사라지고, 소유자가 푸는 순간 운영자가 막으려던 에이전트가 산다.
 *     소유자는 운영자 정지를 넘겨받지 못한다(바꾸지 않는다).
 */
export async function setAgentSuspendedOp(
  db: Queryable,
  agentId: AgentId,
  on: boolean,
  actor: Suspender,
  confirm: (from: AgentStatus, to: AgentStatus) => Promise<void> = () => Promise.resolve(),
): Promise<AgentSuspension> {
  const before = await db.query<{ status: AgentStatus; suspended_by: Suspender | null }>(
    'SELECT status, suspended_by FROM agents WHERE id = $1',
    [agentId],
  );
  const row = before.rows[0];
  if (row === undefined) throw notFound(`에이전트가 없다: ${agentId}`, 'agent_not_found');
  const { status, suspended_by: suspendedBy } = row;

  if (on) {
    if (status === 'suspended') {
      if (actor === 'operator' && suspendedBy === 'owner') {
        await confirm(status, status);
        const taken = await db.query(
          `UPDATE agents SET suspended_by = 'operator' WHERE id = $1 AND status = 'suspended' AND suspended_by = 'owner'`,
          [agentId],
        );
        if (taken.rowCount !== 1) throw concurrentChange(agentId);
        return { status, suspendedBy: 'operator', changed: true };
      }
      return { status, suspendedBy, changed: false };
    }
    if (status !== 'active') throw new AdminInputError(`에이전트 ${agentId} 는 ${status} 다 — active → suspended 만 한다.`, 'invalid_transition', 409);
    await confirm('active', 'suspended');
    const result = await db.query(
      `UPDATE agents SET status = 'suspended', suspended_by = $2 WHERE id = $1 AND status = 'active'`,
      [agentId, actor],
    );
    if (result.rowCount !== 1) throw concurrentChange(agentId);
    return { status: 'suspended', suspendedBy: actor, changed: true };
  }

  if (status === 'active') return { status, suspendedBy: null, changed: false };
  if (status !== 'suspended') throw new AdminInputError(`에이전트 ${agentId} 는 ${status} 다 — suspended → active 만 한다.`, 'invalid_transition', 409);
  if (suspendedBy !== actor) {
    throw actor === 'owner'
      ? new AdminInputError('운영자가 정지한 에이전트다 — 운영자만 풀 수 있다.', 'operator_suspension', 409)
      : new AdminInputError('소유자가 콘솔에서 정지한 에이전트다 — 소유자가 콘솔에서 푼다.', 'owner_suspension', 409);
  }
  await confirm('suspended', 'active');
  const result = await db.query(
    `UPDATE agents SET status = 'active', suspended_by = NULL WHERE id = $1 AND status = 'suspended' AND suspended_by = $2`,
    [agentId, actor],
  );
  if (result.rowCount !== 1) throw concurrentChange(agentId);
  return { status: 'active', suspendedBy: null, changed: true };
}

/**
 * 만들기 본문의 대표 주소 선택(ADR-0014 2026-10 개정 · M3b — "만들 때 고른다"): `domain`(고객 도메인 · 선택) · `primary`(`atmark` | `custom` · 선택).
 *   - 둘 다 없음 → @atmark.ai 대표(예전 그대로).
 *   - `domain` 만 · `primary: 'custom'` + `domain` → 고객 도메인 대표(@atmark.ai 앵커는 내부에만 — 잠듦).
 *   - `primary: 'custom'` 인데 `domain` 없음 · `primary: 'atmark'` 인데 `domain` 있음 → 400 `invalid_body`(@atmark.ai 대표에 고객 주소를 더하려면 만든 뒤
 *     별칭으로 — 한 요청이 주소 둘을 만들지 않는다).
 * 돌려주는 값 = `customPrimaryDomain`(없으면 @atmark.ai 대표).
 */
export function customPrimaryDomainOf(domain: unknown, primary: unknown): string | undefined {
  if (primary !== undefined && primary !== null && primary !== 'atmark' && primary !== 'custom') {
    throw new AdminInputError("primary 는 'atmark' | 'custom' 이다.", 'invalid_body');
  }
  if (domain === undefined || domain === null) {
    if (primary === 'custom') throw new AdminInputError("primary 'custom' 에는 domain 이 필요하다.", 'invalid_body');
    return undefined;
  }
  if (typeof domain !== 'string') throw new AdminInputError('domain 은 문자열이다.', 'invalid_domain');
  const normalized = domain.trim().toLowerCase();
  if (normalized === 'atmark.ai') {
    if (primary === 'custom') throw new AdminInputError("primary 'custom' 의 domain 은 고객 도메인이다.", 'invalid_body');
    return undefined;
  }
  if (primary === 'atmark') {
    throw new AdminInputError("primary 'atmark' 에는 domain 을 쓰지 않는다 — 고객 도메인 주소는 만든 뒤 별칭으로 더한다.", 'invalid_body');
  }
  return normalized;
}

// ---------------------------------------------------------------------------
// 삭제 — 별칭 폐기와 같은 소프트 삭제(진윤겸 결정 2026-10-13)
// ---------------------------------------------------------------------------

export interface AgentDeletion {
  /** 이미 삭제돼 있었다(상태 쓰기 없음). 남은 것이 있으면 정리는 한다 — `changed`. */
  readonly replayed: boolean;
  /** 이 호출이 무엇이든 바꿨다(감사 행 기준) — 첫 삭제는 늘 참, 재생은 남은 것을 정리했을 때만. */
  readonly changed: boolean;
  /** 에이전트의 주소(대표 · 앵커 · 별칭) — 이제 모두 폐기돼 있다. */
  readonly addresses: readonly string[];
  readonly revokedTokens: number;
  readonly cancelledScheduled: number;
  readonly disabledWebhooks: number;
}

/**
 * 에이전트 삭제 — **호출자의 트랜잭션 안에서**(콘솔은 `audited` — 감사 `agent.delete` 와 한 트랜잭션). 행은 지우지 않는다: 받은 메일 · 로그 ·
 * 감사 · 투명성 잎이 그대로 남는다. 되돌릴 수 없다(`disabled` 는 종단 — DB 트리거 `agents_disabled_terminal`, 202610131000).
 *
 *   ① 조직 별칭 잠금(발급 · 대표 선택 · 별칭 폐기와 같은 키 — 대표 선택 커밋과 줄 선다) → 에이전트 행 잠금(FOR NO KEY UPDATE). 토큰 발급 ·
 *      웹훅 등록 · 별칭 추가는 이 행을 FOR SHARE 로 잡고 상태를 다시 본다 — 삭제와 줄 선다.
 *   ② `provisioning` 은 409 `invalid_transition` · 운영자 정지는 409 `operator_suspension`(운영자가 보류한 것을 소유자가 삭제로 풀지 않는다) ·
 *      운영자 예약 주소(support@ 등)를 쥐었으면 409 `operator_reserved`(DB 트리거도 막는다 — 지원 창구를 소유자 콘솔이 끄지 못한다).
 *   ③ 토큰 전부 폐기(`revokeAgentTokensOp` revoke-all — 콘솔 "전부 폐기" 와 같은 길) — API · MCP · 실시간이 바로 끊긴다(인증은 삭제한 에이전트의
 *      토큰을 폐기로 읽는다 · 실시간 푸시 대상 함수가 `revoked_at IS NULL` · `status = 'active'` 를 본다).
 *   ④ `status → 'disabled'`(`suspended_by` 는 CHECK 상 NULL) — 요금제 한도에서 빠진다(`countAgents`). 총합 천장(×3)은 계속 센다.
 *      Stage 0 이 `agent_not_active` 로 모든 발신(즉시 · 승인 릴리스 · 예약 · 초안)을 막는다. 상태 잎은 기존 tlog 트리거, 신원 폐기 요청은
 *      DB 트리거(`agents_disabled_identity_revoke`).
 *   ⑤ 주소 전부 폐기(대표 · 잠든 앵커 포함 — DB 폐기 가드가 disabled 일 때만 대표를 받는다). 재발급은 별칭과 같다(같은 조직 곧바로 · 다른 조직
 *      `ALIAS_REISSUE_HOLD_DAYS` 일 뒤). 수신은 모르는 수신자로 거부(읽기 SQL 의 `retired_at IS NULL`). 잎 `identity.address_retired` 가 주소마다.
 *   ⑥ 대기 예약 취소(정의자 함수 `console_cancel_agent_scheduled_sends`) · ⑦ 웹훅 끄기(`disable_webhook_endpoint` — 엔드포인트마다) ·
 *   ⑧ 결정을 기다리는 정책 변경 요청 닫기(stale `agent_deleted` · 지난 것은 expired).
 *
 * **재생**(이미 `disabled`): 상태는 그대로 두고 ③ · ⑤ · ⑥ · ⑦ 의 **남은 것만** 다시 정리한다(보안 리뷰 MED-3 — admin 롤의 raw `status` UPDATE ·
 * 옛 코드가 남긴 살아 있는 주소 · 토큰 · 예약 · 웹훅). 남은 것이 없으면 `changed = false`(감사 없음 — 별칭 폐기 재생과 같다).
 */
export async function deleteAgentOp(pool: Pool, organizationId: string, agentId: AgentId): Promise<AgentDeletion> {
  // 조직 잠금 먼저, 그다음 에이전트 행 — 별칭 추가 · 대표 선택(조직 잠금 → 주소·선택 INSERT 의 FK KEY SHARE)과 같은 순서라 교착이 없다.
  // `NO KEY UPDATE` — 키 칸은 바꾸지 않는다(FK 의 KEY SHARE 와 부딪히지 않는다).
  await lockOrganizationAliases(pool, organizationId);
  const current = await pool.query<{ status: AgentStatus; suspended_by: Suspender | null }>(
    'SELECT status, suspended_by FROM agents WHERE id = $1 AND organization_id = $2 FOR NO KEY UPDATE',
    [agentId, organizationId],
  );
  const row = current.rows[0];
  if (row === undefined) throw notFound(`에이전트가 없다: ${agentId}`, 'agent_not_found');
  const replayed = row.status === 'disabled';
  let revoked: number;
  if (replayed) {
    // 재생 — `revokeAgentTokensOp` 는 삭제한 에이전트를 409 로 거른다. 같은 잠금 아래 같은 문장을 직접 쓴다(폐기 시각은 덮지 않는다).
    await lockAgentTokens(pool, agentId);
    revoked = (await pool.query('UPDATE agent_api_keys SET revoked_at = now() WHERE agent_id = $1 AND revoked_at IS NULL', [agentId])).rowCount ?? 0;
  } else {
    if (row.status === 'provisioning') throw new AdminInputError(`에이전트 ${agentId} 는 아직 provisioning 이다.`, 'invalid_transition', 409);
    if (row.status === 'suspended' && row.suspended_by === 'operator') {
      throw new AdminInputError('운영자가 정지한 에이전트다 — 운영자가 풀기 전에는 삭제할 수 없다.', 'operator_suspension', 409);
    }
    const reserved = await pool.query(
      'SELECT 1 FROM agent_addresses WHERE agent_id = $1 AND retired_at IS NULL AND address = ANY (atmark_operator_assignable_addresses()) LIMIT 1',
      [agentId],
    );
    if ((reserved.rowCount ?? 0) > 0) {
      throw new AdminInputError('운영자 예약 주소를 쥔 에이전트다 — 운영자가 그 주소를 옮기기 전에는 삭제할 수 없다.', 'operator_reserved', 409);
    }
    revoked = (await revokeAgentTokensOp(pool, agentId, 'revoke-all', { capabilities: DEFAULT_AGENT_TOKEN_CAPABILITIES, expiresAt: null })).revoked;
    const disabled = await pool.query(
      `UPDATE agents SET status = 'disabled', suspended_by = NULL WHERE id = $1 AND status IN ('active', 'suspended')`,
      [agentId],
    );
    if (disabled.rowCount !== 1) throw concurrentChange(agentId);
  }
  // 값은 DB 가드가 now() 로 덮는다. 행마다 주소 잠금을 잡는다(발급 보류 트리거와 같은 키 — 다른 조직의 동시 발급과 줄 선다).
  const retired = await pool.query(`UPDATE agent_addresses SET retired_at = now() WHERE agent_id = $1 AND retired_at IS NULL`, [agentId]);
  const cancelled = await pool.query<{ n: number }>('SELECT console_cancel_agent_scheduled_sends($1, $2) AS n', [organizationId, agentId]);
  // 웹훅 등록과 같은 잠금 키(`src/webhooks/management.ts` `registerWebhookEndpoint` · DB 트리거 `webhook_endpoints_active_limit`) — 삭제 커밋 전에
  // 상태를 active 로 본 등록(에이전트 API — 행 잠금을 잡을 수 없는 앱 롤)이 끝난 뒤에 엔드포인트를 읽어 그것까지 끈다(보안 재검토 L-1).
  await pool.query(`SELECT pg_advisory_xact_lock(hashtextextended('webhook_endpoints_active:' || $1::text, 0))`, [agentId]);
  const endpoints = await pool.query<{ id: string }>('SELECT id::text AS id FROM webhook_endpoints WHERE agent_id = $1 AND disabled_at IS NULL ORDER BY id', [agentId]);
  for (const endpoint of endpoints.rows) await pool.query('SELECT disable_webhook_endpoint($1, $2::uuid)', [agentId, endpoint.id]);
  // ⑧ 결정을 기다리는 정책 변경 요청을 닫는다(ADR-0007 2026-10-13) — 지운 에이전트의 정책은 더 바뀌지 않는다. 만료 전이면 stale(agent_deleted),
  //   이미 지났으면 expired(전이 트리거가 시계로 가른다). 승인 연산도 disabled 에이전트를 거부한다(`decidePolicyRequestOp`).
  const closedRequests = await pool.query(
    `UPDATE policy_change_requests
        SET status = CASE WHEN expires_at > now() THEN 'stale' ELSE 'expired' END,
            stale_reason = CASE WHEN expires_at > now() THEN 'agent_deleted' END,
            decided_by = CASE WHEN expires_at > now() THEN 'system:agent_deleted' ELSE 'system:expiry' END
      WHERE agent_id = $1 AND status = 'pending'`,
    [agentId],
  );
  const addresses = await pool.query<{ address: string }>('SELECT DISTINCT address FROM agent_addresses WHERE agent_id = $1 ORDER BY address', [agentId]);
  const cancelledScheduled = cancelled.rows[0]?.n ?? 0;
  return {
    replayed,
    changed: !replayed || revoked + (retired.rowCount ?? 0) + cancelledScheduled + endpoints.rows.length + (closedRequests.rowCount ?? 0) > 0,
    addresses: addresses.rows.map((r) => r.address),
    revokedTokens: revoked,
    cancelledScheduled,
    disabledWebhooks: endpoints.rows.length,
  };
}
