/**
 * AC-0 판정 (§3.2 C1·V1, §11B B2①②) — **공허 통과 경로를 하나씩 막는다.**
 *
 * 각 절은 "통과 시나리오에서 한 가지만 뺀 것" 이다. 기준 시나리오(`judge({})`)가 통과하는 것을 먼저
 * 확인하므로, 아래의 비-통과는 판정이 원래 통과를 못 내는 것이 아니라 **그 한 가지 때문에** 막힌 것이다.
 */

import { describe, expect, it } from 'vitest';

import {
  AC0_MIN_BASELINE_SENDERS,
  Ac0InputError,
  ac0ActivityWindows,
  decideAc0,
  type GateEvent,
  type InterventionRecord,
} from '../../../src/gate/ac0-verdict';
import { activityFor, arrivals, at, DECLINING, factsOf, fwd, judge, OFF, ON, RESTARTS, START, T1 } from './support/ac0-scenario';

describe('기준 시나리오 — 통과가 실제로 도달 가능하다(이 도구가 영원히 3 만 내는 것도 공허다)', () => {
  it('관측 추세 OK · 7일차 끝에 OFF · 증명 7일 무개입 · 활동 충족 → 통과(exit 0)', () => {
    const verdict = judge({});
    expect(verdict.status).toBe('passed');
    expect(verdict.exitCode).toBe(0);
    expect(verdict.dayNumber).toBe(15);
    expect(verdict.observation).toMatchObject({ baselineDay: 1, comparisonDay: 7, trend: 'passed', onAtStart: true });
    expect(verdict.proof.start).toEqual(at(8, 0));
    expect(verdict.proof.window).toEqual({ start: at(8, 0), end: at(15, 0) });
  });
});

describe('① B2① 최소 표본 — 1일차 전달 0건은 `0 ≤ 0` 통과가 아니다', () => {
  it('전달이 한 번도 없다: 산술로는 통과(2·0 ≤ 0)지만 판정은 관측 연장', () => {
    const verdict = judge({ forwarded: [], events: [START, ON] });
    expect(verdict.status).toBe('observation_extended');
    expect(verdict.exitCode).toBe(3);
    expect(verdict.observation.baselineDay).toBeNull();
    expect(verdict.proof.activity).toBeNull();
  });

  it('…그 상태로 7일차에 규칙을 꺼도 통과가 아니다 — 비교일을 모르는 OFF 는 이르다(관측 무효, exit 1)', () => {
    const verdict = judge({ forwarded: [] });
    expect(verdict.status).toBe('restart_required');
    expect(verdict.restart).toMatchObject({ returnDay: 1, cause: 'observation_invalid' });
  });

  it(`1일차 ${String(AC0_MIN_BASELINE_SENDERS - 1)}건(미달) → 기준일이 2일차로 밀리고 비교일은 8일차(관측 연장)`, () => {
    const verdict = judge({
      forwarded: arrivals({ 1: AC0_MIN_BASELINE_SENDERS - 1, 2: 4, 3: 3, 8: 1 }),
      events: [START, ON],
      asOf: at(8, 12),
    });
    expect(verdict.observation).toMatchObject({ baselineDay: 2, comparisonDay: 8, trend: 'pending' });
    expect(verdict.status).toBe('observation_extended');
  });

  it('…연장 중 7일차 밤에 끄면 관측 무효 — 연장된 비교일(8일차)이 끝나기 전이다', () => {
    const verdict = judge({ forwarded: arrivals({ 1: 2, 2: 4, 8: 1 }), asOf: at(9, 12) });
    expect(verdict.restart?.cause).toBe('observation_invalid');
  });

  it('최소 표본 딱 그 값이면 기준일이 된다', () => {
    const verdict = judge({ forwarded: arrivals({ 1: AC0_MIN_BASELINE_SENDERS, 7: 1 }) });
    expect(verdict.observation.baselineDay).toBe(1);
    expect(verdict.status).toBe('passed');
  });
});

