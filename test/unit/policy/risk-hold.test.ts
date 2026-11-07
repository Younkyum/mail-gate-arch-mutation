/**
 * 위험 보류(`src/policy/rules/risk-hold.ts`, ADR-0016) — **좁히기만** 한다.
 *
 *   ① 속성: 무작위 판정·입력 수천 개에서 결과는 원래보다 관대하지 않다(allowed > pending_approval > denied). denied 는 그대로.
 *      신호를 더하면 결과가 더 관대해지지 않는다(단조).
 *   ② 표: 모드별 동작(allowlist_only 정확 주소 ≈ 변화 없음 · reply_only 위험 신호 → 거부) · 면제(정확 주소 allow · seed · recipient 범위 승인 ·
 *      grant) · 면제 아님(도메인 allow 규칙 · 스레드 자동 승인 · 도메인 자동 승인 · domain/thread 범위 승인 · unrestricted ·
 *      **오염 메일의 발신자 본인에게 회신** — 진윤겸 2026-10-02 "항상 승인").
 *
 * M0 — 아직 `evaluateOutboundMode` 에 배선하지 않았다. 여기서는 Stage 7 의 실제 판정 위에 이 함수를 손으로 얹어 본다.
 */

import { describe, expect, it } from 'vitest';

import { evaluateOutboundMode } from '../../../src/policy/rules/outbound-mode';
import {
  DLP_HOLD_REASON,
  applyRiskHold,
  riskHoldInputOf,
  riskHoldReasons,
  type RiskHoldInput,
  type RiskHoldVerdict,
  type RiskSignals,
} from '../../../src/policy/rules/risk-hold';
import {
  allowed,
  deny,
  pendingApproval,
  toDeniedDecision,
  type AuditDecision,
  type Decision,
  type DecisionReason,
  type NonEmptyReasons,
  type OutboundMode,
  type PolicyStamp,
} from '../../../src/policy/types';
import { DLP_FAMILIES, type DlpFamily } from '../../../src/security/dlp/scan';
import { ALLOWED_RECIPIENT, NOW, STRANGER_RECIPIENT, contextWith, policyWith, verifiedThread } from './fixtures';

const STAMP: PolicyStamp = { policyVersion: 3, policyVersionId: 'v-3', evaluatedAt: NOW };
const CLEAN: RiskSignals = { agentTainted: false, threadTainted: false, taintedSenders: [], dlp: [] };
const TAINTED: RiskSignals = { ...CLEAN, agentTainted: true };
const MODES: readonly OutboundMode[] = ['disabled', 'allowlist_only', 'blocklist_only', 'unrestricted', 'approval_required', 'reply_only'];

const RANK: Readonly<Record<AuditDecision, number>> = { allowed: 2, pending_approval: 1, denied: 0 };

function verdictOf(decision: Decision, outcome: RiskHoldVerdict): AuditDecision {
  if (outcome.kind === 'unchanged') return decision.verdict;
  return outcome.kind === 'hold' ? 'pending_approval' : 'denied';
}

// ---------------------------------------------------------------------------
// ① 속성
// ---------------------------------------------------------------------------

