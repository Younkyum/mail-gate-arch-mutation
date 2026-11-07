/**
 * 위험 보류(ADR-0016 A·B). Stage 7 의 판정을 **좁히는 방향으로만** 고친다. 순수 · I/O 없음.
 *
 * `outbound-mode.ts` `holdForRisk` 가 `evaluateMode` 뒤 · `requireHumanApproval` 앞에서 부른다. 위험 신호는 로더가 별도 포트
 * (`RiskSignalSource`)로 읽어 `ApprovalContext.riskHold` 에, DLP 계열은 발송 서비스가 `OutboundAttempt.dlp` 에 싣는다.
 * 운영자 킬 스위치 `ATMARK_RISK_HOLD_ENFORCE=observe` 면 판정을 바꾸지 않고 관문이 센다(`risk_hold.evaluated`).
 * 이 파일은 `Decision` 을 만들지 않는다 — 무엇으로 바꿀지(`RiskHoldVerdict`)만 말하고 찍는 것은 Stage 7 이다(`type-discipline`).
 *
 * 규칙(좁히기만):
 *   - `denied` → 그대로. 위험 신호는 거부를 뒤집지 않는다(억제된 상대를 사람에게 묻지 않는다 — §4.2 원칙 1).
 *   - `allowed` → 사유가 있으면 `hold`(허용 사유는 버리고 `bootstrap_grace` 표지만 옮긴다).
 *   - `pending_approval` → 사유가 있으면 `hold`, 위험 사유를 맨 앞에(승인 화면이 위험을 먼저 보인다).
 *   - `reply_only` 의 사람 없는 스레드 회신(`reply_within_thread`) + 위험 사유 → `deny`(`reply_only_risk_hold`) — 보류할 사람이 없다.
 *
 * **오염 맥락(`tainted_context`)** = 에이전트 4시간 창 · 스레드 7일 창 · 수신자 중 7일 창의 오염 발신자 — 셋 중 하나.
 * 면제는 소유자가 **이름으로** 신뢰한 경우뿐이다(수신자 전원): 정확 주소 allow 규칙 · seed · recipient 범위 standing approval · grant.
 * 도메인 규칙·자동 승인·thread/domain 범위 승인·`unrestricted`/`blocklist_only` 허용·**오염 메일 발신자 본인에게 하는 회신**은 면제가
 * 아니다(진윤겸 2026-10-02 — 공격자 도메인의 DMARC 통과는 쉽다).
 * 보안 감사 H-1(2026-10-13) — 두 가지를 더 닫는다:
 *   - **에이전트가 요청해 생긴 정확 주소 allow 규칙**(`ResolvedPolicy.agentRequestedAllowlist` — 정책 변경 요청을 소유자가 승인)은 이름으로 한 신뢰가
 *     아니다. 인젝션된 에이전트가 공격자 주소를 요청하고 소유자가 승인하면(발신이 열려 있을 때는 무해해 보인다) 그 주소가 보류를 영영 비껴갔다.
 *   - **7일 창의 오염 발신자 본인**인 수신자는 어떤 소유자 신뢰(정확 규칙 · seed · recipient 승인)로도 면제되지 않는다 — 오염 메일을 보낸 그 주소로
 *     나가는 것이 유출의 가장 짧은 길이다. grant(사람이 그 봉투를 본 릴리스)만 덮는다.
 *
 * **DLP 계열**은 grant 말고는 면제가 없다 — 신뢰한 상대라도 자격 증명·남의 비밀은 사람이 본다. 계열 자체의 제외는 `security/dlp/**`.
 * grant 가 수신자 전원을 덮는 릴리스는 손대지 않는다. 위험 보류의 승인은 `once` 다(상시 관계를 만들지 않는다).
 */

import {
  deny,
  type Decision,
  type DecisionReason,
  type DenyOnly,
  type EvaluationContext,
  type NonEmptyReasons,
  type OutboundMode,
  type ResolvedPolicy,
  type RiskHoldReason,
} from '../types';
import type { DlpFamily } from '../../security/dlp/scan';

/** DLP 계열 → 보류 사유. `Record` 라 계열이 늘면 여기서 컴파일이 멈춘다. */
export const DLP_HOLD_REASON: Readonly<Record<DlpFamily, RiskHoldReason>> = {
  atmark_credential: 'dlp_atmark_credential',
  third_party_secret: 'dlp_third_party_secret',
  verification_code: 'dlp_verification_code',
  secret_link: 'dlp_secret_link',
  inbound_copy: 'dlp_inbound_copy',
  scan_limit: 'dlp_scan_limit',
};

/**
 * 위험 보류 사유 전부(닫힌 목록) — 승인 범위(`once`)·알림·콘솔이 audit 사유로 위험 보류를 가린다.
 * DB 트리거 `approval_requests_risk_hold_once`(202610041000)가 같은 집합이다(통합 테스트가 대조).
 */
export const RISK_HOLD_REASONS: readonly RiskHoldReason[] = ['tainted_context', ...Object.values(DLP_HOLD_REASON)];