describe('② 활동 분모 — 개입 0 이어도 활동이 없으면 통과가 아니다', () => {
  it('활동 0 → 증명 연장(exit 3), 통과 아님', () => {
    const verdict = judge({ activitySatisfied: false });
    expect(verdict.status).toBe('proof_extended');
    expect(verdict.exitCode).toBe(3);
    expect(verdict.proof.interventions).toEqual([]);
  });

  it('창이 있는데 분모를 안 주거나 다른 창의 분모를 주면 판정 불가(던진다)', () => {
    const facts = factsOf({});
    expect(() => decideAc0(facts, [])).toThrow(Ac0InputError);
    const wrong = activityFor({ start: at(1, 0), end: at(8, 0) }, true);
    expect(() => decideAc0(facts, [wrong])).toThrow(Ac0InputError);
  });

  it('증명 연장 — 연속 7일 창을 전부 본다: 16일차면 창은 8~14·9~15, 둘 다 미달이면 최근 창을 보인다', () => {
    const verdict = judge({ asOf: at(16, 1), activitySatisfied: false });
    expect(verdict.status).toBe('proof_extended');
    expect(verdict.proof.window).toEqual({ start: at(9, 0), end: at(16, 0) });
  });

  it('첫 창(8~14)은 미달, 둘째 창(9~15)이 충족 → 통과, 증거는 둘째 창', () => {
    const verdict = judge({ asOf: at(16, 1), activitySatisfied: (window) => window.start.getTime() === at(9, 0).getTime() });
    expect(verdict.status).toBe('passed');
    expect(verdict.proof.window).toEqual({ start: at(9, 0), end: at(16, 0) });
  });

  it('통과한 게이트는 뒤의 창이 조용해도 통과로 남는다(8~14 충족, 9~15 미달)', () => {
    const verdict = judge({ asOf: at(16, 1), activitySatisfied: (window) => window.start.getTime() === at(8, 0).getTime() });
    expect(verdict.status).toBe('passed');
    expect(verdict.proof.window).toEqual({ start: at(8, 0), end: at(15, 0) });
  });

  it('…그러나 통과 뒤의 개입은 게이트를 다시 연다(프리모템 #5)', () => {
    const verdict = judge({ asOf: at(16, 1), interventions: [{ recordedAt: at(15, 12), category: 'agent_gap', reason: 'x' }] });
    expect(verdict.status).toBe('restart_required');
  });
});

describe('③ 전달 규칙 OFF 기록 — 없으면 증명 구간이 시작하지 않는다', () => {
  it('15일차까지 OFF 기록 없음 → 전환 대기(exit 3), 증명 창·분모 없음', () => {
    const verdict = judge({ events: [START, ON] });
    expect(verdict.status).toBe('awaiting_switch');
    expect(verdict.exitCode).toBe(3);
    expect(verdict.proof.start).toBeNull();
    expect(verdict.proof.window).toBeNull();
  });

  it('OFF 가 늦으면(8일차 10시) 증명은 9일차부터 — 8일차는 전환 대기', () => {
    const lateOff: GateEvent = { kind: 'forwarding_off', recordedAt: at(8, 10) };
    const midway = judge({ events: [START, ON, lateOff], asOf: at(8, 12) });
    expect(midway.status).toBe('awaiting_switch');
    expect(midway.proof.start).toEqual(at(9, 0));
    const done = judge({ events: [START, ON, lateOff], asOf: at(16, 1) });
    expect(done.status).toBe('passed');
    expect(done.proof.window).toEqual({ start: at(9, 0), end: at(16, 0) });
  });

  it('OFF 기록 뒤 증명 시작 전의 개입도 증명 구간 것으로 센다', () => {
    const lateOff: GateEvent = { kind: 'forwarding_off', recordedAt: at(8, 10) };
    const verdict = judge({
      events: [START, ON, lateOff],
      asOf: at(8, 12),
      interventions: [{ recordedAt: at(8, 11), category: 'agent_gap', reason: '첨부 처리' }],
    });
    expect(verdict.status).toBe('restart_required');
    expect(verdict.restart?.returnDay).toBe(8);
  });
});