/** 결정적 PRNG(mulberry32) — 실패가 재현되게 씨앗을 고정한다. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ALLOW_REASONS: readonly DecisionReason[] = ['allowlist_match', 'unrestricted_mode', 'not_blocklisted', 'seed_relationship', 'standing_approval', 'auto_approve_reply_within_thread', 'auto_approve_domain', 'approval_granted', 'reply_within_thread'];
const PENDING_REASONS: readonly DecisionReason[] = ['new_recipient', 'transition_announcement'];
const DENY_REASONS: readonly DecisionReason[] = ['recipient_blocklisted', 'suppression_list', 'rate_limit_per_minute', 'recipient_not_allowlisted', 'reply_only_no_inbound_thread', 'outbound_disabled'];

function randomCase(rand: () => number): { decision: Decision; input: RiskHoldInput } {
  const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)] as T;
  const some = <T,>(xs: readonly T[]): T[] => xs.filter(() => rand() < 0.3);
  const grace = rand() < 0.3;
  const reasonsOf = (pool: readonly DecisionReason[]): NonEmptyReasons => {
    const list = [pick(pool), ...some(pool)];
    return (grace ? [...list, 'bootstrap_grace'] : list) as unknown as NonEmptyReasons;
  };
  const kind = pick(['allowed', 'pending', 'denied'] as const);
  const decision =
    kind === 'allowed'
      ? allowed(reasonsOf(ALLOW_REASONS), STAMP, grace ? 3 : null)
      : kind === 'pending'
        ? pendingApproval(reasonsOf(PENDING_REASONS), STAMP, grace ? 3 : null)
        : toDeniedDecision(deny(reasonsOf(DENY_REASONS)), STAMP);
  const addresses = ['a@x.example', 'b@y.example', 'c@z.example'];
  const recipients = some(addresses);
  const input: RiskHoldInput = {
    outboundMode: pick(MODES),
    signals: {
      agentTainted: rand() < 0.4,
      threadTainted: rand() < 0.4,
      taintedSenders: some(addresses),
      dlp: some(DLP_FAMILIES),
    },
    recipients: recipients.map((recipient) => ({ recipient, ownerTrusted: rand() < 0.4 })),
    grantCoversAll: rand() < 0.15,
  };
  return { decision, input };
}

describe('① 속성 — 좁히기만 한다', () => {
  const rand = prng(20261002);
  const cases = Array.from({ length: 5_000 }, () => randomCase(rand));

  it('결과는 원래 판정보다 관대하지 않다', () => {
    for (const { decision, input } of cases) {
      const outcome = applyRiskHold(decision, input);
      expect(RANK[verdictOf(decision, outcome)]).toBeLessThanOrEqual(RANK[decision.verdict]);
    }
  });

  it('denied 는 언제나 그대로다', () => {
    for (const { decision, input } of cases.filter((c) => c.decision.verdict === 'denied')) {
      expect(applyRiskHold(decision, input)).toEqual({ kind: 'unchanged' });
    }
  });

  it('보류 사유에는 허용 사유가 없다 · bootstrap 잔여를 옮긴다 · 위험 사유가 맨 앞이다', () => {
    let holds = 0;
    for (const { decision, input } of cases) {
      const outcome = applyRiskHold(decision, input);
      if (outcome.kind !== 'hold') continue;
      holds += 1;
      for (const reason of outcome.reasons) expect(ALLOW_REASONS).not.toContain(reason);
      expect(outcome.bootstrapGraceRemaining).toBe(decision.bootstrapGraceRemaining);
      expect(riskHoldReasons(input)).toContain(outcome.reasons[0]);
    }
    expect(holds).toBeGreaterThan(500); // 비공허성
  });

  it('단조 — DLP 계열·오염 신호를 더하면 더 관대해지지 않는다', () => {
    for (const { decision, input } of cases) {
      const before = RANK[verdictOf(decision, applyRiskHold(decision, input))];
      const more: RiskHoldInput = {
        ...input,
        signals: { ...input.signals, agentTainted: true, threadTainted: true, dlp: [...input.signals.dlp, 'atmark_credential'] },
      };
      expect(RANK[verdictOf(decision, applyRiskHold(decision, more))]).toBeLessThanOrEqual(before);
    }
  });

  it('신호가 없으면 아무것도 바꾸지 않는다', () => {
    for (const { decision, input } of cases) {
      expect(applyRiskHold(decision, { ...input, signals: CLEAN })).toEqual({ kind: 'unchanged' });
    }
  });
});

// ---------------------------------------------------------------------------
// ② Stage 7 의 실제 판정 위에서 — 모드 · 면제
// ---------------------------------------------------------------------------

/** Stage 7 판정 + 위험 보류(M1 이 할 배선을 손으로). */
function judge(
  mode: OutboundMode,
  signals: RiskSignals,
  ctxOverrides: Parameters<typeof contextWith>[0] = {},
  policyOverrides: Parameters<typeof policyWith>[0] = {},
): { decision: Decision; outcome: RiskHoldVerdict } {
  const ctx = contextWith(ctxOverrides);
  const policy = policyWith({ outboundMode: mode, ...policyOverrides });
  const decision = evaluateOutboundMode(ctx, policy, STAMP);
  return { decision, outcome: applyRiskHold(decision, riskHoldInputOf(ctx, policy, signals)) };
}

