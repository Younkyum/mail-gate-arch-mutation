/**
 * src/admin/ops/watch.ts — 콘솔 '감시' 탭의 받기 설정 · 보류 메일 연산(ADR-0016 2026-10-08 · 마이그레이션 202610081000).
 *
 * 읽기는 admin 롤의 SELECT(설정 표 셋 · `inbound_messages` · 적중의 계열 칸), **쓰기는 정의자 함수 셋뿐**이다(표 쓰기 권한 0):
 *   - `atmark_watch_set_agent` — 에이전트의 위험 처리(deliver | hold) · 위험 알림(켬 | 끔).
 *   - `atmark_watch_set_trusted_senders` — 조직 신뢰 발신자 목록을 통째로(빠진 항목은 지우기 표시 · 200 상한).
 *   - `atmark_watch_release_inbound` — 숨은 메일 하나를 풀고 같은 트랜잭션에서 `message.received` 웹훅을 적는다(본문은 여기서 `messageReceivedEvent` 로
 *     만들고 함수가 이 메일의 것인지 확인한다).
 * 조직 범위는 SQL 이 가른다(다른 조직의 대상 = 없음). 역할 · CSRF 는 라우터 표, 감사 행은 라우트의 `audited`.
 *
 * 등급 · 계열은 `src/security/levels.ts` 하나로 계산한다(API · 알림 · 콘솔이 같은 등급을 본다). 보류 목록에 본문 · 제목 · 보낸 사람 주소는 없다
 * (보낸 사람 도메인 · 인증 여부 · 받은 시각 · 계열만).
 */

import type { Pool } from 'pg';

import type { Queryable } from '../../db/client';
import type { MemberRole } from '../context';
import { isSendApproval, type SendApproval } from '../../policy/rules/send-approval';
import { changePolicyOp } from './policy';
import { isAgentId, toAgentId, type InjectionRisk, type RiskHandling, type TrustedSenderKind } from '../../db/schema';
import type { RuleFamily } from '../../security/injection/rule-types';
import { classifyInboundLevel, type InboundLevel, type QuarantineReason, type ReleasedFrom } from '../../security/levels';
import { messageReceivedEvent } from '../../webhooks/events';
import { DEFAULT_AGENT_WATCH_SETTINGS, DOMAIN_SHAPE, MAX_TRUSTED_SENDERS, isFreemailDomain, isRiskHandling, parseTrustedSender, type TrustedSender } from '../../watch/settings';
import { AdminInputError } from './errors';

export const WATCH_AGENT_SET_ACTION = 'watch.agent.set';
export const WATCH_TRUSTED_SENDERS_SET_ACTION = 'watch.trusted_senders.set';
export const WATCH_RELEASE_ACTION = 'watch.release';
/** 발신 승인(auto | always)이 바뀐 호출 — 정책 새 버전과 같은 트랜잭션(ADR-0016 2026-10-08). */
export const WATCH_SEND_APPROVAL_SET_ACTION = 'watch.send_approval.set';

/** 보류 목록 한 쪽의 기본 · 최대 크기. */
const HELD_LIST_DEFAULT_LIMIT = 50;
const HELD_LIST_MAX_LIMIT = 100;

// ---------------------------------------------------------------------------
// 조직 설정 — 신뢰 발신자
// ---------------------------------------------------------------------------

export interface TrustedSenderView {
  readonly kind: TrustedSenderKind;
  readonly value: string;
  readonly createdAt: string;
}

