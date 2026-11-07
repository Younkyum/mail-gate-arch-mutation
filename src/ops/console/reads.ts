/**
 * src/ops/console/reads.ts — 운영자 화면의 **읽기**(대시보드 · 검토 대기열 · 조직 · 요금제 · 긴급 정지 · 감사)와 확인 입력 검사.
 *
 * 로컬 화면(`api.ts` — 소유자 롤 풀)과 호스팅 콘솔(`src/ops/hosted/**` — `atmark_ops` 롤, 컬럼 GRANT 는 **이 파일의 SELECT 에서 뽑는다**,
 * `.omc/plans/ops-console.md` §3.2)이 같은 조회를 쓴다. 쓰기 경로(`src/ops/core/**` · `writeEntitlementVersion`)를 import 하지 않는다 — 호스팅 폐포에
 * 요금제 쓰기가 들어가지 않게(arch §3.9). 조회는 `db` 하나로만 하고 시각은 호출자가 준다(테스트가 고정한다).
 * 사용자가 고른 문자열(조직 이름 · 주소)은 정화해 싣고(`sanitizeDisplayText`), 화면은 `textContent` 로만 그린다.
 */

import { listAgentsOp, MAX_AGENTS_PER_ORG, ORGANIZATION_ID_PATTERN } from '../../admin/ops/agents';
import { AdminInputError } from '../../admin/ops/errors';
import { planUsageOp } from '../../admin/ops/plan';
import {
  ENTITLEMENT_CEILINGS,
  LIMIT_COLUMNS,
  PLAN_CATALOG,
  PLAN_CODES,
  resolveEntitlements,
  type EntitlementRowInput,
} from '../../billing/plans';
import type { Queryable } from '../../db/client';
import { ORG_ENTITLEMENTS_COLUMNS } from '../../db/repositories/entitlements';
import { sanitizeDisplayText } from '../../notify/approval-notification-template';

export interface ApiResult {
  readonly status: number;
  readonly body: unknown;
}

export const ok = (body: unknown): ApiResult => ({ status: 200, body });

/** 확인 단어 — 되돌릴 수 없거나 조직 전체를 멈추는 쓰기. */
export const ACK_WORD = 'CONFIRM';

/** 되돌릴 수 없는 쓰기(거절 · 조직 정지 켜기)가 요구하는 조직 id 앞자리 수. */
export const ID_PREFIX_LENGTH = 8;

/** 화면에 그리는 조직 이름(정화 — 제어문자·양방향·폭 없는 문자 제거, 한 줄). 확인 입력도 이것과 대조한다. 비면 조직 id. */
export function displayName(name: string, id: string): string {
  const shown = sanitizeDisplayText(name, 200).trim();
  return shown === '' ? id : shown;
}

export const text = (value: string | null | undefined, max: number): string | null => (value === null || value === undefined ? null : sanitizeDisplayText(value, max));
export const iso = (value: Date | null | undefined): string | null => (value === null || value === undefined ? null : value.toISOString());

export function requireOrgId(raw: string): string {
  if (!ORGANIZATION_ID_PATTERN.test(raw)) throw new AdminInputError('조직 id(uuid)가 아니다.', 'invalid_organization');
  return raw.toLowerCase();
}

/** 확인 대상 — 조직의 표시 이름과 id. */
export interface ConfirmTarget {
  readonly id: string;
  readonly name: string;
}

export async function confirmTarget(db: Queryable, organizationId: string): Promise<ConfirmTarget> {
  const row = await db.query<{ name: string }>('SELECT name FROM organizations WHERE id = $1', [organizationId]);
  const name = row.rows[0]?.name;
  if (name === undefined) throw new AdminInputError('조직이 없다.', 'organization_not_found', 404);
  return { id: organizationId, name: displayName(name, organizationId) };
}

export function record(body: unknown): Record<string, unknown> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new AdminInputError('본문은 JSON 객체다.', 'invalid_body');
  return body as Record<string, unknown>;
}

/**
 * 확인 입력 검사 — 아무것도 바꾸기 전에 부른다.
 *   - `name`: `confirm` = 조직 표시 이름(양쪽 NFC 정규화 — 조합형·완성형 한글이 같은 글자로 비교된다).
 *   - `irreversible`(거절 · 조직 정지 켜기): `confirm` = 조직 id 앞 8자리(대소문자 무관) **그리고** `ack` = `CONFIRM`. 이름은 보이는 글자가
 *     같아도 다른 문자열일 수 있어(혼동 문자) 되돌릴 수 없는 동작의 대상 확인으로 쓰지 않는다.
 */
