/**
 * src/ops/metrics.ts — 호스팅 운영자 콘솔(ops.atmark.ai)의 **알람 수치**(`.omc/plans/ops-console.md` §3.8, 알람 #29~#36).
 *
 * 이름은 알람(`infra/cdk/stacks/observability-stack.ts`)과의 단일 진실 원천이다 — 인프라·메일러·스위퍼가 이 상수를 import 한다.
 * 네임스페이스는 기존 `METRIC_NAMESPACE`('Atmark') 그대로다.
 *
 * **차원은 닫힌 유니온 셋뿐이다**(`OPS_METRIC_DIMENSION_KEYS`): `action`(계약의 `OpsAction`) · `reason`(아래 닫힌 목록) · `code`(닫힌 실패 코드).
 * 주소 · 운영자 id · 조직 id · 세션 · 요청자 키는 **싣지 않는다**(N6 — 식별자 0). 전역 `METRIC_DIMENSION_KEYS` 를 넓히지 않으려고 이 파일이
 * 같은 EMF 한 줄(`writeLine`, 던지지 않는다)을 직접 쓴다. 빈 차원 집합(롤업)을 늘 함께 낸다 — 차원 없는 알람이 공허해지지 않게.
 */

import { writeLine } from '../observability/logger';
import { METRIC_NAMESPACE } from '../observability/metrics';
import type { OpsAction } from './contract';

export const OPS_METRIC_NAMES = {
  codeRequested: 'atmark.ops.code_requested',
  codeRateLimited: 'atmark.ops.code_rate_limited',
  /** 알람 #32(>= 20 / 15분). */
  codeInvalid: 'atmark.ops.code_invalid',
  loginOk: 'atmark.ops.login_ok',
  /** 알람 #29 — 검증 결과가 `requested` 일 때만 센다(I-9). */
  accessRequested: 'atmark.ops.access_requested',
  /** 알람 #30. */
  operatorDecided: 'atmark.ops.operator_decided',
  /** 알람 #30. */
  operatorRevoked: 'atmark.ops.operator_revoked',
  /** 알람 #33 — 차원 `action`(org.reject · P2 org.freeze_on). */
  privilegedAction: 'atmark.ops.privileged_action',
  stepUpRequired: 'atmark.ops.step_up_required',
  /** 차원 `reason`. */
  sessionRevoked: 'atmark.ops.session_revoked',
  /** 차원 `code`. */
  writeFailed: 'atmark.ops.write_failed',
  /** 알람 #36 — login-mailer 운영 워커(W-DB)가 낸다. 차원 `reason`. */
  mailerSkipped: 'atmark.ops.mailer_skipped',
  /** 알람 #31 — 스위퍼(W-DB)가 5분마다. */
  censusActive: 'atmark.ops.census_active',
  censusPending: 'atmark.ops.census_pending',
  /** 알람 #32. */
  censusAddressesFailingToday: 'atmark.ops.census_addresses_failing_today',
  /** 알람 #32. */
  censusAddressesLocked: 'atmark.ops.census_addresses_locked',
} as const;

export type OpsMetricName = (typeof OPS_METRIC_NAMES)[keyof typeof OPS_METRIC_NAMES];

/** 차원 키의 전부. */
export const OPS_METRIC_DIMENSION_KEYS = ['action', 'reason', 'code'] as const;

/** `mailer_skipped` 의 사유(§3.4 표) · `session_revoked` 의 사유. */
export const OPS_MAILER_SKIP_REASONS = ['schema', 'permission', 'config', 'placeholder', 'key_invalid'] as const;
export const OPS_SESSION_REVOKE_REASONS = ['logout', 'logout_all', 'ua_changed', 'expired', 'operator_revoked', 'step_up_failures'] as const;
export type OpsMailerSkipReason = (typeof OPS_MAILER_SKIP_REASONS)[number];
export type OpsSessionRevokeReason = (typeof OPS_SESSION_REVOKE_REASONS)[number];

/** `write_failed` 의 코드 — SQLSTATE DETAIL 코드(계약 §3.2 표) · `ticket_violation`(definer 안의 42501 — `zz_ops_require_ticket` 거부) · `internal`. */
export const OPS_WRITE_FAILURE_CODES = [
  'session_invalid',
  'step_up_required',
  'forbidden',
  'cli_operator',
  'self_decision',
  'last_operator',
  'organization_not_found',
  'agent_not_found',
  'operator_not_found',
  'invalid_transition',
  'concurrent_change',
  'not_requested',
  'rate_limited',
  'ticket_cap',
  'action_cap',
  'ops_disabled',
  'ticket_violation',
  'internal',
] as const;
export type OpsWriteFailureCode = (typeof OPS_WRITE_FAILURE_CODES)[number];

/**
 * 대기자 명단 호스팅 쓰기(202609301520) — `privileged_action` 의 `action` 차원 값(닫힌 집합). 알람 #33 은 지금 `org.reject` 만 본다 — 대량 지우기 알람은
 * 인프라(observability-stack)에서 `waitlist.remove` 차원을 더해 건다.
 */
export const OPS_WAITLIST_ACTIONS = ['waitlist.invite', 'waitlist.invite_oldest', 'waitlist.remove'] as const;
export type OpsWaitlistAction = (typeof OPS_WAITLIST_ACTIONS)[number];

export interface OpsMetricDimensions {
  readonly action?: OpsAction | OpsWaitlistAction;
  readonly reason?: OpsMailerSkipReason | OpsSessionRevokeReason;
  readonly code?: OpsWriteFailureCode;
}

const KNOWN = new Set<string>(OPS_METRIC_DIMENSION_KEYS);

/** 메트릭 한 건(EMF 한 줄). **던지지 않는다.** 어휘 밖 키 · 빈 값은 버린다. */
export function emitOpsMetric(name: OpsMetricName, value: number, dimensions: OpsMetricDimensions = {}): void {
  const present: Record<string, string> = {};
  for (const [key, raw] of Object.entries(dimensions)) {
    if (!KNOWN.has(key) || typeof raw !== 'string' || raw === '') continue;
    present[key] = raw;
  }
  const names = Object.keys(present).sort();
  let line: string;
  try {
    line = JSON.stringify({
      _aws: {
        Timestamp: Date.now(),
        CloudWatchMetrics: [{ Namespace: METRIC_NAMESPACE, Dimensions: names.length === 0 ? [[]] : [[], names], Metrics: [{ Name: name, Unit: 'Count' }] }],
      },
      ...present,
      [name]: value,
    });
  } catch {
    return;
  }
  writeLine(line);
}

export function countOpsMetric(name: OpsMetricName, dimensions: OpsMetricDimensions = {}): void {
  emitOpsMetric(name, 1, dimensions);
}
