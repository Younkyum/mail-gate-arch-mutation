/**
 * 소유자 발신 승인(`src/policy/rules/send-approval.ts`, ADR-0016 2026-10-08 — `send_approval = always`) — **좁히기만** 한다.
 *
 *   ① 속성(규칙 단독): 무작위 판정 · 입력 수천 개에서 결과는 원래보다 관대하지 않다. denied · grant 릴리스 · auto 는 그대로.
 *   ② 속성(Stage 7 전체 — 위험 보류 속성 확장): 무작위 맥락(모드 · 수신자 · 위험 신호 · DLP · grant · 스레드)에서 `always` 의 판정은 `auto` 의 판정보다
 *      관대하지 않고, 위험 보류를 켜든 끄든 같다. `always` 에서 사람 승인 없이 `allowed` 가 나오는 경우는 grant 릴리스뿐이다.
 *   ③ 표: 모드별 동작 · reply_only 의 사람 없는 회신 → `reply_only_owner_approval` 거부 · 위험 사유가 맨 앞 · 경로 표지가 맨 앞.
 */

import { describe, expect, it } from 'vitest';

import { evaluateOutboundMode } from '../../../src/policy/rules/outbound-mode';
import { applySendApproval, type SendApprovalInput, type SendApprovalVerdict } from '../../../src/policy/rules/send-approval';
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
  type RiskHoldContext,
} from '../../../src/policy/types';
import { DLP_FAMILIES } from '../../../src/security/dlp/scan';
import { ALLOWED_RECIPIENT, NOW, STRANGER_RECIPIENT, contextWith, policyWith, verifiedThread } from './fixtures';

const STAMP: PolicyStamp = { policyVersion: 3, policyVersionId: 'v-3', evaluatedAt: NOW };
const MODES: readonly OutboundMode[] = ['disabled', 'allowlist_only', 'blocklist_only', 'unrestricted', 'approval_required', 'reply_only'];
const RANK: Readonly<Record<AuditDecision, number>> = { allowed: 2, pending_approval: 1, denied: 0 };

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

function verdictOf(decision: Decision, outcome: SendApprovalVerdict): AuditDecision {
  if (outcome.kind === 'unchanged') return decision.verdict;
  return outcome.kind === 'hold' ? 'pending_approval' : 'denied';
}

const ALLOW_REASONS: readonly DecisionReason[] = ['allowlist_match', 'unrestricted_mode', 'not_blocklisted', 'seed_relationship', 'standing_approval', 'auto_approve_domain', 'approval_granted', 'reply_within_thread'];
const PENDING_REASONS: readonly DecisionReason[] = ['new_recipient', 'transition_announcement', 'tainted_context', 'dlp_atmark_credential'];
const DENY_REASONS: readonly DecisionReason[] = ['recipient_blocklisted', 'suppression_list', 'recipient_not_allowlisted', 'reply_only_risk_hold', 'outbound_disabled'];

