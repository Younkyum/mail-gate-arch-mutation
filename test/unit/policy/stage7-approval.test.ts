/**
 * Stage 7 — `approval_required` · `reply_only`(+bootstrap_grace) 분기 (계획 §4.2 · §3.1 · §3.4, P2).
 *
 * 엔진 테이블(60 케이스)은 모드 × 관계상태의 **격자**를 본다. 여기서는 격자가 못 보는 것 —
 * 수신자가 여럿일 때의 판정, pre-approval 규칙 각각, 릴리스 grant 의 범위, grace 의 경계 —
 * 를 하나씩 못 박는다. 각 테스트의 제목이 곧 "이 줄이 없으면 무엇이 새는가" 다.
 */

import { describe, expect, it } from 'vitest';

import { evaluate } from '../../../src/policy/engine';
import {
  BOOTSTRAP_GRACE_DAYS,
  BOOTSTRAP_GRACE_MAX_SENDS,
  evaluateOutboundMode,
  graceRemainingAfterAttempt,
} from '../../../src/policy/rules/outbound-mode';
import type { PolicyStamp, RelationshipMatch } from '../../../src/policy/types';
import { ALLOWED_RECIPIENT, NOW, STRANGER_RECIPIENT, contextWith, policyWith, verifiedThread } from './fixtures';

const STAMP: PolicyStamp = { policyVersion: 3, policyVersionId: 'v-3', evaluatedAt: NOW };
const DAY_MS = 24 * 60 * 60 * 1000;

const approvalRequired = policyWith({ outboundMode: 'approval_required' });
const replyOnly = policyWith({ outboundMode: 'reply_only' });

function seed(recipient: string): RelationshipMatch {
  return { recipient, trustCategory: 'seed', scope: 'recipient' };
}
function standing(recipient: string, scope: RelationshipMatch['scope'] = 'recipient'): RelationshipMatch {
  return { recipient, trustCategory: 'approved', scope };
}

