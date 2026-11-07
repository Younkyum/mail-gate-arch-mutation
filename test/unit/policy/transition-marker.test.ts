/**
 * 매니페스트 **사람 승인 필수** 표지 (`requiresHumanApproval`) — 계획 §3.2 2단계 · AC-b1.
 *
 * 긴장: 전환 공지의 수신자는 **seed** 이고 seed 는 Stage 7 에서 승인 없이 통과한다(AC-a2). 그러면
 * `ApprovalRequest` 가 0개라 AC-b1 이 깨진다. 해법은 매니페스트의 경로 표지이고, 이 파일이 그 표지의
 * 세 성질을 못 박는다:
 *   ① **출처는 매니페스트뿐** — 로더가 `routeId` 로 읽는다. 호출자·DB 가 싣는 자리가 없다.
 *   ② **좁히기만 한다** — 허용(어떤 사유든) → 승인 대기. seed·standing·pre-approval·grant 가 넘지 못한다.
 *   ③ **거부를 뒤집지 않는다** — 거부 축(kill-switch·억제·차단·캡)은 표지보다 먼저 오고 그대로 거부다.
 */

import { describe, expect, it } from 'vitest';

import { evaluate } from '../../../src/policy/engine';
import { OUTBOUND_ROUTES } from '../../../src/policy/manifest';
import { humanApprovalRequirementOf, loadEvaluationInput } from '../../../src/policy/policy-loader';
import { evaluateOutboundMode } from '../../../src/policy/rules/outbound-mode';
import type { PolicyStamp, RelationshipMatch } from '../../../src/policy/types';
import { fixedSource, sourceResult } from '../../integration/outbound/support/fakes';
import { AGENT_ID, ALLOWED_RECIPIENT, NOW, STRANGER_RECIPIENT, contextWith, policyWith, verifiedThread } from './fixtures';

const STAMP: PolicyStamp = { policyVersion: 7, policyVersionId: 'v-7', evaluatedAt: NOW };
const DAY_MS = 24 * 60 * 60 * 1000;
const MARKED = { humanApprovalRequired: 'transition_announcement' } as const;

const approvalRequired = policyWith({ outboundMode: 'approval_required' });

function seed(recipient: string): RelationshipMatch {
  return { recipient, trustCategory: 'seed', scope: 'recipient' };
}

describe('① 출처는 매니페스트뿐', () => {
  it('매니페스트에서 표지를 단 경로는 transition_announcement 하나다', () => {
    const marked = OUTBOUND_ROUTES.filter((route) => route.kind === 'http' && route.requiresHumanApproval !== undefined);
    expect(marked.map((route) => route.id)).toEqual(['transition_announcement']);
  });

  it('로더의 조회: 표지 경로는 사유 코드, 나머지·워커·미등록 경로는 null', () => {
    expect(humanApprovalRequirementOf('transition_announcement')).toBe('transition_announcement');
    expect(humanApprovalRequirementOf('send')).toBeNull();
    // 릴리스는 표지가 없어야 한다 — 있으면 승인된 공지가 영원히 다시 승인 대기가 된다.
    expect(humanApprovalRequirementOf('approval_release')).toBeNull();
    expect(humanApprovalRequirementOf('no_such_route')).toBeNull();
  });

  it('loadEvaluationInput 이 routeId 로 표지를 싣는다 — 소스 결과(DB)와 무관하다', async () => {
    const load = (routeId: string) =>
      loadEvaluationInput(fixedSource(sourceResult()), {
        agentId: AGENT_ID,
        attempt: {
          routeId,
          fromAddress: 'demo-agent@atmark.ai',
          recipients: [ALLOWED_RECIPIENT],
          attachments: [],
          threadId: null,
          contentShape: 'other', dlp: [], pinnedTaint: false,
        },
        now: NOW,
        traceId: null,
        thisAttemptCostCents: 0,
        release: null,
      });
    expect((await load('transition_announcement')).ctx.approval.humanApprovalRequired).toBe('transition_announcement');
    expect((await load('send')).ctx.approval.humanApprovalRequired).toBeNull();
  });
});

