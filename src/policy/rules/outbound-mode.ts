/**
 * Stage 7 — outbound_mode(계획 §4.2, §4.4, §3.1, §3.4). 하드 거부를 전부 지난 시도의 수신자 자격을 판정한다.
 * **`Decision`·`pending_approval` 을 만드는 유일한 파일이다.** 앞 Stage 가 `DenyOnly` 만 반환하므로 여기서 거부를 뒤집을 수 없고
 * (§4.2 원칙 2), 승인 판정이 하드 거부 뒤라 억제·예산 소진 메일을 사람에게 묻지 않는다(원칙 1).
 *
 * 승인은 메시지당이 아니라 **상대방당** 비용이어야 한다(§3.4) — 관계·pre-approval·grant 로 덮이지 않은 수신자가 있을 때만 묻는다.
 */

import { anyContactRuleMatches, domainOfAddress } from '../contact-rules';
import { applyRiskHold, riskHoldInputOf } from './risk-hold';
import { applySendApproval, sendApprovalInputOf } from './send-approval';
import {
  allowed,
  deny,
  pendingApproval,
  toDeniedDecision,
  UnimplementedOutboundModeError,
  type AllowReason,
  type Decision,
  type EvaluationContext,
  type NonEmptyReasons,
  type PolicyStamp,
  type ResolvedPolicy,
  type TerminalStageRule,
} from '../types';

// ---------------------------------------------------------------------------
// bootstrap_grace (§3.1 층 3)
// ---------------------------------------------------------------------------

/**
 * `reply_only` 에이전트가 생성 뒤 `approval_required` 처럼 동작하는 발송 수 상한 — "10건 또는 14일 중 먼저"(§3.1 층 3).
 * 코드 상수다(워밍업 캡과 같은 이유 — jsonb 면 감사 없이 늘어난다).
 */
export const BOOTSTRAP_GRACE_MAX_SENDS = 10;

/** grace 의 달력 상한(일). `agents.created_at` 기준. */
export const BOOTSTRAP_GRACE_DAYS = 14;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * grace 잔여 — **이 시도가 나가면 남는 수**(끝났으면 `null`). AC-a4: 9번째 시도의 audit 행과 9건 뒤 API 응답(`bootstrap_grace_remaining`)이
 * 같은 값을 싣는다 — "이 시도 포함" 이다. 14일째 정각부터, 그리고 10건 뒤부터 grace 밖이다(AC-a3).
 */
export function graceRemainingAfterAttempt(
  input: { readonly agentCreatedAt: Date; readonly outboundSentCount: number },
  now: Date,
): number | null {
  const withinDays = now.getTime() < input.agentCreatedAt.getTime() + BOOTSTRAP_GRACE_DAYS * DAY_MS;
  if (!withinDays || input.outboundSentCount >= BOOTSTRAP_GRACE_MAX_SENDS) return null;
  return BOOTSTRAP_GRACE_MAX_SENDS - input.outboundSentCount - 1;
}

// ---------------------------------------------------------------------------
// 수신자별 판정
// ---------------------------------------------------------------------------

/**
 * Stage 7 이 읽는 허용 비교형 수신자(소문자, `+tag` 보존). 판정형(`attempt.recipients`)과 길이가 다르면 던진다(관문이
 * `evaluation_error` 로 닫는다) — 특히 허용 쪽만 비면 `allowlist_only` 의 `every` 가 공허하게 참이 된다.
 */
function allowRecipientsOf(ctx: EvaluationContext): readonly string[] {
  const exact = ctx.approval.recipients;
  if (exact.length !== ctx.attempt.recipients.length) {
    throw new Error(
      `허용 판정용 수신자(${String(exact.length)})가 시도의 수신자(${String(ctx.attempt.recipients.length)})와 맞지 않는다`,
    );
  }
  return exact;
}

/**
 * 수신자 하나가 무엇으로 덮이는가(`null` = 사람에게 묻는다). 순서는 audit 사유만 바꾼다 — seed 가 먼저인 것은 AC-a2 질의가
 * `seed_relationship` 사유를 요구하기 때문이다.
 */