describe('② 모드별 동작', () => {
  it('allowlist_only — 목록 안 수신자는 오염 맥락으로 바뀌지 않는다(사실상 변화 없음) · 목록 밖은 원래 거부', () => {
    expect(judge('allowlist_only', TAINTED).outcome).toEqual({ kind: 'unchanged' });
    const outside = judge('allowlist_only', TAINTED, { attempt: { recipients: [STRANGER_RECIPIENT] } });
    expect(outside.decision.verdict).toBe('denied');
    expect(outside.outcome).toEqual({ kind: 'unchanged' });
  });

  it('allowlist_only 의 도메인 규칙 상대는 면제가 아니다 — 오염 창이면 보류', () => {
    const { decision, outcome } = judge('allowlist_only', TAINTED, {}, { allowlist: ['example.com'] });
    expect(decision.reasons).toEqual(['allowlist_match']);
    expect(outcome).toEqual({ kind: 'hold', reasons: ['tainted_context'], bootstrapGraceRemaining: null });
  });

  it('allowlist_only 라도 DLP 자격 증명은 사람에게 간다(값 없이 사유만)', () => {
    const { outcome } = judge('allowlist_only', { ...CLEAN, dlp: ['atmark_credential'] });
    expect(outcome).toEqual({ kind: 'hold', reasons: ['dlp_atmark_credential'], bootstrapGraceRemaining: null });
  });

  it.each(['unrestricted', 'blocklist_only'] as const)('%s — 오염 맥락이면 보류(허용 사유는 싣지 않는다)', (mode) => {
    const { decision, outcome } = judge(mode, TAINTED, { attempt: { recipients: [STRANGER_RECIPIENT] } });
    expect(decision.verdict).toBe('allowed');
    expect(outcome).toEqual({ kind: 'hold', reasons: ['tainted_context'], bootstrapGraceRemaining: null });
  });

  it('disabled — 원래 거부, 그대로', () => {
    expect(judge('disabled', TAINTED).outcome).toEqual({ kind: 'unchanged' });
  });

  it('approval_required — 이미 승인 대기면 위험 사유를 맨 앞에 붙인다', () => {
    const { decision, outcome } = judge('approval_required', { ...TAINTED, dlp: ['verification_code'] }, { attempt: { recipients: [STRANGER_RECIPIENT] } });
    expect(decision.verdict).toBe('pending_approval');
    expect(outcome).toEqual({ kind: 'hold', reasons: ['tainted_context', 'dlp_verification_code', 'new_recipient'], bootstrapGraceRemaining: null });
  });

  describe('reply_only — 사람 없는 스레드 회신에 위험 신호가 있으면 거부(reply_only_risk_hold)', () => {
    const ctx = { attempt: { recipients: [STRANGER_RECIPIENT] }, approval: { thread: verifiedThread('external') } };
    it.each<[string, RiskSignals]>([
      ['오염 스레드', { ...CLEAN, threadTainted: true }],
      ['깨끗한 스레드 · 에이전트 창만', TAINTED],
      ['깨끗한 스레드 · DLP 만', { ...CLEAN, dlp: ['verification_code'] }],
      ['수신자가 오염 발신자', { ...CLEAN, taintedSenders: [STRANGER_RECIPIENT] }],
    ])('%s', (_name, signals) => {
      const { decision, outcome } = judge('reply_only', signals, ctx);
      expect(decision.reasons).toEqual(['reply_within_thread']);
      expect(outcome).toEqual({ kind: 'deny', result: deny(['reply_only_risk_hold']) });
    });

    it('깨끗하면 그대로', () => {
      expect(judge('reply_only', CLEAN, ctx).outcome).toEqual({ kind: 'unchanged' });
    });

    it('seed 상대 회신이면 오염 맥락은 면제되고 그대로 · DLP 는 거부', () => {
      const seeded = { ...ctx, approval: { ...ctx.approval, relationships: [{ recipient: STRANGER_RECIPIENT, trustCategory: 'seed' as const, scope: 'recipient' as const }] } };
      expect(judge('reply_only', TAINTED, seeded).outcome).toEqual({ kind: 'unchanged' });
      expect(judge('reply_only', { ...CLEAN, dlp: ['third_party_secret'] }, seeded).outcome).toMatchObject({ kind: 'deny' });
    });
  });

  it('reply_only grace(approval_required 처럼) — bootstrap_grace 표지와 잔여를 옮긴다', () => {
    const { decision, outcome } = judge('reply_only', TAINTED, {
      attempt: { recipients: [ALLOWED_RECIPIENT] },
      approval: { relationships: [{ recipient: ALLOWED_RECIPIENT, trustCategory: 'approved', scope: 'domain' }] },
    }, { allowlist: [] });
    expect(decision.verdict).toBe('allowed');
    expect(decision.reasons).toContain('bootstrap_grace');
    expect(outcome).toEqual({ kind: 'hold', reasons: ['tainted_context', 'bootstrap_grace'], bootstrapGraceRemaining: decision.bootstrapGraceRemaining });
  });
});

