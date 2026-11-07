/**
 * src/gate/ac0-commands.ts — AC-0 게이트 **기록** 명령(시작·전달 규칙·개입)의 검증과 실행. `pnpm ac0:start|forwarding|
 * intervention` 과 관리 API(`/api/gate/*`)가 **같은 함수**를 부른다 — 한쪽만 고쳐지는 날(예: 사람 메일함이
 * 에이전트 도메인인데 한 표면만 받아 주는 날)을 막는다.
 *
 * 기록 시각은 전부 DB `now()` 다(`ac0-store.ts` — 시각 인자 없음). 1일차는 **다음 KST 자정 이후**만 된다.
 */

import type { Pool } from 'pg';

import { toAgentId, type AgentId } from '../db/schema';
import { AGENT_ADDRESS_DOMAIN } from '../identity/address';
import { kstMidnightAfter, kstMidnightOf } from '../observability/ac0-metrics';
import { createAc0Gate, dbNow, listAc0Gates, recordForwarding, recordIntervention, type Ac0Gate } from './ac0-store';
import { Ac0InputError, returnDayFor, type InterventionCategory } from './ac0-verdict';

const MAILBOX = /^[^@\s<>]+@[^@\s<>]+\.[^@\s<>]+$/;

/** `atmark.ai` 또는 그 하위 도메인인가. 스키마 CHECK(`ac0_mailboxes_valid`)와 같은 모양. */
export function isAgentRootDomain(domain: string): boolean {
  return domain === AGENT_ADDRESS_DOMAIN || domain.endsWith(`.${AGENT_ADDRESS_DOMAIN}`);
}

/** 사람 메일함 — 소문자·중복 제거 · 주소 모양 · **에이전트 도메인 거부**(`ac0_mailboxes_valid` CHECK 와 같은 모양). */
export function resolveHumanMailboxes(raw: readonly string[]): string[] {
  const mailboxes = [...new Set(raw.map((value) => value.trim().toLowerCase()))].filter((value) => value !== '');
  if (mailboxes.length === 0) throw new Ac0InputError('사람 메일함이 하나 이상 필요하다(전달 규칙을 건 메일함).');
  for (const mailbox of mailboxes) {
    if (!MAILBOX.test(mailbox)) throw new Ac0InputError(`주소 모양이 아니다: ${mailbox}`);
    if (isAgentRootDomain(mailbox.split('@')[1] ?? '')) throw new Ac0InputError(`사람 메일함이 에이전트 도메인이다: ${mailbox}`);
  }
  return mailboxes;
}

export interface StartAc0GateRequest {
  readonly agentId: string | null;
  readonly organizationId: string | null;
  readonly humanMailboxes: readonly string[];
  /** KST 날짜 `YYYY-MM-DD`. 없으면 다음 KST 자정. */
  readonly day1?: string | undefined;
  /** 이미 게이트가 있어도 새로 연다(범위를 잘못 적었거나 AC-0 미성립 뒤 다시 여는 경우). */
  readonly newGate: boolean;
  /** "이미 게이트가 있다" 를 셀 범위. CLI 는 `null`(DB 전체), 관리 API 는 세션의 조직. */
  readonly existingScopeOrganizationId: string | null;
}

/**
 * 이미 게이트가 있는데 새 게이트를 요구하지 않았다. `Ac0InputError` 라 CLI 는 그대로 exit 2 + 이 문구를 낸다. 관리 API 는
 * 이 클래스를 보고 **웹 문구**(409 `gate_exists`)로 바꾼다 — CLI 명령(`pnpm ac0:restart`)을 웹 사용자에게 보이지 않게.
 */
export class Ac0GateExistsError extends Ac0InputError {
  readonly count: number;

  constructor(count: number, latestId: string) {
    super(
      `게이트가 이미 ${String(count)}개 있다(최근 ${latestId}). 다시 시작은 \`pnpm ac0:restart\`, ` +
        '범위를 잘못 적었으면 새 게이트(--new-gate).',
    );
    this.name = 'Ac0GateExistsError';
    this.count = count;
  }
}

