/**
 * `src/security/sender-trust.ts` — `computeTrust` 는 **권한 판정의 입력**이다.
 *
 * `sender_trust >= seen` 은 `auto_approve_verification_senders`(§3.4 3조)의 전제다. 이 파일의 절반은
 * "올릴 것을 올린다" 이고, 나머지 절반은 **올리지 말아야 할 것을 올리지 않는다**: 메일 N통, 인증 없는
 * 발신자, 공유 도메인 신뢰, 차단을 덮는 다른 신호, 수집기 없는 `passport_verified`. 뒤쪽이 빨개지지
 * 않는 판정기는 승인 우회 장치다.
 */

import { describe, expect, it } from 'vitest';

import {
  computeTrust,
  trustAtLeast,
  UncollectedTrustSignalError,
  type SenderTrustCategory,
  type TrustFloor,
} from '../../../src/security/sender-trust';
import { isSharedMailboxDomain } from '../../../src/security/shared-mailbox';
import type { TrustSignal } from '../../../src/security/trust-signals';

const AUTH: TrustSignal = { kind: 'spf_dkim_aligned' };
const SEED: TrustSignal = { kind: 'seed_contact' };
const APPROVED: TrustSignal = { kind: 'approved_relationship', scope: 'recipient', domain: null, approvalId: 'apr-1' };
const MARKED_SEEN: TrustSignal = { kind: 'owner_marked_seen', scope: 'address', domain: null };
const BLOCKED: TrustSignal = { kind: 'blocklisted', entry: 'mallory@evil.example' };
const PASSPORT: TrustSignal = { kind: 'passport_verified', did: 'did:web:atmark.ai:agents:x' };

/** 공격자가 원하는 만큼 쌓을 수 있는 이력 — 전부 인증, 1년, 에이전트 발신까지. */
const HEAVY_HISTORY: TrustSignal = {
  kind: 'contact_history',
  inboundCount: 10_000,
  authenticatedInboundCount: 10_000,
  outboundSentCount: 50,
  firstInboundAt: new Date('2025-01-01T00:00:00Z'),
  firstOutboundAt: new Date('2025-01-02T00:00:00Z'),
};

const ALL_CATEGORIES: readonly SenderTrustCategory[] = ['blocked', 'unknown', 'seen', 'seed', 'approved'];
const ALL_FLOORS: readonly TrustFloor[] = ['unknown', 'seen', 'seed', 'approved'];

function permutations<T>(items: readonly T[]): T[][] {
  if (items.length <= 1) return [items.slice()];
  return items.flatMap((item, index) =>
    permutations([...items.slice(0, index), ...items.slice(index + 1)]).map((rest) => [item, ...rest]),
  );
}

describe('격자 — blocked < unknown < seen < seed < approved', () => {
  it('`>= seen` 을 만족하는 것은 seen·seed·approved 뿐이다', () => {
    const passing = ALL_CATEGORIES.filter((category) => trustAtLeast(category, 'seen'));
    expect(passing).toEqual(['seen', 'seed', 'approved']);
  });

  it('blocked 는 어떤 하한에도 진다 — `unknown` 하한조차', () => {
    for (const floor of ALL_FLOORS) expect(trustAtLeast('blocked', floor)).toBe(false);
  });

  it('비교는 전순서다 — 반사적이고 추이적이다', () => {
    const chain: readonly TrustFloor[] = ['unknown', 'seen', 'seed', 'approved'];
    chain.forEach((category, i) => {
      chain.forEach((floor, j) => expect(trustAtLeast(category, floor)).toBe(i >= j));
    });
  });
});

describe('computeTrust — 올릴 것을 올린다', () => {
  it('신호가 없으면 unknown', () => {
    expect(computeTrust([])).toEqual({ category: 'unknown', decidedBy: null, capped: [] });
  });

  it.each([
    [MARKED_SEEN, 'seen'],
    [SEED, 'seed'],
    [APPROVED, 'approved'],
  ] as const)('인증된 %o → %s', (signal, category) => {
    const trust = computeTrust([AUTH, signal]);
    expect(trust.category).toBe(category);
    expect(trust.decidedBy).toBe(signal.kind);
    expect(trustAtLeast(trust.category, 'seen')).toBe(true);
  });

  it('여러 올림이 있으면 가장 높은 것 — 순서와 무관하다', () => {
    for (const order of permutations([AUTH, MARKED_SEEN, SEED, APPROVED])) {
      expect(computeTrust(order).category).toBe('approved');
    }
  });

  it('소유자가 명시한 조직 도메인 신뢰는 유효하다', () => {
    const domain: TrustSignal = { kind: 'approved_relationship', scope: 'domain', domain: 'partner.com', approvalId: 'apr-2' };
    expect(computeTrust([AUTH, domain]).category).toBe('approved');
    expect(computeTrust([AUTH, { kind: 'owner_marked_seen', scope: 'domain', domain: 'github.com' }]).category).toBe('seen');
  });
});

