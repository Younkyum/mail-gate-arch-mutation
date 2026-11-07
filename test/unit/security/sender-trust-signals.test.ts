/**
 * `src/security/trust-signals.ts` — 사실 → 신호 수집기, 그리고 수집기 + `computeTrust` 를 이은 공격 시나리오.
 *
 * 수집기는 포트가 준 행을 **발신자·에이전트로 다시 거른다.** 포트가 범위를 빠뜨려도 다른 사람의 관계가
 * 이 발신자의 신뢰로 둔갑하지 않아야 한다. 그리고 Phase 1 수집기 집합은 `passport_verified` 를 만들지
 * 않는다(AC-f1).
 */

import { describe, expect, it } from 'vitest';

import { normalizeAddress } from '../../../src/policy/policy-loader';
import { evaluateBlocklist } from '../../../src/policy/rules/blocklist';
import { computeTrust, trustAtLeast } from '../../../src/security/sender-trust';
import {
  collectTrustSignals,
  loadTrustSignals,
  type InboundTrustContext,
  type RelationshipFact,
  type TrustFacts,
  type TrustFactsPort,
} from '../../../src/security/trust-signals';
import { contextWith, policyWith } from '../policy/fixtures';

const AGENT = 'agent-1';
const NOW = new Date('2026-09-23T12:00:00Z');

const EMPTY_FACTS: TrustFacts = {
  relationships: [],
  ownerClassifications: [],
  blocklist: [],
  suppressions: [],
  priorInjectionRisks: [],
  inbound: { count: 0, authenticatedCount: 0, firstAt: null },
  outbound: { sentCount: 0, firstAt: null },
};

function message(overrides: Partial<InboundTrustContext> = {}): InboundTrustContext {
  return { agentId: AGENT, from: 'bob@partner.com', fromAuthenticated: true, authorityThreadId: null, now: NOW, ...overrides };
}

function facts(overrides: Partial<TrustFacts> = {}): TrustFacts {
  return { ...EMPTY_FACTS, ...overrides };
}

function relationship(overrides: Partial<RelationshipFact> = {}): RelationshipFact {
  return {
    agentId: AGENT,
    scope: 'recipient',
    trustCategory: 'approved',
    address: 'bob@partner.com',
    domain: null,
    threadId: null,
    grantedViaApprovalId: 'apr-1',
    ...overrides,
  };
}

function trustOf(ctx: InboundTrustContext, f: TrustFacts) {
  return computeTrust(collectTrustSignals(ctx, f));
}

describe('공격 시나리오 — 첫 메일로 seen 을 얻고 두 번째 메일로 자동 승인을 끌어낸다 (§3.4 3조)', () => {
  it('★ 인증된 첫 메일: unknown', () => {
    const trust = trustOf(message({ from: 'mallory@evil.example' }), EMPTY_FACTS);
    expect(trust.category).toBe('unknown');
  });

  it('★ 인증된 두 번째 메일(이력 1통, injection 없음): 여전히 unknown — `>= seen` 불성립', () => {
    const second = facts({
      priorInjectionRisks: ['none'],
      inbound: { count: 1, authenticatedCount: 1, firstAt: new Date('2026-09-23T11:00:00Z') },
    });
    const trust = trustOf(message({ from: 'mallory@evil.example' }), second);
    expect(trustAtLeast(trust.category, 'seen')).toBe(false);
  });

  it('★ 인내심 있는 공격자(인증 메일 500통·90일·깨끗한 이력·에이전트가 그 스레드에 회신까지): 여전히 unknown', () => {
    const patient = facts({
      priorInjectionRisks: Array.from({ length: 500 }, () => 'none' as const),
      inbound: { count: 500, authenticatedCount: 500, firstAt: new Date('2026-06-25T00:00:00Z') },
      outbound: { sentCount: 20, firstAt: new Date('2026-06-26T00:00:00Z') },
    });
    const trust = trustOf(message({ from: 'mallory@evil.example', authorityThreadId: 'thread-mallory' }), patient);
    expect(trust.category).toBe('unknown');
  });

  it('★ seed 주소를 사칭한 인증 없는 메일: unknown (seed 는 DMARC 통과 시에만)', () => {
    const seeded = facts({ relationships: [relationship({ trustCategory: 'seed', grantedViaApprovalId: null })] });
    expect(trustOf(message({ fromAuthenticated: false }), seeded).category).toBe('unknown');
    expect(trustOf(message({ fromAuthenticated: true }), seeded).category).toBe('seed');
  });
});

