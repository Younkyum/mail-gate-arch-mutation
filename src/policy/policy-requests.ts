/**
 * src/policy/policy-requests.ts — **에이전트의 정책 변경 요청**(ADR-0007 2026-10-13 개정 · 진윤겸 결정 A)의 순수 규칙. 입력 해석 · 지문 · 표시 문장.
 *
 * 에이전트(토큰 권한 `policy:request`)는 자기 정책의 **좁은 변경 하나**를 이유와 함께 요청할 수 있다. 요청은 아무것도 바꾸지 않는다 — 소유자가 콘솔에서
 * 승인하면 소유자 행위(관리 연산 · 감사 1행 · 새 정책 버전)로서 바뀐다(`admin/ops/policy-requests.ts`).
 *
 * **요청할 수 있는 것은 이 파일의 닫힌 어휘뿐이다:**
 *   - `add_rule` · `remove_rule` — 발신 · 수신 × 허용 · 차단 목록의 항목 하나(값은 연락처 규칙 모양 — `contact-rules.ts`, 관리 연산과 같은 검사).
 *   - `set_mode` — 발신 · 수신 모드를 콘솔 이름 넷(`all` · `allowlist` · `blocklist` · `none`) 중 하나로. 레거시 승인 모드는 고를 수 없다.
 * **요청할 수 없는 것**(칸이 없다): 긴급 정지 · 재개 · 위험 보류(ADR-0016 — 에이전트가 끌 수 있으면 인젝션의 첫 지시가 "그 설정을 꺼라" 가 된다) ·
 * 소유자 발신 승인(`always`) · 신뢰 발신자 · 토큰 · 권한 · 웹훅 · 자가 등록 · 한도 · 예산. 모르는 칸은 거부한다(조용히 버리지 않는다).
 *
 * 이유(`reason`)는 **사람이 읽는 에이전트의 글자**다 — 콘솔에만 보이고(표시 정화), 알림 메일에는 싣지 않는다(ADR-0016 "에이전트가 만든 문자열을 경고
 * 문구에 넣지 않는다").
 */

import { createHash } from 'node:crypto';

import { contactRuleKindOf, isPlatformDomainRule, normalizeContactRuleValue } from './contact-rules';
import { CONSOLE_MODES, type ConsoleMode } from './mode-names';

export type PolicyRequestAction = 'add_rule' | 'remove_rule' | 'set_mode';
export const POLICY_REQUEST_ACTIONS = ['add_rule', 'remove_rule', 'set_mode'] as const satisfies readonly PolicyRequestAction[];

export type PolicyRequestDirection = 'outbound' | 'inbound';
export type PolicyRequestList = 'allow' | 'block';

/**
 * **요청 출처 표지**(보안 감사 H-1, 2026-10-13) — 승인이 쓰는 행(`agent_contact_rules.created_by` · `policy_versions.created_by`)에
 * `<결정한 쪽> policy_request:<요청 id>` 로 남는다(`policyRequestCreatedBy`). 로더(`db/repositories/policy-source.ts`)는 이 표지가 든 발신 허용
 * 규칙을 **에이전트가 요청한 규칙**으로 읽어, 위험 보류(ADR-0016)의 "소유자가 이름으로 신뢰한 상대" 면제에서 뺀다 — 인젝션된 에이전트가 공격자 주소를
 * 요청하고 소유자가 무심코 승인해도 그 주소가 오염 맥락의 보류를 영영 비껴가지 않게. 표지가 잘못 붙는 쪽(소유자 규칙을 요청 규칙으로 읽음)은 좁히기만 한다.
 */
export const POLICY_REQUEST_PROVENANCE = 'policy_request:';

/** 승인이 쓰는 행의 `created_by` — 결정한 쪽 + 요청 표지. 콘솔 · CLI 승인이 모두 이 값을 쓴다(`decidePolicyRequestOp`). */
export function policyRequestCreatedBy(actor: string, requestId: string): string {
  return `${actor} ${POLICY_REQUEST_PROVENANCE}${requestId}`;
}

