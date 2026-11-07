/**
 * AC-0 "다음 할 일" 코드(`nextSteps`) — CLI 문장(`next`)과 **같은 줄·같은 순서**인지 판정 분기마다 본다.
 *
 * 콘솔은 `nextSteps` 코드를 두 언어 문구로 그리고(`src/admin/ui/app.ts` `GATE_NEXT_STEP_TEXT`), CLI 는 `next` 를 그대로
 * 찍는다. 둘이 어긋나면 콘솔은 CLI 와 다른 일을 시킨다. 그래서:
 *   Ⓢ-1 분기마다 기대 코드 열 = 실제 코드 열, `next` 와 길이가 같다.
 *   Ⓢ-2 `next[i]` 는 `nextSteps[i].code` 의 문장이다(코드별 서명 정규식) · 숫자 params 는 그 문장에 그대로 있다.
 *   Ⓢ-3 유니온(원문에서 읽는다)의 모든 코드가 어떤 분기에서 실제로 나온다 — 죽은 코드도, 서명 없는 코드도 없다.
 *
 * 되돌려서 빨개지는지 확인한 것(2026-09-24): 증명 중 분기의 코드를 `passed_keep_off` 로 바꾸면 → Ⓢ-1·Ⓢ-2 ·
 * 판정 보류 줄의 코드를 빼고 `next` 만 남기면(`nextSteps` 를 `extra.next` 에서만 만들면) → Ⓢ-1(길이) ·
 * `proving_progress` 의 `completeDays` 를 상수로 바꾸면 → Ⓢ-2.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { Ac0NextStepCode, GateEvent } from '../../../src/gate/ac0-verdict';
import { arrivals, at, DECLINING, judge, OFF, ON, RESTARTS, START, type Scenario } from './support/ac0-scenario';

/** 코드 → 그 코드의 CLI 문장 서명. 코드가 늘면 여기(와 콘솔 문구)가 같이 늘어야 한다(Ⓢ-3). */
const SIGNATURE: Readonly<Record<Ac0NextStepCode, RegExp>> = {
  restart_signal: /^재시작 \d+회 — .*--new-gate/,
  restart_signal_counterfactual: /^\(신호가 없었다면: /,
  held_classifier_mismatch: /^판정 보류 — .*ac0:probe/,
  held_counterfactual: /^\(보류가 없었다면: /,
  wait_day1_forwarding_on: /^1일차 00:00 KST 를 기다린다\. 전달 규칙 ON 이 기록/,
  forwarding_on_before_day1: /^1일차 00:00 KST 전에 .*ac0:forwarding on/,
  observation_no_on_restart: /^전달 규칙을 켜고 .*ac0:restart/,
  observation_early_off_restart: /^전달 규칙을 다시 켜고 .*ac0:restart/,
  observation_only_days: /^1~5일차는 관측 전용/,
  baseline_not_yet: /^아직 서로 다른 외부 발신자 \d+명/,
  observation_extended_check_classifier: /^관측 연장 중\. .*ac0:probe/,
  observation_pending_comparison: /^기준일 \d+일차 → 비교일 \d+일차/,
  observation_trend_failed_reannounce: /^옛 주소로 보내는 상대에게 재공지.*ac0:restart/,
  forwarding_off_now: /^AC-b3 추세 통과\. .*ac0:forwarding off/,
  off_record_required: /^OFF 기록이 없으면 증명 구간은/,
  leak_verify_removed: /^Gmail 필터와 전달 주소가 정말 삭제/,
  leak_reannounce_restart: /^보낸 상대에게 재공지 .*ac0:restart/,
  reenabled_restart: /^`pnpm ac0:restart`\(1일차 복귀\)\. 관측을/,
  intervention_transition_reannounce_restart: /^해당 상대에게 재공지 .*ac0:restart/,
  intervention_fix_restart_day8: /^원인을 이슈로 .*8일차/,
  proof_starts_next_midnight: /^전달 규칙 OFF 기록됨\. 증명 구간/,
  proving_progress: /^증명 \d+\/\d+일 무개입\. .*ac0:intervention/,
  proof_activity_shortfall: /^개입 0건이지만 활동 분모 미달/,
  passed_keep_off: /^AC-0 통과\. /,
};

const LATE_OFF: GateEvent = { kind: 'forwarding_off', recordedAt: at(8, 10) };

/** 분기 → 기대 코드 열. 판정 코드의 분기 전부(+ 보류·신호 머리줄). */
const BRANCHES: ReadonlyArray<readonly [string, Scenario, readonly Ac0NextStepCode[]]> = [
  ['1일차 전 · ON 기록 없음', { events: [START], asOf: at(0, 12) }, ['forwarding_on_before_day1']],
  ['1일차 전 · ON 기록 있음', { events: [START, ON], asOf: at(0, 12) }, ['wait_day1_forwarding_on']],
  ['관측 · 1일차 ON 기록 없음', { events: [START], asOf: at(3, 1) }, ['observation_no_on_restart']],
  ['관측 · 이른 OFF', { events: [START, ON, { kind: 'forwarding_off', recordedAt: at(5, 10) }], asOf: at(6, 1) }, ['observation_early_off_restart']],
  ['관측 · 기준일 없음(2일차)', { events: [START, ON], forwarded: [], asOf: at(2, 1) }, ['observation_only_days', 'baseline_not_yet']],
  ['관측 연장 · 기준일 없음(9일차)', { events: [START, ON], forwarded: [], asOf: at(9, 1) }, ['baseline_not_yet', 'observation_extended_check_classifier']],
  ['관측 · 비교일 대기', { events: [START, ON], forwarded: arrivals({ 1: 6 }), asOf: at(3, 1) }, ['observation_only_days', 'observation_pending_comparison']],
  ['관측 · 추세 실패', { forwarded: arrivals({ 1: 6, 7: 4 }) }, ['observation_trend_failed_reannounce']],
  ['전환 대기 · OFF 기록 없음', { events: [START, ON] }, ['forwarding_off_now', 'off_record_required']],
  ['누수', { forwarded: [...arrivals(DECLINING), { at: at(10, 14), sender: 'late@partner.kr' }] }, ['leak_verify_removed', 'leak_reannounce_restart']],
  ['재가동', { events: [START, ON, OFF, { kind: 'forwarding_on', recordedAt: at(11, 9) }] }, ['reenabled_restart']],
  ['개입 · 주소 전환', { interventions: [{ recordedAt: at(10, 15), category: 'address_transition', reason: 'x' }] }, ['intervention_transition_reannounce_restart']],
  ['개입 · 그 외', { interventions: [{ recordedAt: at(10, 15), category: 'agent_gap', reason: 'x' }] }, ['intervention_fix_restart_day8']],
  ['전환 대기 · OFF 기록됨, 증명 전', { events: [START, ON, LATE_OFF], asOf: at(8, 12) }, ['proof_starts_next_midnight']],
  ['증명 중', { asOf: at(11, 1) }, ['proving_progress']],
  ['증명 연장', { activitySatisfied: false }, ['proof_activity_shortfall']],
  ['통과', {}, ['passed_keep_off']],
  ['판정 보류(통과 위)', { auxiliary: [at(9, 10)] }, ['held_classifier_mismatch', 'held_counterfactual', 'passed_keep_off']],
  ['재시작 신호(통과 위)', { events: [START, ON, OFF, ...RESTARTS], asOf: at(21, 1) }, ['restart_signal', 'restart_signal_counterfactual', 'passed_keep_off']],
  [
    '재시작 신호(개입 위 — 원인이 괄호에)',
    { events: [START, ON, OFF, ...RESTARTS], interventions: [{ recordedAt: at(14, 12), category: 'agent_gap', reason: 'x' }], asOf: at(15, 1) },
    ['restart_signal', 'restart_signal_counterfactual', 'intervention_fix_restart_day8'],
  ],
];

/** 원문에서 문자열 유니온의 값을 읽는다(주석 제거 뒤). */
function unionLiterals(source: string, name: string): string[] {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  const m = new RegExp(`export type ${name}\\s*=([^;]*);`).exec(code);
  if (m === null) throw new Error(`유니온 ${name} 을 찾지 못했다`);
  return [...(m[1] ?? '').matchAll(/'([a-z0-9_]+)'/g)].map((x) => x[1] ?? '');
}

describe('Ⓢ AC-0 다음 할 일 — nextSteps 는 next 와 같은 줄·같은 순서', () => {
  it.each(BRANCHES)('Ⓢ-1 %s → 코드 열', (_, scenario, codes) => {
    const verdict = judge(scenario);
    expect(verdict.nextSteps.map((step) => step.code)).toEqual(codes);
    expect(verdict.next).toHaveLength(verdict.nextSteps.length);
  });

  it.each(BRANCHES)('Ⓢ-2 %s → next[i] 는 그 코드의 문장 · 숫자 params 는 문장에 있다', (_, scenario) => {
    const verdict = judge(scenario);
    verdict.nextSteps.forEach((step, i) => {
      const text = verdict.next[i] ?? '';
      expect(text, step.code).toMatch(SIGNATURE[step.code]);
      for (const [key, value] of Object.entries(step.params ?? {})) {
        if (typeof value === 'number') expect(text, `${step.code}.${key}`).toContain(String(value));
      }
      if (step.params?.cause !== undefined) expect(text).toContain(step.params.cause);
    });
  });

  it('Ⓢ-2 params 는 판정 값과 같다(증명 일수 · 기준일/비교일 · 보류 건수 · 재시작 횟수 · 가정 상태)', () => {
    expect(judge({ asOf: at(11, 1) }).nextSteps[0]?.params).toEqual({ completeDays: 3, proofDays: 7 });
    expect(judge({ events: [START, ON], forwarded: arrivals({ 1: 6 }), asOf: at(3, 1) }).nextSteps[1]?.params).toEqual({ baselineDay: 1, comparisonDay: 7 });
    expect(judge({ auxiliary: [at(9, 10), at(10, 10)] }).nextSteps.slice(0, 2).map((s) => s.params)).toEqual([{ count: 2 }, { status: 'passed' }]);
    const signal = judge({
      events: [START, ON, OFF, ...RESTARTS],
      interventions: [{ recordedAt: at(14, 12), category: 'agent_gap', reason: 'x' }],
      asOf: at(15, 1),
    });
    expect(signal.nextSteps.slice(0, 2).map((s) => s.params)).toEqual([
      { restarts: 4, threshold: 3 },
      { status: 'restart_required', cause: 'intervention_other' },
    ]);
  });

  it('Ⓢ-3 유니온의 모든 코드가 어떤 분기에서 나온다 · 서명이 있다(유니온은 원문에서 읽는다)', () => {
    const source = readFileSync(join(__dirname, '../../../src/gate/ac0-verdict.ts'), 'utf8');
    const union = unionLiterals(source, 'Ac0NextStepCode');
    expect(union.length).toBeGreaterThanOrEqual(20);
    const emitted = new Set(BRANCHES.flatMap(([, scenario]) => judge(scenario).nextSteps.map((step) => step.code)));
    expect(union.filter((code) => !emitted.has(code as Ac0NextStepCode))).toEqual([]);
    expect(Object.keys(SIGNATURE).sort()).toEqual([...union].sort());
  });
});