describe('④ OFF 이후 전달 메일 도착 = 규칙이 실제로 꺼지지 않았다', () => {
  it('10일차에 전달 1건 → 재시작 1일차(forwarding_leak, exit 1)', () => {
    const verdict = judge({ forwarded: [...arrivals(DECLINING), fwd(at(10, 14))] });
    expect(verdict.status).toBe('restart_required');
    expect(verdict.exitCode).toBe(1);
    expect(verdict.restart).toMatchObject({ returnDay: 1, cause: 'forwarding_leak' });
    expect(verdict.proof.leaks).toEqual([at(10, 14)]);
  });

  it('OFF 직후 10분 안의 도착은 전송 중이던 것 — 누수 아님', () => {
    const verdict = judge({ forwarded: [...arrivals(DECLINING), fwd(at(7, 23, 35))] });
    expect(verdict.proof.leaks).toEqual([]);
    expect(verdict.status).toBe('passed');
  });

  it('OFF 11분 뒤 도착은 누수', () => {
    const verdict = judge({ forwarded: [...arrivals(DECLINING), fwd(at(7, 23, 41))] });
    expect(verdict.restart?.cause).toBe('forwarding_leak');
  });
});

describe('⑤ 관측 도중의 OFF — 7일차가 0 이 되어 추세가 공허하게 통과하는 경로', () => {
  it('5일차에 끄면 관측 무효(재시작 1일차)', () => {
    const verdict = judge({ events: [START, ON, { kind: 'forwarding_off', recordedAt: at(5, 12) }] });
    expect(verdict.status).toBe('restart_required');
    expect(verdict.restart).toMatchObject({ returnDay: 1, cause: 'observation_invalid' });
  });

  it('7일차 22:30(끝 1.5시간 전) OFF → 무효, 23:00(끝 1시간 전) → 허용', () => {
    const early = judge({ events: [START, ON, { kind: 'forwarding_off', recordedAt: at(7, 22, 30) }] });
    expect(early.restart?.cause).toBe('observation_invalid');
    const allowed = judge({ events: [START, ON, { kind: 'forwarding_off', recordedAt: at(7, 23, 0) }] });
    expect(allowed.status).toBe('passed');
  });
});

describe('⑥ 1일차 시작 시점의 규칙 ON 기록', () => {
  it('ON 기록이 아예 없다 → 관측 무효', () => {
    const verdict = judge({ events: [START, OFF] });
    expect(verdict.status).toBe('restart_required');
    expect(verdict.observation.onAtStart).toBe(false);
    expect(verdict.restart?.cause).toBe('observation_invalid');
  });

  it('ON 을 1일차 오전에 기록했다(시작 뒤) → 관측 무효', () => {
    const verdict = judge({ events: [START, { kind: 'forwarding_on', recordedAt: at(1, 9) }, OFF] });
    expect(verdict.restart?.cause).toBe('observation_invalid');
  });
});

describe('⑦ 증명 도중 규칙 재가동', () => {
  it('11일차에 다시 켬 → 재시작 1일차(forwarding_reenabled)', () => {
    const verdict = judge({ events: [START, ON, OFF, { kind: 'forwarding_on', recordedAt: at(11, 9) }] });
    expect(verdict.restart).toMatchObject({ returnDay: 1, cause: 'forwarding_reenabled' });
  });
});

describe('AC-b3 추세 경계', () => {
  it('7일차 = 1일차 × 0.5 정확히 → 통과, 하나 더 → 재시작 1일차(observation_trend)', () => {
    expect(judge({ forwarded: arrivals({ 1: 6, 7: 3 }) }).status).toBe('passed');
    const failed = judge({ forwarded: arrivals({ 1: 6, 7: 4 }) });
    expect(failed.status).toBe('restart_required');
    expect(failed.restart).toMatchObject({ returnDay: 1, cause: 'observation_trend' });
  });

  it('추세 실패 뒤의 OFF 로는 증명이 시작되지 않는다(창 없음)', () => {
    expect(ac0ActivityWindows(factsOf({ forwarded: arrivals({ 1: 6, 7: 4 }) }))).toEqual([]);
  });
});

