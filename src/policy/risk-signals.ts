/**
 * 위험 신호 포트(ADR-0016 A) — 관문이 읽는 두 번째 데이터 출처. `PolicySource`("소유자가 정한 것 + 카운터")를 넓히지 않고
 * 따로 둔다: 섞으면 정책 소스를 바꾸는 날 위험 판정이 함께 흔들리고, 따로 끊을 수 있어야 운영자 킬 스위치가 한 자리에 선다.
 * 이 파일은 해석만 한다(순수) — 창 계산은 `security/taint.ts`, 판정은 `rules/risk-hold.ts`. `ApprovalContext.riskHold` 를 채우는
 * 프로덕션 코드는 로더 하나다(`test/arch/risk-signals.arch.test.ts`).
 */

import {
  agentTaintActive,
  taintedSenders,
  threadTaintActive,
  type TaintExposure,
} from '../security/taint';
import type { AgentId, RiskHoldContext } from './types';

/** 운영자 킬 스위치(`ATMARK_RISK_HOLD_ENFORCE`). 기본 `enforce`(진윤겸 2026-10-04). */
export type RiskHoldMode = 'observe' | 'enforce';

export const RISK_HOLD_MODES: readonly RiskHoldMode[] = ['observe', 'enforce'];

export const RISK_HOLD_ENFORCE_ENV = 'ATMARK_RISK_HOLD_ENFORCE';

export const RISK_HOLD_MODE_DEFAULT: RiskHoldMode = 'enforce';

/** 환경 값 → 모드. 비면 기본, **틀린 값은 `enforce`**(오타로 통제가 풀리지 않게) — 경고용으로 `invalid` 를 함께 돌려준다. */
export function parseRiskHoldMode(raw: string | undefined): { readonly mode: RiskHoldMode; readonly invalid: boolean } {
  const value = raw?.trim() ?? '';
  if (value === '') return { mode: RISK_HOLD_MODE_DEFAULT, invalid: false };
  if (value === 'observe' || value === 'enforce') return { mode: value, invalid: false };
  return { mode: 'enforce', invalid: true };
}

export interface RiskSignalQuery {
  readonly agentId: AgentId;
  /** 창의 기준 시각(관문의 `request.now`). */
  readonly now: Date;
}

export interface RiskSignalResult {
  readonly mode: RiskHoldMode;
  /** 창(최대 7일) 안의 T2 노출. 소스는 넓게 읽어도 된다(창 판정은 다시 한다). */
  readonly exposures: readonly TaintExposure[];
}

/** 위험 신호의 출처(운영 `db/repositories/risk-signal-store.ts`). 읽지 못하면 던진다 — 관문이 `evaluation_error` 로 닫는다. */
export interface RiskSignalSource {
  load(query: RiskSignalQuery): Promise<RiskSignalResult>;
}

/**
 * 소스 결과 → Stage 7 이 읽는 사실. `threadId` 는 검증된 회신 스레드, 없으면 주장된 스레드(좁히는 방향이라 주장도 센다).
 * `pinnedTaint`(예약 때 고정된 오염 — 리뷰 H1)면 에이전트 창이 열린 것으로 친다.
 */
export function resolveRiskHold(result: RiskSignalResult, threadId: string | null, now: Date, pinnedTaint = false): RiskHoldContext {
  return {
    enforce: result.mode === 'enforce',
    agentTainted: pinnedTaint || agentTaintActive(result.exposures, now),
    threadTainted: threadTaintActive(result.exposures, threadId, now),
    taintedSenders: taintedSenders(result.exposures, now),
  };
}