describe('① 속성 — 규칙 단독', () => {
  const rand = prng(20261008);
  const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)] as T;
  const some = <T,>(xs: readonly T[]): T[] => xs.filter(() => rand() < 0.3);
  const cases = Array.from({ length: 5_000 }, () => {
    const grace = rand() < 0.3;
    const reasonsOf = (pool: readonly DecisionReason[]): NonEmptyReasons =>
      (grace ? [pick(pool), ...some(pool), 'bootstrap_grace'] : [pick(pool), ...some(pool)]) as unknown as NonEmptyReasons;
    const kind = pick(['allowed', 'pending', 'denied'] as const);
    const decision =
      kind === 'allowed'
        ? allowed(reasonsOf(ALLOW_REASONS), STAMP, grace ? 3 : null)
        : kind === 'pending'
          ? pendingApproval(reasonsOf(PENDING_REASONS), STAMP, grace ? 3 : null)
          : toDeniedDecision(deny(reasonsOf(DENY_REASONS)), STAMP);
    const input: SendApprovalInput = { sendApproval: rand() < 0.7 ? 'always' : 'auto', outboundMode: pick(MODES), grantCoversAll: rand() < 0.15 };
    return { decision, input };
  });

  it('결과는 원래 판정보다 관대하지 않다 · denied · auto · grant 릴리스는 그대로', () => {
    for (const { decision, input } of cases) {
      const outcome = applySendApproval(decision, input);
      expect(RANK[verdictOf(decision, outcome)]).toBeLessThanOrEqual(RANK[decision.verdict]);
      if (decision.verdict === 'denied' || input.sendApproval === 'auto' || input.grantCoversAll) expect(outcome).toEqual({ kind: 'unchanged' });
    }
  });

  it('always 이고 grant 가 아니면 allowed 는 남지 않는다 · 보류 사유에 허용 사유가 없다 · 잔여를 옮긴다 · 사유는 owner_requires_approval 를 싣는다', () => {
    let holds = 0;
    for (const { decision, input } of cases) {
      const outcome = applySendApproval(decision, input);
      if (input.sendApproval === 'always' && !input.grantCoversAll) expect(verdictOf(decision, outcome)).not.toBe('allowed');
      if (outcome.kind !== 'hold') continue;
      holds += 1;
      for (const reason of outcome.reasons) expect(ALLOW_REASONS).not.toContain(reason);
      expect(outcome.reasons).toContain('owner_requires_approval');
      expect(new Set(outcome.reasons).size).toBe(outcome.reasons.length);
      expect(outcome.bootstrapGraceRemaining).toBe(decision.bootstrapGraceRemaining);
      // 대기에 더할 때는 원래 사유가 앞에 남는다(위험 사유가 맨 앞 — 승인 화면).
      if (decision.verdict === 'pending_approval') expect(outcome.reasons[0]).toBe(decision.reasons[0]);
    }
    expect(holds).toBeGreaterThan(1_000);
  });
});

describe('② 속성 — Stage 7 전체(위험 보류 · 경로 표지와 함께)', () => {
  const rand = prng(1008);
  const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)] as T;
  const some = <T,>(xs: readonly T[]): T[] => xs.filter(() => rand() < 0.3);
  const ADDRESSES = [ALLOWED_RECIPIENT, STRANGER_RECIPIENT, 'third@other.example'];

  function randomCase(): { ctx: ReturnType<typeof contextWith>; mode: OutboundMode; allowlist: string[]; autoDomains: string[] } {
    const recipients = [pick(ADDRESSES), ...some(ADDRESSES)].filter((v, i, xs) => xs.indexOf(v) === i);
    const riskHold: RiskHoldContext | null =
      rand() < 0.3 ? null : { enforce: rand() < 0.8, agentTainted: rand() < 0.3, threadTainted: rand() < 0.2, taintedSenders: some(ADDRESSES) };
    const thread = rand() < 0.3 ? verifiedThread(rand() < 0.5 ? 'agent' : 'external') : null;
    const grant = rand() < 0.15 ? { approvalId: 'a', recipients: rand() < 0.7 ? recipients : recipients.slice(1), approvedBy: 'owner' } : null;
    const ctx = contextWith({
      attempt: { recipients, dlp: some(DLP_FAMILIES), threadId: thread?.threadId ?? null },
      approval: {
        recipients,
        riskHold,
        thread,
        grant,
        humanApprovalRequired: rand() < 0.1 ? 'transition_announcement' : null,
        relationships: some(recipients).map((recipient) => ({ recipient, trustCategory: pick(['seed', 'approved'] as const), scope: 'recipient' as const })),
      },
    });
    return { ctx, mode: pick(MODES), allowlist: some(ADDRESSES), autoDomains: rand() < 0.2 ? ['example.com'] : [] };
  }

  const cases = Array.from({ length: 4_000 }, randomCase);

  it('always 는 auto 보다 관대하지 않다 · always 의 allowed 는 grant 릴리스뿐이다', () => {
    let narrowed = 0;
    for (const { ctx, mode, allowlist, autoDomains } of cases) {
      const base = { outboundMode: mode, allowlist, preApproval: { autoApproveDomains: autoDomains } };
      let auto: Decision;
      let always: Decision;
      try {
        auto = evaluateOutboundMode(ctx, policyWith({ ...base, sendApproval: 'auto' }), STAMP);
        always = evaluateOutboundMode(ctx, policyWith({ ...base, sendApproval: 'always' }), STAMP);
      } catch {
        continue; // disabled 외 모순 맥락(수신자 길이 불일치 등)은 관문이 evaluation_error 로 닫는다 — 여기서는 비교 대상이 아니다.
      }
      expect(RANK[always.verdict]).toBeLessThanOrEqual(RANK[auto.verdict]);
      if (always.verdict === 'allowed') {
        const grant = ctx.approval.grant;
        expect(grant !== null && ctx.approval.recipients.every((r) => grant.recipients.includes(r))).toBe(true);
      }
      if (RANK[always.verdict] < RANK[auto.verdict]) narrowed += 1;
    }
    expect(narrowed).toBeGreaterThan(300);
  });
});