export async function startAc0GateOp(pool: Pool, request: StartAc0GateRequest): Promise<{ gate: Ac0Gate; day1At: Date }> {
  if ((request.agentId === null) === (request.organizationId === null)) {
    throw new Ac0InputError('에이전트와 조직 중 정확히 하나를 준다.');
  }
  const mailboxes = resolveHumanMailboxes(request.humanMailboxes);
  let agentId: AgentId | null = null;
  if (request.agentId !== null) {
    try {
      agentId = toAgentId(request.agentId);
    } catch {
      throw new Ac0InputError(`에이전트 id(hex 32)가 아니다: ${request.agentId}`);
    }
  }
  const now = await dbNow(pool);
  let day1At = kstMidnightAfter(now);
  if (request.day1 !== undefined) {
    const parsed = kstMidnightOf(request.day1);
    if (parsed === null) throw new Ac0InputError(`day1 은 YYYY-MM-DD 다: ${request.day1}`);
    if (parsed.getTime() <= now.getTime()) {
      throw new Ac0InputError(`day1 ${request.day1} 은 이미 시작됐다 — 1일차는 다음 KST 자정 이후여야 한다.`);
    }
    day1At = parsed;
  }
  if (!request.newGate) {
    const existing = await listAc0Gates(pool, request.existingScopeOrganizationId);
    if (existing.length > 0) throw new Ac0GateExistsError(existing.length, existing[0]?.id ?? '?');
  }
  const gate = await createAc0Gate(pool, { agentId, organizationId: request.organizationId, humanMailboxes: mailboxes, day1At });
  return { gate, day1At };
}

export type ForwardingState = 'on' | 'off';

export function resolveForwardingState(raw: unknown): ForwardingState {
  if (raw !== 'on' && raw !== 'off') throw new Ac0InputError('전달 규칙 상태는 on | off 다.');
  return raw;
}

export async function recordForwardingOp(pool: Pool, gateId: string, state: ForwardingState): Promise<Date> {
  return recordForwarding(pool, gateId, state);
}

const INTERVENTION_CATEGORY_ALIASES: Readonly<Record<string, InterventionCategory>> = {
  주소전환: 'address_transition',
  '주소 전환': 'address_transition',
  address_transition: 'address_transition',
  에이전트: 'agent_gap',
  agent_gap: 'agent_gap',
  배달: 'deliverability',
  deliverability: 'deliverability',
  정책: 'policy_friction',
  policy_friction: 'policy_friction',
  기타: 'other',
  other: 'other',
};

export function resolveInterventionCategory(raw: unknown): InterventionCategory {
  const category = typeof raw === 'string' ? INTERVENTION_CATEGORY_ALIASES[raw.trim()] : undefined;
  if (category === undefined) throw new Ac0InputError('category 가 필요하다(주소전환|에이전트|배달|정책|기타).');
  return category;
}

/** 한 줄 메모 — 1~500자, 줄바꿈·제어문자 금지(메일 원문을 붙여 넣는 자리가 아니다). */
export function resolveInterventionReason(raw: unknown): string {
  const reason = typeof raw === 'string' ? raw.trim() : '';
  if (reason.length === 0 || reason.length > 500 || /[\u0000-\u001f\u007f]/.test(reason)) {
    throw new Ac0InputError('reason 은 1~500자 한 줄이다(줄바꿈·제어문자 금지).');
  }
  return reason;
}

export async function recordInterventionOp(
  pool: Pool,
  gateId: string,
  category: InterventionCategory,
  reason: string,
): Promise<{ recordedAt: Date; returnDay: 1 | 8 }> {
  const recordedAt = await recordIntervention(pool, gateId, category, reason);
  return { recordedAt, returnDay: returnDayFor(category) };
}