describe('② 면제', () => {
  const stranger = { attempt: { recipients: [STRANGER_RECIPIENT] } } as const;

  it('정확 주소 allow 규칙 — unrestricted 에서도 그 수신자는 오염 맥락 면제', () => {
    expect(judge('unrestricted', TAINTED, {}, { allowlist: [ALLOWED_RECIPIENT] }).outcome).toEqual({ kind: 'unchanged' });
  });

  it.each(['example.com', '*.com'])('도메인 allow 규칙(%s)은 면제가 아니다', (rule) => {
    expect(judge('unrestricted', TAINTED, {}, { allowlist: [rule] }).outcome).toMatchObject({ kind: 'hold', reasons: ['tainted_context'] });
  });

  it('seed · recipient 범위 승인 — 면제', () => {
    const seed = { ...stranger, approval: { relationships: [{ recipient: STRANGER_RECIPIENT, trustCategory: 'seed' as const, scope: 'recipient' as const }] } };
    const standing = { ...stranger, approval: { relationships: [{ recipient: STRANGER_RECIPIENT, trustCategory: 'approved' as const, scope: 'recipient' as const }] } };
    expect(judge('approval_required', TAINTED, seed).outcome).toEqual({ kind: 'unchanged' });
    expect(judge('approval_required', TAINTED, standing).outcome).toEqual({ kind: 'unchanged' });
  });

  it.each(['domain', 'thread'] as const)('%s 범위 승인은 면제가 아니다', (scope) => {
    const ctx = { ...stranger, approval: { relationships: [{ recipient: STRANGER_RECIPIENT, trustCategory: 'approved' as const, scope }] } };
    const { decision, outcome } = judge('approval_required', TAINTED, ctx);
    expect(decision.verdict).toBe('allowed');
    expect(outcome).toMatchObject({ kind: 'hold', reasons: ['tainted_context'] });
  });

  it('도메인 자동 승인 · 에이전트 스레드 자동 승인은 면제가 아니다', () => {
    const domain = judge('approval_required', TAINTED, stranger, { preApproval: { autoApproveDomains: ['example.com'] } });
    expect(domain.decision.reasons).toEqual(['auto_approve_domain']);
    expect(domain.outcome).toMatchObject({ kind: 'hold', reasons: ['tainted_context'] });
    const thread = judge('approval_required', TAINTED, { ...stranger, approval: { thread: verifiedThread('agent') } });
    expect(thread.decision.reasons).toEqual(['auto_approve_reply_within_thread']);
    expect(thread.outcome).toMatchObject({ kind: 'hold', reasons: ['tainted_context'] });
  });

  it('면제는 수신자 **전원**일 때만 — 하나라도 덮이지 않으면 보류', () => {
    const { outcome } = judge('unrestricted', TAINTED, { attempt: { recipients: [ALLOWED_RECIPIENT, STRANGER_RECIPIENT] } }, { allowlist: [ALLOWED_RECIPIENT] });
    expect(outcome).toMatchObject({ kind: 'hold', reasons: ['tainted_context'] });
  });

  it('소유자가 신뢰한 상대라도 DLP 는 면제되지 않는다', () => {
    const { outcome } = judge('unrestricted', { ...TAINTED, dlp: ['third_party_secret'] }, {}, { allowlist: [ALLOWED_RECIPIENT] });
    expect(outcome).toEqual({ kind: 'hold', reasons: ['dlp_third_party_secret'], bootstrapGraceRemaining: null });
  });

  describe('오염 메일의 발신자 본인에게 회신 — 면제 없음(진윤겸 2026-10-02 "항상 승인")', () => {
    const reply = { ...stranger, approval: { thread: verifiedThread('external') } };
    const source: RiskSignals = { ...TAINTED, threadTainted: true, taintedSenders: [STRANGER_RECIPIENT] };

    it('DLP 가 깨끗해도 보류', () => {
      expect(judge('unrestricted', source, reply).outcome).toEqual({ kind: 'hold', reasons: ['tainted_context'], bootstrapGraceRemaining: null });
    });

    it('리뷰 프로브 회귀 — 오염 + 공격자(인증된 원 발신자)에게 회신 → 보류', () => {
      const attacker = 'attacker@evil.example';
      const probe = { attempt: { recipients: [attacker] }, approval: { thread: verifiedThread('external') } };
      const signals: RiskSignals = { agentTainted: true, threadTainted: true, taintedSenders: [attacker], dlp: [] };
      for (const mode of ['unrestricted', 'blocklist_only', 'approval_required'] as const) {
        const { decision, outcome } = judge(mode, signals, probe, { allowlist: [] });
        expect(RANK[verdictOf(decision, outcome)], mode).toBeLessThanOrEqual(RANK.pending_approval);
        expect(outcome, mode).toMatchObject({ kind: 'hold', reasons: expect.arrayContaining(['tainted_context']) as unknown });
      }
    });

    it('DLP 적중이면 위험 사유 둘', () => {
      expect(judge('unrestricted', { ...source, dlp: ['inbound_copy'] }, reply).outcome).toMatchObject({
        kind: 'hold',
        reasons: ['tainted_context', 'dlp_inbound_copy'],
      });
    });
  });

  it('오염 발신자에게 보내기 — 에이전트 창이 지나도 7일 동안 보류', () => {
    const { outcome } = judge('unrestricted', { ...CLEAN, taintedSenders: [STRANGER_RECIPIENT] }, stranger);
    expect(outcome).toMatchObject({ kind: 'hold', reasons: ['tainted_context'] });
  });

  it('사람이 승인한 릴리스(grant 가 전원을 덮음) — 손대지 않는다', () => {
    const ctx = { ...stranger, approval: { grant: { approvalId: 'ap-1', recipients: [STRANGER_RECIPIENT], approvedBy: 'owner' } } };
    const { decision, outcome } = judge('approval_required', { ...TAINTED, dlp: ['atmark_credential'] }, ctx);
    expect(decision.reasons).toEqual(['approval_granted']);
    expect(outcome).toEqual({ kind: 'unchanged' });
  });

  describe('보안 감사 H-1 — 에이전트가 요청한 allow 규칙 · 오염 발신자 본인', () => {
    it('★ 정책 변경 요청으로 생긴 정확 주소 allow 규칙은 면제가 아니다 — 오염 맥락이면 보류(unrestricted · allowlist_only)', () => {
      for (const mode of ['unrestricted', 'allowlist_only', 'blocklist_only'] as const) {
        const { decision, outcome } = judge(mode, TAINTED, {}, { allowlist: [ALLOWED_RECIPIENT], agentRequestedAllowlist: [ALLOWED_RECIPIENT] });
        expect(decision.verdict, mode).toBe('allowed');
        expect(outcome, mode).toEqual({ kind: 'hold', reasons: ['tainted_context'], bootstrapGraceRemaining: null });
      }
    });

    it('★ 요청 규칙 상대 = 오염 메일의 발신자(공격자 회신 경로) → 보류', () => {
      const attacker = 'attacker@evil.example';
      const ctx = { attempt: { recipients: [attacker] }, approval: { thread: verifiedThread('external') } };
      const signals: RiskSignals = { ...CLEAN, taintedSenders: [attacker] };
      const { outcome } = judge('allowlist_only', signals, ctx, { allowlist: [attacker], agentRequestedAllowlist: [attacker] });
      expect(outcome).toMatchObject({ kind: 'hold', reasons: ['tainted_context'] });
    });

    it('★ 소유자가 이름으로 넣은 규칙이라도 수신자가 오염 발신자 본인이면 면제가 아니다(seed · recipient 승인도)', () => {
      const attacker = 'attacker@evil.example';
      const signals: RiskSignals = { ...CLEAN, taintedSenders: [attacker] };
      const to = { attempt: { recipients: [attacker] } };
      expect(judge('allowlist_only', signals, to, { allowlist: [attacker] }).outcome).toMatchObject({ kind: 'hold', reasons: ['tainted_context'] });
      const seeded = { ...to, approval: { relationships: [{ recipient: attacker, trustCategory: 'seed' as const, scope: 'recipient' as const }] } };
      expect(judge('approval_required', signals, seeded).outcome).toMatchObject({ kind: 'hold', reasons: ['tainted_context'] });
      // 오염 발신자가 아닌 소유자 규칙 상대는 그대로 면제(회귀 없음).
      expect(judge('allowlist_only', TAINTED, {}, { allowlist: [ALLOWED_RECIPIENT] }).outcome).toEqual({ kind: 'unchanged' });
    });

    it('요청 규칙 목록에 다른 주소만 있으면 소유자 규칙 상대의 면제는 그대로', () => {
      expect(judge('unrestricted', TAINTED, {}, { allowlist: [ALLOWED_RECIPIENT, 'other@x.example'], agentRequestedAllowlist: ['other@x.example'] }).outcome).toEqual({ kind: 'unchanged' });
    });

    it('grant(사람이 그 봉투를 승인한 릴리스)는 여전히 덮는다', () => {
      const attacker = 'attacker@evil.example';
      const ctx = { attempt: { recipients: [attacker] }, approval: { grant: { approvalId: 'ap-1', recipients: [attacker], approvedBy: 'owner' } } };
      expect(judge('allowlist_only', { ...TAINTED, taintedSenders: [attacker] }, ctx, { allowlist: [attacker], agentRequestedAllowlist: [attacker] }).outcome).toEqual({ kind: 'unchanged' });
    });
  });

  it('수신자 0명 — 공허한 "전원 면제" 로 열지 않는다', () => {
    const input: RiskHoldInput = { outboundMode: 'unrestricted', signals: TAINTED, recipients: [], grantCoversAll: false };
    expect(riskHoldReasons(input)).toEqual(['tainted_context']);
  });
});

describe('사유 표', () => {
  it('DLP 계열마다 보류 사유가 하나씩, 이름은 dlp_<계열>', () => {
    for (const family of DLP_FAMILIES) expect(DLP_HOLD_REASON[family]).toBe(`dlp_${family}`);
    const families: DlpFamily[] = [...DLP_FAMILIES];
    expect(Object.keys(DLP_HOLD_REASON).sort()).toEqual(families.sort());
  });
});