function coverageOf(
  recipient: string,
  ctx: EvaluationContext,
  policy: ResolvedPolicy,
): AllowReason | null {
  const matches = ctx.approval.relationships.filter((match) => match.recipient === recipient);
  if (matches.some((match) => match.trustCategory === 'seed')) return 'seed_relationship';
  if (matches.some((match) => match.trustCategory === 'approved')) return 'standing_approval';
  if (policy.preApproval.autoApproveDomains.includes(domainOfAddress(recipient))) return 'auto_approve_domain';
  // grant 는 마지막 — 관계 사유가 더 오래 산다. grant 는 이번 릴리스 한 번의 근거다.
  const grant = ctx.approval.grant;
  if (grant !== null && grant.recipients.includes(recipient)) return 'approval_granted';
  return null;
}

// ---------------------------------------------------------------------------
// 스레드 회신의 pre-approval 두 문 (§3.4 3조 · P3b 리드 결정)
// ---------------------------------------------------------------------------

/** `auto_approve_verification_senders` 의 "수신 후 24시간 이내"(§3.4 3조). 코드 상수(워밍업 캡과 같은 이유). */
export const VERIFICATION_REPLY_WINDOW_MS = 24 * 60 * 60 * 1000;

/** `sender_trust >= seen` — 격자 `blocked < unknown < seen < seed < approved` (P4). */
const TRUST_AT_LEAST_SEEN: ReadonlySet<string> = new Set(['seen', 'seed', 'approved']);

/**
 * `auto_approve_reply_within_thread` — **에이전트가 시작한 스레드에서만** 열린다(P3b). 외부 스레드에서도 열리면
 * "공격자 메일 → 에이전트 회신 → 승인 없이 발송" 이다. 에이전트가 먼저 보낸 상대는 첫 발송에서 이미 관문을 지났다.
 * 답하는 메일이 격리돼 있으면 열지 않는다(injection 의심 메일에 사람 없이 답하지 않는다).
 */
function replyWithinAgentThread(ctx: EvaluationContext, policy: ResolvedPolicy): boolean {
  const thread = ctx.approval.thread;
  return (
    policy.preApproval.autoApproveReplyWithinThread &&
    thread !== null &&
    thread.startedBy === 'agent' &&
    !thread.repliedTo.quarantined
  );
}

/**
 * `auto_approve_verification_senders`(§3.4 3조, 기본 OFF) — **외부 스레드 회신을 사람 없이 내보내는 유일한 문.**
 * 전제가 **전부** 참이어야 한다(모르면 닫힌다): 검증된 스레드 회신(로더가 DMARC 인증 수신만 `repliedTo` 로 고른다) ·
 * `injection_risk === 'none'`(`null` 은 none 이 아니다) · 격리 아님 · `sender_trust >= seen`(`null` 은 미달) ·
 * 수신 후 24시간 이내(미래 시각도 닫는다) · 수신자 전원 = 그 메일의 발신자 · 양쪽 다 첨부 없음 · 본문이 코드 회신뿐(`code_only`).
 */
function verificationSenderQualifies(ctx: EvaluationContext, policy: ResolvedPolicy): boolean {
  const thread = ctx.approval.thread;
  if (!policy.preApproval.autoApproveVerificationSenders || thread === null) return false;
  const inbound = thread.repliedTo;
  const age = ctx.now.getTime() - inbound.receivedAt.getTime();
  return (
    inbound.injectionRisk === 'none' &&
    !inbound.quarantined &&
    inbound.senderTrust !== null &&
    TRUST_AT_LEAST_SEEN.has(inbound.senderTrust) &&
    age >= 0 &&
    age <= VERIFICATION_REPLY_WINDOW_MS &&
    inbound.recipientsAreItsSender &&
    inbound.attachmentCount === 0 &&
    ctx.attempt.attachments.length === 0 &&
    ctx.attempt.contentShape === 'code_only'
  );
}

/** 중복 없이, 처음 나온 순서대로 — audit `reasons[]` 가 결정적이어야 한다. */
function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

/**
 * `approval_required` 의 판정(§4.2 Stage 7 표). `reply_only` 의 grace 도 이것을 쓴다 — 그때는 `bootstrap_grace` 를 사유 **끝에**
 * 붙인다(관측은 `reasons[0]` 만 차원에 싣는다 — 맨 앞이면 grace 기간의 판정이 한 차원으로 뭉친다).
 */