export interface OrgWatchSettingsView {
  readonly trustedSenders: readonly TrustedSenderView[];
  readonly maxTrustedSenders: number;
  /** 조직 설정이 마지막으로 바뀐 시각(한 번도 안 바뀌었으면 null). */
  readonly updatedAt: string | null;
  /** 자가 등록(묶음 D — 기본 꺼짐). 켜도 `agents:enroll` 권한은 소유자가 토큰마다 준다. */
  readonly agentSelfEnroll: boolean;
  /** 조직 하루 자가 등록 시도 상한(1~`MAX_ENROLL_DAILY_CAP`, 기본 5). */
  readonly enrollDailyCap: number;
  readonly maxEnrollDailyCap: number;
  /** 자가 등록 알림(기본 켬). */
  readonly notifyOnEnroll: boolean;
  /** 바깥 가입 감지 알림(기본 켬). */
  readonly notifyOnSignup: boolean;
}

/** 조직 하루 자가 등록 상한의 범위(DB CHECK `org_watch_settings_enroll_daily_cap_check` 와 같다). */
const MAX_ENROLL_DAILY_CAP = 20;
const DEFAULT_ENROLL_DAILY_CAP = 5;
export const WATCH_ORG_SET_ACTION = 'watch.org.set';

export async function getOrgWatchSettingsOp(db: Queryable, organizationId: string): Promise<OrgWatchSettingsView> {
  const entries = await db.query<{ kind: TrustedSenderKind; value: string; created_at: Date }>(
    `SELECT kind, value, created_at FROM org_trusted_senders
      WHERE organization_id = $1 AND removed_at IS NULL
      ORDER BY kind, value`,
    [organizationId],
  );
  const settings = await db.query<{ updated_at: Date; agent_self_enroll: boolean; enroll_daily_cap: number; notify_on_enroll: boolean; notify_on_signup: boolean }>(
    'SELECT updated_at, agent_self_enroll, enroll_daily_cap, notify_on_enroll, notify_on_signup FROM org_watch_settings WHERE organization_id = $1',
    [organizationId],
  );
  const row = settings.rows[0];
  return {
    trustedSenders: entries.rows.map((entry) => ({ kind: entry.kind, value: entry.value, createdAt: entry.created_at.toISOString() })),
    maxTrustedSenders: MAX_TRUSTED_SENDERS,
    updatedAt: row?.updated_at.toISOString() ?? null,
    agentSelfEnroll: row?.agent_self_enroll ?? false,
    enrollDailyCap: row?.enroll_daily_cap ?? DEFAULT_ENROLL_DAILY_CAP,
    maxEnrollDailyCap: MAX_ENROLL_DAILY_CAP,
    notifyOnEnroll: row?.notify_on_enroll ?? true,
    notifyOnSignup: row?.notify_on_signup ?? true,
  };
}

/** 본문 `trustedSenders` — 문자열 배열(주소 또는 도메인). 앞뒤 공백 · 대소문자는 접고 겹치면 하나로. 모양이 틀린 줄은 그 위치와 함께 400. */
export function trustedSendersOf(raw: unknown): TrustedSender[] {
  if (!Array.isArray(raw)) throw new AdminInputError('trustedSenders 는 문자열 배열이다.', 'invalid_trusted_senders');
  const seen = new Map<string, TrustedSender>();
  for (const [index, item] of raw.entries()) {
    const parsed = typeof item === 'string' ? parseTrustedSender(item) : null;
    if (parsed === null) {
      throw new AdminInputError(`trustedSenders[${String(index)}] 는 주소(name@example.com) 또는 도메인(example.com)이어야 한다.`, 'invalid_trusted_sender');
    }
    if (parsed.kind === 'domain' && isFreemailDomain(parsed.value)) {
      throw new AdminInputError(
        `trustedSenders[${String(index)}] 는 공용 메일 도메인이다 — 그 도메인의 누구나가 된다. 정확한 주소(name@${parsed.value})를 넣어라.`,
        'trusted_sender_freemail_domain',
      );
    }
    seen.set(`${parsed.kind}:${parsed.value}`, parsed);
  }
  if (seen.size > MAX_TRUSTED_SENDERS) {
    throw new AdminInputError(`신뢰 발신자는 ${String(MAX_TRUSTED_SENDERS)}개까지다.`, 'too_many_trusted_senders');
  }
  return [...seen.values()];
}

