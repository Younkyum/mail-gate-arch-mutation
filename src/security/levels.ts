/**
 * src/security/levels.ts — **받은 메일의 사용자 등급**(2026-10-08 진윤겸 결정). 순수 · 결정론 · I/O 없음.
 *
 * 스캐너 판정 · 격리 사실 · 신뢰 발신자 우회를 사람이 고르는 두 등급으로 접는다. 콘솔 '감시' 탭 · API/MCP 응답의 `risk.level` · 알림이
 * 모두 이 함수 하나를 쓴다(같은 메일이 면마다 다른 등급으로 보이지 않게).
 *
 * | 등급 | 뜻 | 기본 처리 |
 * |---|---|---|
 * | `block` (차단) | 격리 — 인젝션 위험 `medium` 이상 또는 판정 없음(스캐너 오류) | 에이전트에게 숨김 · 소유자에게 **항상** 알림 · 소유자가 풀어 줄 때까지 보류 |
 * | `risk` (위험) | 격리는 아니지만 본문 `low` 에 에이전트를 움직이는 · 숨긴 계열(서술형 지시 포함)의 완화되지 않은 적중 | 에이전트 설정: 바로 전달(읽으면 발송 승인) 또는 보류 · 알림은 소유자 선택 |
 * | `none` | 그 밖 | 그대로 |
 *
 * 정책 차단(`policy_blocked`)은 인젝션 등급이 아니다 — `none` 이고 `policyBlocked` 로 따로 드러낸다.
 * 신뢰 발신자 우회(감시 탭 — DMARC 통과 + 목록 일치)는 등급을 `none` 으로 두고 `trustedBypass` 로 드러낸다. 스캐너는 여전히 돈다(기록용).
 *
 * **위험 보류(`risk_hold`, 2026-10-08 묶음 A)** 는 에이전트 설정 `hold` 로 숨은 위험 등급 메일이다 — 숨었어도 등급은 `risk` 다(차단이 아니다).
 * **풀린 메일**(소유자가 콘솔에서 풀어 줌 — `releasedFrom`)은 보이지만 등급은 풀기 전 그대로다(`injection_risk` → block · `risk_hold` → risk).
 * 격리되지 않았는데 판정이 없거나 `medium` 이상인 행(풀린 행 말고는 DB CHECK 가 막는다)은 `block` 으로 접는다(fail closed).
 */

import type { RuleFamily } from './injection/rule-types';
import type { InjectionRisk } from './injection/scanner';
import { ACTIONABLE_FAMILIES, CONCEALED_FAMILIES } from './taint';

export type InboundLevel = 'none' | 'risk' | 'block';

export type QuarantineReason = 'injection_risk' | 'scanner_error' | 'policy_blocked' | 'risk_hold';

/** 소유자가 풀어 준 메일이 무엇에서 풀렸나(`inbound_messages.released_from`). */
export type ReleasedFrom = 'injection_risk' | 'risk_hold';

export interface LevelInput {
  readonly quarantined: boolean;
  readonly quarantineReason: QuarantineReason | null;
  /** `null` = 판정 없음. */
  readonly injectionRisk: InjectionRisk | null;
  readonly findings: readonly { readonly family: RuleFamily; readonly damped: boolean }[];
  /** 감시 탭의 신뢰 발신자 우회가 적용됐다. */
  readonly trustedBypass: boolean;
  /** 소유자가 풀어 준 메일이면 무엇에서 풀렸나. 없으면(생략 · `null`) 풀리지 않았다. */
  readonly releasedFrom?: ReleasedFrom | null;
}

export interface LevelResult {
  readonly level: InboundLevel;
  readonly policyBlocked: boolean;
  readonly trustedBypass: boolean;
  /** 등급을 만든 계열(정렬 · 중복 없음). `none` 이면 빈 배열. */
  readonly families: readonly RuleFamily[];
}

/** 위험 등급을 만드는 계열 — 오염 T2 규칙 3 과 같은 집합(서술형 지시 포함). */
export function isRiskFamily(family: RuleFamily): boolean {
  return ACTIONABLE_FAMILIES.has(family) || CONCEALED_FAMILIES.has(family);
}

export function classifyInboundLevel(input: LevelInput): LevelResult {
  const policyBlocked = input.quarantined && input.quarantineReason === 'policy_blocked';
  const undamped = [...new Set(input.findings.filter((f) => !f.damped).map((f) => f.family))].sort();
  const moving = undamped.filter(isRiskFamily);
  const released = input.releasedFrom ?? null;
  if (input.trustedBypass && !input.quarantined) {
    return { level: 'none', policyBlocked: false, trustedBypass: true, families: [] };
  }
  if (input.quarantined && input.quarantineReason === 'risk_hold') {
    return { level: 'risk', policyBlocked: false, trustedBypass: false, families: moving };
  }
  if (input.quarantined && !policyBlocked) {
    return { level: 'block', policyBlocked: false, trustedBypass: false, families: undamped };
  }
  if (!input.quarantined) {
    if (released === 'injection_risk' || input.injectionRisk === null || input.injectionRisk === 'medium' || input.injectionRisk === 'high') {
      return { level: 'block', policyBlocked: false, trustedBypass: false, families: undamped };
    }
    if (released === 'risk_hold' || (input.injectionRisk === 'low' && moving.length > 0)) {
      return { level: 'risk', policyBlocked: false, trustedBypass: false, families: moving };
    }
  }
  return { level: 'none', policyBlocked, trustedBypass: false, families: [] };
}
