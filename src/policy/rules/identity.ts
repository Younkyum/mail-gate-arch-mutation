/**
 * Stage 1 — identity binding(계획 §4.2, AC-1). 에이전트에게 묶이지 않은 주소를 `From` 으로 쓰는 것을 막는다.
 * 뒤 Stage 가 전부 "이 에이전트의" 억제·한도·예산을 보므로, 신원 확정이 모든 계정 단위 규칙보다 먼저다
 * (그러지 않으면 위조된 발신자가 남의 예산을 소진시킨다).
 */

import { deny, type HardStageRule } from '../types';

/** 주소는 로더가 정규화한 값끼리 비교한다 — 여기서 다시 소문자화하지 않는다(정규화 지점은 하나, 불일치는 거부 방향). */
export const evaluateIdentityBinding: HardStageRule = (ctx) => {
  // `from_forgery` 는 위조 시도로 취급한다(정상 경로에서 뜨지 않는다 — 알람 축, §5.4).
  // 이 에이전트의 주소지만 지금 쓸 수 없는 것(폐기된 별칭·잠든 앵커)은 `from_inactive`(위반 아님, ADR-0014 개정) —
  // 승인 대기 중 별칭이 폐기된 릴리스를 위조로 적으면 여권 `no_policy_violations` 가 플랫폼의 폐기로 깨진다.
  if (!ctx.agent.boundAddresses.includes(ctx.attempt.fromAddress)) {
    return deny([ctx.agent.inactiveAddresses.includes(ctx.attempt.fromAddress) ? 'from_inactive' : 'from_forgery']);
  }

  // 자기 자신에게 보내지 않는다 — 모든 모드("전체" 포함, 검증 L1). 목록·모드가 아니라 봉투의 사실이라 이 Stage 에 둔다.
  // 판정형끼리 비교한다(`agent+x@` 도 자기 메일함). 같은 조직의 다른 에이전트는 막지 않는다.
  const own = new Set(ctx.agent.boundAddresses);
  if (ctx.attempt.recipients.some((recipient) => own.has(recipient))) return deny(['recipient_is_self']);
  return null;
};