function evaluateApprovalRequired(
  ctx: EvaluationContext,
  policy: ResolvedPolicy,
  stamp: PolicyStamp,
  graceRemaining: number | null,
): Decision {
  const withGrace = (reasons: NonEmptyReasons): NonEmptyReasons =>
    graceRemaining === null ? reasons : [...reasons, 'bootstrap_grace'];

  // pre-approval ① 에이전트 스레드 내 회신 — 수신자 전원이 그 스레드의 인증 발신자임은 로더가 확인했다.
  if (replyWithinAgentThread(ctx, policy)) {
    return allowed(withGrace(['auto_approve_reply_within_thread']), stamp, graceRemaining);
  }
  // pre-approval ② 확인 메일 발신자에게의 코드 회신(기본 OFF).
  if (verificationSenderQualifies(ctx, policy)) {
    return allowed(withGrace(['auto_approve_verification_sender']), stamp, graceRemaining);
  }

  const covered: AllowReason[] = [];
  let uncovered = 0;
  for (const recipient of allowRecipientsOf(ctx)) {
    const reason = coverageOf(recipient, ctx, policy);
    if (reason === null) uncovered += 1;
    else covered.push(reason);
  }

  // 한 명이라도 덮이지 않으면 메시지 전체가 승인 대기다(부분 발송 없음 — 한 시도 = 한 행 = 한 결말).
  // 수신자 0명도 사람에게 넘긴다 — 사유 없는 허용(§5.1 불변식 ④ 위반)은 열리는 쪽이다.
  const [first, ...rest] = unique(covered);
  if (uncovered > 0 || first === undefined) {
    return pendingApproval(withGrace(['new_recipient']), stamp, graceRemaining);
  }
  return allowed(withGrace([first, ...rest]), stamp, graceRemaining);
}

/**
 * `reply_only`(§3.1 층 3, §4.1 표). 스레드 내 회신만 — grace 동안만 `approval_required` 처럼. 승인 대기 중 grace 가 끝나면
 * 릴리스 재평가도 거부된다(승인 사이에 바뀐 정책 상태를 무시하지 않는다 — grace 밖의 승인 경로는 없다).
 */
function evaluateReplyOnly(ctx: EvaluationContext, policy: ResolvedPolicy, stamp: PolicyStamp): Decision {
  // 스레드 회신은 로더가 확인한 사실이다(시도의 `threadId` 는 주장). 누가 열었는지는 묻지 않지만 격리된 메일에는 답하지 않는다.
  const thread = ctx.approval.thread;
  if (thread !== null && !thread.repliedTo.quarantined) return allowed(['reply_within_thread'], stamp);

  const remaining = graceRemainingAfterAttempt(ctx.approval.bootstrapGrace, ctx.now);
  if (remaining !== null) return evaluateApprovalRequired(ctx, policy, stamp, remaining);

  return toDeniedDecision(
    deny([thread === null ? 'reply_only_no_inbound_thread' : 'reply_only_inbound_quarantined']),
    stamp,
  );
}

/**
 * 경로의 사람 승인 필수 표지(매니페스트 `requiresHumanApproval`, §3.2 2단계 · AC-b1). 모드별 판정을 **좁히기만** 한다:
 *   - `denied` → 그대로(억제된 상대를 사람에게 묻지 않는다 — §4.2 원칙 1).
 *   - `allowed` → `pending_approval`. 허용 사유는 싣지 않는다 — `seed_relationship` 이 남으면 AC-a2 질의("seed 로 승인 없이
 *     나간 발송")에 사람이 승인한 공지가 섞인다.
 *   - `pending_approval` → 표지 사유를 맨 앞에(`reasons[0]` 이 관측 차원).
 * grant 로 풀리지 않는다 — 이 경로는 스스로 보내지 않고, 승인 뒤 발송은 표지 없는 `approval_release` 가 한다.
 * `bootstrap_grace` 표지와 잔여는 옮겨 싣는다.
 */
function requireHumanApproval(ctx: EvaluationContext, stamp: PolicyStamp, decision: Decision): Decision {
  const marker = ctx.approval.humanApprovalRequired;
  if (marker === null || decision.verdict === 'denied') return decision;

  const carried =
    decision.verdict === 'pending_approval'
      ? decision.reasons
      : decision.reasons.filter((reason) => reason === 'bootstrap_grace');
  const [, ...rest] = unique([marker, ...carried]);
  return pendingApproval([marker, ...rest], stamp, decision.bootstrapGraceRemaining);
}