describe('수집기 — 포트가 넘치게 줘도 다시 거른다', () => {
  it('다른 주소·다른 에이전트의 관계는 신호가 되지 않는다', () => {
    const leaky = facts({
      relationships: [
        relationship({ address: 'alice@partner.com' }),
        relationship({ agentId: 'agent-2' }),
        relationship({ trustCategory: 'seed', grantedViaApprovalId: null, address: 'carol@partner.com' }),
      ],
      ownerClassifications: [
        { agentId: 'agent-2', scope: 'address', address: 'bob@partner.com', domain: null, category: 'seen' },
        { agentId: AGENT, scope: 'address', address: 'alice@partner.com', domain: null, category: 'seen' },
        { agentId: AGENT, scope: 'domain', address: null, domain: 'other.com', category: 'seen' },
      ],
    });
    const signals = collectTrustSignals(message(), leaky);
    expect(signals.map((s) => s.kind).sort()).toEqual(['contact_history', 'spf_dkim_aligned']);
    expect(computeTrust(signals).category).toBe('unknown');
  });

  it('올림은 좁게 — `+tag` 발신자는 태그 없는 주소의 관계를 빌리지 못한다', () => {
    const f = facts({ relationships: [relationship()] });
    expect(trustOf(message({ from: 'Bob@Partner.com' }), f).category).toBe('approved');
    expect(trustOf(message({ from: 'bob+x@partner.com' }), f).category).toBe('unknown');
  });

  // V3 T7·T8 — `+tag` 좁힘은 **올리는 신호 전부**에 따로 걸려 있다. 하나만 넓혀도 그 줄이 빨갛다
  // (예전에는 approved 관계에만 단언이 있어 seed·수동 분류·스레드 스코프를 넓히는 변이가 초록이었다).
  it('★ seed 도 좁게 — `+tag` 발신자는 seed 주소의 신뢰를 빌리지 못한다', () => {
    const f = facts({ relationships: [relationship({ trustCategory: 'seed', grantedViaApprovalId: null })] });
    expect(trustOf(message({ from: 'Bob@Partner.com' }), f).category).toBe('seed');
    expect(trustOf(message({ from: 'bob+x@partner.com' }), f).category).toBe('unknown');
  });

  it('★ 소유자 수동 분류(주소 스코프)도 좁게 — `+tag` 발신자는 seen 을 빌리지 못한다', () => {
    const f = facts({
      ownerClassifications: [{ agentId: AGENT, scope: 'address', address: 'bob@partner.com', domain: null, category: 'seen' }],
    });
    expect(trustOf(message({ from: 'Bob@Partner.com' }), f).category).toBe('seen');
    expect(trustOf(message({ from: 'bob+x@partner.com' }), f).category).toBe('unknown');
  });

  it('★ 스레드 스코프 관계도 좁게 — 같은 스레드여도 `+tag` 발신자는 빌리지 못한다', () => {
    const f = facts({ relationships: [relationship({ scope: 'thread', threadId: 'thread-1' })] });
    expect(trustOf(message({ authorityThreadId: 'thread-1' }), f).category).toBe('approved');
    expect(trustOf(message({ from: 'bob+x@partner.com', authorityThreadId: 'thread-1' }), f).category).toBe('unknown');
  });

  it('도메인 관계는 정확 일치만 — 하위 도메인은 빌리지 못한다', () => {
    const f = facts({ relationships: [relationship({ scope: 'domain', address: null, domain: 'partner.com' })] });
    expect(trustOf(message({ from: 'dave@partner.com' }), f).category).toBe('approved');
    expect(trustOf(message({ from: 'dave@mail.partner.com' }), f).category).toBe('unknown');
  });

  it('gmail.com 도메인 관계는 gmail 발신자에게 신뢰를 주지 않는다', () => {
    const f = facts({ relationships: [relationship({ scope: 'domain', address: null, domain: 'gmail.com' })] });
    expect(trustOf(message({ from: 'anyone@gmail.com' }), f).category).toBe('unknown');
  });

  it('스레드 스코프 관계는 이 메일의 권한용 스레드가 그 스레드일 때만', () => {
    const f = facts({ relationships: [relationship({ scope: 'thread', threadId: 'thread-1' })] });
    expect(trustOf(message({ authorityThreadId: 'thread-1' }), f).category).toBe('approved');
    expect(trustOf(message({ authorityThreadId: 'thread-2' }), f).category).toBe('unknown');
    expect(trustOf(message({ authorityThreadId: null }), f).category).toBe('unknown');
  });

  it('승인 id 없는 approved 행·주소 스코프가 아닌 seed 행은 신호가 되지 않는다', () => {
    const f = facts({
      relationships: [
        relationship({ grantedViaApprovalId: null }),
        relationship({ trustCategory: 'seed', scope: 'domain', address: null, domain: 'partner.com', grantedViaApprovalId: null }),
      ],
    });
    expect(trustOf(message(), f).category).toBe('unknown');
  });

  it('소유자 수동 분류(주소·도메인)는 seen 을 만든다', () => {
    const byAddress = facts({
      ownerClassifications: [{ agentId: AGENT, scope: 'address', address: 'noreply@github.com', domain: null, category: 'seen' }],
    });
    expect(trustOf(message({ from: 'noreply@github.com' }), byAddress).category).toBe('seen');
    const byDomain = facts({
      ownerClassifications: [{ agentId: AGENT, scope: 'domain', address: null, domain: 'github.com', category: 'seen' }],
    });
    expect(trustOf(message({ from: 'noreply@github.com' }), byDomain).category).toBe('seen');
  });

  it('주소 모양이 아닌 From 은 아무것도 얻지 못한다', () => {
    const f = facts({ relationships: [relationship()], blocklist: ['bob@partner.com'] });
    expect(trustOf(message({ from: 'not-an-address' }), f).category).toBe('unknown');
  });
});

