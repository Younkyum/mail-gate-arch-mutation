/**
 * 고객 도메인 관문(ADR-0014 결정 7 · 계획 §3.7 · 단계 3) — Stage 0 `domain_suspended`/`domain_plan_limit` · Stage 4 `domain_warmup_daily_cap` ·
 * Stage 1 `from_inactive`(ADR-0014 개정 — 이 에이전트의 주소지만 지금 쓸 수 없다).
 *
 *   ① Stage 0 표 — `platform`·`verified` 통과, `blocked` → `domain_suspended`, `plan_limit` → `domain_plan_limit`, 바인딩 아닌 도메인 → Stage 1
 *      `from_forgery`. 대표·별칭을 가리지 않는다(도메인만 본다). `domain_pending` 사유는 코드에 없다.
 *   ② 다중 도메인 위조 표(L8) — **어느 층이 막는가**를 적는다(관문 층만 — API 400 · IAM 은 다른 테스트).
 *   ③ Stage 4 — 도메인 워밍업 캡(조직 표 재사용 · 수신자 눈금 · 첫 발송일 기준), 우선순위 조직 > 도메인 > 요금제, atmark.ai 무적용.
 *   ④ 속성(시드 고정 mulberry32) — 도메인 캡은 실효 상한을 넓히지 않는다: 도메인 축을 더한 판정이 허용이면 도메인 축 없이도 허용이다.
 *   ⑤ 회귀 — 고객 도메인 행 0(바인딩 도메인 = atmark.ai 뿐 · sendingDomain null)이면 Stage 0·4 판정은 단계 3 전과 같다.
 *   ⑥ Stage 1 — 폐기된 자기 주소는 `from_inactive`(PERMANENT · 위반 아님), 모르는 주소는 그대로 `from_forgery`.
 */

import { describe, expect, it } from 'vitest';

import { POLICY_VIOLATION_REASONS } from '../../../src/passport/attestations';
import { evaluate } from '../../../src/policy/engine';
import { DENY_REASON_PERSISTENCE } from '../../../src/policy/release-deferral';
import { evaluateKillSwitches } from '../../../src/policy/rules/kill-switch';
import { evaluateLimits, isDomainWarmupCapExceeded, warmupDailyCap } from '../../../src/policy/rules/limits';
import type { DomainGateStatus, EvaluationContext } from '../../../src/policy/types';
import { AGENT_ADDRESS, basePolicy, contextWith, NOW } from './fixtures';

const CUSTOM = 'agents.customer.com';
const ALIAS = `bot@${CUSTOM}`;

/** 대표 atmark.ai + 고객 도메인 별칭 하나에 묶인 에이전트, 고객 도메인 상태 `status`. */
function boundTo(status: DomainGateStatus, from = ALIAS): EvaluationContext {
  return contextWith({
    agent: {
      boundAddresses: [AGENT_ADDRESS, ALIAS],
      boundDomains: new Map<string, DomainGateStatus>([
        ['atmark.ai', 'platform'],
        [CUSTOM, status],
      ]),
    },
    attempt: { fromAddress: from },
    sendingDomain: from.endsWith(`@${CUSTOM}`) ? { domain: CUSTOM, sendingStartedAt: new Date('2026-09-01T00:00:00Z') } : null,
  });
}

