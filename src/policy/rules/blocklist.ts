/**
 * Stage 3 — 발신 차단 목록(계획 §4.2 · 정책 v2 `agent_contact_rules` outbound/block).
 *
 * **차단은 항상 allowlist·관계·승인을 이긴다**(§4.2) — 그래서 Stage 7 보다 먼저 돈다.
 * `unrestricted`(콘솔 "전체")만 목록을 읽지 않는다(계약 v2 §1 · ADR-0007). `disabled` 는 Stage 0 이 이미 막았다.
 */

import { anyContactRuleMatches } from '../contact-rules';
import { deny, type HardStageRule } from '../types';

export const evaluateBlocklist: HardStageRule = (ctx, policy) => {
  if (policy.outboundMode === 'unrestricted' || policy.blocklist.length === 0) return null;

  // 한 명이라도 걸리면 메시지 전체를 거부한다 — 조용한 부분 발송은 감사(AC-9)가 설명할 수 없다.
  // 수신자와 목록 주소 값은 둘 다 판정형(`+tag` 절단)이다 — 거부는 넓게.
  const blocked = ctx.attempt.recipients.some((recipient) => anyContactRuleMatches(policy.blocklist, recipient));

  return blocked ? deny(['recipient_blocklisted']) : null;
};
