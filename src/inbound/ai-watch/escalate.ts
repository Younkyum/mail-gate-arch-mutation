/**
 * src/inbound/ai-watch/escalate.ts — 승격 규칙(escalation-only, 설계 §3). **순수 함수 · I/O 없음.**
 *
 * 하나라도 거짓이면 보내지 않는다:
 *   1. 킬 스위치 `ATMARK_AI_WATCH` 가 `off` 가 아니다(`shadow` 는 보내되 보류·표시하지 않는다).
 *   2. 조직이 운영자 허용 목록(`org_features` · `ai_mail_watch`)에 있다.
 *   3. 조직 소유자 토글(`organizations.ai_mail_watch_enabled`)이 켜져 있다.
 *   4. 에이전트에게 **보일** 행이다 — 격리 아님(정책 차단 · 스캐너 예외 포함) · `injection_risk ∈ {none, low}`.
 *   5. 발신자가 소유자가 이름으로 신뢰한 상대가 아니다 — DMARC 인증 + `sender_trust ∈ {seed, approved}` 면 보내지 않는다(`seen` 은 보낸다).
 *   6. 발췌문이 있다(≥ 40 코드 포인트 — `buildAiWatchExcerpt` 가 null 이 아님).
 *   7. 조직 1시간 상한(`AI_WATCH_ORG_HOURLY_CAP`) 아래다.
 *   (8. 같은 조직 × SES 메시지는 작업 하나 — 저장소의 UNIQUE 가 집행한다.)
 * 기준이 **아닌** 것: 인증 코드 여부(코드 라우트가 보류를 보지 않는다 — Q3) · 스팸 판정 · `auto_submitted`.
 *
 * 보류(`hold`)는 `on` 이고 워커가 살아 있을 때만(하트비트 5분 · draining 아님 · 자기 시험 통과) — 죽은 Mac 에 메일마다 30초를 치르지 않는다.
 *
 * ★ 이 결정은 **경고 전용 측정**의 입구다. 결과를 격리·정책·관문·승인·위험 보류에 넘기는 길은 없다(arch `ai-watch-boundary`).
 */

import type { InboundSenderTrust, InjectionRisk } from '../../db/schema';
import { AI_WATCH_ORG_HOURLY_CAP, type AiWatchMode } from './contract';

export interface EscalateInput {
  readonly mode: AiWatchMode;
  readonly org: {
    readonly featureAllowed: boolean;
    readonly ownerEnabled: boolean;
    readonly jobsLastHour: number;
  };
  readonly row: {
    /** 저장소가 쓸 격리 사유(`quarantineOf`) — null 이면 보이는 행. */
    readonly quarantined: boolean;
    /** null = 판정 없음(스캐너 예외 — 격리). */
    readonly injectionRisk: InjectionRisk | null;
    readonly fromAuthenticated: boolean;
    readonly senderTrust: InboundSenderTrust;
  };
  /** `buildAiWatchExcerpt` 의 결과. */
  readonly excerpt: string | null;
  readonly workerHealthy: boolean;
}

export type EscalateSkipReason =
  | 'mode_off'
  | 'feature_not_allowed'
  | 'owner_disabled'
  | 'not_visible'
  | 'trusted_sender'
  | 'no_content'
  | 'rate_capped';

export type EscalateDecision =
  | { readonly escalate: false; readonly reason: EscalateSkipReason }
  | { readonly escalate: true; readonly hold: boolean; readonly shadow: boolean };

const NAMED_TRUST: ReadonlySet<InboundSenderTrust> = new Set<InboundSenderTrust>(['seed', 'approved']);
const VISIBLE_RISK: ReadonlySet<InjectionRisk> = new Set<InjectionRisk>(['none', 'low']);

export function shouldEscalate(input: EscalateInput): EscalateDecision {
  if (input.mode === 'off') return { escalate: false, reason: 'mode_off' };
  if (!input.org.featureAllowed) return { escalate: false, reason: 'feature_not_allowed' };
  if (!input.org.ownerEnabled) return { escalate: false, reason: 'owner_disabled' };
  if (input.row.quarantined || input.row.injectionRisk === null || !VISIBLE_RISK.has(input.row.injectionRisk)) {
    return { escalate: false, reason: 'not_visible' };
  }
  if (input.row.fromAuthenticated && NAMED_TRUST.has(input.row.senderTrust)) return { escalate: false, reason: 'trusted_sender' };
  if (input.excerpt === null) return { escalate: false, reason: 'no_content' };
  if (input.org.jobsLastHour >= AI_WATCH_ORG_HOURLY_CAP) return { escalate: false, reason: 'rate_capped' };
  const shadow = input.mode === 'shadow';
  return { escalate: true, hold: !shadow && input.workerHealthy, shadow };
}