describe('B2② 재시작 원인 구분 — 카테고리가 복귀 일차를 정한다', () => {
  it('증명 구간 개입(주소전환) → 1일차', () => {
    const verdict = judge({
      interventions: [{ recordedAt: at(10, 15), category: 'address_transition', reason: '거래처가 옛 주소로 견적 요청' }],
    });
    expect(verdict.restart).toMatchObject({ returnDay: 1, cause: 'intervention_address_transition' });
  });

  it('증명 구간 개입(그 외) → 8일차', () => {
    for (const category of ['agent_gap', 'deliverability', 'policy_friction', 'other'] as const) {
      const verdict = judge({ interventions: [{ recordedAt: at(10, 15), category, reason: 'x' }] });
      expect(verdict.restart).toMatchObject({ returnDay: 8, cause: 'intervention_other' });
    }
  });

  it('섞여 있으면 1일차가 이긴다(같은 미해결 모집단으로 증명에 재진입하지 않게)', () => {
    const verdict = judge({
      interventions: [
        { recordedAt: at(9, 10), category: 'agent_gap', reason: 'x' },
        { recordedAt: at(10, 10), category: 'address_transition', reason: 'y' },
      ],
    });
    expect(verdict.restart?.returnDay).toBe(1);
  });

  it('관측 구간 개입은 판정에 들지 않는다(표시만)', () => {
    const verdict = judge({ interventions: [{ recordedAt: at(3, 10), category: 'agent_gap', reason: 'x' }] });
    expect(verdict.status).toBe('passed');
    expect(verdict.observationInterventions).toHaveLength(1);
  });
});

describe('재시작 뒤의 타임라인', () => {
  const intervention: InterventionRecord = { recordedAt: at(10, 15), category: 'agent_gap', reason: 'x' };
  const restart8: GateEvent = {
    kind: 'restart',
    recordedAt: at(11, 10),
    effectiveAt: at(12, 0),
    returnDay: 8,
    cause: 'intervention_other',
  };

  it('8일차 복귀: 관측은 유지, 증명은 복귀 자정부터 다시 7일', () => {
    const events = [START, ON, OFF, restart8];
    const proving = judge({ events, interventions: [intervention], asOf: at(15, 1) });
    expect(proving.status).toBe('proving');
    expect(proving.dayNumber).toBe(11);
    const passed = judge({ events, interventions: [intervention], asOf: at(19, 1) });
    expect(passed.status).toBe('passed');
    expect(passed.proof.window).toEqual({ start: at(12, 0), end: at(19, 0) });
    expect(passed.restarts).toMatchObject({ total: 1, toDay8: 1, signal: false });
  });

  it('8일차 복귀 시점에 규칙이 ON 이면(수정 기간에 켜 두었다) → 재가동', () => {
    const events = [START, ON, OFF, { kind: 'forwarding_on', recordedAt: at(11, 9) } as GateEvent, restart8];
    const verdict = judge({ events, interventions: [intervention], asOf: at(19, 1) });
    expect(verdict.restart?.cause).toBe('forwarding_reenabled');
  });

  it('1일차 복귀: 새 1일차 전에 규칙 ON 을 다시 기록해야 한다', () => {
    const restart1: GateEvent = {
      kind: 'restart',
      recordedAt: at(11, 10),
      effectiveAt: at(12, 0),
      returnDay: 1,
      cause: 'intervention_address_transition',
    };
    const without = judge({ events: [START, ON, OFF, restart1], asOf: at(13, 1) });
    expect(without.restart?.cause).toBe('observation_invalid');
    const withOn = judge({
      events: [START, ON, OFF, restart1, { kind: 'forwarding_on', recordedAt: at(11, 20) }],
      forwarded: arrivals({ 12: 5 }),
      asOf: at(13, 1),
    });
    expect(withOn.status).toBe('observing');
    expect(withOn.dayNumber).toBe(2);
    expect(withOn.observation.dailyForwarded).toEqual([5]);
  });
});