describe('Stage 7 — approval_required (기본값·주력, §3.1 층 1)', () => {
  it('관계 없는 신규 상대 → 승인 대기 (`new_recipient`). grace 수치는 없다', () => {
    const decision = evaluateOutboundMode(
      contextWith({ attempt: { recipients: [STRANGER_RECIPIENT] } }),
      approvalRequired,
      STAMP,
    );
    expect(decision.verdict).toBe('pending_approval');
    expect(decision.reasons).toEqual(['new_recipient']);
    expect(decision.bootstrapGraceRemaining).toBeNull();
    // 평가 시점 정책 스탬프가 그대로 실린다 — 릴리스 뒤에도 audit 은 이 값을 유지한다(§4.3).
    expect(decision.policyVersion).toBe(3);
  });

  it('AC-a2 (엔진) — seed 상대로의 첫 발송은 승인 없이 allowed + `seed_relationship`', () => {
    const decision = evaluateOutboundMode(
      contextWith({ approval: { relationships: [seed(ALLOWED_RECIPIENT)] } }),
      approvalRequired,
      STAMP,
    );
    expect(decision.verdict).toBe('allowed');
    expect(decision.reasons).toEqual(['seed_relationship']);
  });

  it('standing approval(승인의 상환, §3.4 2조) → allowed + `standing_approval` — 스코프와 무관하다', () => {
    for (const scope of ['recipient', 'thread', 'domain'] as const) {
      const decision = evaluateOutboundMode(
        contextWith({ approval: { relationships: [standing(ALLOWED_RECIPIENT, scope)] } }),
        approvalRequired,
        STAMP,
      );
      expect(decision.verdict).toBe('allowed');
      expect(decision.reasons).toEqual(['standing_approval']);
    }
  });

  it('seed 와 standing 이 한 수신자에 겹치면 사유는 seed 다 — AC-a2 의 질의가 그 행을 놓치지 않게', () => {
    const decision = evaluateOutboundMode(
      contextWith({ approval: { relationships: [standing(ALLOWED_RECIPIENT), seed(ALLOWED_RECIPIENT)] } }),
      policyWith({ outboundMode: 'approval_required', preApproval: { autoApproveDomains: ['example.com'] } }),
      STAMP,
    );
    expect(decision.reasons).toEqual(['seed_relationship']);
  });

  it('**부분 발송은 없다** — 한 명이라도 덮이지 않으면 메시지 전체가 승인 대기다', () => {
    const decision = evaluateOutboundMode(
      contextWith({
        attempt: { recipients: [ALLOWED_RECIPIENT, STRANGER_RECIPIENT] },
        approval: { relationships: [seed(ALLOWED_RECIPIENT)] },
      }),
      approvalRequired,
      STAMP,
    );
    expect(decision.verdict).toBe('pending_approval');
  });

  it('여러 수신자가 서로 다른 이유로 덮이면 사유가 중복 없이 순서대로 전부 실린다', () => {
    const other = 'other@example.org';
    const third = 'third@example.org';
    const decision = evaluateOutboundMode(
      contextWith({
        attempt: { recipients: [ALLOWED_RECIPIENT, other, third] },
        approval: { relationships: [seed(ALLOWED_RECIPIENT), standing(other), standing(third)] },
      }),
      approvalRequired,
      STAMP,
    );
    expect(decision.verdict).toBe('allowed');
    expect(decision.reasons).toEqual(['seed_relationship', 'standing_approval']);
  });

  it('관계는 **그 수신자**의 것만 센다 — 다른 수신자의 관계가 신규 상대를 덮지 않는다', () => {
    const decision = evaluateOutboundMode(
      contextWith({
        attempt: { recipients: [STRANGER_RECIPIENT] },
        approval: { relationships: [seed(ALLOWED_RECIPIENT)] },
      }),
      approvalRequired,
      STAMP,
    );
    expect(decision.verdict).toBe('pending_approval');
  });

  it('pre-approval `auto_approve_domains` — 수신자 도메인이 목록에 있으면 allowed', () => {
    const decision = evaluateOutboundMode(
      contextWith({ attempt: { recipients: ['ceo@partner.co'] } }),
      policyWith({ outboundMode: 'approval_required', preApproval: { autoApproveDomains: ['partner.co'] } }),
      STAMP,
    );
    expect(decision.verdict).toBe('allowed');
    expect(decision.reasons).toEqual(['auto_approve_domain']);
  });

  it('pre-approval `auto_approve_domains` — 하위 도메인·접미사 일치는 덮지 않는다(정확 일치)', () => {
    const decision = evaluateOutboundMode(
      contextWith({ attempt: { recipients: ['x@evil-partner.co', 'y@mail.partner.co'] } }),
      policyWith({ outboundMode: 'approval_required', preApproval: { autoApproveDomains: ['partner.co'] } }),
      STAMP,
    );
    expect(decision.verdict).toBe('pending_approval');
  });

  it('pre-approval `auto_approve_reply_within_thread`(기본 true) — **에이전트 스레드** 회신은 승인 없이 allowed', () => {
    const decision = evaluateOutboundMode(
      contextWith({ attempt: { recipients: [STRANGER_RECIPIENT] }, approval: { thread: verifiedThread('agent') } }),
      approvalRequired,
      STAMP,
    );
    expect(decision.verdict).toBe('allowed');
    expect(decision.reasons).toEqual(['auto_approve_reply_within_thread']);
  });

  it('`auto_approve_reply_within_thread=false` 면 스레드 회신도 신규 상대는 승인 대기다', () => {
    const decision = evaluateOutboundMode(
      contextWith({ attempt: { recipients: [STRANGER_RECIPIENT] }, approval: { thread: verifiedThread('agent') } }),
      policyWith({ outboundMode: 'approval_required', preApproval: { autoApproveReplyWithinThread: false } }),
      STAMP,
    );
    expect(decision.verdict).toBe('pending_approval');
  });

  it('릴리스 grant — **승인이 덮는 수신자만** 통과한다 (`approval_granted`)', () => {
    const grant = { approvalId: 'apr-1', recipients: [STRANGER_RECIPIENT], approvedBy: 'owner@example.com' };
    const covered = evaluateOutboundMode(
      contextWith({ attempt: { recipients: [STRANGER_RECIPIENT] }, approval: { grant } }),
      approvalRequired,
      STAMP,
    );
    expect(covered.verdict).toBe('allowed');
    expect(covered.reasons).toEqual(['approval_granted']);

    // 사람이 본 봉투 밖의 수신자는 grant 로 통과하지 않는다 — 봉투가 바뀐 릴리스를 막는 줄.
    const outside = evaluateOutboundMode(
      contextWith({ attempt: { recipients: [STRANGER_RECIPIENT, 'extra@example.com'] }, approval: { grant } }),
      approvalRequired,
      STAMP,
    );
    expect(outside.verdict).toBe('pending_approval');
  });

  it('수신자 0명은 허용이 아니다 — 사유 없는 허용은 표현 불가능해야 한다(§5.1 ④)', () => {
    const decision = evaluateOutboundMode(contextWith({ attempt: { recipients: [] } }), approvalRequired, STAMP);
    expect(decision.verdict).toBe('pending_approval');
  });

  it('§4.2 원칙 1 — 억제 목록 수신자는 **사람에게 묻지 않고** 거부된다(Stage 2 가 먼저)', () => {
    const decision = evaluate(
      contextWith({ attempt: { recipients: [STRANGER_RECIPIENT] }, suppressedRecipients: [STRANGER_RECIPIENT] }),
      approvalRequired,
    );
    expect(decision.verdict).toBe('denied');
    expect(decision.reasons).toEqual(['suppression_list']);
  });
});

