/**
 * Stage 7 의 위험 보류 배선(ADR-0016 M1·M2 — `rules/outbound-mode.ts` `holdForRisk`). 순수 함수 표.
 *
 *   - `riskHold === null`(릴리스 · 포트 미배선) → 판정 그대로.
 *   - 관찰(`enforce: false`) → 판정 그대로(관문이 센다).
 *   - 강제 → `allowed` 는 `pending_approval`(위험 사유 맨 앞) · `reply_only` 의 사람 없는 회신은 `reply_only_risk_hold` 거부 · `denied` 그대로.
 *   - 경로 표지(전환 공지)는 위험 사유 **앞**이다(`requireHumanApproval(holdForRisk(…))`).
 *   - DLP 계열은 시도(`attempt.dlp`)에서 온다 — 정확 주소 allow 상대여도 보류.
 *   - 킬 스위치 파서: 없음·빈 값 = enforce · 틀린 값 = enforce + invalid(fail closed).
 */

import { describe, expect, it } from 'vitest';

import { evaluateOutboundMode } from '../../../src/policy/rules/outbound-mode';
import { parseRiskHoldMode, resolveRiskHold, RISK_HOLD_MODE_DEFAULT } from '../../../src/policy/risk-signals';
import type { PolicyStamp, RiskHoldContext } from '../../../src/policy/types';
import { ALLOWED_RECIPIENT, NOW, STRANGER_RECIPIENT, contextWith, policyWith, verifiedThread } from './fixtures';

const STAMP: PolicyStamp = { policyVersion: 3, policyVersionId: 'v-3', evaluatedAt: NOW };
const TAINTED: RiskHoldContext = { enforce: true, agentTainted: true, threadTainted: false, taintedSenders: [] };
const CLEAN: RiskHoldContext = { enforce: true, agentTainted: false, threadTainted: false, taintedSenders: [] };

