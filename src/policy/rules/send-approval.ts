/**
 * 소유자 발신 승인(`send_approval`, ADR-0016 2026-10-08 개정). 순수 · I/O 없음.
 *
 * `agent_policies.require_approval`(스냅샷 `require_approval`) — `auto`(기본) | `always`. `always` 면 엔진이 허용했을 발송은
 * 전부 소유자 승인 대기(`owner_requires_approval`)가 된다. 바꾸는 길은 정책 새 버전뿐이다(`admin/ops/policy.ts`).
 *
 * `outbound-mode.ts` 가 `holdForRisk` 뒤 · `requireHumanApproval` 앞에서 부른다. 이 파일은 `Decision` 을 만들지 않고 무엇으로
 * 바꿀지만 말한다(승인 대기를 찍는 자리는 Stage 7 하나 — `type-discipline`).
 *
 * 규칙(좁히기만 — 속성 테스트 `test/unit/policy/send-approval.test.ts`):
 *   - `auto`, `denied`, 사람이 승인한 릴리스(grant 가 수신자 전원을 덮음) → 그대로. 다시 물으면 승인이 끝나지 않는다.
 *   - `allowed` → `pending_approval`(`bootstrap_grace` 표지만 옮긴다).
 *   - `pending_approval` → 그대로 대기, 사유 끝에 `owner_requires_approval`(위험 사유가 맨 앞에 남는다).
 *   - 레거시 `reply_only` 의 사람 없는 스레드 회신(`reply_within_thread`) → **거부**(`reply_only_owner_approval`).
 *     사람이 끼지 않는 모드라는 계약이다 — 승인을 원하면 모드를 바꾼다.
 */

import { deny, type Decision, type DecisionReason, type DenyOnly, type EvaluationContext, type NonEmptyReasons, type ResolvedPolicy } from '../types';

/** 정책 값 — 콘솔 · API 이름. */
export type SendApproval = 'auto' | 'always';

export function isSendApproval(value: unknown): value is SendApproval {
  return value === 'auto' || value === 'always';
}

export type SendApprovalVerdict =
  | { readonly kind: 'unchanged' }
  | { readonly kind: 'hold'; readonly reasons: NonEmptyReasons; readonly bootstrapGraceRemaining: number | null }
  | { readonly kind: 'deny'; readonly result: DenyOnly };

export interface SendApprovalInput {
  readonly sendApproval: SendApproval;
  readonly outboundMode: ResolvedPolicy['outboundMode'];
  /** 사람이 승인한 릴리스이고 grant 가 수신자 전원을 덮는다. */
  readonly grantCoversAll: boolean;
}

export function sendApprovalInputOf(ctx: EvaluationContext, policy: ResolvedPolicy): SendApprovalInput {
  const recipients = ctx.approval.recipients;
  const grant = ctx.approval.grant;
  return {
    sendApproval: policy.sendApproval,
    outboundMode: policy.outboundMode,
    grantCoversAll: grant !== null && recipients.length > 0 && recipients.every((r) => grant.recipients.includes(r)),
  };
}

/** 판정 하나에 소유자 발신 승인을 건다 — **좁히기만**(머리말). */
export function applySendApproval(decision: Decision, input: SendApprovalInput): SendApprovalVerdict {
  if (input.sendApproval !== 'always' || decision.verdict === 'denied' || input.grantCoversAll) return { kind: 'unchanged' };

  if (input.outboundMode === 'reply_only' && decision.verdict === 'allowed' && decision.reasons.includes('reply_within_thread')) {
    return { kind: 'deny', result: deny(['reply_only_owner_approval']) };
  }

  const reasons: DecisionReason[] =
    decision.verdict === 'pending_approval'
      ? [...decision.reasons, 'owner_requires_approval']
      : ['owner_requires_approval', ...decision.reasons.filter((reason) => reason === 'bootstrap_grace')];
  const [head, ...tail] = [...new Set<DecisionReason>(reasons)];
  return { kind: 'hold', reasons: [head ?? 'owner_requires_approval', ...tail], bootstrapGraceRemaining: decision.bootstrapGraceRemaining };
}