describe('수집기 — 막는 신호는 넓게', () => {
  it('blocklist 는 `+tag`·대소문자·하위 도메인(`*.`) 변형 앞에서도 걸리고, 승인 관계를 이긴다', () => {
    const f = facts({ blocklist: ['bob@partner.com', 'evil.example', '*.evil.example'], relationships: [relationship()] });
    expect(trustOf(message({ from: 'Bob+x@Partner.com' }), f).category).toBe('blocked');
    expect(trustOf(message({ from: 'x@mail.evil.example' }), f).category).toBe('blocked');
    expect(trustOf(message({ from: 'bob@partner.com', fromAuthenticated: false }), f).category).toBe('blocked');
  });

  it('blocklist 판정은 관문 Stage 3(`evaluateBlocklist`)과 같다 — 정규화 지점이 갈라지지 않는다', () => {
    // 정책 v2 규칙 값 — 주소 · 정확한 도메인 · `*.` 하위 도메인(`contact-rules.ts`). 모양 밖 값(`@`)도 섞어 둔다 — 둘 다 무시해야 한다.
    const blocklist = ['bob@partner.com', 'evil.example', '*.evil.example', '@', 'plain.example'];
    const senders = [
      'bob@partner.com',
      'Bob+tag@partner.com',
      'alice@partner.com',
      'x@evil.example',
      'x@deep.mail.evil.example',
      'x@notevil.example',
      'x@plain.example',
      'x@partner.com',
    ];
    for (const sender of senders) {
      const gate = evaluateBlocklist(
        contextWith({ attempt: { recipients: [normalizeAddress(sender)] } }),
        policyWith({ blocklist }),
      );
      const collected = collectTrustSignals(message({ from: sender }), facts({ blocklist }));
      expect(collected.some((s) => s.kind === 'blocklisted'), sender).toBe(gate !== null);
    }
  });

  it('억제 목록은 만료 전까지만 걸린다', () => {
    const f = (expiresAt: Date | null) =>
      facts({
        relationships: [relationship()],
        suppressions: [{ address: 'bob@partner.com', source: 'bounce', expiresAt }],
      });
    expect(trustOf(message({ from: 'bob+x@partner.com' }), f(null)).capped).toContain('suppression_hit');
    expect(trustOf(message(), f(new Date('2026-09-24T00:00:00Z'))).category).toBe('unknown');
    expect(trustOf(message(), f(NOW)).category).toBe('approved');
  });

  it('과거 injection 판정은 가장 나쁜 값 하나로 모이고, `none` 만이면 신호가 없다', () => {
    const worst = collectTrustSignals(message(), facts({ priorInjectionRisks: ['low', 'none', 'high', 'medium'] }));
    expect(worst.filter((s) => s.kind === 'injection_history')).toEqual([{ kind: 'injection_history', worst: 'high' }]);
    const clean = collectTrustSignals(message(), facts({ priorInjectionRisks: ['none', 'none'] }));
    expect(clean.some((s) => s.kind === 'injection_history')).toBe(false);
  });
});

