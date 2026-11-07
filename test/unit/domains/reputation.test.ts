/**
 * 평판 동결 판정(ADR-0014 결정 14 · J6) — 윌슨 하한 · 건수 조건 · 계정 기여분 · 7일 · 24시간 창. 집계 질의는 통합 테스트(`test/integration/domains/tick.test.ts`).
 */

import { describe, expect, it } from 'vitest';

import { REPUTATION_THRESHOLDS } from '../../../src/domains/contract';
import { accountContributionReasons, judgeReputation, judgeWindow, wilsonLowerBound } from '../../../src/domains/reputation';

const zero = { attempts: 0, bounces: 0, complaints: 0 };

describe('윌슨 95% 하한', () => {
  it('알려진 값 · 표본이 작으면 낮다 · 0 시도 = 0 · 단조', () => {
    expect(wilsonLowerBound(0, 0)).toBe(0);
    expect(wilsonLowerBound(0, 100)).toBeCloseTo(0, 6);
    // 10/100 → 0.0552(교과서 값).
    expect(wilsonLowerBound(10, 100)).toBeCloseTo(0.0552, 3);
    // 같은 비율 5% 라도 표본이 작으면 하한이 3% 아래 — 우연한 몇 건으로 얼지 않는다.
    expect(wilsonLowerBound(1, 20)).toBeLessThan(REPUTATION_THRESHOLDS.freezeBounceWilsonLower);
    expect(wilsonLowerBound(500, 10_000)).toBeGreaterThan(REPUTATION_THRESHOLDS.freezeBounceWilsonLower);
    for (let n = 10; n < 1_000; n += 37) expect(wilsonLowerBound(n * 0.1, n)).toBeLessThan(0.1);
  });
});

describe('창 판정 · 계정 기여분', () => {
  it('complaint 은 비율 ≥ 0.08% 그리고 ≥ 3건 — 둘 다', () => {
    expect(judgeWindow({ attempts: 2_000, bounces: 0, complaints: 2 }).action).toBe('warn'); // 0.1% 지만 2건(경고 조건은 충족)
    expect(judgeWindow({ attempts: 2_000, bounces: 0, complaints: 3 })).toEqual({ action: 'freeze', reasons: ['complaint_rate'] });
    expect(judgeWindow({ attempts: 100_000, bounces: 0, complaints: 3 }).action).toBe('ok'); // 0.003%
  });

  it('bounce 는 윌슨 하한 ≥ 3% 동결 · ≥ 2% 경고', () => {
    expect(judgeWindow({ attempts: 10_000, bounces: 400, complaints: 0 }).action).toBe('freeze');
    expect(judgeWindow({ attempts: 10_000, bounces: 250, complaints: 0 })).toEqual({ action: 'warn', reasons: ['bounce_wilson_warn'] });
    expect(judgeWindow(zero).action).toBe('ok');
  });

  it('계정 기여분 — 도메인 bounce ÷ 계정 전달 ≥ 1%p · complaint ≥ 0.02%p 면 비율과 무관하게 동결', () => {
    expect(accountContributionReasons({ attempts: 50_000, bounces: 1_000, complaints: 0 }, 100_000)).toEqual(['account_bounce_contribution']);
    expect(accountContributionReasons({ attempts: 50_000, bounces: 999, complaints: 20 }, 100_000)).toEqual(['account_complaint_contribution']);
    expect(accountContributionReasons({ attempts: 50_000, bounces: 1_000, complaints: 20 }, 0)).toEqual([]);
    // 도메인 비율(2%)은 동결선 아래지만 계정 기여분 1%p 로 동결.
    expect(judgeReputation({ week: { attempts: 50_000, bounces: 1_000, complaints: 0 }, day: zero, accountAttemptsWeek: 100_000 })).toEqual({
      action: 'freeze',
      reasons: ['7d:account_bounce_contribution'],
    });
  });

  it('24시간 창의 폭주도 동결한다(7일 창이 희석해도) · 가장 센 것', () => {
    const verdict = judgeReputation({
      week: { attempts: 100_000, bounces: 300, complaints: 1 },
      day: { attempts: 1_000, bounces: 80, complaints: 0 },
      accountAttemptsWeek: 10_000_000,
    });
    expect(verdict).toEqual({ action: 'freeze', reasons: ['24h:bounce_wilson'] });
    expect(judgeReputation({ week: zero, day: zero, accountAttemptsWeek: 0 })).toEqual({ action: 'ok', reasons: [] });
  });

  it('★ 계정 기여분 최소 건수(#13 M3) — complaint 1·2건은 기여분을 넘어도 동결하지 않고 3건이면 판정 · bounce 는 10건부터', () => {
    // 계정 전달이 적은 시기: 1,000 시도에서 complaint 1건 = 0.1%p(기여분 0.02%p 의 다섯 배)여도 건수가 모자라면 그 지표로는 얼지 않는다.
    for (const complaints of [1, 2]) expect(accountContributionReasons({ attempts: 900, bounces: 0, complaints }, 1_000), String(complaints)).toEqual([]);
    expect(accountContributionReasons({ attempts: 900, bounces: 0, complaints: 3 }, 1_000)).toEqual(['account_complaint_contribution']);
    expect(accountContributionReasons({ attempts: 900, bounces: 9, complaints: 0 }, 100)).toEqual([]);
    expect(accountContributionReasons({ attempts: 900, bounces: 10, complaints: 0 }, 100)).toEqual(['account_bounce_contribution']);
    expect(REPUTATION_THRESHOLDS.freezeAccountComplaintMinCount).toBe(REPUTATION_THRESHOLDS.freezeComplaintMinCount);
    // 판정 전체 — complaint 2건(비율 0.22%)은 비율 경로도 최소 건수(3) 미만 · 기여분도 미만 → 경고만.
    expect(judgeReputation({ week: { attempts: 900, bounces: 0, complaints: 2 }, day: zero, accountAttemptsWeek: 1_000 }).action).toBe('warn');
    expect(judgeReputation({ week: { attempts: 900, bounces: 0, complaints: 3 }, day: zero, accountAttemptsWeek: 1_000 }).action).toBe('freeze');
  });

  it('bounce 는 영구만 센다 — 집계가 쓰는 종류는 permanent(일시 · 판정 불가 · NULL 은 분자 밖, 통합 테스트가 질의로 본다)', () => {
    expect(REPUTATION_THRESHOLDS.countedBounceType).toBe('permanent');
  });
});