/** 위험 신호 — 창 계산은 `src/security/taint.ts`. */
export interface RiskSignals {
  /** 에이전트 4시간 창 안에 T2 노출이 있다. */
  readonly agentTainted: boolean;
  /** 이번 발송의 스레드(검증된 회신이면 그 스레드)가 7일 창 안에서 오염됐다. */
  readonly threadTainted: boolean;
  /** 7일 창의 오염 발신자(허용 비교형, 소문자). */
  readonly taintedSenders: readonly string[];
  /** 발신 DLP 결과(`scanOutbound(...).families`). */
  readonly dlp: readonly DlpFamily[];
}

/** 수신자 한 명의 면제 사실 — `riskHoldInputOf` 가 맥락에서 계산한다. */
export interface RecipientCoverage {
  readonly recipient: string;
  /** 정확 주소 allow 규칙(에이전트가 요청해 생긴 것 제외) · seed · recipient 범위 승인 중 하나(소유자가 이 주소를 이름으로 신뢰했다). */
  readonly ownerTrusted: boolean;
}

export interface RiskHoldInput {
  readonly outboundMode: OutboundMode;
  readonly signals: RiskSignals;
  readonly recipients: readonly RecipientCoverage[];
  /** 사람이 승인한 릴리스이고 grant 가 수신자 전원을 덮는다. */
  readonly grantCoversAll: boolean;
}

/** 판정을 어떻게 바꿀지. Stage 7 이 `pendingApproval`·`toDeniedDecision` 으로 찍는다. */
export type RiskHoldVerdict =
  | { readonly kind: 'unchanged' }
  | { readonly kind: 'hold'; readonly reasons: NonEmptyReasons; readonly bootstrapGraceRemaining: number | null }
  | { readonly kind: 'deny'; readonly result: DenyOnly };

/**
 * 맥락 → 입력. 면제는 Stage 7 과 같은 비교형(`ApprovalContext.recipients`)으로 계산하고, allow 규칙은 **정확 주소만** 센다 —
 * 도메인 규칙은 "이 상대를 이름으로 신뢰했다" 가 아니다.
 */
export function riskHoldInputOf(ctx: EvaluationContext, policy: ResolvedPolicy, signals: RiskSignals): RiskHoldInput {
  const recipients = ctx.approval.recipients;
  const grant = ctx.approval.grant;
  return {
    outboundMode: policy.outboundMode,
    signals,
    recipients: recipients.map((recipient) => {
      const matches = ctx.approval.relationships.filter((m) => m.recipient === recipient);
      // 정확 주소 allow 규칙 — 에이전트가 요청해 생긴 규칙은 세지 않는다(H-1). 같은 값의 소유자 규칙이 함께 있을 수 없지만(중복 거부) 있어도 좁힌다.
      const ownerTrusted =
        (policy.allowlist.some((rule) => rule.includes('@') && rule === recipient) && !policy.agentRequestedAllowlist.includes(recipient)) ||
        matches.some((m) => m.trustCategory === 'seed') ||
        matches.some((m) => m.trustCategory === 'approved' && m.scope === 'recipient');
      return { recipient, ownerTrusted };
    }),
    grantCoversAll: grant !== null && recipients.length > 0 && recipients.every((r) => grant.recipients.includes(r)),
  };
}

/** 이 시도에 걸린 위험 사유(면제 반영 뒤). 순서: `tainted_context` 먼저, 그다음 DLP 계열 순서. */
export function riskHoldReasons(input: RiskHoldInput): RiskHoldReason[] {
  const { signals } = input;
  const reasons: RiskHoldReason[] = [];
  const tainted = new Set(signals.taintedSenders.map((s) => s.toLowerCase()));

  const taintedContext =
    signals.agentTainted || signals.threadTainted || input.recipients.some((r) => tainted.has(r.recipient.toLowerCase()));
  // 수신자가 0명이면 면제도 없다(공허한 "전원" 을 열리는 쪽으로 읽지 않는다). 오염 발신자 본인은 소유자 신뢰로 면제되지 않는다(H-1).
  const ownerTrustedAll =
    input.recipients.length > 0 && input.recipients.every((r) => r.ownerTrusted && !tainted.has(r.recipient.toLowerCase()));
  if (taintedContext && !ownerTrustedAll) reasons.push('tainted_context');
  for (const family of new Set(signals.dlp)) reasons.push(DLP_HOLD_REASON[family]);
  return [...new Set(reasons)];
}

/** 판정 하나에 위험 보류를 건다 — **좁히기만**(머리말). */
export function applyRiskHold(decision: Decision, input: RiskHoldInput): RiskHoldVerdict {
  if (decision.verdict === 'denied' || input.grantCoversAll) return { kind: 'unchanged' };

  const [first, ...rest] = riskHoldReasons(input);
  if (first === undefined) return { kind: 'unchanged' };

  // reply_only 의 사람 없는 스레드 회신 — 위험 사유가 있으면 거부(보류할 사람이 없다).
  if (input.outboundMode === 'reply_only' && decision.verdict === 'allowed' && decision.reasons.includes('reply_within_thread')) {
    return { kind: 'deny', result: deny(['reply_only_risk_hold']) };
  }

  const carried: DecisionReason[] =
    decision.verdict === 'pending_approval'
      ? [...decision.reasons]
      : decision.reasons.filter((reason) => reason === 'bootstrap_grace');
  const [head, ...tail] = [...new Set<DecisionReason>([first, ...rest, ...carried])];
  return {
    kind: 'hold',
    reasons: [head ?? first, ...tail],
    bootstrapGraceRemaining: decision.bootstrapGraceRemaining,
  };
}