describe('③ 표 — Stage 7 배선', () => {
  it('always + allowlist_only 목록 일치 → 승인 대기(owner_requires_approval)', () => {
    const decision = evaluateOutboundMode(
      contextWith({}),
      policyWith({ outboundMode: 'allowlist_only', allowlist: [ALLOWED_RECIPIENT], sendApproval: 'always' }),
      STAMP,
    );
    expect([decision.verdict, decision.reasons]).toEqual(['pending_approval', ['owner_requires_approval']]);
  });

  it('auto 는 판정 그대로(오늘 동작)', () => {
    const decision = evaluateOutboundMode(contextWith({}), policyWith({ outboundMode: 'allowlist_only', allowlist: [ALLOWED_RECIPIENT] }), STAMP);
    expect([decision.verdict, decision.reasons]).toEqual(['allowed', ['allowlist_match']]);
  });

  it('always 도 목록 밖은 거부 그대로(묻지 않는다)', () => {
    const decision = evaluateOutboundMode(
      contextWith({ attempt: { recipients: [STRANGER_RECIPIENT] } }),
      policyWith({ outboundMode: 'allowlist_only', allowlist: [ALLOWED_RECIPIENT], sendApproval: 'always' }),
      STAMP,
    );
    expect([decision.verdict, decision.reasons]).toEqual(['denied', ['recipient_not_allowlisted']]);
  });

  it('위험 보류와 겹치면 위험 사유가 맨 앞 · 경로 표지는 그보다 앞', () => {
    const riskHold: RiskHoldContext = { enforce: true, agentTainted: true, threadTainted: false, taintedSenders: [] };
    const held = evaluateOutboundMode(
      contextWith({ attempt: { recipients: [STRANGER_RECIPIENT] }, approval: { riskHold } }),
      policyWith({ outboundMode: 'unrestricted', sendApproval: 'always' }),
      STAMP,
    );
    expect([held.verdict, held.reasons]).toEqual(['pending_approval', ['tainted_context', 'owner_requires_approval']]);
    const marked = evaluateOutboundMode(
      contextWith({ attempt: { recipients: [STRANGER_RECIPIENT] }, approval: { humanApprovalRequired: 'transition_announcement' } }),
      policyWith({ outboundMode: 'unrestricted', sendApproval: 'always' }),
      STAMP,
    );
    expect([marked.verdict, marked.reasons]).toEqual(['pending_approval', ['transition_announcement', 'owner_requires_approval']]);
  });

  it('사람이 승인한 릴리스(grant 가 전원을 덮음)는 나간다 — 승인이 끝나지 않는 고리를 만들지 않는다', () => {
    const decision = evaluateOutboundMode(
      contextWith({ attempt: { recipients: [STRANGER_RECIPIENT] }, approval: { grant: { approvalId: 'a', recipients: [STRANGER_RECIPIENT], approvedBy: 'owner' } } }),
      policyWith({ outboundMode: 'unrestricted', sendApproval: 'always' }),
      STAMP,
    );
    expect([decision.verdict, decision.reasons]).toEqual(['allowed', ['unrestricted_mode']]);
  });

  it('레거시 reply_only 의 사람 없는 회신 → reply_only_owner_approval 거부', () => {
    const thread = verifiedThread('external');
    const decision = evaluateOutboundMode(
      contextWith({ attempt: { threadId: thread.threadId }, approval: { thread } }),
      policyWith({ outboundMode: 'reply_only', sendApproval: 'always' }),
      STAMP,
    );
    expect([decision.verdict, decision.reasons]).toEqual(['denied', ['reply_only_owner_approval']]);
  });
});