describe('AC-f1 — Phase 1 수집기 집합은 passport_verified 를 만들지 않는다 (§4B.4)', () => {
  it('사실 조합 전수(인증·관계 스코프·분류·차단·억제·injection·이력)에서 passport_verified 0건', () => {
    const relationshipVariants: RelationshipFact[][] = [
      [],
      [relationship()],
      [relationship({ trustCategory: 'seed', grantedViaApprovalId: null })],
      [relationship({ scope: 'thread', threadId: 't' })],
      [relationship({ scope: 'domain', address: null, domain: 'partner.com' })],
    ];
    const kinds = new Set<string>();
    for (const fromAuthenticated of [true, false]) {
      for (const relationships of relationshipVariants) {
        for (const blocklist of [[], ['partner.com']]) {
          for (const priorInjectionRisks of [[], ['high']] as const) {
            for (const seenMark of [false, true]) {
              const signals = collectTrustSignals(
                message({ fromAuthenticated, authorityThreadId: 't' }),
                facts({
                  relationships,
                  blocklist,
                  priorInjectionRisks,
                  suppressions: [{ address: 'bob@partner.com', source: 'manual', expiresAt: null }],
                  ownerClassifications: seenMark
                    ? [{ agentId: AGENT, scope: 'address', address: 'bob@partner.com', domain: null, category: 'seen' }]
                    : [],
                  inbound: { count: 3, authenticatedCount: 3, firstAt: NOW },
                  outbound: { sentCount: 1, firstAt: NOW },
                }),
              );
              for (const signal of signals) kinds.add(signal.kind);
              // 수집기 출력은 언제나 computeTrust 가 던지지 않고 받는다.
              expect(() => computeTrust(signals)).not.toThrow();
            }
          }
        }
      }
    }
    expect(kinds.has('passport_verified')).toBe(false);
    // 전수가 공허하지 않다 — 나머지 8종은 전부 한 번 이상 나왔다.
    expect([...kinds].sort()).toEqual([
      'approved_relationship',
      'blocklisted',
      'contact_history',
      'injection_history',
      'owner_marked_seen',
      'seed_contact',
      'spf_dkim_aligned',
      'suppression_hit',
    ]);
  });
});

describe('포트', () => {
  it('loadTrustSignals 는 봉투 에이전트와 From 원형으로 포트를 부른다', async () => {
    const calls: [string, string][] = [];
    const port: TrustFactsPort = {
      loadTrustFacts(agentId, sender) {
        calls.push([agentId, sender]);
        return Promise.resolve(facts({ relationships: [relationship()] }));
      },
    };
    const signals = await loadTrustSignals(message({ from: 'Bob@Partner.com' }), port);
    expect(calls).toEqual([[AGENT, 'Bob@Partner.com']]);
    expect(computeTrust(signals).category).toBe('approved');
  });
});
