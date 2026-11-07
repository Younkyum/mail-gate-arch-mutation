/**
 * 엔진 테이블 테스트(계획 §5.1) — `outbound_mode(6) × 관계상태(4) × 한도상태(3)` = 72 케이스. 목록 축 전수는 `policy-v2.test.ts`.
 *
 * | 모드 | none | seed | approved | thread |
 * |---|---|---|---|---|
 * | approval_required | **승인 대기** | 허용(seed) | 허용(standing) | 허용(pre-approval) |
 * | reply_only (grace 중) | 승인 대기 +grace | 허용(seed) +grace | 허용(standing) +grace | 허용(스레드) |
 *
 * 픽스처는 grace 안이다(오늘 생성·0건). grace 밖은 `stages.test.ts`(AC-a3).
 */

import { describe, expect, it } from 'vitest';
import { evaluate } from '../../../src/policy/engine';
import { OUTBOUND_MODES, type OutboundMode } from '../../../src/policy/types';
import {
  ALLOWED_RECIPIENT,
  STRANGER_RECIPIENT,
  basePolicy,
  contextWith,
  policyWith,
  verifiedThread,
} from './fixtures';

/** 계획 §5.1 의 "관계상태 4". seed·approved 는 관계 행(로더가 매칭한 결과)으로 나타난다. */
const RELATIONSHIP_STATES = ['none', 'seed', 'approved', 'thread_established'] as const;
type RelationshipState = (typeof RELATIONSHIP_STATES)[number];

const LIMIT_STATES = ['ok', 'near', 'exceeded'] as const;
type LimitState = (typeof LIMIT_STATES)[number];

/** 관계상태 → 수신자·관계 행·스레드. seed·approved 는 allowlist 등재와 관계 행을 함께 가진다(프로비저닝과 같은 모양). */
function contextFor(relationship: RelationshipState, limit: LimitState) {
  const inAllowlist = relationship === 'seed' || relationship === 'approved';
  const perMinute = basePolicy.limits.perMinute;

  return contextWith({
    attempt: {
      recipients: [inAllowlist ? ALLOWED_RECIPIENT : STRANGER_RECIPIENT],
    },
    counters: {
      agentLastMinute: limit === 'ok' ? 0 : limit === 'near' ? perMinute - 1 : perMinute,
    },
    approval: {
      // "스레드 성립" 은 **로더가 확인한** 에이전트 스레드 회신이다(P3b) — 시도의 주장이 아니다.
      thread: relationship === 'thread_established' ? verifiedThread('agent') : null,
      relationships: inAllowlist
        ? [{ recipient: ALLOWED_RECIPIENT, trustCategory: relationship, scope: 'recipient' }]
        : [],
    },
  });
}

/** 승인 경로 모드의 기대 판정 (위 표). */
function expectedApprovalPath(
  mode: Extract<OutboundMode, 'approval_required' | 'reply_only'>,
  relationship: RelationshipState,
): { readonly verdict: 'allowed' | 'pending_approval'; readonly reasons: readonly string[] } {
  const grace = mode === 'reply_only' ? ['bootstrap_grace'] : [];
  switch (relationship) {
    case 'none':
      return { verdict: 'pending_approval', reasons: ['new_recipient', ...grace] };
    case 'seed':
      return { verdict: 'allowed', reasons: ['seed_relationship', ...grace] };
    case 'approved':
      return { verdict: 'allowed', reasons: ['standing_approval', ...grace] };
    case 'thread_established':
      // reply_only 의 스레드 회신은 grace 와 무관하다 — 모드 본래의 허용이다.
      return mode === 'reply_only'
        ? { verdict: 'allowed', reasons: ['reply_within_thread'] }
        : { verdict: 'allowed', reasons: ['auto_approve_reply_within_thread'] };
  }
}

describe('engine — outbound_mode(6) × 관계상태(4) × 한도상태(3) = 72 케이스', () => {
  const cases = OUTBOUND_MODES.flatMap((mode) =>
    RELATIONSHIP_STATES.flatMap((relationship) =>
      LIMIT_STATES.map((limit) => ({ mode, relationship, limit })),
    ),
  );

  it('케이스 수가 72 다(계획의 60 + 정책 v2 의 blocklist_only 12) — 축이 조용히 줄어드는 것을 막는다', () => {
    expect(cases).toHaveLength(72);
  });

  for (const { mode, relationship, limit } of cases) {
    it(`${mode} × ${relationship} × ${limit}`, () => {
      const ctx = contextFor(relationship, limit);
      const policy = policyWith({ outboundMode: mode });

      // 한도 초과는 Stage 4 라 Stage 7 보다 먼저 끝난다 — 승인 대기가 아니라 거부(§4.2 원칙 1).
      if (limit === 'exceeded' && mode !== 'disabled') {
        const decision = evaluate(ctx, policy);
        expect(decision.verdict).toBe('denied');
        expect(decision.reasons).toContain('rate_limit_per_minute');
        return;
      }

      if (mode === 'disabled') {
        const decision = evaluate(ctx, policy);
        expect(decision.verdict).toBe('denied');
        expect(decision.reasons).toContain('outbound_disabled');
        return;
      }

      const decision = evaluate(ctx, policy);

      if (mode === 'approval_required' || mode === 'reply_only') {
        const expected = expectedApprovalPath(mode, relationship);
        expect(decision.verdict).toBe(expected.verdict);
        expect([...decision.reasons]).toEqual(expected.reasons);
        return;
      }

      if (mode === 'unrestricted') {
        expect(decision.verdict).toBe('allowed');
        expect(decision.reasons).toEqual(['unrestricted_mode']);
        return;
      }

      // blocklist_only — 차단 목록(픽스처는 비었다)에 없으면 관계·스레드와 무관하게 허용이다.
      if (mode === 'blocklist_only') {
        expect(decision.verdict).toBe('allowed');
        expect(decision.reasons).toEqual(['not_blocklisted']);
        return;
      }

      // allowlist_only — 스레드 회신·관계 행이 있어도 목록 밖이면 거부(승인 경로·스레드 예외 없음).
      const expected = relationship === 'seed' || relationship === 'approved' ? 'allowed' : 'denied';
      expect(decision.verdict).toBe(expected);
    });
  }
});

describe('engine — 모든 결정은 사유와 정책 스탬프를 갖는다', () => {
  it('`reasons` 는 allowed 에서도 비어 있지 않다 (§5.1 속성 불변식 ④)', () => {
    const allowedDecision = evaluate(contextWith({}), basePolicy);
    expect(allowedDecision.verdict).toBe('allowed');
    expect(allowedDecision.reasons.length).toBeGreaterThan(0);
  });

  it('평가 시점 정책 버전이 스탬프된다 (§4.2 "정책 버전")', () => {
    const decision = evaluate(contextWith({}), policyWith({ version: 7 }));
    expect(decision.policyVersion).toBe(7);
    expect(decision.policyVersionId).toBe(basePolicy.versionId);
    expect(decision.evaluatedAt).toEqual(contextWith({}).now);
  });

  it('retry_after 는 한도 계열 거부에만 붙는다', () => {
    const rateDenied = evaluate(
      contextWith({ counters: { agentLastMinute: basePolicy.limits.perMinute } }),
      basePolicy,
    );
    expect(rateDenied.retryAfterSeconds).toBe(60);

    const allowlistDenied = evaluate(
      contextWith({ attempt: { recipients: [STRANGER_RECIPIENT] } }),
      basePolicy,
    );
    expect(allowlistDenied.verdict).toBe('denied');
    expect(allowlistDenied.retryAfterSeconds).toBeNull();
  });
});