describe('Stage 7 — reply_only + bootstrap_grace (§3.1 층 3)', () => {
  it('스레드 내 회신은 grace 와 무관하게 allowed (`reply_within_thread`)', () => {
    const decision = evaluateOutboundMode(
      contextWith({
        attempt: { recipients: [STRANGER_RECIPIENT] },
        approval: {
          thread: verifiedThread('external'),
          bootstrapGrace: { agentCreatedAt: new Date(NOW.getTime() - 30 * DAY_MS), outboundSentCount: 99 },
        },
      }),
      replyOnly,
      STAMP,
    );
    expect(decision.verdict).toBe('allowed');
    expect(decision.reasons).toEqual(['reply_within_thread']);
    expect(decision.bootstrapGraceRemaining).toBeNull();
  });

  it('grace 중 신규 상대 → approval_required 처럼 승인 대기 + `bootstrap_grace` + 잔여', () => {
    const decision = evaluateOutboundMode(
      contextWith({ attempt: { recipients: [STRANGER_RECIPIENT] } }),
      replyOnly,
      STAMP,
    );
    expect(decision.verdict).toBe('pending_approval');
    // grace 표지는 **끝에** 붙는다 — 관측은 reasons[0] 만 메트릭 차원에 싣는다.
    expect(decision.reasons).toEqual(['new_recipient', 'bootstrap_grace']);
    expect(decision.bootstrapGraceRemaining).toBe(BOOTSTRAP_GRACE_MAX_SENDS - 1);
  });

  it('grace 중 seed 상대 → allowed + [`seed_relationship`, `bootstrap_grace`]', () => {
    const decision = evaluateOutboundMode(
      contextWith({ approval: { relationships: [seed(ALLOWED_RECIPIENT)] } }),
      replyOnly,
      STAMP,
    );
    expect(decision.verdict).toBe('allowed');
    expect(decision.reasons).toEqual(['seed_relationship', 'bootstrap_grace']);
  });

  it('AC-a4 — 9번째 시도(8건 발송 후)의 잔여는 1 이다', () => {
    const decision = evaluateOutboundMode(
      contextWith({
        approval: {
          relationships: [seed(ALLOWED_RECIPIENT)],
          bootstrapGrace: { agentCreatedAt: NOW, outboundSentCount: 8 },
        },
      }),
      replyOnly,
      STAMP,
    );
    expect(decision.bootstrapGraceRemaining).toBe(1);
  });

  it('AC-a3 — 10건 발송 뒤 11번째 → denied `reply_only_no_inbound_thread` (seed 여도)', () => {
    const decision = evaluateOutboundMode(
      contextWith({
        approval: {
          relationships: [seed(ALLOWED_RECIPIENT)],
          bootstrapGrace: { agentCreatedAt: NOW, outboundSentCount: BOOTSTRAP_GRACE_MAX_SENDS },
        },
      }),
      replyOnly,
      STAMP,
    );
    expect(decision.verdict).toBe('denied');
    expect(decision.reasons).toEqual(['reply_only_no_inbound_thread']);
  });

  it('AC-a3 — 14일째 **정각**부터 grace 밖이다 (15일째 첫 outbound 는 거부)', () => {
    const createdAt = new Date(NOW.getTime() - BOOTSTRAP_GRACE_DAYS * DAY_MS);
    const decision = evaluateOutboundMode(
      contextWith({ approval: { bootstrapGrace: { agentCreatedAt: createdAt, outboundSentCount: 0 } } }),
      replyOnly,
      STAMP,
    );
    expect(decision.verdict).toBe('denied');
    expect(decision.reasons).toEqual(['reply_only_no_inbound_thread']);

    // 1ms 전은 아직 grace 다 — 경계가 한쪽으로 밀리면 이 쌍 중 하나가 실패한다.
    const justBefore = new Date(createdAt.getTime() + 1);
    expect(graceRemainingAfterAttempt({ agentCreatedAt: justBefore, outboundSentCount: 0 }, NOW)).toBe(9);
  });

  it('grace 밖이면 릴리스 grant 가 있어도 통과하지 못한다 — reply_only 에는 grace 밖 승인 경로가 없다', () => {
    const decision = evaluateOutboundMode(
      contextWith({
        attempt: { recipients: [STRANGER_RECIPIENT] },
        approval: {
          grant: { approvalId: 'apr-1', recipients: [STRANGER_RECIPIENT], approvedBy: 'owner' },
          bootstrapGrace: { agentCreatedAt: NOW, outboundSentCount: BOOTSTRAP_GRACE_MAX_SENDS },
        },
      }),
      replyOnly,
      STAMP,
    );
    expect(decision.verdict).toBe('denied');
  });
});