describe('computeTrust — 올리지 말아야 할 것을 올리지 않는다', () => {
  it('★ 이력만으로는 seen 이 되지 않는다 — 인증된 메일 1만 통·1년·에이전트 발신 50통이어도 unknown', () => {
    const trust = computeTrust([AUTH, HEAVY_HISTORY]);
    expect(trust.category).toBe('unknown');
    expect(trustAtLeast(trust.category, 'seen')).toBe(false);
  });

  it('★ 인증 없는 발신자는 어떤 관계도 빌리지 못한다 — From 사칭', () => {
    for (const signal of [MARKED_SEEN, SEED, APPROVED]) {
      const trust = computeTrust([signal, HEAVY_HISTORY]);
      expect(trust.category).toBe('unknown');
      expect(trust.capped).toContain('unauthenticated');
    }
    expect(computeTrust([MARKED_SEEN, SEED, APPROVED]).category).toBe('unknown');
  });

  it('억제 목록·과거 injection 판정은 상한을 unknown 으로 누른다', () => {
    const suppressed = computeTrust([AUTH, SEED, { kind: 'suppression_hit', source: 'complaint' }]);
    expect(suppressed).toEqual({ category: 'unknown', decidedBy: null, capped: ['suppression_hit'] });

    for (const worst of ['low', 'medium', 'high'] as const) {
      const tainted = computeTrust([AUTH, APPROVED, { kind: 'injection_history', worst }]);
      expect(tainted.category).toBe('unknown');
      expect(tainted.capped).toEqual(['injection_history']);
    }
  });

  it.each(['gmail.com', 'Mail.Yahoo.com', 'naver.com', 'atmark.ai'])(
    '공유 메일 도메인(%s)의 도메인 스코프 신뢰는 무효다',
    (domain) => {
      const approved: TrustSignal = { kind: 'approved_relationship', scope: 'domain', domain, approvalId: 'apr-3' };
      const marked: TrustSignal = { kind: 'owner_marked_seen', scope: 'domain', domain };
      for (const signal of [approved, marked]) {
        const trust = computeTrust([AUTH, signal]);
        expect(trust.category).toBe('unknown');
        expect(trust.capped).toEqual(['shared_domain_scope']);
      }
    },
  );

  it('도메인 스코프인데 도메인이 없으면 무효다(모양이 틀린 신호가 공유 도메인 검사를 건너뛰지 않는다)', () => {
    const shapeless: TrustSignal = { kind: 'approved_relationship', scope: 'domain', domain: null, approvalId: 'apr-4' };
    expect(computeTrust([AUTH, shapeless]).category).toBe('unknown');
  });

  it('공유 도메인 목록은 에이전트 도메인과 무료 메일 하위 도메인을 덮고, 조직 도메인은 덮지 않는다', () => {
    expect(isSharedMailboxDomain('atmark.ai')).toBe(true);
    expect(isSharedMailboxDomain(' GMAIL.COM ')).toBe(true);
    expect(isSharedMailboxDomain('mail.yahoo.com')).toBe(true);
    expect(isSharedMailboxDomain('partner.com')).toBe(false);
    expect(isSharedMailboxDomain('notgmail.com')).toBe(false);
  });
});

describe('computeTrust — blocked 는 흡수한다', () => {
  it('★ 차단 신호는 인증·seed·승인·수동 분류·이력 어떤 조합과 어떤 순서에도 blocked 다', () => {
    const others = [AUTH, SEED, APPROVED, MARKED_SEEN, HEAVY_HISTORY];
    for (const order of permutations([BLOCKED, ...others])) {
      const trust = computeTrust(order);
      expect(trust.category).toBe('blocked');
      expect(trust.decidedBy).toBe('blocklisted');
      expect(trustAtLeast(trust.category, 'seen')).toBe(false);
    }
  });

  it('차단은 인증을 요구하지 않는다 — 사칭된 From 이 차단 주소를 달고 와도 막는다', () => {
    expect(computeTrust([BLOCKED]).category).toBe('blocked');
  });
});

describe('computeTrust — passport_verified 는 선언만 됐다 (§4B.4)', () => {
  it('★ 들어오면 던진다 — 단독이든, 올림·차단과 함께든, 어느 위치든', () => {
    const cases: TrustSignal[][] = [
      [PASSPORT],
      [AUTH, PASSPORT],
      [AUTH, SEED, PASSPORT],
      [PASSPORT, AUTH, APPROVED],
      [BLOCKED, PASSPORT],
    ];
    for (const signals of cases) {
      expect(() => computeTrust(signals)).toThrow(UncollectedTrustSignalError);
    }
  });

  it('던지는 오류는 신호 이름을 싣는다', () => {
    try {
      computeTrust([AUTH, PASSPORT]);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(UncollectedTrustSignalError);
      expect((error as UncollectedTrustSignalError).kind).toBe('passport_verified');
    }
  });
});