/**
 * 위험 보류(ADR-0016) — 모드별 판정 뒤, 경로 표지 앞. 무엇으로 바꿀지는 `rules/risk-hold.ts`, 찍는 것은 여기다.
 * `riskHold === null`(릴리스 · 포트 미배선)이나 관찰 모드면 그대로(관찰은 관문이 센다).
 */
function holdForRisk(ctx: EvaluationContext, policy: ResolvedPolicy, stamp: PolicyStamp, decision: Decision): Decision {
  const risk = ctx.approval.riskHold;
  if (risk === null || !risk.enforce) return decision;
  const verdict = applyRiskHold(
    decision,
    riskHoldInputOf(ctx, policy, {
      agentTainted: risk.agentTainted,
      threadTainted: risk.threadTainted,
      taintedSenders: risk.taintedSenders,
      dlp: ctx.attempt.dlp,
    }),
  );
  switch (verdict.kind) {
    case 'unchanged':
      return decision;
    case 'hold':
      return pendingApproval(verdict.reasons, stamp, verdict.bootstrapGraceRemaining);
    case 'deny':
      return toDeniedDecision(verdict.result, stamp, decision.bootstrapGraceRemaining);
  }
}

/**
 * 소유자 발신 승인(`send_approval = always`) — 위험 보류 뒤, 경로 표지 앞. 무엇으로 바꿀지는 `rules/send-approval.ts`.
 * 소유자가 고른 설정이라 운영자 관찰 스위치가 없다.
 */
function holdForOwner(ctx: EvaluationContext, policy: ResolvedPolicy, stamp: PolicyStamp, decision: Decision): Decision {
  const verdict = applySendApproval(decision, sendApprovalInputOf(ctx, policy));
  switch (verdict.kind) {
    case 'unchanged':
      return decision;
    case 'hold':
      return pendingApproval(verdict.reasons, stamp, verdict.bootstrapGraceRemaining);
    case 'deny':
      return toDeniedDecision(verdict.result, stamp, decision.bootstrapGraceRemaining);
  }
}

export const evaluateOutboundMode: TerminalStageRule = (ctx, policy, stamp) =>
  requireHumanApproval(ctx, stamp, holdForOwner(ctx, policy, stamp, holdForRisk(ctx, policy, stamp, evaluateMode(ctx, policy, stamp))));

/** 모드별 판정 — 표지와 무관한 Stage 7 의 본래 표(§4.2). */
function evaluateMode(ctx: EvaluationContext, policy: ResolvedPolicy, stamp: PolicyStamp): Decision {
  switch (policy.outboundMode) {
    case 'disabled':
      // Stage 0 이 이미 막지만 방어 분기를 둔다 — Stage 0 이 약해진 날 `disabled` 가 허용으로 굴러떨어지지 않게.
      return toDeniedDecision(deny(['outbound_disabled']), stamp);

    case 'allowlist_only':
      // 콘솔 "화이트리스트"(정책 v2 기본값). 수신자 전원이 allow 목록에 있어야 한다 — 한 명이라도 밖이면 전체 거부.
      // **승인 경로가 없다** — 목록 밖은 그냥 막는다(진윤겸 결정 ①). 차단은 Stage 3 이 이미 봤다.
      return allowRecipientsOf(ctx).every((recipient) => anyContactRuleMatches(policy.allowlist, recipient))
        ? allowed(['allowlist_match'], stamp)
        : toDeniedDecision(deny(['recipient_not_allowlisted']), stamp);

    case 'blocklist_only':
      // 콘솔 "블랙리스트" — 차단 판정은 Stage 3 이 끝냈다.
      return allowed(['not_blocklisted'], stamp);

    case 'unrestricted':
      // 콘솔 "전체" — 수신자 자격만 없다. Stage 0~6 은 그대로 적용된 뒤다(계약 v2 §1).
      return allowed(['unrestricted_mode'], stamp);

    case 'approval_required':
      // 레거시(ADR-0007). 관계 있는 상대 = 허용, 없는 상대 = 사람에게 묻는다.
      return evaluateApprovalRequired(ctx, policy, stamp, null);

    case 'reply_only':
      // 레거시(ADR-0007).
      return evaluateReplyOnly(ctx, policy, stamp);

    default: {
      // 열거형이 늘면 `never` 대입이 컴파일을 깬다. 런타임 도달(DB 의 열거형 밖 값)은 예외 → fail closed.
      const exhaustive: never = policy.outboundMode;
      throw new UnimplementedOutboundModeError(exhaustive);
    }
  }
}
