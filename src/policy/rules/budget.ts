/**
 * Stage 5 — budget(계획 §4.2). 월 예산을 넘기는 발송을 막는다.
 * 승인(Stage 7)보다 앞이다 — 예산이 소진된 메일을 사람에게 승인시킨 뒤 거부하지 않는다(§4.2 원칙 1).
 */

import { deny, type HardStageRule } from '../types';

/**
 * 센트 단위 정수 비교만 한다 — 부동소수 통화는 "1센트 차이" 의 판정을 재현 불가능하게 만든다.
 * 이번 시도 비용을 **더한 값**으로 판정한다: 초과 전 거부다(보낸 뒤 발견한 초과는 되돌릴 수 없다).
 */
export const evaluateBudget: HardStageRule = (ctx) => {
  const projected = ctx.budget.monthToDateSpentCents + ctx.budget.thisAttemptCostCents;
  return projected > ctx.budget.monthlyBudgetCents ? deny(['budget_exhausted']) : null;
};