export interface OrgWatchPatch {
  readonly agentSelfEnroll: boolean | null;
  readonly enrollDailyCap: number | null;
  readonly notifyOnEnroll: boolean | null;
  readonly notifyOnSignup: boolean | null;
}

export const ORG_WATCH_PATCH_KEYS: readonly string[] = ['agentSelfEnroll', 'enrollDailyCap', 'notifyOnEnroll', 'notifyOnSignup'];

/** 본문 → 조직 설정 바꾸기(없는 키 = 그대로). 값 모양이 틀리면 400. */
export function orgWatchPatchOf(body: Record<string, unknown>): OrgWatchPatch {
  const flag = (name: string): boolean | null => {
    const value = body[name];
    if (value === undefined) return null;
    if (typeof value !== 'boolean') throw new AdminInputError(`${name} 는 true | false 다.`, 'invalid_watch_setting');
    return value;
  };
  const rawCap = body['enrollDailyCap'];
  if (rawCap !== undefined && (typeof rawCap !== 'number' || !Number.isInteger(rawCap) || rawCap < 1 || rawCap > MAX_ENROLL_DAILY_CAP)) {
    throw new AdminInputError(`enrollDailyCap 은 1~${String(MAX_ENROLL_DAILY_CAP)} 정수다.`, 'invalid_enroll_daily_cap');
  }
  return {
    agentSelfEnroll: flag('agentSelfEnroll'),
    enrollDailyCap: (rawCap as number | undefined) ?? null,
    notifyOnEnroll: flag('notifyOnEnroll'),
    notifyOnSignup: flag('notifyOnSignup'),
  };
}

export interface OrgWatchChange extends OrgWatchSettingsView {
  readonly changed: boolean;
}

export async function setOrgWatchOp(db: Queryable, organizationId: string, userId: string, patch: OrgWatchPatch): Promise<OrgWatchChange> {
  const result = await db.query<{ outcome: string }>(
    'SELECT outcome FROM atmark_watch_set_org($1, $2, $3, $4, $5, $6)',
    [organizationId, patch.agentSelfEnroll, patch.enrollDailyCap, patch.notifyOnEnroll, patch.notifyOnSignup, userId],
  );
  const outcome = result.rows[0]?.outcome;
  if (outcome !== 'changed' && outcome !== 'unchanged') throw new Error('atmark_watch_set_org 가 모르는 결과를 돌려주었다');
  return { ...(await getOrgWatchSettingsOp(db, organizationId)), changed: outcome === 'changed' };
}

// ---------------------------------------------------------------------------
// 바깥 가입 감지 — 목록
// ---------------------------------------------------------------------------

export interface SignupView {
  readonly agentId: string;
  readonly agentName: string;
  /** 등록 가능 도메인(DMARC 인증된 보낸 사람에서). */
  readonly serviceDomain: string;
  readonly kind: 'verification' | 'welcome' | 'account_created';
  readonly firstSeenAt: string;
  readonly lastSeenAt: string;
  readonly messageCount: number;
}

export interface SignupListQuery {
  readonly agentId: string | null;
  readonly limit: number;
  readonly cursor: { readonly at: string; readonly agentId: string; readonly domain: string } | null;
}

/**
 * 목록 쿼리 공통 — `agentId`(모양만 — 조직 범위는 SQL) · `limit` · `cursor`(이전 응답의 `nextCursor`, base64url JSON).
 * `cursorOf` 는 풀어 낸 객체를 검사해 커서를 돌려주거나, 모양이 틀리면 `null`.
 */