describe('① Stage 0 — 발신 도메인의 관문 상태', () => {
  it.each([
    ['platform', null],
    ['verified', null],
    ['blocked', 'domain_suspended'],
    ['plan_limit', 'domain_plan_limit'],
  ] as const)('%s → %s', (status, expected) => {
    const result = evaluateKillSwitches(boundTo(status), basePolicy);
    expect(result === null ? null : result.reasons).toEqual(expected === null ? null : [expected]);
    const decision = evaluate(boundTo(status), basePolicy);
    if (expected === null) expect(decision.verdict).toBe('allowed');
    else expect(decision).toMatchObject({ verdict: 'denied', reasons: [expected] });
  });

  it('도메인만 본다 — 같은 에이전트가 atmark.ai 대표로 보내면 고객 도메인이 정지여도 통과(대표·별칭 무관)', () => {
    expect(evaluate(boundTo('blocked', AGENT_ADDRESS), basePolicy).verdict).toBe('allowed');
  });

  it('다른 Stage 0 사유와 함께 적힌다(목록 — 단락 없음)', () => {
    const ctx = { ...boundTo('blocked'), organization: { ...boundTo('blocked').organization, abuseFreeze: true } };
    expect(evaluateKillSwitches(ctx, basePolicy)?.reasons).toEqual(['org_abuse_freeze', 'domain_suspended']);
  });

  it('릴리스 분류 — domain_suspended 는 영구(즉시 종결) · domain_plan_limit 은 미룸(1시간)', () => {
    expect(DENY_REASON_PERSISTENCE['domain_suspended']).toMatchObject({ kind: 'permanent' });
    expect(DENY_REASON_PERSISTENCE['domain_plan_limit']).toMatchObject({ kind: 'transient' });
  });
});

describe('② 다중 도메인 위조 표(L8) — 관문 층', () => {
  // 에이전트: a@atmark.ai 대표 + bot@agents.customer.com 별칭(verified). 로더가 From 을 정규화하므로 대문자·+tag 는 관문을 지난다(API·IAM 층이 막는다).
  const table: readonly (readonly [string, string, string | null])[] = [
    ['자기 별칭', ALIAS, null],
    ['같은 도메인의 남의 로컬파트(바인딩 도메인 — Stage 1)', `other@${CUSTOM}`, 'from_forgery'],
    ['다른 도메인 atmark.ai 의 남의 주소', 'someone@atmark.ai', 'from_forgery'],
    ['하위 도메인(바인딩 아님 — Stage 1)', `bot@sub.${CUSTOM}`, 'from_forgery'],
    ['apex(바인딩 아님)', 'bot@customer.com', 'from_forgery'],
    ['끝 점(바인딩 아님)', `bot@${CUSTOM}.`, 'from_forgery'],
  ];
  it.each(table)('%s — %s → %s', (_label, from, expected) => {
    const decision = evaluate(boundTo('verified', from), basePolicy);
    if (expected === null) expect(decision.verdict).toBe('allowed');
    else expect(decision).toMatchObject({ verdict: 'denied', reasons: [expected] });
  });

  it.each(['blocked', 'plan_limit'] as const)(
    '정지(%s)된 바인딩 도메인에서 로컬파트를 위조해도 Stage 1 from_forgery(위반) — 도메인 제동은 바인딩 주소에만 건다(보안 리뷰 M2)',
    (status) => {
      const forged = `other@${CUSTOM}`;
      expect(evaluateKillSwitches(boundTo(status, forged), basePolicy)).toBeNull();
      expect(evaluate(boundTo(status, forged), basePolicy)).toMatchObject({ verdict: 'denied', reasons: ['from_forgery'] });
      // 정지 전에도 같다.
      expect(evaluate(boundTo('verified', forged), basePolicy)).toMatchObject({ verdict: 'denied', reasons: ['from_forgery'] });
      // plan_limit 위조가 transient 로 재시도되지 않는다 — from_forgery 는 영구.
      expect(DENY_REASON_PERSISTENCE['from_forgery']).toMatchObject({ kind: 'permanent' });
      expect(evaluate(boundTo(status, `bot@sub.${CUSTOM}`), basePolicy)).toMatchObject({ verdict: 'denied', reasons: ['from_forgery'] });
    },
  );
});

