/**
 * Stage 0 — kill switches(계획 §4.2). 조직·에이전트·정책 어느 층에서든 "지금 보내면 안 된다" 를 끊는다.
 * 첫 번째인 이유: 여기서 끊으면 억제·한도·예산을 **읽지도 않고** 끝나 정지된 테넌트가 다른 규칙의 버그로 샐 표면이 0이다
 * (순서의 의미는 `engine.ts` `HARD_STAGES`).
 */

import {
  BILLING_STATUSES_BLOCKING_OUTBOUND,
  denyIfAny,
  type DecisionReason,
  type HardStageRule,
} from '../types';

export const evaluateKillSwitches: HardStageRule = (ctx, policy) => {
  const reasons: DecisionReason[] = [];

  // 결제 정지·연체 — 값 목록은 schema 상수를 그대로 쓴다(상태가 늘 때 이 파일만 뒤처지지 않게).
  if ((BILLING_STATUSES_BLOCKING_OUTBOUND as readonly string[]).includes(ctx.organization.billingStatus)) {
    reasons.push('org_billing_blocked');
  }

  // abuse 알람(§5.4)이 기계적으로 켜는 조직 정지 — 어떤 정책 설정으로도 뚫리지 않는다.
  if (ctx.organization.abuseFreeze) {
    reasons.push('org_abuse_freeze');
  }

  // 소유자가 콘솔에서 건 조직 정지. 동결과 같은 강도이고 누가 푸는가만 다르다(사유 코드로 남긴다).
  if (ctx.organization.ownerPaused) {
    reasons.push('org_owner_paused');
  }

  // 셀프 가입 조직의 운영자 검토. `active` 가 아니면 거부(허용 목록 방식 — 상태가 늘어도 기본이 거부).
  if (ctx.organization.reviewStatus !== 'active') {
    reasons.push(ctx.organization.reviewStatus === 'rejected' ? 'org_review_rejected' : 'org_pending_review');
  }

  // 같은 허용 목록 방식 — `provisioning` 등 `active` 가 아닌 상태는 전부 거부.
  if (ctx.agent.status !== 'active') {
    reasons.push('agent_not_active');
  }

  // `disabled` 는 Stage 7 이 아니라 여기서 막는다 — 뒤로 미루면 그 사이 규칙이 던질 때 킬 스위치가 평가되지 않는다.
  if (policy.outboundMode === 'disabled') {
    reasons.push('outbound_disabled');
  }

  // 발신 주소의 고객 도메인(ADR-0014 결정 7). 로더가 접은 `domainGateStatusOf` 를 읽기만 한다.
  // **From 이 이 에이전트의 바인딩 주소일 때만** 건다(보안 리뷰 M2) — 그 밖은 Stage 1 이 `from_forgery` 로 판정한다.
  // 그러지 않으면 정지된 도메인의 로컬파트 위조가 도메인 제동에 가려지고, `domain_plan_limit`(transient)이면 재시도까지 된다.
  // `platform`·`verified` 는 통과 — 고객 도메인 행이 0 이면 판정이 이전과 같다.
  const fromDomain = ctx.attempt.fromAddress.slice(ctx.attempt.fromAddress.lastIndexOf('@') + 1);
  const domainGate = ctx.agent.boundAddresses.includes(ctx.attempt.fromAddress) ? ctx.agent.boundDomains.get(fromDomain) : undefined;
  if (domainGate === 'blocked') reasons.push('domain_suspended');
  else if (domainGate === 'plan_limit') reasons.push('domain_plan_limit');

  return denyIfAny(reasons);
};