describe('KST 일차 경계 (00:00 KST = 15:00 UTC)', () => {
  it('T1 은 UTC 전날 15:00 이다', () => {
    expect(T1.toISOString()).toBe('2026-09-30T15:00:00.000Z');
  });

  it('T1 1ms 전의 전달은 1일차가 아니고, T1 정각은 1일차다', () => {
    const verdict = judge({
      forwarded: [fwd(new Date(T1.getTime() - 1), 'a@x.kr'), fwd(T1, 'b@x.kr'), ...arrivals({ 1: 2 })],
      events: [START, ON],
      asOf: at(2, 1),
    });
    expect(verdict.observation.dailyForwarded).toEqual([3]);
  });

  it('1일차 이전 → 관측 대기(exit 3)', () => {
    const verdict = judge({ asOf: at(0, 23) });
    expect(verdict.status).toBe('waiting');
    expect(verdict.dayNumber).toBeNull();
  });

  it('start 기록 없는 게이트 → 판정 불가', () => {
    expect(() => judge({ events: [ON] })).toThrow(Ac0InputError);
  });
});

describe('⑧ 판정식 불일치 의심(보조 신호) — 1건이라도 있으면 통과가 아니다 (V3 B1)', () => {
  it('OFF 뒤 증명 구간에 판정식이 모르는 봉투로 7일 내내 도착 → 판정 보류(exit 3), 통과 아님', () => {
    const unknownEnvelope = [8, 9, 10, 11, 12, 13, 14].map((day) => at(day, 10));
    const verdict = judge({ auxiliary: unknownEnvelope });
    expect(verdict.status).toBe('held');
    expect(verdict.exitCode).toBe(3);
    expect(verdict.auxiliary).toHaveLength(7);
    expect(verdict.next[0]).toContain('판정 보류');
  });

  it('관측 구간의 1건도 보류 — 관측 건수가 판정식에 달려 있다', () => {
    expect(judge({ auxiliary: [at(3, 10)] }).status).toBe('held');
  });

  it('이 1일차 구간 밖(1일차 복귀 전 구간)의 보조 신호는 보지 않는다', () => {
    expect(judge({ auxiliary: [at(0, 9)] }).status).toBe('passed');
  });

  it('알려진 재시작 원인(누수)이 있으면 그쪽이 이긴다 — exit 1', () => {
    const verdict = judge({ auxiliary: [at(9, 10)], forwarded: [...arrivals(DECLINING), fwd(at(10, 14))] });
    expect(verdict.status).toBe('restart_required');
    expect(verdict.restart?.cause).toBe('forwarding_leak');
  });
});

describe('⑨ 재시작 3회 초과 신호 — exit 0 불가 (V3 B2)', () => {
  it('8일차 복귀 4회 뒤 증명 7일·활동 충족이어도 AC-0 미성립(exit 1), 재시작 기록 불가(restart null)', () => {
    const verdict = judge({ events: [START, ON, OFF, ...RESTARTS], asOf: at(21, 1) });
    expect(verdict.restarts).toMatchObject({ total: 4, signal: true });
    expect(verdict.status).toBe('not_yet_true');
    expect(verdict.exitCode).toBe(1);
    expect(verdict.restart).toBeNull();
    expect(verdict.next.some((line) => line.includes('아직 참이 아니다'))).toBe(true);
    expect(verdict.next.some((line) => line.includes('통과'))).toBe(true);
  });

  it('재시작 3회까지는 신호가 아니다 — 같은 조건이면 통과', () => {
    const verdict = judge({ events: [START, ON, OFF, ...RESTARTS.slice(0, 3)], asOf: at(20, 1) });
    expect(verdict.restarts.signal).toBe(false);
    expect(verdict.status).toBe('passed');
  });

  it('신호 아래에서는 새 재시작 원인이 생겨도 restart 가 없다(재시작을 더 쌓지 않는다)', () => {
    const verdict = judge({
      events: [START, ON, OFF, ...RESTARTS],
      interventions: [{ recordedAt: at(14, 12), category: 'agent_gap', reason: 'x' }],
      asOf: at(15, 1),
    });
    expect(verdict.status).toBe('not_yet_true');
    expect(verdict.restart).toBeNull();
  });
});