describe('③ Stage 4 — 도메인 워밍업 캡', () => {
  const domainDay1 = { domain: CUSTOM, sendingStartedAt: NOW };

  it('도메인 Day 1 캡 20(수신자 눈금) — 19 + 1 통과 · 20 + 1 거부(domain_warmup_daily_cap)', () => {
    const ok = contextWith({ ...boundTo('verified'), sendingDomain: domainDay1, counters: { domainRecipientsLastDay: 19 } });
    expect(evaluateLimits(ok, basePolicy)).toBeNull();
    const over = contextWith({ ...boundTo('verified'), sendingDomain: domainDay1, counters: { domainRecipientsLastDay: 20 } });
    expect(evaluateLimits(over, basePolicy)?.reasons).toEqual(['domain_warmup_daily_cap']);
    expect(evaluateLimits(over, basePolicy)?.retryAfterSeconds).toBeGreaterThan(0);
  });

  it('첫 발송 전(sending_started_at null)은 첫 구간 20 — 기준일이 없다고 캡이 사라지지 않는다', () => {
    const ctx = contextWith({ ...boundTo('verified'), sendingDomain: { domain: CUSTOM, sendingStartedAt: null }, counters: { domainRecipientsLastDay: 20 } });
    expect(isDomainWarmupCapExceeded(ctx)).toBe(true);
  });

  it('우선순위 — 조직 워밍업 > 도메인 워밍업 > 요금제(사유는 하나)', () => {
    const base = { ...boundTo('verified'), sendingDomain: domainDay1 };
    // 셋 다 넘었다 → 조직 워밍업(조직 Day 16+ = 1000).
    const all = contextWith({ ...base, counters: { orgRecipientsLastDay: 1000, domainRecipientsLastDay: 20 } });
    expect(evaluateLimits(all, basePolicy)?.reasons).toEqual(['warmup_daily_cap']);
    // 도메인 + 요금제(beta 요금제 하루 수신자 한도보다 큰 수) → 도메인.
    const plan = all.organization.entitlements.orgDailyRecipients;
    const domainAndPlan = contextWith({ ...base, organization: { sendingStartedAt: new Date('2026-01-01T00:00:00Z') }, counters: { orgRecipientsLastDay: plan, domainRecipientsLastDay: 20 } });
    expect(evaluateLimits(domainAndPlan, basePolicy)?.reasons).toEqual(
      plan < warmupDailyCap(NOW, new Date('2026-01-01T00:00:00Z')) ? ['domain_warmup_daily_cap'] : ['warmup_daily_cap'],
    );
    // 도메인 안 · 요금제만 → 요금제.
    const planOnly = contextWith({ ...base, counters: { orgRecipientsLastDay: plan, domainRecipientsLastDay: 0 } });
    expect(evaluateLimits(planOnly, basePolicy)?.reasons).toEqual(plan < 1000 ? ['plan_daily_cap'] : ['warmup_daily_cap']);
  });

  it('atmark.ai 발신(sendingDomain null)은 도메인 카운터가 커도 도메인 캡이 없다', () => {
    const ctx = contextWith({ sendingDomain: null, counters: { domainRecipientsLastDay: 1_000_000 } });
    expect(isDomainWarmupCapExceeded(ctx)).toBe(false);
    expect(evaluateLimits(ctx, basePolicy)).toBeNull();
  });

  it('릴리스 분류 — 미룸(transient)', () => {
    expect(DENY_REASON_PERSISTENCE['domain_warmup_daily_cap']).toMatchObject({ kind: 'transient' });
  });
});

/** 시드 고정 난수(빨강이 재현된다). */
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