export function requireConfirmation(body: Record<string, unknown>, target: ConfirmTarget, mode: 'name' | 'irreversible'): void {
  const typed = typeof body['confirm'] === 'string' ? body['confirm'].trim().normalize('NFC') : '';
  if (mode === 'irreversible') {
    if (typed.toLowerCase() !== target.id.slice(0, ID_PREFIX_LENGTH).toLowerCase()) {
      throw new AdminInputError(`확인 입력이 조직 id 앞 ${String(ID_PREFIX_LENGTH)}자리와 다릅니다. 아무것도 바꾸지 않았습니다.`, 'confirmation_required', 422);
    }
    if (body['ack'] !== ACK_WORD) throw new AdminInputError(`되돌릴 수 없는 변경입니다. ${ACK_WORD} 를 입력하세요.`, 'confirmation_required', 422);
    return;
  }
  if (typed === '' || typed !== target.name.normalize('NFC')) {
    throw new AdminInputError('확인 입력이 조직 이름과 다릅니다. 아무것도 바꾸지 않았습니다.', 'confirmation_required', 422);
  }
}

// ---------------------------------------------------------------------------
// 읽기
// ---------------------------------------------------------------------------

/** 검토 대기(pending_review) 조직 — 가입 순. `listPendingReviewOp`(CLI `--list`)와 같은 행 + 가입 출처. */
export async function readReviewQueue(db: Queryable): Promise<ApiResult> {
  const rows = await db.query<{ id: string; name: string; owner_email: string | null; created_at: Date; agents: number; signup_source: string }>(
    `SELECT o.id, o.name, o.owner_email, o.created_at, o.signup_source, count(a.id)::int AS agents
       FROM organizations o
       LEFT JOIN agents a ON a.organization_id = o.id
      WHERE o.review_status = 'pending_review'
      GROUP BY o.id
      ORDER BY o.created_at, o.id`,
  );
  return ok({
    items: rows.rows.map((row) => ({
      id: row.id,
      name: displayName(row.name, row.id),
      ownerEmail: text(row.owner_email, 254),
      createdAt: iso(row.created_at),
      agents: row.agents,
      signupSource: row.signup_source,
    })),
  });
}

interface OrgListRow {
  id: string;
  name: string;
  owner_email: string | null;
  review_status: string;
  signup_source: string;
  abuse_freeze: boolean;
  owner_paused: boolean;
  created_at: Date;
  agents_non_disabled: number;
  agents_total: number;
}

type EntitlementListRow = EntitlementRowInput & {
  organization_id: string;
  source: string;
  version: string;
  provider_override_allowed: boolean;
};

export const ORG_LIST_LIMIT = 200;
const REVIEW_STATUSES = ['pending_review', 'active', 'rejected'] as const;