describe('Stage 7 — 허용 매칭은 `+tag` 를 보존한다 (허용은 좁게, V1 MINOR-2)', () => {
  // 로더가 만드는 모양 그대로: 판정형(`attempt`)은 태그를 자르고, 허용 비교형(`approval`)은 보존한다.
  const tagged = (approval: Parameters<typeof contextWith>[0]['approval'] = {}) =>
    contextWith({ attempt: { recipients: ['sales@corp.com'] }, approval: { recipients: ['sales+eu@corp.com'], ...approval } });

  it('`sales@` 의 관계는 `sales+eu@` 를 덮지 않는다 — 소유자는 그 주소를 본 적이 없다', () => {
    const decision = evaluateOutboundMode(tagged({ relationships: [] }), approvalRequired, STAMP);
    expect(decision.verdict).toBe('pending_approval');
  });

  it('`sales+eu@` 의 관계는 `sales+eu@` 만 덮는다', () => {
    const covered = evaluateOutboundMode(tagged({ relationships: [standing('sales+eu@corp.com')] }), approvalRequired, STAMP);
    expect([covered.verdict, covered.reasons]).toEqual(['allowed', ['standing_approval']]);
    // 같은 관계로 태그 없는 주소(판정형은 같다)에 보내면 승인 대기다 — 판정형으로 매칭하던 예전에는 통과했다.
    const bare = evaluateOutboundMode(
      contextWith({ attempt: { recipients: ['sales@corp.com'] }, approval: { recipients: ['sales@corp.com'], relationships: [] } }),
      approvalRequired,
      STAMP,
    );
    expect(bare.verdict).toBe('pending_approval');
  });

  it('grant 도 허용 비교형으로 본다 — `sales+eu@` 승인이 `sales+us@` 릴리스를 덮지 않는다', () => {
    const grant = { approvalId: 'apr-1', recipients: ['sales+eu@corp.com'], approvedBy: 'owner' };
    const other = contextWith({
      attempt: { recipients: ['sales@corp.com'] },
      approval: { recipients: ['sales+us@corp.com'], grant },
    });
    expect(evaluateOutboundMode(other, approvalRequired, STAMP).verdict).toBe('pending_approval');
    expect(evaluateOutboundMode(tagged({ grant }), approvalRequired, STAMP).reasons).toEqual(['approval_granted']);
  });

  it('allowlist_only 도 허용 비교형으로 본다 — 목록의 `sales@` 가 `sales+eu@` 를 열지 않는다', () => {
    const policy = policyWith({ outboundMode: 'allowlist_only', allowlist: ['sales@corp.com'] });
    expect(evaluateOutboundMode(tagged(), policy, STAMP).reasons).toEqual(['recipient_not_allowlisted']);
    const exact = policyWith({ outboundMode: 'allowlist_only', allowlist: ['sales+eu@corp.com'] });
    expect(evaluateOutboundMode(tagged(), exact, STAMP).reasons).toEqual(['allowlist_match']);
  });

  it('두 수신자 목록의 길이가 다르면 던진다 — 관문이 evaluation_error 로 닫는다(빈 허용 목록이 allowlist 를 공허하게 열지 않는다)', () => {
    const skewed = contextWith({ attempt: { recipients: ['sales@corp.com'] }, approval: { recipients: [] } });
    expect(() => evaluateOutboundMode(skewed, policyWith({ outboundMode: 'allowlist_only' }), STAMP)).toThrow(/맞지 않는다/);
    expect(() => evaluateOutboundMode(skewed, approvalRequired, STAMP)).toThrow(/맞지 않는다/);
  });
});