describe('④ 속성 — 도메인 캡은 실효 상한을 넓히지 않는다', () => {
  it('시드 고정 5,000 사례: 도메인 축을 더한 판정이 허용이면 도메인 축을 뺀 판정도 허용 · 거부 사유 집합은 단조', () => {
    const random = mulberry32(20261002);
    const int = (max: number): number => Math.floor(random() * (max + 1));
    const statuses: DomainGateStatus[] = ['platform', 'verified', 'plan_limit', 'blocked'];
    for (let i = 0; i < 5000; i += 1) {
      const started = int(3) === 0 ? null : new Date(NOW.getTime() - int(30) * 86_400_000);
      const orgStarted = new Date(NOW.getTime() - int(30) * 86_400_000);
      const recipients = Array.from({ length: 1 + int(4) }, (_, k) => `r${String(k)}@example.com`);
      const withDomain = contextWith({
        ...boundTo(statuses[int(3)] as DomainGateStatus),
        organization: { sendingStartedAt: orgStarted },
        attempt: { fromAddress: ALIAS, recipients },
        approval: { recipients },
        sendingDomain: { domain: CUSTOM, sendingStartedAt: started },
        counters: { orgRecipientsLastDay: int(1200), domainRecipientsLastDay: int(1200) },
      });
      // 같은 시도에서 도메인 축만 뺀다(고객 도메인 행이 없던 세계 — atmark.ai 처럼).
      const withoutDomain: EvaluationContext = {
        ...withDomain,
        agent: { ...withDomain.agent, boundDomains: new Map([...withDomain.agent.boundDomains].map(([d]) => [d, 'platform' as const])) },
        sendingDomain: null,
        counters: { ...withDomain.counters, domainRecipientsLastDay: 0 },
      };
      const a = evaluate(withDomain, { ...basePolicy, outboundMode: 'unrestricted' });
      const b = evaluate(withoutDomain, { ...basePolicy, outboundMode: 'unrestricted' });
      if (a.verdict === 'allowed') expect(b.verdict, `사례 ${String(i)}`).toBe('allowed');
      // 도메인 축이 없는 쪽이 거부면 도메인 축이 있는 쪽도 거부다(Stage 0 의 다른 축 · 조직 캡 · 요금제는 같다).
      if (b.verdict === 'denied') expect(a.verdict, `사례 ${String(i)}`).toBe('denied');
    }
  });
});

describe('⑤ 회귀 — 고객 도메인 행 0 이면 판정이 단계 3 전과 같다', () => {
  it('바인딩 = atmark.ai(platform) · sendingDomain null · 도메인 카운터 0 → Stage 0 은 도메인 사유를 만들지 않고 Stage 4 는 도메인 캡을 보지 않는다', () => {
    const random = mulberry32(7);
    for (let i = 0; i < 2000; i += 1) {
      const ctx = contextWith({
        organization: { abuseFreeze: random() < 0.1, ownerPaused: random() < 0.1, sendingStartedAt: new Date(NOW.getTime() - Math.floor(random() * 30) * 86_400_000) },
        counters: { orgRecipientsLastDay: Math.floor(random() * 1200), agentLastDay: Math.floor(random() * 600) },
      });
      const decision = evaluate(ctx, basePolicy);
      const reasons = decision.verdict === 'denied' ? decision.reasons : [];
      expect(reasons.filter((reason) => reason.startsWith('domain_'))).toEqual([]);
      // 도메인 축을 지운 같은 입력(boundDomains 비움)과 판정이 같다 — 도메인 분기는 atmark.ai 에서 아무 일도 하지 않는다.
      const bare = evaluate({ ...ctx, agent: { ...ctx.agent, boundDomains: new Map() } }, basePolicy);
      expect(bare).toEqual(decision);
    }
  });
});

describe('⑥ Stage 1 — from_inactive(이 에이전트의 주소지만 지금 쓸 수 없다)', () => {
  const RETIRED = 'old-alias@atmark.ai';

  it('폐기된 자기 별칭 → from_inactive · 모르는 주소 → from_forgery', () => {
    const retired = contextWith({ agent: { inactiveAddresses: [RETIRED] }, attempt: { fromAddress: RETIRED } });
    expect(evaluate(retired, basePolicy)).toMatchObject({ verdict: 'denied', reasons: ['from_inactive'] });
    const unknown = contextWith({ agent: { inactiveAddresses: [RETIRED] }, attempt: { fromAddress: 'stranger@atmark.ai' } });
    expect(evaluate(unknown, basePolicy)).toMatchObject({ verdict: 'denied', reasons: ['from_forgery'] });
  });

  it('PERMANENT(릴리스 즉시 종결) · 위반 아님(여권 no_policy_violations 를 깨지 않는다)', () => {
    expect(DENY_REASON_PERSISTENCE['from_inactive']).toMatchObject({ kind: 'permanent' });
    expect(POLICY_VIOLATION_REASONS).not.toContain('from_inactive');
    expect(POLICY_VIOLATION_REASONS).toContain('from_forgery');
  });
});