function pageQueryOf<C>(
  query: Readonly<Record<string, string>>,
  cursorOf: (decoded: Record<string, unknown>) => C | null,
): { agentId: string | null; limit: number; cursor: C | null } {
  const agent = query['agentId'];
  if (agent !== undefined && !isAgentId(agent)) throw new AdminInputError('agentId 는 에이전트 id(hex 32)다.', 'invalid_agent');
  const rawLimit = query['limit'];
  const limit = rawLimit === undefined ? HELD_LIST_DEFAULT_LIMIT : Number(rawLimit);
  if (!Number.isInteger(limit) || limit < 1 || limit > HELD_LIST_MAX_LIMIT) {
    throw new AdminInputError(`limit 은 1~${String(HELD_LIST_MAX_LIMIT)} 의 정수다.`, 'invalid_limit');
  }
  const rawCursor = query['cursor'];
  if (rawCursor === undefined) return { agentId: agent ?? null, limit, cursor: null };
  const invalid = new AdminInputError('cursor 는 이전 응답의 nextCursor 값 그대로여야 한다.', 'invalid_cursor');
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(rawCursor, 'base64url').toString('utf8'));
  } catch {
    throw invalid;
  }
  const cursor = cursorOf(typeof decoded === 'object' && decoded !== null ? (decoded as Record<string, unknown>) : {});
  if (cursor === null) throw invalid;
  return { agentId: agent ?? null, limit, cursor };
}

export function signupListQueryOf(query: Readonly<Record<string, string>>): SignupListQuery {
  return pageQueryOf(query, ({ t, a, d }) =>
    typeof t !== 'string' || typeof a !== 'string' || typeof d !== 'string' || !isAgentId(a) || !DOMAIN_SHAPE.test(d) || Number.isNaN(Date.parse(t))
      ? null
      : { at: new Date(t).toISOString(), agentId: a, domain: d },
  );
}

/** 조직의 가입 감지 목록 — 마지막으로 본 것부터. 도메인 · 종류 · 시각 · 수뿐(제목 · 본문 없음). */
export async function listSignupsOp(db: Queryable, organizationId: string, query: SignupListQuery): Promise<{ items: SignupView[]; nextCursor: string | null }> {
  const result = await db.query<{
    agent_id: string;
    agent_name: string;
    service_domain: string;
    kind: SignupView['kind'];
    first_seen_at: Date;
    last_seen_at: Date;
    message_count: number;
  }>(
    `SELECT s.agent_id, a.name AS agent_name, s.service_domain, s.kind, s.first_seen_at, s.last_seen_at, s.message_count
       FROM agent_signups s JOIN agents a ON a.id = s.agent_id
      WHERE s.organization_id = $1 AND a.organization_id = $1
        AND ($2::text IS NULL OR s.agent_id = $2::bpchar)
        AND ($3::timestamptz IS NULL OR (s.last_seen_at, s.agent_id, s.service_domain) < ($3::timestamptz, $4::bpchar, $5::text))
      ORDER BY s.last_seen_at DESC, s.agent_id DESC, s.service_domain DESC
      LIMIT $6`,
    [organizationId, query.agentId, query.cursor?.at ?? null, query.cursor?.agentId ?? null, query.cursor?.domain ?? null, query.limit + 1],
  );
  const rows = result.rows.slice(0, query.limit);
  const last = rows[rows.length - 1];
  return {
    items: rows.map((row) => ({
      agentId: row.agent_id,
      agentName: row.agent_name,
      serviceDomain: row.service_domain,
      kind: row.kind,
      firstSeenAt: row.first_seen_at.toISOString(),
      lastSeenAt: row.last_seen_at.toISOString(),
      messageCount: row.message_count,
    })),
    nextCursor:
      result.rows.length > query.limit && last !== undefined
        ? Buffer.from(JSON.stringify({ t: last.last_seen_at.toISOString(), a: last.agent_id, d: last.service_domain }), 'utf8').toString('base64url')
        : null,
  };
}

export interface TrustedSendersChange extends OrgWatchSettingsView {
  readonly changed: boolean;
  readonly added: number;
  readonly removed: number;
}

