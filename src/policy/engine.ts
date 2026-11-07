/**
 * 정책 평가의 순수 함수(계획 §4.2). **I/O 가 없다** — 조회는 전부 `policy-loader.ts` 가 미리 해 `ctx` 에 담는다.
 * 그래야 전수 테이블 테스트(§5.1)가 DB 없이 돈다. Stage 순서는 `HARD_STAGES` 배열 한 곳에만 둔다.
 */

import { evaluateBlocklist } from './rules/blocklist';
import { evaluateBudget } from './rules/budget';
import { evaluateContentGuards } from './rules/content';
import { evaluateIdentityBinding } from './rules/identity';
import { evaluateKillSwitches } from './rules/kill-switch';
import { evaluateLimits } from './rules/limits';
import { evaluateOutboundMode } from './rules/outbound-mode';
import { evaluateSuppression } from './rules/suppression';
import {
  toDeniedDecision,
  type Decision,
  type EvaluationContext,
  type HardStageRule,
  type PolicyStamp,
  type ResolvedPolicy,
} from './types';

/** Stage 0~6 의 이름과 규칙. 이름은 로그·테스트·문서가 공유하는 어휘다. */
export interface HardStage {
  readonly index: 0 | 1 | 2 | 3 | 4 | 5 | 6;
  readonly name: string;
  readonly run: HardStageRule;
}

/**
 * 하드 거부 단계 — 원소 타입(`HardStageRule`)이 `DenyOnly` 만 반환하므로, 재정렬·삽입해도
 * "후단 규칙은 선행 거부를 넓힐 수 없다"(§4.2 원칙 2)가 구조적으로 유지된다.
 *
 * **순서는 결과(허용/거부)가 아니라 "무엇이 평가되는가" 를 정한다** — 첫 거부에서 멈추므로 앞 Stage 가
 * 뒤 Stage 의 평가 자체를 막는다. 신원(1)이 뒤에 있으면 위조된 발신자로 남의 한도·예산을 조회하고,
 * 킬 스위치(0)가 뒤에 있으면 그 사이 규칙이 던질 때 스위치가 평가되지 않은 채 예외로 빠진다.
 */
export const HARD_STAGES: readonly HardStage[] = [
  { index: 0, name: 'kill_switch', run: evaluateKillSwitches },
  { index: 1, name: 'identity_binding', run: evaluateIdentityBinding },
  { index: 2, name: 'suppression', run: evaluateSuppression },
  { index: 3, name: 'blocklist', run: evaluateBlocklist },
  { index: 4, name: 'limits', run: evaluateLimits },
  { index: 5, name: 'budget', run: evaluateBudget },
  { index: 6, name: 'content_guards', run: evaluateContentGuards },
];

/**
 * 정책 평가(§4.2 Stage 0~8). **첫 거부에서 멈춘다** — 사유를 모으려면 뒤 Stage 가 이미 거부된
 * 비정상 입력(예: 위조된 `from` 의 한도)을 평가해야 한다. 끊으면 뒤 Stage 는 신원·킬 스위치가 확정된 입력만 본다.
 *
 * 예외를 잡지 않는다 — `gate.ts` 가 `denied` + `evaluation_error` 로 바꾼다. 여기서 잡으면 엔진 버그가 정상 거부처럼 보인다.
 */
export function evaluate(ctx: EvaluationContext, policy: ResolvedPolicy): Decision {
  const stamp: PolicyStamp = {
    policyVersion: policy.version,
    policyVersionId: policy.versionId,
    evaluatedAt: ctx.now,
  };

  for (const stage of HARD_STAGES) {
    const result = stage.run(ctx, policy);
    // `null` 은 허용이 아니라 "거부 사유 없음" — 허용을 만드는 자리는 아래 한 줄뿐이다.
    if (result !== null) return toDeniedDecision(result, stamp);
  }

  // `Decision` 으로 승격하는 유일한 경로 — Stage 7 이 허용·거부·승인대기를 확정한다.
  return evaluateOutboundMode(ctx, policy, stamp);
}