describe('⑪ 복귀 일차 데이터 교차 검증 — 카테고리 자기 신고만 믿지 않는다 (V3 B2②)', () => {
  const restart8: GateEvent = { kind: 'restart', recordedAt: at(11, 10), effectiveAt: at(12, 0), returnDay: 8, cause: 'intervention_other' };
  const other: InterventionRecord = { recordedAt: at(10, 15), category: 'other', reason: '기타' };

  it('"기타" 개입과 같은 구간에 전달 메일 → 카테고리와 무관하게 1일차(forwarding_leak)', () => {
    const verdict = judge({ interventions: [other], forwarded: [...arrivals(DECLINING), fwd(at(10, 16))] });
    expect(verdict.restart).toMatchObject({ returnDay: 1, cause: 'forwarding_leak' });
  });

  it('8일차 복귀 기록 **전** 구간의 전달 메일(수집 지연·판정식 소급)도 누수 → 1일차', () => {
    const events = [START, ON, OFF, restart8];
    const clean = judge({ events, interventions: [other], asOf: at(19, 1) });
    expect(clean.status).toBe('passed');
    const verdict = judge({ events, interventions: [other], forwarded: [...arrivals(DECLINING), fwd(at(10, 20))], asOf: at(19, 1) });
    expect(verdict.status).toBe('restart_required');
    expect(verdict.restart).toMatchObject({ returnDay: 1, cause: 'forwarding_leak' });
  });

  it('수정 기간에 규칙을 켰다가 복귀 전에 다시 끔 → 재가동(1일차)', () => {
    const events: GateEvent[] = [
      START,
      ON,
      OFF,
      { kind: 'forwarding_on', recordedAt: at(10, 18) },
      { kind: 'forwarding_off', recordedAt: at(11, 9) },
      restart8,
    ];
    const verdict = judge({ events, interventions: [other], asOf: at(19, 1) });
    expect(verdict.restart).toMatchObject({ returnDay: 1, cause: 'forwarding_reenabled' });
  });

  it('8일차 복귀여도 관측을 현재 판정식으로 다시 산출 — 소급으로 추세가 깨지면 1일차', () => {
    const events = [START, ON, OFF, restart8];
    const verdict = judge({ events, interventions: [other], forwarded: arrivals({ 1: 6, 7: 4 }), asOf: at(19, 1) });
    expect(verdict.restart).toMatchObject({ returnDay: 1, cause: 'observation_trend' });
  });
});

describe('⑩ 최소 표본 = 서로 다른 외부 발신자 (V3 H1)', () => {
  it('에이전트 자기 메일이 규칙으로 되돌아온 3통(sender null) → 기준일 없음', () => {
    const internal = [0, 1, 2].map((i) => fwd(at(1, 9, i), null));
    const verdict = judge({ forwarded: internal, events: [START, ON], asOf: at(9, 1) });
    expect(verdict.observation.baselineDay).toBeNull();
    expect(verdict.observation.dailyForwarded[0]).toBe(0);
    expect(verdict.status).toBe('observation_extended');
  });

  it('한 상대가 세 통 → 기준일 없음, 세 상대가 한 통씩 → 기준일', () => {
    const one = [0, 1, 2].map((i) => fwd(at(1, 9, i), 'bob@vendor.kr'));
    expect(judge({ forwarded: one, events: [START, ON], asOf: at(9, 1) }).observation.baselineDay).toBeNull();
    const three = ['a', 'b', 'c'].map((name, i) => fwd(at(1, 9, i), `${name}@vendor.kr`));
    const verdict = judge({ forwarded: three, events: [START, ON], asOf: at(9, 1) });
    expect(verdict.observation).toMatchObject({ baselineDay: 1, dailySenders: [3, 0, 0, 0, 0, 0, 0] });
  });

  it('내부 발신 전달도 OFF 뒤라면 누수다 — 규칙이 켜져 있다는 증거', () => {
    const verdict = judge({ forwarded: [...arrivals(DECLINING), fwd(at(10, 14), null)] });
    expect(verdict.restart?.cause).toBe('forwarding_leak');
  });
});