/** 요청 하나가 담는 변경 — 목록 항목(값 저장형) 또는 모드(콘솔 이름). */
export type PolicyRequestChange =
  | {
      readonly action: 'add_rule' | 'remove_rule';
      readonly direction: PolicyRequestDirection;
      readonly list: PolicyRequestList;
      readonly value: string;
    }
  | { readonly action: 'set_mode'; readonly direction: PolicyRequestDirection; readonly mode: ConsoleMode };

/** 결정 상태 — `policy_change_requests.status`. */
export type PolicyRequestStatus = 'pending' | 'approved' | 'rejected' | 'stale' | 'expired';

/** 이유 길이 상한(DB CHECK 와 같다). */
export const POLICY_REQUEST_REASON_MAX = 500;
/** 결정을 기다리는 기간 — 7일(승인 요청의 TTL 상한과 같은 결 · DB CHECK `policy_change_requests_expiry`). */
export const POLICY_REQUEST_TTL_DAYS = 7;
/** 에이전트당 24시간 요청 상한(재생은 세지 않는다 — DB 정의자 함수가 센다). */
export const POLICY_REQUESTS_PER_DAY = 20;
/** 에이전트당 결정을 기다리는 요청 상한. */
export const POLICY_REQUESTS_PENDING_MAX = 5;

const KNOWN_KEYS: ReadonlySet<string> = new Set(['action', 'direction', 'list', 'value', 'mode', 'reason']);

/** 입력 거부 — 코드는 REST 400 의 `error`, MCP 의 인자 오류 문장이 같다. */
export class PolicyRequestInputError extends Error {
  constructor(
    readonly code:
      | 'invalid_request'
      | 'invalid_action'
      | 'invalid_direction'
      | 'invalid_list'
      | 'invalid_rule_value'
      | 'rule_platform_domain'
      | 'invalid_mode'
      | 'reason_required'
      | 'reason_too_long',
    message: string,
  ) {
    super(message);
    this.name = 'PolicyRequestInputError';
  }
}

export interface ParsedPolicyRequest {
  readonly change: PolicyRequestChange;
  /** 앞뒤 공백을 걷은 이유(제어 문자 없음 · 1~500자). */
  readonly reason: string;
}

function stringField(body: Readonly<Record<string, unknown>>, key: string): string | null {
  const value = body[key];
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw new PolicyRequestInputError('invalid_request', `${key} must be a string.`);
  return value;
}

/** 본문(`{action, direction, list?, value?, mode?, reason}`) → 변경 + 이유. 틀리면 `PolicyRequestInputError`. */
export function parsePolicyRequest(body: Readonly<Record<string, unknown>>): ParsedPolicyRequest {
  const unknown = Object.keys(body).filter((key) => !KNOWN_KEYS.has(key));
  if (unknown.length > 0) {
    throw new PolicyRequestInputError(
      'invalid_request',
      `Unknown field(s): ${unknown.join(', ')}. You can only request a list entry change (action add_rule | remove_rule with direction, list, value) ` +
        'or a mode change (action set_mode with direction, mode), plus a reason.',
    );
  }
  const rawAction = stringField(body, 'action');
  if (rawAction === null || !(POLICY_REQUEST_ACTIONS as readonly string[]).includes(rawAction)) {
    throw new PolicyRequestInputError('invalid_action', 'action must be add_rule, remove_rule or set_mode.');
  }
  const action = rawAction as PolicyRequestAction;
  const direction = stringField(body, 'direction');
  if (direction !== 'outbound' && direction !== 'inbound') {
    throw new PolicyRequestInputError('invalid_direction', 'direction must be outbound or inbound.');
  }
  const reason = parseReason(stringField(body, 'reason'));
  const list = stringField(body, 'list');
  const rawValue = stringField(body, 'value');
  const mode = stringField(body, 'mode');

  if (action === 'set_mode') {
    if (list !== null || rawValue !== null) throw new PolicyRequestInputError('invalid_request', 'set_mode takes direction and mode only (no list or value).');
    if (mode === null || !(CONSOLE_MODES as readonly string[]).includes(mode)) {
      throw new PolicyRequestInputError('invalid_mode', 'mode must be all, allowlist, blocklist or none.');
    }
    return { change: { action, direction, mode: mode as ConsoleMode }, reason };
  }
  if (mode !== null) throw new PolicyRequestInputError('invalid_request', `${action} takes direction, list and value (no mode).`);
  if (list !== 'allow' && list !== 'block') throw new PolicyRequestInputError('invalid_list', 'list must be allow or block.');
  if (rawValue === null) throw new PolicyRequestInputError('invalid_rule_value', 'value is required (an email address or a domain).');
  const value = normalizeContactRuleValue(rawValue);
  const kind = contactRuleKindOf(value);
  if (kind === null) {
    throw new PolicyRequestInputError(
      'invalid_rule_value',
      'value must be an email address (name@example.com) or a domain (example.com — subdomains: *.example.com), ASCII only.',
    );
  }
  if (action === 'add_rule' && direction === 'outbound' && list === 'allow' && kind === 'domain' && isPlatformDomainRule(value)) {
    throw new PolicyRequestInputError(
      'rule_platform_domain',
      'An atmark.ai domain rule would open every agent on the platform. Request the exact address (name@atmark.ai) instead.',
    );
  }
  return { change: { action, direction, list, value }, reason };
}

