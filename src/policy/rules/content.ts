/**
 * Stage 6 — content guards(계획 §4.2). 첨부 총량 초과, 허용 목록 밖 MIME, 시스템 절대 상한을 넘는 수신자 수를 막는다.
 * 하드 거부의 마지막(입력이 가장 크고 가장 자주 통과)이지만 Stage 7 보다는 앞이다 — 못 나갈 메일을 사람에게 승인시키지 않는다.
 */

import { denyIfAny, type DecisionReason, type HardStageRule } from '../types';

/**
 * 메시지당 수신자 **절대 상한**. Stage 4 의 `limits.recipientsPerMessage` 는 테넌트가 정하는 한도이고, 이것은 설정으로
 * 넘을 수 없는 천장이다 — 없으면 jsonb 한 줄(`recipientsPerMessage: 100000`)이 조직을 대량 발송기로 만든다.
 */
export const MAX_RECIPIENTS_PER_MESSAGE = 50;

export const evaluateContentGuards: HardStageRule = (ctx, policy) => {
  const reasons: DecisionReason[] = [];

  const totalBytes = ctx.attempt.attachments.reduce((sum, attachment) => sum + attachment.bytes, 0);
  if (totalBytes > policy.content.maxAttachmentBytesTotal) {
    reasons.push('attachment_bytes_exceeded');
  }

  // 허용 목록이다 — 목록에 없으면 거부가 기본값(fail closed). 차단 목록은 새 위험 타입을 뒤쫓는 동안 열려 있다.
  const hasDisallowedMime = ctx.attempt.attachments.some(
    (attachment) => !policy.content.allowedMimeTypes.includes(attachment.mimeType),
  );
  if (hasDisallowedMime) {
    reasons.push('mime_type_not_allowed');
  }

  if (ctx.attempt.recipients.length > MAX_RECIPIENTS_PER_MESSAGE) {
    reasons.push('recipient_ceiling_exceeded');
  }

  return denyIfAny(reasons);
};