export async function setTrustedSendersOp(
  db: Queryable,
  organizationId: string,
  userId: string,
  entries: readonly TrustedSender[],
): Promise<TrustedSendersChange> {
  const result = await db.query<{ outcome: string; r_added: number; r_removed: number }>(
    'SELECT outcome, r_added, r_removed FROM atmark_watch_set_trusted_senders($1, $2::text[], $3::text[], $4)',
    [organizationId, entries.map((entry) => entry.kind), entries.map((entry) => entry.value), userId],
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error('atmark_watch_set_trusted_senders 가 행을 돌려주지 않았다');
  if (row.outcome === 'too_many') throw new AdminInputError(`신뢰 발신자는 ${String(MAX_TRUSTED_SENDERS)}개까지다.`, 'too_many_trusted_senders');
  const view = await getOrgWatchSettingsOp(db, organizationId);
  return { ...view, changed: row.outcome === 'changed', added: row.r_added, removed: row.r_removed };
}

// ---------------------------------------------------------------------------
// 에이전트 설정
// ---------------------------------------------------------------------------

export interface AgentWatchSettingsView {
  readonly agentId: string;
  readonly riskHandling: RiskHandling;
  readonly riskNotify: boolean;
  /**
   * 소유자 발신 승인(ADR-0016 2026-10-08) — `auto`(엔진 판정 그대로) | `always`(허용됐을 발송도 모두 소유자 승인). 저장은 정책(`agent_policies.require_approval` ·
   * 스냅샷)이고 바꾸면 정책 새 버전이다.
   */
  readonly sendApproval: SendApproval;
  /** 위험 처리 · 알림을 한 번도 바꾸지 않았으면(기본값) null. */
  readonly updatedAt: string | null;
}

/** 호출자가 에이전트의 조직 소속을 먼저 확인했다(`requireAgentInOrganization`). */
export async function getAgentWatchSettingsOp(db: Queryable, agentId: string): Promise<AgentWatchSettingsView> {
  const result = await db.query<{ risk_handling: RiskHandling; risk_notify: boolean; updated_at: Date }>(
    'SELECT risk_handling, risk_notify, updated_at FROM agent_watch_settings WHERE agent_id = $1',
    [agentId],
  );
  const sendApproval = await sendApprovalOf(db, agentId);
  const row = result.rows[0];
  if (row === undefined) return { agentId, ...DEFAULT_AGENT_WATCH_SETTINGS, sendApproval, updatedAt: null };
  return { agentId, riskHandling: row.risk_handling, riskNotify: row.risk_notify, sendApproval, updatedAt: row.updated_at.toISOString() };
}

/** 정책 행의 발신 승인. 관문은 행 · 스냅샷 중 하나라도 참이면 always 로 읽는다 — 여기서도 같은 쪽으로(현재 버전 스냅샷과 함께). */
async function sendApprovalOf(db: Queryable, agentId: string): Promise<SendApproval> {
  const result = await db.query<{ always: boolean }>(
    `SELECT (p.require_approval OR coalesce(v.snapshot -> 'require_approval' = 'true'::jsonb, false)) AS always
       FROM agent_policies p LEFT JOIN policy_versions v ON v.agent_id = p.agent_id AND v.version = p.current_version
      WHERE p.agent_id = $1`,
    [agentId],
  );
  return result.rows[0]?.always === true ? 'always' : 'auto';
}

export interface AgentWatchPatch {
  readonly riskHandling: RiskHandling | null;
  readonly riskNotify: boolean | null;
  readonly sendApproval: SendApproval | null;
}

const AGENT_KEYS: ReadonlySet<string> = new Set(['riskHandling', 'riskNotify', 'sendApproval']);

export function agentWatchPatchOf(body: Record<string, unknown>): AgentWatchPatch {
  const unknown = Object.keys(body).find((key) => !AGENT_KEYS.has(key));
  if (unknown !== undefined) throw new AdminInputError(`모르는 키: ${unknown} (riskHandling · riskNotify · sendApproval)`, 'invalid_body');
  const handling = body['riskHandling'];
  const notify = body['riskNotify'];
  const approval = body['sendApproval'];
  if (handling !== undefined && !isRiskHandling(handling)) throw new AdminInputError('riskHandling 은 deliver | hold 다.', 'invalid_risk_handling');
  if (notify !== undefined && typeof notify !== 'boolean') throw new AdminInputError('riskNotify 는 true | false 다.', 'invalid_risk_notify');
  if (approval !== undefined && !isSendApproval(approval)) throw new AdminInputError('sendApproval 은 auto | always 다.', 'invalid_send_approval');
  if (handling === undefined && notify === undefined && approval === undefined) {
    throw new AdminInputError('riskHandling · riskNotify · sendApproval 중 하나는 있어야 한다.', 'invalid_body');
  }
  return { riskHandling: handling ?? null, riskNotify: (notify as boolean | undefined) ?? null, sendApproval: (approval as SendApproval | undefined) ?? null };
}

export interface AgentWatchChange extends AgentWatchSettingsView {
  readonly changed: boolean;
  /** 발신 승인이 바뀌었다(정책 새 버전을 썼다) — 감사 행위 이름이 `watch.send_approval.set` 이 된다. */
  readonly sendApprovalChanged: boolean;
}

/**
 * 감시 탭 에이전트 설정 한 번 — 위험 처리 · 알림(정의자 함수) + 발신 승인(정책 새 버전 — `changePolicyOp`, 같은 트랜잭션). 호출자(`audited`)의 트랜잭션 안에서
 * 부른다. 발신 승인이 지금 값과 같으면 정책 버전을 올리지 않는다(빈 버전 없음).
 */
export async function setAgentWatchOp(
  db: Pool,
  organizationId: string,
  userId: string,
  agentId: string,
  patch: AgentWatchPatch,
  actor: string,
  actorRole: MemberRole,
): Promise<AgentWatchChange> {
  // **풀기는 소유자만**(2026-10-08 리드 — 적대 검증 후속 D1-I060): 발신 승인 always → auto · 위험 처리 hold → deliver. 관리자는 조이기만 한다.
  //   위험 처리는 정의자 함수가 한 번 더 막는다(202610081103 — owner 멤버십). 발신 승인은 정책 새 버전 경로라 여기가 문이다.
  if (actorRole !== 'owner') {
    const current = await getAgentWatchSettingsOp(db, agentId);
    const loosens =
      (patch.sendApproval === 'auto' && current.sendApproval === 'always') || (patch.riskHandling === 'deliver' && current.riskHandling === 'hold');
    if (loosens) {
      throw new AdminInputError('발신 승인을 끄거나 위험 보류를 푸는 것은 소유자만 한다(관리자는 조이기만).', 'forbidden_role', 403);
    }
  }
  let sendApprovalChanged = false;
  if (patch.sendApproval !== null && (await sendApprovalOf(db, agentId)) !== patch.sendApproval) {
    await changePolicyOp(
      db,
      toAgentId(agentId),
      { outboundMode: undefined, inboundMode: undefined, perMinute: undefined, verificationSenders: undefined, requireApproval: patch.sendApproval === 'always' },
      actor,
    );
    sendApprovalChanged = true;
  }
  if (patch.riskHandling === null && patch.riskNotify === null) {
    return { ...(await getAgentWatchSettingsOp(db, agentId)), changed: sendApprovalChanged, sendApprovalChanged };
  }
  const sendApproval = await sendApprovalOf(db, agentId);
  const result = await db.query<{ outcome: string; r_risk_handling: RiskHandling | null; r_risk_notify: boolean | null; r_updated_at: Date | null }>(
    'SELECT outcome, r_risk_handling, r_risk_notify, r_updated_at FROM atmark_watch_set_agent($1, $2, $3, $4, $5)',
    [organizationId, agentId, patch.riskHandling, patch.riskNotify, userId],
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error('atmark_watch_set_agent 가 행을 돌려주지 않았다');
  if (row.outcome === 'not_found' || row.r_risk_handling === null || row.r_risk_notify === null) {
    throw new AdminInputError('에이전트가 없다.', 'agent_not_found', 404);
  }
  return {
    agentId,
    riskHandling: row.r_risk_handling,
    riskNotify: row.r_risk_notify,
    sendApproval,
    updatedAt: row.r_updated_at?.toISOString() ?? null,
    changed: row.outcome === 'changed' || sendApprovalChanged,
    sendApprovalChanged,
  };
}

// ---------------------------------------------------------------------------
// 보류 메일 — 목록 · 풀기
// ---------------------------------------------------------------------------

export interface HeldMessageView {
  readonly id: string;
  readonly agentId: string;
  readonly agentName: string;
  readonly level: InboundLevel;
  /** 왜 숨었나 — 격리(injection_risk) · 판정 없음(scanner_error) · 위험 보류(risk_hold). */
  readonly reason: 'injection_risk' | 'scanner_error' | 'risk_hold';
  readonly families: readonly RuleFamily[];
  readonly injectionRisk: InjectionRisk | null;
  readonly senderDomain: string;
  /** DMARC 인증된 From 인가 — 거짓이면 도메인은 위조일 수 있다. */
  readonly senderAuthenticated: boolean;
  readonly receivedAt: string;
  /** 풀 수 있나 — 판정 없음(scanner_error)은 풀지 않는다(fail closed). */
  readonly releasable: boolean;
}

export interface HeldListQuery {
  readonly agentId: string | null;
  readonly limit: number;
  readonly cursor: { readonly at: string; readonly id: string } | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function encodeHeldCursor(at: string, id: string): string {
  return Buffer.from(JSON.stringify({ t: at, i: id }), 'utf8').toString('base64url');
}

export function heldListQueryOf(query: Readonly<Record<string, string>>): HeldListQuery {
  return pageQueryOf(query, ({ t, i }) =>
    typeof t !== 'string' || typeof i !== 'string' || !UUID.test(i) || Number.isNaN(Date.parse(t)) ? null : { at: new Date(t).toISOString(), id: i },
  );
}

interface HeldRow {
  id: string;
  agent_id: string;
  agent_name: string;
  quarantine_reason: 'injection_risk' | 'scanner_error' | 'risk_hold';
  injection_risk: InjectionRisk | null;
  from_domain: string;
  from_authenticated: boolean;
  received_at: Date;
  findings: string[];
}

function findingOf(raw: string): { family: RuleFamily; damped: boolean } {
  const at = raw.lastIndexOf(':');
  return { family: raw.slice(0, at) as RuleFamily, damped: raw.slice(at + 1) === '1' };
}

/** 조직의 숨은 메일(격리 · 판정 없음 · 위험 보류), 최근 것부터. 정책 차단은 없다(콘솔 로그 — 정책을 고칠 일). */
export async function listHeldOp(db: Queryable, organizationId: string, query: HeldListQuery): Promise<{ items: HeldMessageView[]; nextCursor: string | null }> {
  const result = await db.query<HeldRow>(
    `SELECT m.id, m.agent_id, a.name AS agent_name, m.quarantine_reason, m.injection_risk, m.from_domain, m.from_authenticated, m.received_at,
            coalesce((SELECT array_agg(f.family || ':' || CASE WHEN f.damped THEN '1' ELSE '0' END ORDER BY f.family)
                        FROM security_findings f
                       WHERE f.inbound_message_id = m.id AND f.scanner_version = m.scanner_version), '{}') AS findings
       FROM inbound_messages m
       JOIN agents a ON a.id = m.agent_id
      WHERE a.organization_id = $1
        AND m.quarantined AND m.quarantine_reason IN ('injection_risk', 'scanner_error', 'risk_hold')
        AND ($2::text IS NULL OR m.agent_id = $2::bpchar)
        AND ($3::timestamptz IS NULL OR (m.received_at, m.id) < ($3::timestamptz, $4::uuid))
      ORDER BY m.received_at DESC, m.id DESC
      LIMIT $5`,
    [organizationId, query.agentId, query.cursor?.at ?? null, query.cursor?.id ?? null, query.limit + 1],
  );
  const rows = result.rows.slice(0, query.limit);
  const items = rows.map((row): HeldMessageView => {
    const verdict = classifyInboundLevel({
      quarantined: true,
      quarantineReason: row.quarantine_reason as QuarantineReason,
      injectionRisk: row.injection_risk,
      findings: row.findings.map(findingOf),
      trustedBypass: false,
    });
    return {
      id: row.id,
      agentId: row.agent_id,
      agentName: row.agent_name,
      level: verdict.level,
      reason: row.quarantine_reason,
      families: verdict.families,
      injectionRisk: row.injection_risk,
      senderDomain: row.from_domain,
      senderAuthenticated: row.from_authenticated,
      receivedAt: row.received_at.toISOString(),
      releasable: row.quarantine_reason !== 'scanner_error' && row.injection_risk !== null,
    };
  });
  const last = rows[rows.length - 1];
  return { items, nextCursor: result.rows.length > query.limit && last !== undefined ? encodeHeldCursor(last.received_at.toISOString(), last.id) : null };
}

export type ReleaseOutcome =
  | { readonly kind: 'not_found' | 'policy_blocked' | 'not_releasable' | 'not_held' }
  | {
      readonly kind: 'released' | 'replayed';
      readonly agentId: string;
      readonly releasedAt: Date;
      readonly releasedFrom: ReleasedFrom;
      readonly webhooks: number;
    };

export function isMessageId(value: string): boolean {
  return UUID.test(value);
}

/** 풀기 — 정의자 함수 한 번(조직 범위 · 상태 판정 · 풀기 · 웹훅). 웹훅 본문은 받을 때와 같은 빌더로 만든다(에이전트에게 같은 모양). */
export async function releaseHeldOp(db: Queryable, organizationId: string, userId: string, messageId: string): Promise<ReleaseOutcome> {
  const found = await db.query<{ agent_id: string; thread_id: string; received_at: Date }>(
    `SELECT m.agent_id, m.thread_id, m.received_at FROM inbound_messages m JOIN agents a ON a.id = m.agent_id
      WHERE m.id = $1 AND a.organization_id = $2`,
    [messageId, organizationId],
  );
  const target = found.rows[0];
  if (target === undefined) return { kind: 'not_found' };
  const event = messageReceivedEvent({ agentId: target.agent_id, inboundMessageId: messageId, threadId: target.thread_id, receivedAt: target.received_at });
  const result = await db.query<{ outcome: string; r_agent_id: string | null; r_released_at: Date | null; r_released_from: ReleasedFrom | null; r_webhooks: number }>(
    'SELECT outcome, r_agent_id, r_released_at, r_released_from, r_webhooks FROM atmark_watch_release_inbound($1, $2, $3, $4, $5)',
    [organizationId, messageId, userId, event.eventId, event.body],
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error('atmark_watch_release_inbound 가 행을 돌려주지 않았다');
  switch (row.outcome) {
    case 'released':
    case 'replayed':
      if (row.r_agent_id === null || row.r_released_at === null || row.r_released_from === null) throw new Error('풀기 결과의 칸이 비었다');
      return { kind: row.outcome, agentId: row.r_agent_id, releasedAt: row.r_released_at, releasedFrom: row.r_released_from, webhooks: row.r_webhooks };
    case 'not_found':
    case 'policy_blocked':
    case 'not_releasable':
    case 'not_held':
      return { kind: row.outcome };
    default:
      throw new Error(`atmark_watch_release_inbound: 모르는 결과 ${row.outcome}`);
  }
}