/** 이유 — 필수 · 제어 문자 없음 · 앞뒤 공백 제거 뒤 1~500자. */
export function parseReason(raw: string | null): string {
  const reason = (raw ?? '').trim();
  if (reason === '') throw new PolicyRequestInputError('reason_required', 'reason is required: tell your owner, in a sentence, why you need this change.');
  if ([...reason].length > POLICY_REQUEST_REASON_MAX) {
    throw new PolicyRequestInputError('reason_too_long', `reason must be at most ${String(POLICY_REQUEST_REASON_MAX)} characters.`);
  }
  // 줄바꿈 · 탭 포함 제어 문자는 받지 않는다(DB CHECK `[[:cntrl:]]` 와 같다) — 콘솔 한 줄에 그대로 보인다.
  if (/\p{Cc}/u.test(reason)) throw new PolicyRequestInputError('invalid_request', 'reason must be a single line without control characters.');
  return reason;
}

/** 변경의 지문(sha256 hex) — 같은 변경의 pending 이 있으면 재생한다. 이유는 넣지 않는다(다시 쓴 이유로 같은 요청이 둘이 되지 않게). */
export function policyRequestHash(change: PolicyRequestChange): string {
  const canonical =
    change.action === 'set_mode'
      ? ['set_mode', change.direction, change.mode]
      : [change.action, change.direction, change.list, change.value];
  return createHash('sha256').update(JSON.stringify(canonical), 'utf8').digest('hex');
}

/** DB 행 모양(`list` · `value` · `mode` 가 NULL 가능) → 변경. 모양이 틀리면 `null`(DB CHECK 가 막으므로 생기지 않는다). */
export function policyRequestChangeOf(row: {
  readonly action: string;
  readonly direction: string;
  readonly list: string | null;
  readonly value: string | null;
  readonly mode: string | null;
}): PolicyRequestChange | null {
  if (row.direction !== 'outbound' && row.direction !== 'inbound') return null;
  if (row.action === 'set_mode') {
    if (row.mode === null || !(CONSOLE_MODES as readonly string[]).includes(row.mode)) return null;
    return { action: 'set_mode', direction: row.direction, mode: row.mode as ConsoleMode };
  }
  if ((row.action === 'add_rule' || row.action === 'remove_rule') && (row.list === 'allow' || row.list === 'block') && row.value !== null) {
    return { action: row.action, direction: row.direction, list: row.list, value: row.value };
  }
  return null;
}

/** 에이전트 표면(REST · MCP)의 변경 모양 — 입력과 같은 칸 이름. */
export function policyRequestChangeBody(change: PolicyRequestChange): Readonly<Record<string, string>> {
  return change.action === 'set_mode'
    ? { action: change.action, direction: change.direction, mode: change.mode }
    : { action: change.action, direction: change.direction, list: change.list, value: change.value };
}

/** 지금 시각으로 본 상태 — 지난 pending 은 expired 로 읽는다(만들기 함수가 다음 요청 때 행을 닫는다, 스위퍼 없음). */
export function effectivePolicyRequestStatus(status: PolicyRequestStatus, expiresAt: Date, now: Date): PolicyRequestStatus {
  return status === 'pending' && expiresAt.getTime() <= now.getTime() ? 'expired' : status;
}