export async function readOrganizations(db: Queryable, query: URLSearchParams, now: Date): Promise<ApiResult> {
  const q = (query.get('q') ?? '').trim().slice(0, 100);
  const status = query.get('status') ?? '';
  if (status !== '' && !(REVIEW_STATUSES as readonly string[]).includes(status)) throw new AdminInputError('status 는 pending_review|active|rejected.', 'invalid_status');
  const like = q === '' ? null : `%${q.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
  const rows = await db.query<OrgListRow>(
    // 조직을 먼저 자르고(최근 순 200) 에이전트 수는 그 행마다 — 전체 조직 × 에이전트 GROUP BY 를 하지 않는다.
    `SELECT o.id, o.name, o.owner_email, o.review_status::text AS review_status, o.signup_source, o.abuse_freeze, o.owner_paused, o.created_at,
            (SELECT count(*) FROM agents a WHERE a.organization_id = o.id AND a.status <> 'disabled')::int AS agents_non_disabled,
            (SELECT count(*) FROM agents a WHERE a.organization_id = o.id)::int AS agents_total
       FROM organizations o
      WHERE ($1::text IS NULL OR o.name ILIKE $1 OR o.owner_email ILIKE $1 OR o.id::text ILIKE $1)
        AND ($2::text = '' OR o.review_status::text = $2)
      ORDER BY o.created_at DESC, o.id
      LIMIT ${String(ORG_LIST_LIMIT)}`,
    [like, status],
  );
  const ids = rows.rows.map((row) => row.id);
  const ent = await db.query<EntitlementListRow>(
    `SELECT ${ORG_ENTITLEMENTS_COLUMNS}, provider_override_allowed FROM org_entitlements WHERE organization_id = ANY($1::uuid[])`,
    [ids],
  );
  const entOf = new Map(ent.rows.map((row) => [row.organization_id, row]));
  return ok({
    limit: ORG_LIST_LIMIT,
    items: rows.rows.map((row) => {
      const entitlement = entOf.get(row.id) ?? null;
      const applied = resolveEntitlements(entitlement, now);
      return {
        id: row.id,
        name: displayName(row.name, row.id),
        ownerEmail: text(row.owner_email, 254),
        reviewStatus: row.review_status,
        signupSource: row.signup_source,
        abuseFreeze: row.abuse_freeze,
        ownerPaused: row.owner_paused,
        createdAt: iso(row.created_at),
        plan: {
          code: applied.planCode,
          basis: applied.basis,
          rowCode: entitlement?.plan_code ?? null,
          source: entitlement?.source ?? null,
          releasedToProvider: entitlement?.provider_override_allowed ?? false,
        },
        agents: { active: row.agents_non_disabled, total: row.agents_total, max: Math.min(applied.maxAgents, MAX_AGENTS_PER_ORG) },
      };
    }),
  });
}

interface OrgRow {
  id: string;
  name: string;
  owner_email: string | null;
  review_status: string;
  signup_source: string;
  reviewed_at: Date | null;
  abuse_freeze: boolean;
  owner_paused: boolean;
  billing_status: string;
  sending_started_at: Date | null;
  created_at: Date;
}

export async function readOrganization(db: Queryable, organizationId: string, now: Date, options: AuditOptions = LOCAL_AUDIT): Promise<ApiResult> {
  const org = await db.query<OrgRow>(
    `SELECT id, name, owner_email, review_status::text AS review_status, signup_source, reviewed_at, abuse_freeze, owner_paused,
            billing_status::text AS billing_status, sending_started_at, created_at
       FROM organizations WHERE id = $1`,
    [organizationId],
  );
  const row = org.rows[0];
  if (row === undefined) throw new AdminInputError('조직이 없다.', 'organization_not_found', 404);
  const members = await db.query<{ email: string; role: string; joined_via: string; created_at: Date }>(
    `SELECT u.email, m.role, m.joined_via, m.created_at FROM memberships m JOIN users u ON u.id = m.user_id
      WHERE m.organization_id = $1 AND m.removed_at IS NULL ORDER BY m.created_at, m.id`,
    [organizationId],
  );
  const agents = await listAgentsOp(db, organizationId);
  const plan = await planUsageOp(db, organizationId, now);
  const control = await db.query<{ source: string; cause: string; provider_override_allowed: boolean }>(
    'SELECT source, cause, provider_override_allowed FROM org_entitlements WHERE organization_id = $1',
    [organizationId],
  );
  const subscriptions = await db.query<{
    environment: string;
    status: string;
    plan_code: string | null;
    current_period_end: Date | null;
    scheduled_change_action: string | null;
    scheduled_change_at: Date | null;
    past_due_since: Date | null;
    synced_at: Date | null;
  }>(
    `SELECT environment::text AS environment, status::text AS status, plan_code, current_period_end, scheduled_change_action, scheduled_change_at,
            past_due_since, synced_at
       FROM billing_subscriptions WHERE organization_id = $1 ORDER BY synced_at DESC NULLS LAST`,
    [organizationId],
  );
  const audit = await auditRows(db, { organizationId, source: 'all', action: null, since: null, limit: 20 }, options);
  return ok({
    organization: {
      id: row.id,
      name: displayName(row.name, row.id),
      ownerEmail: text(row.owner_email, 254),
      reviewStatus: row.review_status,
      signupSource: row.signup_source,
      reviewedAt: iso(row.reviewed_at),
      abuseFreeze: row.abuse_freeze,
      ownerPaused: row.owner_paused,
      billingStatus: row.billing_status,
      sendingStartedAt: iso(row.sending_started_at),
      createdAt: iso(row.created_at),
    },
    members: members.rows.map((m) => ({ email: text(m.email, 254), role: m.role, joinedVia: m.joined_via, createdAt: iso(m.created_at) })),
    agents: agents.map((a) => ({
      id: a.id,
      name: sanitizeDisplayText(a.name, 120),
      address: a.address,
      status: a.status,
      suspendedBy: a.suspendedBy,
      activeTokens: a.activeTokens,
      createdAt: a.createdAt,
    })),
    plan,
    entitlementControl:
      control.rows[0] === undefined
        ? null
        : { source: control.rows[0].source, cause: control.rows[0].cause, releasedToProvider: control.rows[0].provider_override_allowed },
    billing: {
      subscriptions: subscriptions.rows.map((s) => ({
        environment: s.environment,
        status: s.status,
        plan: s.plan_code,
        currentPeriodEnd: iso(s.current_period_end),
        scheduledChange: s.scheduled_change_action === null ? null : { action: s.scheduled_change_action, at: iso(s.scheduled_change_at) },
        pastDueSince: iso(s.past_due_since),
        syncedAt: iso(s.synced_at),
      })),
      // 결제 체크아웃 잠금(콘솔 `billingOverviewOp` 의 'beta' 사유) — 지금 적용 요금제가 beta 면 결제가 열리지 않는다.
      betaLocked: plan.plan.code === 'beta',
    },
    audit,
  });
}

export function readCatalog(): ApiResult {
  return ok({
    plans: PLAN_CODES,
    columns: LIMIT_COLUMNS.map(([key, column]) => ({ column, ceiling: ENTITLEMENT_CEILINGS[key] })),
    catalog: Object.fromEntries(PLAN_CODES.map((code) => [code, Object.fromEntries(LIMIT_COLUMNS.map(([key, column]) => [column, PLAN_CATALOG[code][key]]))])),
  });
}

// ---------------------------------------------------------------------------
// 대시보드 · 요금제 · 긴급 정지 — 읽기 전용 집계(소유자 롤 풀). 쓰기 없음 · 시각은 `now` 기준(테스트가 고정한다).
// ---------------------------------------------------------------------------

const DAY_MS = 24 * 60 * 60 * 1000;
export const DASHBOARD_RECENT_LIMIT = 8;

/** 발송 한 창(24시간 · 7일) — `messages` 의 상태별 수. `queued` = 대기(pending) + 보내는 중(dispatching). `received` = 수신. */
export interface SendingWindow {
  sent: number;
  denied: number;
  failed: number;
  queued: number;
  received: number;
}

const emptyWindow = (): SendingWindow => ({ sent: 0, denied: 0, failed: 0, queued: 0, received: 0 });

function addToWindow(window: SendingWindow, direction: string, status: string, count: number): void {
  if (direction === 'inbound') window.received += count;
  else if (status === 'sent') window.sent += count;
  else if (status === 'denied') window.denied += count;
  else if (status === 'failed') window.failed += count;
  else if (status === 'pending' || status === 'dispatching') window.queued += count;
}

/** 대시보드 — 조직 수(검토 상태별 · 동결) · 에이전트 수 · 가입(직접 가입, 24시간·7일) · 최근 가입 · 발송(24시간·7일). 창은 `[now - 창, now)` — 위쪽 끝을 둔다. */
export async function readDashboard(db: Queryable, now: Date): Promise<ApiResult> {
  const day = new Date(now.getTime() - DAY_MS);
  const week = new Date(now.getTime() - 7 * DAY_MS);
  const orgs = await db.query<{ pending: number; active: number; rejected: number; frozen: number; signups_day: number; signups_week: number }>(
    `SELECT count(*) FILTER (WHERE review_status = 'pending_review')::int AS pending,
            count(*) FILTER (WHERE review_status = 'active')::int AS active,
            count(*) FILTER (WHERE review_status = 'rejected')::int AS rejected,
            count(*) FILTER (WHERE abuse_freeze)::int AS frozen,
            count(*) FILTER (WHERE signup_source = 'self_signup' AND created_at >= $1 AND created_at < $3)::int AS signups_day,
            count(*) FILTER (WHERE signup_source = 'self_signup' AND created_at >= $2 AND created_at < $3)::int AS signups_week
       FROM organizations`,
    [day, week, now],
  );
  const agents = await db.query<{ active: number; suspended: number; provisioning: number; total: number }>(
    `SELECT count(*) FILTER (WHERE status = 'active')::int AS active,
            count(*) FILTER (WHERE status = 'suspended')::int AS suspended,
            count(*) FILTER (WHERE status = 'provisioning')::int AS provisioning,
            count(*) FILTER (WHERE status <> 'disabled')::int AS total
       FROM agents`,
  );
  const recent = await db.query<{ id: string; name: string; owner_email: string | null; review_status: string; created_at: Date; agents: number }>(
    `SELECT o.id, o.name, o.owner_email, o.review_status::text AS review_status, o.created_at,
            (SELECT count(*) FROM agents a WHERE a.organization_id = o.id)::int AS agents
       FROM organizations o
      WHERE o.signup_source = 'self_signup'
      ORDER BY o.created_at DESC, o.id
      LIMIT ${String(DASHBOARD_RECENT_LIMIT)}`,
  );
  const sending = await db.query<{ in_day: boolean; direction: string; status: string; count: number }>(
    `SELECT created_at >= $1 AS in_day, direction::text AS direction, status::text AS status, count(*)::int AS count
       FROM messages
      WHERE created_at >= $2 AND created_at < $3
      GROUP BY 1, 2, 3`,
    [day, week, now],
  );
  const windows = { day: emptyWindow(), week: emptyWindow() };
  for (const row of sending.rows) {
    addToWindow(windows.week, row.direction, row.status, row.count);
    if (row.in_day) addToWindow(windows.day, row.direction, row.status, row.count);
  }
  const o = orgs.rows[0];
  const a = agents.rows[0];
  return ok({
    at: now.toISOString(),
    organizations: {
      pendingReview: o?.pending ?? 0,
      active: o?.active ?? 0,
      rejected: o?.rejected ?? 0,
      frozen: o?.frozen ?? 0,
    },
    signups: { day: o?.signups_day ?? 0, week: o?.signups_week ?? 0 },
    agents: { active: a?.active ?? 0, suspended: a?.suspended ?? 0, provisioning: a?.provisioning ?? 0, total: a?.total ?? 0 },
    recentSignups: recent.rows.map((row) => ({
      id: row.id,
      name: displayName(row.name, row.id),
      ownerEmail: text(row.owner_email, 254),
      reviewStatus: row.review_status,
      createdAt: iso(row.created_at),
      agents: row.agents,
    })),
    sending: windows,
  });
}

export const PLAN_LIST_LIMIT = 200;

/** 요금제 — 행 기준 분포(행 없음 = free 로 적용) · 기본 행이 아닌 조직(운영자·결제) 최근 바뀐 순. 거절 조직은 세지 않는다. */
export async function readPlans(db: Queryable, now: Date): Promise<ApiResult> {
  const counts = await db.query<{ plan: string; organizations: number }>(
    `SELECT coalesce(e.plan_code, 'none') AS plan, count(*)::int AS organizations
       FROM organizations o
       LEFT JOIN org_entitlements e ON e.organization_id = o.id
      WHERE o.review_status <> 'rejected'
      GROUP BY 1`,
  );
  const rows = await db.query<EntitlementListRow & { cause: string; name: string; updated_at: Date }>(
    `SELECT e.*, o.name
       FROM (SELECT ${ORG_ENTITLEMENTS_COLUMNS}, provider_override_allowed
               FROM org_entitlements
              WHERE source <> 'default' OR plan_code <> 'free'
              ORDER BY updated_at DESC, organization_id
              LIMIT ${String(PLAN_LIST_LIMIT)}) e
       JOIN organizations o ON o.id = e.organization_id
      ORDER BY e.updated_at DESC, e.organization_id`,
  );
  const byPlan = new Map(counts.rows.map((row) => [row.plan, row.organizations]));
  return ok({
    limit: PLAN_LIST_LIMIT,
    counts: [...PLAN_CODES, 'none'].map((plan) => ({ plan, organizations: byPlan.get(plan) ?? 0 })),
    items: rows.rows.map((row) => {
      const applied = resolveEntitlements(row, now);
      return {
        id: row.organization_id,
        name: displayName(row.name, row.organization_id),
        plan: applied.planCode,
        basis: applied.basis,
        rowCode: row.plan_code,
        source: row.source,
        cause: row.cause,
        version: Number(row.version),
        graceUntil: iso(row.grace_until),
        releasedToProvider: row.provider_override_allowed,
        updatedAt: iso(row.updated_at),
      };
    }),
  });
}

export const KILL_LIST_LIMIT = 200;

/** 긴급 정지 — 지금 동결된 조직 · 운영자가 정지한 에이전트(최근 바뀐 순). 푸는 쓰기는 기존 `/freeze` · `/suspend` 로. */
export async function readKillSwitch(db: Queryable): Promise<ApiResult> {
  const frozen = await db.query<{ id: string; name: string; owner_email: string | null; review_status: string; updated_at: Date }>(
    `SELECT id, name, owner_email, review_status::text AS review_status, updated_at
       FROM organizations WHERE abuse_freeze
      ORDER BY updated_at DESC, id LIMIT ${String(KILL_LIST_LIMIT)}`,
  );
  const agents = await db.query<{ id: string; name: string; address: string | null; organization_id: string; organization_name: string; updated_at: Date }>(
    `SELECT a.id, a.name, ad.address, a.organization_id, o.name AS organization_name, a.updated_at
       FROM agents a
       JOIN organizations o ON o.id = a.organization_id
       -- 유효 대표(ADR-0014 2026-10 개정 — 정의자 함수의 두 칸만 · 잠든 앵커는 나오지 않는다 · 무효면 NULL).
       LEFT JOIN LATERAL atmark_agent_primary_view(a.id) ad ON true
      WHERE a.status = 'suspended' AND a.suspended_by = 'operator'
      ORDER BY a.updated_at DESC, a.id LIMIT ${String(KILL_LIST_LIMIT)}`,
  );
  return ok({
    limit: KILL_LIST_LIMIT,
    frozenOrganizations: frozen.rows.map((row) => ({
      id: row.id,
      name: displayName(row.name, row.id),
      ownerEmail: text(row.owner_email, 254),
      reviewStatus: row.review_status,
      updatedAt: iso(row.updated_at),
    })),
    suspendedAgents: agents.rows.map((row) => ({
      id: row.id,
      name: sanitizeDisplayText(row.name, 120),
      address: row.address,
      organizationId: row.organization_id,
      organizationName: displayName(row.organization_name, row.organization_id),
      updatedAt: iso(row.updated_at),
    })),
  });
}

export type AuditSource = 'all' | 'owner' | 'billing' | 'ops';
export const AUDIT_MAX_LIMIT = 200;

/**
 * 감사에 운영자 콘솔 기록(`ops_actions` 티켓·실패·운영자 사건 + 트리거가 적은 `ops_action_effects`)을 넣는가. 호스팅만 켠다 — 로컬 화면은 0500
 * 적용 전 DB 에도 붙으므로 그 표를 모른다(켜지 않는다).
 */
export interface AuditOptions {
  readonly ops: boolean;
}

export const LOCAL_AUDIT: AuditOptions = { ops: false };
export const HOSTED_AUDIT: AuditOptions = { ops: true };

interface AuditFilter {
  readonly organizationId: string | null;
  readonly source: AuditSource;
  /** 행위 접두사 — 화면에 보이는 값 그대로(owner_actions.action · billing_audit.cause · ops_actions 는 `kind:action`). */
  readonly action: string | null;
  readonly since: Date | null;
  readonly limit: number;
}

interface AuditRow {
  source: 'owner' | 'billing' | 'ops';
  created_at: Date;
  organization_id: string | null;
  organization_name: string | null;
  action: string;
  target_id: string | null;
  actor: string | null;
  detail: string | null;
}

/**
 * 운영자 콘솔 기록 — 티켓 한 행에 그 트랜잭션의 효과(표 · 동작)를 붙인다(수락 기준: 감사 화면에 티켓과 효과가 함께 보인다).
 * 행위자는 운영자 주소(없으면 `ops:<id>`). 조직이 없는 행(운영자 사건 · 로그인)도 나온다.
 */
export const OPS_AUDIT_SQL = `SELECT 'ops' AS source, x.created_at, x.organization_id, org.name AS organization_name,
                       x.kind || coalesce(':' || x.action, '') AS action, coalesce(x.agent_id::text, x.target_operator_id::text) AS target_id,
                       coalesce(op.email, 'ops:' || x.operator_id::text) AS actor,
                       concat_ws(' · ', nullif(x.result, 'ok'), x.code,
                                 (SELECT string_agg(e.table_name || ' ' || e.op, ', ' ORDER BY e.table_name, e.op)
                                    FROM ops_action_effects e WHERE e.action_id = x.id)) AS detail
                  FROM ops_actions x
                  LEFT JOIN organizations org ON org.id = x.organization_id
                  LEFT JOIN ops_operators op ON op.id = x.operator_id
                 WHERE ($1::uuid IS NULL OR x.organization_id = $1) AND ($2::text IS NULL OR x.kind || coalesce(':' || x.action, '') LIKE $2)
                   AND ($3::timestamptz IS NULL OR x.created_at >= $3)`;

/**
 * 감사 행 — `owner_actions`(콘솔·조직 키 행위, 행위자 = 세션 사용자 주소 또는 `org_key:<이름>` · 운영자 CLI · 플랫폼 자동 동결은
 * `admin:<명령>:<운영자>` · `system:<원인>` 과 사유 — 202610131610) + `billing_audit`(요금제 변경, 행위자 그대로)
 * (+ 호스팅이면 운영자 콘솔 기록). 로컬은 소유자 롤, 호스팅은 `atmark_ops` 의 컬럼 GRANT 로 읽는다.
 */
async function auditRows(db: Queryable, filter: AuditFilter, options: AuditOptions): Promise<unknown[]> {
  const parts: string[] = [];
  if (filter.source === 'all' || filter.source === 'owner') {
    parts.push(`SELECT 'owner' AS source, o.created_at, o.organization_id, org.name AS organization_name, o.action, o.target_id,
                       coalesce(u.email, CASE WHEN k.id IS NULL THEN NULL ELSE 'org_key:' || k.label END, o.operator_actor) AS actor,
                       o.operator_reason AS detail
                  FROM owner_actions o
                  JOIN organizations org ON org.id = o.organization_id
                  LEFT JOIN owner_sessions s ON s.id = o.session_id
                  LEFT JOIN users u ON u.id = s.user_id
                  LEFT JOIN org_api_keys k ON k.id = o.org_api_key_id
                 WHERE ($1::uuid IS NULL OR o.organization_id = $1) AND ($2::text IS NULL OR o.action LIKE $2) AND ($3::timestamptz IS NULL OR o.created_at >= $3)`);
  }
  if (filter.source === 'all' || filter.source === 'billing') {
    parts.push(`SELECT 'billing' AS source, b.created_at, b.organization_id, org.name AS organization_name, b.cause AS action, NULL::text AS target_id,
                       b.actor, coalesce(b.from_plan, '-') || ' -> ' || b.to_plan || ' v' || b.entitlement_version::text || coalesce(' · ' || b.note, '') AS detail
                  FROM billing_audit b
                  JOIN organizations org ON org.id = b.organization_id
                 WHERE ($1::uuid IS NULL OR b.organization_id = $1) AND ($2::text IS NULL OR b.cause LIKE $2) AND ($3::timestamptz IS NULL OR b.created_at >= $3)`);
  }
  if (options.ops && (filter.source === 'all' || filter.source === 'ops')) parts.push(OPS_AUDIT_SQL);
  if (parts.length === 0) return [];
  const like = filter.action === null ? null : `${filter.action.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
  const rows = await db.query<AuditRow>(`${parts.join(' UNION ALL ')} ORDER BY created_at DESC LIMIT ${String(filter.limit)}`, [filter.organizationId, like, filter.since]);
  return rows.rows.map((row) => ({
    source: row.source,
    createdAt: iso(row.created_at),
    organizationId: row.organization_id,
    organizationName: row.organization_id === null ? null : displayName(row.organization_name ?? '', row.organization_id),
    action: row.action,
    targetId: row.target_id,
    actor: text(row.actor, 200),
    detail: text(row.detail, 600),
  }));
}

export async function readAudit(db: Queryable, query: URLSearchParams, options: AuditOptions = LOCAL_AUDIT): Promise<ApiResult> {
  const source = query.get('source') ?? 'all';
  const sources: readonly string[] = options.ops ? ['all', 'owner', 'billing', 'ops'] : ['all', 'owner', 'billing'];
  if (!sources.includes(source)) throw new AdminInputError(`source 는 ${sources.join('|')}.`, 'invalid_source');
  const org = (query.get('org') ?? '').trim();
  const action = (query.get('action') ?? '').trim();
  if (action !== '' && !/^[a-z0-9_.:]{1,60}$/.test(action)) throw new AdminInputError('action 은 소문자·숫자·_·.·: 60자 이하.', 'invalid_action');
  const sinceRaw = (query.get('since') ?? '').trim();
  const since = sinceRaw === '' ? null : new Date(sinceRaw);
  if (since !== null && (!/^\d{4}-\d{2}-\d{2}/.test(sinceRaw) || Number.isNaN(since.getTime()))) throw new AdminInputError('since 는 날짜(2026-09-01).', 'invalid_since');
  const limitRaw = Number(query.get('limit') ?? '100');
  const limit = Number.isInteger(limitRaw) && limitRaw >= 1 ? Math.min(limitRaw, AUDIT_MAX_LIMIT) : 100;
  const items = await auditRows(db, { organizationId: org === '' ? null : requireOrgId(org), source: source as AuditSource, action: action === '' ? null : action, since, limit }, options);
  return ok({ items, limit });
}

// ---------------------------------------------------------------------------
// 대기자 명단(202609301520)
// ---------------------------------------------------------------------------

export const WAITLIST_LIST_LIMIT = 200;
/** 화면의 상태 거르개 — `expired` 는 저장된 상태가 아니라 `invited` 중 초대가 끝난 것. */
export const WAITLIST_FILTERS = ['waiting', 'invited', 'expired', 'joined', 'all'] as const;
export type WaitlistFilter = (typeof WAITLIST_FILTERS)[number];
export const WAITLIST_EVENTS_LIMIT = 20;

/** 등급 후보(202609301530 — 마케팅 계획 §4.2). `null` = 용도가 비어 있다(1520 시절 · 가입 요청으로 올라온 항목 — 운영자가 메모를 읽고 정한다). */
export type WaitlistGradeHint = 'A' | 'B' | 'hold' | null;

/**
 * 등급 **후보** — 최종 등급은 운영자가 메모를 직접 읽고 정한다(메모·주소는 어떤 모델에도 넣지 않는다). A = 보고·알림 또는 답장 + 메모가 있다 ·
 * 보류 = 먼저 발송 · B = 그 밖의 수신 용도(인증코드, 메모 없는 보고·알림·답장). 가입한 항목은 메모가 비어 있으므로 A 가 되지 않는다(초대 뒤라 뜻이 없다).
 * 입력(용도 · 메모)이 본인 확인이 없는 값이라 후보도 그렇다 — 화면과 CLI 는 "본인 확인 안 됨 · unverified" 로 붙여 보인다.
 */
export function waitlistGradeHint(useCase: string | null, note: string | null): WaitlistGradeHint {
  if (useCase === 'outreach') return 'hold';
  if (useCase === 'alerts' || useCase === 'replies') return note !== null && note.trim() !== '' ? 'A' : 'B';
  if (useCase === 'codes') return 'B';
  return null;
}

interface WaitlistRow {
  id: string;
  email: string | null;
  lang: string;
  note: string | null;
  source: string;
  use_case: string | null;
  heard_from: string | null;
  ref: string | null;
  status: string;
  created_at: Date;
  invited_at: Date | null;
  invite_expires_at: Date | null;
  joined_at: Date | null;
  invited_by: string | null;
}

/** `waitlist_entries.id` 모양(uuid). */
export function requireWaitlistEntryId(raw: string): string {
  if (!ORGANIZATION_ID_PATTERN.test(raw)) throw new AdminInputError('대기 항목 id(uuid)가 아니다.', 'invalid_entry');
  return raw.toLowerCase();
}

/**
 * 대기자 명단 — 상태 거르개(`waiting` 기본 · 가장 오래 기다린 사람부터) · 수(상태별 · 24시간 초대) · 최근 운영 기록. 주소 · 메모는 사용자가 쓴 문자열이라
 * 정화해 싣고(`sanitizeDisplayText` — 제어·양방향·폭 없는 문자 제거 · 한 줄), 화면은 `textContent` 로만 그린다. 호스팅은 `atmark_ops` 의 칸 GRANT
 * (202609301520 · 신청서 세 칸 202609301530 — 이 SELECT 의 칸만)로 읽는다. 가입한 항목은 주소·메모가 비어 있다(개인정보 처리 안내).
 */
export async function readWaitlist(db: Queryable, query: URLSearchParams, now: Date): Promise<ApiResult> {
  const status = (query.get('status') ?? 'waiting').trim() as WaitlistFilter;
  if (!(WAITLIST_FILTERS as readonly string[]).includes(status)) throw new AdminInputError(`status 는 ${WAITLIST_FILTERS.join('|')}.`, 'invalid_status');
  const rows = await db.query<WaitlistRow>(
    `SELECT id, email, lang, note, source, use_case, heard_from, ref, status, created_at, invited_at, invite_expires_at, joined_at, invited_by
       FROM waitlist_entries
      WHERE CASE $1::text
              WHEN 'all' THEN true
              WHEN 'expired' THEN status = 'invited' AND invite_expires_at <= $2
              WHEN 'invited' THEN status = 'invited' AND invite_expires_at > $2
              ELSE status = $1
            END
      ORDER BY CASE WHEN $1 = 'waiting' THEN created_at END, coalesce(joined_at, invited_at, created_at) DESC, id
      LIMIT ${String(WAITLIST_LIST_LIMIT)}`,
    [status, now],
  );
  const counts = await db.query<{ waiting: number; invited: number; expired: number; joined: number }>(
    `SELECT count(*) FILTER (WHERE status = 'waiting')::int AS waiting,
            count(*) FILTER (WHERE status = 'invited' AND invite_expires_at > $1)::int AS invited,
            count(*) FILTER (WHERE status = 'invited' AND invite_expires_at <= $1)::int AS expired,
            count(*) FILTER (WHERE status = 'joined')::int AS joined
       FROM waitlist_entries`,
    [now],
  );
  const events = await db.query<{ id: string; entry_id: string; action: string; actor: string; created_at: Date }>(
    `SELECT id, entry_id, action, actor, created_at FROM waitlist_events ORDER BY created_at DESC, id DESC LIMIT ${String(WAITLIST_EVENTS_LIMIT)}`,
  );
  const invitedDay = await db.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM waitlist_events WHERE action = 'invite' AND created_at > $1`,
    [new Date(now.getTime() - DAY_MS)],
  );
  return ok({
    status,
    limit: WAITLIST_LIST_LIMIT,
    counts: { ...(counts.rows[0] ?? { waiting: 0, invited: 0, expired: 0, joined: 0 }), invitedLastDay: invitedDay.rows[0]?.n ?? 0 },
    items: rows.rows.map((row) => ({
      id: row.id,
      email: text(row.email, 254),
      lang: row.lang,
      note: text(row.note, 200),
      source: row.source,
      // 신청서 칸은 닫힌 값(CHECK)이라 정화하지 않는다. 등급은 본인 확인 안 된 **후보**다(`waitlistGradeHint`).
      useCase: row.use_case,
      heardFrom: row.heard_from,
      ref: row.ref,
      gradeHint: waitlistGradeHint(row.use_case, row.note),
      status: row.status === 'invited' && row.invite_expires_at !== null && row.invite_expires_at.getTime() <= now.getTime() ? 'expired' : row.status,
      createdAt: iso(row.created_at),
      invitedAt: iso(row.invited_at),
      inviteExpiresAt: iso(row.invite_expires_at),
      joinedAt: iso(row.joined_at),
      invitedBy: text(row.invited_by, 160),
    })),
    events: events.rows.map((row) => ({
      id: String(row.id),
      entryId: row.entry_id,
      action: row.action,
      actor: text(row.actor, 160),
      createdAt: iso(row.created_at),
    })),
  });
}

/** 대기 항목 확인 대상 — 항목의 (정화한) 주소. 없으면 404, 가입 끝남(주소 없음)은 409. 쓰기 전 확인 입력(`requireAddressConfirmation`)이 대조한다. */
export async function waitlistConfirmTarget(db: Queryable, entryId: string): Promise<{ readonly id: string; readonly email: string }> {
  const row = await db.query<{ email: string | null; status: string }>('SELECT email, status FROM waitlist_entries WHERE id = $1', [entryId]);
  const found = row.rows[0];
  if (found === undefined) throw new AdminInputError('대기 항목이 없다.', 'entry_not_found', 404);
  if (found.email === null) throw new AdminInputError('이미 가입한 항목이다.', 'already_joined', 409);
  return { id: entryId, email: found.email };
}

/** 주소 대상 쓰기(대기 항목 · 호스팅의 운영자 결정)의 확인 입력 — `confirm` = 그 주소(NFC · 대소문자 무관). 틀리면 422 — 아무것도 바꾸지 않는다. */
export function requireAddressConfirmation(body: Record<string, unknown>, email: string): void {
  const typed = typeof body['confirm'] === 'string' ? body['confirm'].trim().normalize('NFC').toLowerCase() : '';
  if (typed === '' || typed !== email.normalize('NFC').toLowerCase()) {
    throw new AdminInputError('확인 입력이 대상 주소와 다릅니다. 주소를 그대로 입력하세요.', 'confirmation_required', 422);
  }
}

/** N 명 초대의 수(1~50)와 확인 입력(`confirm` = 그 수). */
export const WAITLIST_INVITE_BATCH_MAX = 50;
export function requireInviteCount(body: Record<string, unknown>): number {
  const n = body['n'];
  if (typeof n !== 'number' || !Number.isInteger(n) || n < 1 || n > WAITLIST_INVITE_BATCH_MAX) {
    throw new AdminInputError(`n 은 1~${String(WAITLIST_INVITE_BATCH_MAX)} 정수.`, 'invalid_count');
  }
  const typed = typeof body['confirm'] === 'string' ? body['confirm'].trim() : '';
  if (typed !== String(n)) throw new AdminInputError('확인 입력이 초대할 수와 다릅니다. 수를 그대로 입력하세요.', 'confirmation_required', 422);
  return n;
}