describe('Stage 7 위험 보류 — 강제 · 관찰 · 없음', () => {
  it('강제 + 오염 → unrestricted 허용이 승인 대기(tainted_context)', () => {
    const decision = evaluateOutboundMode(
      contextWith({ attempt: { recipients: [STRANGER_RECIPIENT] }, approval: { riskHold: TAINTED } }),
      policyWith({ outboundMode: 'unrestricted' }),
      STAMP,
    );
    expect([decision.verdict, decision.reasons]).toEqual(['pending_approval', ['tainted_context']]);
  });

  it('관찰 → 판정 그대로 · null → 판정 그대로', () => {
    for (const riskHold of [{ ...TAINTED, enforce: false }, null]) {
      const decision = evaluateOutboundMode(
        contextWith({ attempt: { recipients: [STRANGER_RECIPIENT], dlp: ['atmark_credential'] }, approval: { riskHold } }),
        policyWith({ outboundMode: 'unrestricted' }),
        STAMP,
      );
      expect([decision.verdict, decision.reasons]).toEqual(['allowed', ['unrestricted_mode']]);
    }
  });

  it('DLP 계열은 정확 주소 allow 상대에게도 보류 — 오염 없이도', () => {
    const decision = evaluateOutboundMode(
      contextWith({ attempt: { dlp: ['atmark_credential', 'inbound_copy'] }, approval: { riskHold: CLEAN } }),
      policyWith({ outboundMode: 'allowlist_only', allowlist: [ALLOWED_RECIPIENT] }),
      STAMP,
    );
    expect([decision.verdict, decision.reasons]).toEqual(['pending_approval', ['dlp_atmark_credential', 'dlp_inbound_copy']]);
  });

  it('정확 주소 allow 상대는 오염 맥락 면제 — 판정 그대로', () => {
    const decision = evaluateOutboundMode(
      contextWith({ approval: { riskHold: TAINTED } }),
      policyWith({ outboundMode: 'allowlist_only', allowlist: [ALLOWED_RECIPIENT] }),
      STAMP,
    );
    expect([decision.verdict, decision.reasons]).toEqual(['allowed', ['allowlist_match']]);
  });

  it('reply_only 의 사람 없는 스레드 회신 + 위험 → reply_only_risk_hold 거부', () => {
    const thread = verifiedThread('external');
    const decision = evaluateOutboundMode(
      contextWith({ attempt: { threadId: thread.threadId }, approval: { thread, riskHold: { ...CLEAN, threadTainted: true } } }),
      // 정확 주소 allow 규칙이 없는 상대(있으면 오염 맥락은 면제다 — 위 표).
      policyWith({ outboundMode: 'reply_only', allowlist: [] }),
      STAMP,
    );
    expect([decision.verdict, decision.reasons]).toEqual(['denied', ['reply_only_risk_hold']]);
  });

  it('denied 는 위험 신호로 바뀌지 않는다', () => {
    const decision = evaluateOutboundMode(
      contextWith({ attempt: { recipients: [STRANGER_RECIPIENT], dlp: ['atmark_credential'] }, approval: { riskHold: TAINTED } }),
      policyWith({ outboundMode: 'allowlist_only', allowlist: [ALLOWED_RECIPIENT] }),
      STAMP,
    );
    expect([decision.verdict, decision.reasons]).toEqual(['denied', ['recipient_not_allowlisted']]);
  });

  it('경로 표지(전환 공지)는 위험 사유보다 앞이다', () => {
    const decision = evaluateOutboundMode(
      contextWith({ attempt: { recipients: [STRANGER_RECIPIENT] }, approval: { riskHold: TAINTED, humanApprovalRequired: 'transition_announcement' } }),
      policyWith({ outboundMode: 'unrestricted' }),
      STAMP,
    );
    expect([decision.verdict, decision.reasons]).toEqual(['pending_approval', ['transition_announcement', 'tainted_context']]);
  });

  it('grant 가 수신자 전원을 덮는 릴리스는 손대지 않는다(로더는 릴리스에 riskHold 를 싣지 않지만, 실려도 같다)', () => {
    const decision = evaluateOutboundMode(
      contextWith({
        attempt: { recipients: [STRANGER_RECIPIENT], dlp: ['atmark_credential'] },
        approval: { riskHold: TAINTED, grant: { approvalId: 'a', recipients: [STRANGER_RECIPIENT], approvedBy: 'owner' } },
      }),
      policyWith({ outboundMode: 'approval_required' }),
      STAMP,
    );
    expect([decision.verdict, decision.reasons]).toEqual(['allowed', ['approval_granted']]);
  });
});

describe('위험 신호 — 킬 스위치 파서 · 창 해석', () => {
  it('없음·빈 값 = enforce(진윤겸 2026-10-04) · observe · 틀린 값은 enforce + invalid', () => {
    expect(RISK_HOLD_MODE_DEFAULT).toBe('enforce');
    expect(parseRiskHoldMode(undefined)).toEqual({ mode: 'enforce', invalid: false });
    expect(parseRiskHoldMode('  ')).toEqual({ mode: 'enforce', invalid: false });
    expect(parseRiskHoldMode('observe')).toEqual({ mode: 'observe', invalid: false });
    expect(parseRiskHoldMode('enforce')).toEqual({ mode: 'enforce', invalid: false });
    for (const bad of ['OBSERVE', 'off', 'false', '0']) expect(parseRiskHoldMode(bad)).toEqual({ mode: 'enforce', invalid: true });
  });

  it('창 — 에이전트 4시간 · 스레드·발신자 7일(검증된 회신 스레드가 없으면 주장된 스레드)', () => {
    const exposedAt = new Date(NOW.getTime() - 5 * 60 * 60 * 1000);
    const result = { mode: 'enforce' as const, exposures: [{ level: 'T2' as const, exposedAt, threadId: 't-1', senderAddress: 'Mallory@Evil.example' }] };
    expect(resolveRiskHold(result, 't-1', NOW)).toEqual({ enforce: true, agentTainted: false, threadTainted: true, taintedSenders: ['mallory@evil.example'] });
    expect(resolveRiskHold(result, null, NOW).threadTainted).toBe(false);
    expect(resolveRiskHold({ ...result, mode: 'observe' }, null, new Date(NOW.getTime() - 4 * 60 * 60 * 1000)).agentTainted).toBe(true);
  });
});
