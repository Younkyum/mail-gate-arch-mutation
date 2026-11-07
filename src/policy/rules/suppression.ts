/**
 * Stage 2 — suppression(계획 §4.2). 바운스·불만으로 억제된 주소와 SES 계정 수준 억제 주소로의 재발송을 막는다.
 * 억제 위반은 평판을 직접 태우고(§3.3), 어차피 거부될 메일을 사람에게 묻지 않도록 Stage 7 보다 앞이다.
 */

import { denyIfAny, type DecisionReason, type HardStageRule } from '../types';

/**
 * 조직 억제와 SES 계정 수준 억제는 **사유 코드를 나눈다** — 해소 경로가 다르다(우리 DB vs SES API).
 * 만료(`expires_at`) 판정은 로더가 `ctx.now` 기준으로 끝냈다.
 */
export const evaluateSuppression: HardStageRule = (ctx) => {
  const reasons: DecisionReason[] = [];

  if (ctx.suppressedRecipients.length > 0) reasons.push('suppression_list');
  if (ctx.sesSuppressedRecipients.length > 0) reasons.push('ses_account_level_suppression');

  return denyIfAny(reasons);
};