describe('② 좁히기만 한다 — 어떤 허용 사유도 표지를 넘지 못한다', () => {
  it('대조군: 표지가 없으면 seed 는 승인 없이 allowed (AC-a2)', () => {
    const decision = evaluateOutboundMode(
      contextWith({ approval: { relationships: [seed(ALLOWED_RECIPIENT)] } }),
      approvalRequired,
      STAMP,
    );
    expect(decision.verdict).toBe('allowed');
  });

  it('AC-b1 (엔진) — seed 에게도 승인 대기, 사유는 transition_announcement 하나 (seed_relationship 없음)', () => {
    const decision = evaluateOutboundMode(
      contextWith({ approval: { ...MARKED, relationships: [seed(ALLOWED_RECIPIENT)] } }),
      approvalRequired,
      STAMP,
    );
    expect(decision.verdict).toBe('pending_approval');
    // seed_relationship 이 남으면 AC-a2 의 "seed 로 승인 없이 나간 첫 발송" 질의가 이 행을 잡는다.
    expect(decision.reasons).toEqual(['transition_announcement']);
    expect(decision.policyVersion).toBe(7);
  });

  it('standing approval · auto_approve_domain · 스레드 회신 pre-approval 도 넘지 못한다', () => {
    const standing = evaluateOutboundMode(
      contextWith({
        approval: { ...MARKED, relationships: [{ recipient: ALLOWED_RECIPIENT, trustCategory: 'approved', scope: 'recipient' }] },
      }),
      approvalRequired,
      STAMP,
    );
    const domain = evaluateOutboundMode(
      contextWith({ approval: MARKED }),
      policyWith({ outboundMode: 'approval_required', preApproval: { autoApproveDomains: ['example.com'] } }),
      STAMP,
    );
    const threadReply = evaluateOutboundMode(
      contextWith({ approval: { ...MARKED, thread: verifiedThread('agent') } }),
      approvalRequired,
      STAMP,
    );
    for (const decision of [standing, domain, threadReply]) {
      expect(decision.verdict).toBe('pending_approval');
      expect(decision.reasons).toEqual(['transition_announcement']);
    }
  });

  it('릴리스 grant 도 이 경로에서는 허용을 만들지 못한다 — 발송은 표지 없는 approval_release 의 몫', () => {
    const decision = evaluateOutboundMode(
      contextWith({
        approval: {
          ...MARKED,
          grant: { approvalId: 'a-1', recipients: [ALLOWED_RECIPIENT], approvedBy: 'owner@example.com' },
        },
      }),
      approvalRequired,
      STAMP,
    );
    expect(decision.verdict).toBe('pending_approval');
  });

  it('allowlist_only 목록 일치 · unrestricted 도 승인 대기가 된다', () => {
    const allowlist = evaluateOutboundMode(contextWith({ approval: MARKED }), policyWith({ outboundMode: 'allowlist_only' }), STAMP);
    const unrestricted = evaluateOutboundMode(contextWith({ approval: MARKED }), policyWith({ outboundMode: 'unrestricted' }), STAMP);
    expect(allowlist.verdict).toBe('pending_approval');
    expect(unrestricted.verdict).toBe('pending_approval');
    expect(unrestricted.reasons).toEqual(['transition_announcement']);
  });

  it('이미 승인 대기면 표지 사유를 맨 앞에 붙이고 원래 사유를 유지한다 (reasons[0] = 관측 차원)', () => {
    const decision = evaluateOutboundMode(
      contextWith({ attempt: { recipients: [STRANGER_RECIPIENT] }, approval: MARKED }),
      approvalRequired,
      STAMP,
    );
    expect(decision.reasons).toEqual(['transition_announcement', 'new_recipient']);
  });

  it('reply_only grace 안: seed 허용 → 승인 대기, bootstrap_grace 표지와 잔여는 옮겨 싣는다', () => {
    const decision = evaluateOutboundMode(
      contextWith({
        approval: {
          ...MARKED,
          relationships: [seed(ALLOWED_RECIPIENT)],
          bootstrapGrace: { agentCreatedAt: NOW, outboundSentCount: 3 },
        },
      }),
      policyWith({ outboundMode: 'reply_only' }),
      STAMP,
    );
    expect(decision.verdict).toBe('pending_approval');
    expect(decision.reasons).toEqual(['transition_announcement', 'bootstrap_grace']);
    expect(decision.bootstrapGraceRemaining).toBe(6);
  });
});

describe('③ 거부를 뒤집지 않는다 — 거부 축이 표지보다 먼저다', () => {
  it('Stage 7 자신의 거부(목록 밖 · disabled · reply_only grace 종료)는 그대로 거부', () => {
    const outsideList = evaluateOutboundMode(
      contextWith({ attempt: { recipients: [STRANGER_RECIPIENT] }, approval: MARKED }),
      policyWith({ outboundMode: 'allowlist_only' }),
      STAMP,
    );
    const disabled = evaluateOutboundMode(contextWith({ approval: MARKED }), policyWith({ outboundMode: 'disabled' }), STAMP);
    const graceOver = evaluateOutboundMode(
      contextWith({
        approval: { ...MARKED, bootstrapGrace: { agentCreatedAt: new Date(NOW.getTime() - 30 * DAY_MS), outboundSentCount: 0 } },
      }),
      policyWith({ outboundMode: 'reply_only' }),
      STAMP,
    );
    expect(outsideList.reasons).toEqual(['recipient_not_allowlisted']);
    expect(disabled.reasons).toEqual(['outbound_disabled']);
    expect(graceOver.reasons).toEqual(['reply_only_no_inbound_thread']);
    for (const decision of [outsideList, disabled, graceOver]) expect(decision.verdict).toBe('denied');
  });

  it.each([
    ['kill-switch', contextWith({ organization: { abuseFreeze: true }, approval: { ...MARKED, relationships: [seed(ALLOWED_RECIPIENT)] } }), 'org_abuse_freeze'],
    ['억제 목록', contextWith({ suppressedRecipients: [ALLOWED_RECIPIENT], approval: { ...MARKED, relationships: [seed(ALLOWED_RECIPIENT)] } }), 'suppression_list'],
    [
      '워밍업 캡',
      contextWith({
        organization: { sendingStartedAt: null },
        counters: { orgRecipientsLastDay: 20 },
        approval: { ...MARKED, relationships: [seed(ALLOWED_RECIPIENT)] },
      }),
      'warmup_daily_cap',
    ],
  ] as const)('%s — seed 이고 표지가 있어도 사람에게 묻지 않고 거부 (§4.2 원칙 1)', (_name, ctx, reason) => {
    const decision = evaluate(ctx, approvalRequired);
    expect(decision.verdict).toBe('denied');
    expect(decision.reasons).toContain(reason);
    expect(decision.reasons).not.toContain('transition_announcement');
  });

  it('blocklist — 표지가 있어도 거부', () => {
    const decision = evaluate(
      contextWith({ approval: { ...MARKED, relationships: [seed(ALLOWED_RECIPIENT)] } }),
      policyWith({ outboundMode: 'approval_required', blocklist: [ALLOWED_RECIPIENT] }),
    );
    expect(decision.verdict).toBe('denied');
    expect(decision.reasons).toEqual(['recipient_blocklisted']);
  });
});
