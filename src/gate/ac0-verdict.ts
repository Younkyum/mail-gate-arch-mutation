/**
 * src/gate/ac0-verdict.ts — AC-0 게이트 판정 (계획 §3.2 C1·V1, §6 GATE, §11B B2①②). **순수 함수.**
 *
 * 입력은 DB 에서 온 사실뿐이다: 게이트 이벤트(start·restart·전달 규칙 on/off), 전달 판정된 수신 시각,
 * 개입 기록, 활동 분모. 출력은 상태 하나와 exit code 하나. markdown 은 입력이 아니다(계획 P2).
 *
 * ===========================================================================
 * ## 시간 축
 * ===========================================================================
 *
 *   T1 ─ 관측(규칙 ON) ─ 기준일 b … 비교일 b+6 ─┬─ OFF 기록 ─ T8 ─ 증명(규칙 OFF) 7일 ─ 통과
 *                                              └ (비교일 끝 1시간 전부터 OFF 허용)
 *
 * - **T1** = 1일차 00:00 KST (`start` 또는 `restart(1)` 의 effective_at).
 * - **기준일 b** = 끝난 관측일 중 서로 다른 외부 발신자가 `AC0_MIN_BASELINE_SENDERS` 이상인 **첫 날**. 보통 1일차.
 *   1일차가 미달이면 기준일이 뒤로 밀린다 = **관측 구간 연장**(B2①). 비교일은 항상 b+6.
 * - **T8** = OFF 기록 이후 첫 KST 자정(`ac0ProofStartForOff` — 런북 두 개가 이 함수를 인용한다). 비교일
 *   마지막 1시간 안에 끄면 T8 = 비교일 다음 날 00:00 이라 빈틈이 없다. 늦게 끄면 그 사이 날은 "전환 대기" 이고
 *   증명에 들지 않는다.
 * - `restart(8)` 이면 관측은 같은 T1 로 다시 산출하고(⑪) T8 만 새로 정한다(= 그 이벤트의 effective_at).
 *
 * ===========================================================================
 * ## 공허 통과 차단 — 여기가 이 파일의 존재 이유다
 * ===========================================================================
 *
 * 결함 10건 이상이 "초록인데 아무것도 안 지킨다" 였다. 각 경로와 그것을 닫는 줄:
 *
 *   ① 1일차 전달 0건 → `0 ≤ 0` 추세 통과          → 최소 표본 미달이면 기준일 없음 = 관측 연장(exit 3)
 *   ② 활동 0 이어도 개입 0 → 통과                  → 7일 창의 활동 분모 3종 미달 = 증명 연장(exit 3)
 *   ③ OFF 기록 없이 8일차 도달 → 통과              → OFF 기록 전에는 T8 이 존재하지 않는다(exit 3)
 *   ④ OFF 기록 후에도 전달 메일 도착 → 통과         → 누수 1건 = 재시작 1일차(exit 1)
 *   ⑤ 관측 도중 규칙을 끄면 7일차가 0 → 추세 통과  → 비교일 끝 1시간 전보다 이른 OFF = 관측 무효(exit 1)
 *   ⑥ 규칙 ON 기록 없이 관측 → 전달 0 이 "전환 완료" 로 읽힘 → T1 시점 규칙 상태가 ON 이 아니면 관측 무효
 *   ⑦ 증명 도중 규칙을 다시 켬 → 개입이 전달로 가려짐 → 재가동 = 재시작 1일차
 *   ⑧ 판정식이 모르는 봉투로 전달이 계속 옴 → 누수 0 으로 통과  → 보조 신호 불일치 1건 = 판정 보류(exit 3)
 *   ⑨ 재시작 3회 초과인데 통과                    → 신호 = AC-0 미성립(exit 1, 이 게이트는 더 통과하지 않는다)
 *   ⑩ 에이전트 자기 메일·같은 상대 여러 통으로 기준일 → 최소 표본 = 서로 다른 **외부** 발신자 수
 *   ⑪ 8일차 복귀 뒤, 그 전 구간의 전달 메일이 소급 판정으로 드러남 → 누수는 **첫 OFF** 부터 센다(1일차)
 *
 * 각 경로를 되돌리면 빨개지는 것을 `test/unit/gate/ac0-verdict.test.ts` 가 하나씩 고정하고,
 * exit code 는 `test/integration/gate/ac0-cli.test.ts` 가 CLI 를 실제로 띄워 고정한다.
 *
 * ===========================================================================
 * ## ⑧ 판정 보류 — 왜 1 이 아니라 3 인가 (V3 B1)
 * ===========================================================================
 *
 * 보조 신호(`X-Forwarded-*` 가 사람 메일함/에이전트를 가리키는데 봉투는 판정식이 아는 전달 형태가 아님)가
 * 게이트 구간(현 1일차 ~ 지금)에 1건이라도 있으면 **판정식이 틀렸을 가능성이 열려 있다 = 모른다.**
 *   - 통과(0)는 불가: 그 메일이 진짜 전달이면 규칙 OFF 는 거짓이고 누수 0 은 공허하다.
 *   - 재시작(1)도 아니다: 헤더는 발신자가 쓸 수 있고(상대 자신의 Gmail 전달도 같은 헤더를 단다) 원인을
 *     모르는 채 `ac0:restart` 를 하면 재시작 횟수(⑨ 신호)만 태우고, 재시작 뒤에도 같은 판정식이 같은
 *     메일을 못 본다 — 관측이 다시 공허해진다.
 *   - 그래서 3(`held`): 사람이 `ac0:probe` 로 원자료를 보고 `isForwardedFormOf` 를 실측값으로 고친다.
 *     판정은 저장되지 않으므로 고치는 즉시 **소급**되어 그 메일은 누수(exit 1)나 무관(보류 해제)으로 갈린다.
 *   재시작 원인(누수·재가동·개입·관측 실패)이 따로 있으면 그쪽이 먼저다 — 알려진 실패가 모르는 것을 이긴다.
 *
 * ===========================================================================
 * ## ⑨ 재시작 신호 — 왜 exit 1 이고 종단인가 (V3 B2)
 * ===========================================================================
 *
 * 계획 §3.2: "재시작이 3회를 넘으면 게이트 실패가 아니라 AC-0 이 아직 참이 아니라는 신호이며, P3·P4 로
 * 되돌아간다." 신호가 참이면 이 게이트의 판정은 무엇이든 `not_yet_true`(exit 1)다. 3(진행 중)이 아닌
 * 이유: 이 게이트는 더 진행해도 통과에 도달하지 않는다 — "아직 모른다" 가 아니라 "아니다" 다.
 * `restart` 는 `null` 이라 `ac0:restart` 가 더 기록하지 않는다(재시작을 더 쌓는 것은 루프다). P3·P4 에서
 * 원인을 고친 뒤 `pnpm ac0:start --new-gate` 로 새 게이트를 연다.
 *
 * ===========================================================================
 * ## ⑪ 복귀 일차를 카테고리 자기 신고에만 맡기지 않는다 (V3 B2②)
 * ===========================================================================
 *
 * 주소 전환이 원인인 개입을 "기타" 로 적으면 8일차 복귀가 되고, 같은 미해결 상대를 데리고 증명에 재진입한다.
 * 규칙이 정말 꺼져 있으면 그 상대의 메일은 우리에게 오지 않으므로(사람 메일함에만 있다) **데이터로 볼 수
 * 있는 것은 "규칙 OFF 뒤에 전달 판정 메일이 있었는가" 하나다.** 그것을 이렇게 쓴다:
 *   - 누수는 8일차 복귀가 있어도 **이 1일차 구간의 첫 OFF(+유예)** 부터 센다. 복귀 기록 전 구간에 있었던
 *     전달 메일(수집 지연, 판정식 소급 수정으로 새로 드러난 것)도 누수 → 카테고리와 무관하게 1일차.
 *   - 규칙 재가동도 첫 OFF 부터 본다(수정 기간에 켰다 끈 것 포함).
 *   - 관측(추세·ON 기록·이른 OFF)은 8일차 복귀여도 **현재 판정식으로 다시 산출**한다 — 소급으로 관측이
 *     깨졌으면 1일차.
 *   - 누수는 개입보다 먼저 판정한다 — 같은 구간에 "기타" 개입과 전달 메일이 있으면 1일차다.
 * 그 밖의 오기(전달 흔적이 없는 주소 전환)는 데이터로 구분되지 않는다. 그 루프는 ⑨ 가 3회에서 끊는다.
 *
 * ===========================================================================
 * ## 최소 표본 = 서로 다른 외부 발신자 3명 (B2①, V3 H1)
 * ===========================================================================
 *
 * - **메일 수가 아니라 서로 다른 외부 발신자 수다.** 메일 수면 한 상대가 세 통 보내거나, 에이전트가 대표
 *   Gmail 로 보낸 메일이 규칙에 되돌아온 세 통으로 기준일이 생긴다(외부 상대 0명). 발신자는 From 의
 *   정규화 주소(`contactKey` — `+태그`·Gmail 점 무시)이고, 에이전트 도메인(`atmark.ai` 등)·사람 메일함 발신은
 *   외부가 아니다(`ForwardedArrival.sender = null`). 그런 메일도 **누수 판정에는 든다** — 규칙이 켜져
 *   있다는 증거로는 누가 보냈든 같다.
 * - 추세(비교일 ≤ 기준일 × 0.5)는 계획대로 **건수**로 본다. 기준일 건수는 발신자 수 이상이므로 ≥ 3.
 * - 1 이면 `1 → 0` 한 통 차이가 "추세" 다. 2 면 `2 → 1` 이 통과한다(`1 ≤ 1`). **3 이 비교일에 "최소 2통
 *   감소(≥67%)" 를 요구하는 가장 작은 값**이다(`c7 ≤ 1.5` → `c7 ≤ 1`).
 * - 더 올리지 않는 이유: 이 값의 일차 목적은 **판정식이 살아 있다는 증거**다(`+caf_=` 가정이 틀리면
 *   전달이 0으로 보이고, 그때 0 ≤ 0 이 통과하는 것이 B2① 이 막으려는 사고다). 통계적 검정력이 목적이
 *   아니다 — 관측은 여과기이고 진짜 시험은 규칙 OFF 7일(증명)이다. 관측의 오통과는 증명에서 개입으로
 *   드러나고 주소 전환 원인이면 1일차로 되돌아온다(B2②). 반면 값을 5·10 으로 올리면 seed 20명짜리
 *   대표의 하루 전달량으로는 영영 기준일이 생기지 않아 게이트가 시작되지 못한다.
 * - 포아송 참고: 실제 감소가 없는데 일 평균 3통이면 비교일 ≤ 1 확률 ≈ 0.20. 이 20% 는 위 이유로 받아들인다.
 *
 * ===========================================================================
 * ## exit code
 * ===========================================================================
 *
 *   0 통과 · 1 실패(재시작 필요 · AC-0 미성립) · 3 진행 중·보류(관측/연장/전환 대기/증명/증명 연장/판정 보류)
 *   · 2 판정 불가(입력·설정·DB)
 *
 * 3 을 1 과 분리한 이유: "아직 모른다" 와 "틀렸다" 를 같은 비-0 으로 내면 매일 도는 cron 이 둘을
 * 구분하지 못하고, 사람은 곧 비-0 을 무시하게 된다. 2 는 CLI 가 낸다(`Ac0InputError`).
 */

import {
  completeDaysSince,
  countPerDay,
  DAY_MS,
  dayIndexFrom,
  kstMidnightAtOrAfter,
  type Ac0Activity,
  type Ac0Window,
} from '../observability/ac0-metrics';

/** B2① 최소 표본 — 기준일에 필요한 **서로 다른 외부 발신자** 수. 근거는 머리말. */
export const AC0_MIN_BASELINE_SENDERS = 3;
/** 관측 구간 = 기준일 ~ 비교일(기준일 + 6). AC-b3: 비교일 ≤ 기준일 × 0.5 (정수 비교: 2·비교일 ≤ 기준일). */
export const AC0_OBSERVATION_DAYS = 7;
export const AC0_PROOF_DAYS = 7;
/** 비교일 끝나기 이만큼 전부터의 OFF 는 관측을 깨지 않는다(자정 정각에 끄라고 요구하지 않기 위해). */
const AC0_OFF_EARLY_TOLERANCE_MS = 3_600_000;
/** OFF 기록 직후 이미 전송 중이던 전달 메일의 도착 여유. 이 뒤의 전달 메일은 누수다. */
const AC0_LEAK_GRACE_MS = 10 * 60_000;
/** §3.2: 재시작이 이 횟수를 넘으면 게이트 실패가 아니라 "AC-0 이 아직 참이 아니다" 신호. */
export const AC0_RESTART_SIGNAL_THRESHOLD = 3;

export type RestartCause =
  | 'intervention_address_transition'
  | 'intervention_other'
  | 'forwarding_leak'
  | 'forwarding_reenabled'
  | 'observation_trend'
  | 'observation_invalid';

export type InterventionCategory = 'address_transition' | 'agent_gap' | 'deliverability' | 'policy_friction' | 'other';

export const INTERVENTION_CATEGORIES = [
  'address_transition',
  'agent_gap',
  'deliverability',
  'policy_friction',
  'other',
] as const satisfies readonly InterventionCategory[];

/** B2②: 카테고리가 복귀 일차를 정한다. 주소 전환만 1일차 — 관측 구간이 걸렀어야 할 바로 그것이므로. */
export function returnDayFor(category: InterventionCategory): 1 | 8 {
  return category === 'address_transition' ? 1 : 8;
}

export type GateEvent =
  | { readonly kind: 'start'; readonly recordedAt: Date; readonly effectiveAt: Date }
  | {
      readonly kind: 'restart';
      readonly recordedAt: Date;
      readonly effectiveAt: Date;
      readonly returnDay: 1 | 8;
      readonly cause: RestartCause;
    }
  | { readonly kind: 'forwarding_on' | 'forwarding_off'; readonly recordedAt: Date };

export interface InterventionRecord {
  readonly recordedAt: Date;
  readonly category: InterventionCategory;
  readonly reason: string;
}

/** 판정 불가 — 입력·설정 오류. CLI 는 exit 2 로 낸다. */
export class Ac0InputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'Ac0InputError';
  }
}

export type Ac0Status =
  | 'held'
  | 'not_yet_true'
  | 'waiting'
  | 'observing'
  | 'observation_extended'
  | 'awaiting_switch'
  | 'proving'
  | 'proof_extended'
  | 'passed'
  | 'restart_required';

export type Ac0Phase = 'before' | 'observation' | 'switch' | 'proof';

export interface Ac0Restart {
  readonly returnDay: 1 | 8;
  readonly cause: RestartCause;
  readonly detail: string;
}

/**
 * `next` 한 줄의 **코드**. `next` 는 CLI(`check:ac0`)용 한국어 문장이고, 콘솔은 이 코드를 두 언어 문구(콘솔 버튼 안내)로
 * 바꾼다(`src/admin/ui/app.ts` `GATE_NEXT_STEP_TEXT` — 이 유니온 전부에 한국어가, `i18n.ts` 에 영어가 있어야 한다:
 * `admin-console-v2.test.ts` Ⓖ 가 이 원문을 읽어 대조한다). `nextSteps[i]` 는 언제나 `next[i]` 와 같은 줄이다.
 */
export type Ac0NextStepCode =
  | 'restart_signal'
  | 'restart_signal_counterfactual'
  | 'held_classifier_mismatch'
  | 'held_counterfactual'
  | 'wait_day1_forwarding_on'
  | 'forwarding_on_before_day1'
  | 'observation_no_on_restart'
  | 'observation_early_off_restart'
  | 'observation_only_days'
  | 'baseline_not_yet'
  | 'observation_extended_check_classifier'
  | 'observation_pending_comparison'
  | 'observation_trend_failed_reannounce'
  | 'forwarding_off_now'
  | 'off_record_required'
  | 'leak_verify_removed'
  | 'leak_reannounce_restart'
  | 'reenabled_restart'
  | 'intervention_transition_reannounce_restart'
  | 'intervention_fix_restart_day8'
  | 'proof_starts_next_midnight'
  | 'proving_progress'
  | 'proof_activity_shortfall'
  | 'passed_keep_off';

/** 문장 안의 숫자·상태. 코드마다 쓰는 것만 싣는다. */
export interface Ac0NextStepParams {
  readonly restarts?: number;
  readonly threshold?: number;
  readonly count?: number;
  /** 신호·보류가 없었다면의 상태. */
  readonly status?: Ac0Status;
  readonly cause?: RestartCause;
  readonly minSenders?: number;
  readonly baselineDay?: number;
  readonly comparisonDay?: number;
  readonly completeDays?: number;
  readonly proofDays?: number;
}

export interface Ac0NextStep {
  readonly code: Ac0NextStepCode;
  readonly params?: Ac0NextStepParams;
}

export interface Ac0Verdict {
  readonly status: Ac0Status;
  readonly exitCode: 0 | 1 | 3;
  readonly phase: Ac0Phase;
  readonly asOf: Date;
  /** 게이트 기준 일차(1-기반). 1일차 이전이면 `null`. */
  readonly dayNumber: number | null;
  readonly forwardingNow: 'on' | 'off' | 'unrecorded';
  readonly restart: Ac0Restart | null;
  readonly observation: {
    readonly anchor: Date;
    /** 끝난 관측일의 외부 발신 전달 건수(인덱스 0 = 1일차). */
    readonly dailyForwarded: readonly number[];
    /** 끝난 관측일의 서로 다른 외부 발신자 수 — 기준일(최소 표본)을 정한다. */
    readonly dailySenders: readonly number[];
    /** 진행 중인 날의 전달 건수(관측 중일 때만 의미). */
    readonly todayForwarded: number;
    readonly baselineDay: number | null;
    readonly comparisonDay: number | null;
    readonly trend: 'pending' | 'passed' | 'failed';
    readonly onAtStart: boolean;
  };
  readonly proof: {
    readonly start: Date | null;
    readonly completeDays: number;
    readonly interventions: readonly InterventionRecord[];
    readonly leaks: readonly Date[];
    readonly window: Ac0Window | null;
    readonly activity: Ac0Activity | null;
  };
  readonly observationInterventions: readonly InterventionRecord[];
  /** 게이트 구간(현 1일차 ~ 지금)의 보조 신호 불일치 도착 시각. 1건이라도 있으면 통과가 아니다(⑧). */
  readonly auxiliary: readonly Date[];
  readonly restarts: { readonly total: number; readonly toDay1: number; readonly toDay8: number; readonly signal: boolean };
  /** 다음에 사람이 할 일(CLI 한국어 문장). */
  readonly next: readonly string[];
  /** `next` 와 같은 줄·같은 순서의 코드 — 콘솔이 두 언어로 그린다. */
  readonly nextSteps: readonly Ac0NextStep[];
}

/** `next` 한 줄 = 문장 + 코드. 둘을 한 자리에서 만들어 어긋나지 않게 한다. */
interface NextLine {
  readonly text: string;
  readonly step: Ac0NextStep;
}

function line(code: Ac0NextStepCode, text: string, params?: Ac0NextStepParams): NextLine {
  return { text, step: params === undefined ? { code } : { code, params } };
}

/** 전달 판정(`classifyForwarded` → forwarded)된 수신 하나. */
export interface ForwardedArrival {
  /** `received_at`. */
  readonly at: Date;
  /** 외부 발신자의 정규화 주소(`contactKey`). 내부(에이전트 도메인·사람 메일함) 발신이면 `null` — 관측 표본에서 빠지고 누수에는 든다. */
  readonly sender: string | null;
}

export interface Ac0Facts {
  readonly asOf: Date;
  readonly events: readonly GateEvent[];
  readonly forwardedArrivals: readonly ForwardedArrival[];
  /** 전달 판정은 아니지만 `X-Forwarded-*` 보조 신호가 선 수신의 `received_at`(판정식 불일치 의심). */
  readonly auxiliaryArrivals: readonly Date[];
  readonly interventions: readonly InterventionRecord[];
}

type ProofFacts = Pick<Ac0Facts, 'asOf' | 'events' | 'forwardedArrivals'>;

// ---------------------------------------------------------------------------
// 타임라인
// ---------------------------------------------------------------------------

interface Timeline {
  readonly t1: Date;
  readonly day8Restart: Extract<GateEvent, { kind: 'restart' }> | null;
  readonly forwarding: readonly Extract<GateEvent, { kind: 'forwarding_on' | 'forwarding_off' }>[];
  readonly restarts: Ac0Verdict['restarts'];
}

function sortedEvents(events: readonly GateEvent[]): GateEvent[] {
  return [...events].sort((a, b) => a.recordedAt.getTime() - b.recordedAt.getTime());
}

function timelineOf(events: readonly GateEvent[]): Timeline {
  const ordered = sortedEvents(events);
  const segments = ordered.filter(
    (event): event is Extract<GateEvent, { kind: 'start' | 'restart' }> =>
      event.kind === 'start' || event.kind === 'restart',
  );
  if (!segments.some((event) => event.kind === 'start')) {
    throw new Ac0InputError('게이트에 start 기록이 없다 — `pnpm ac0:start` 로 시작한 게이트가 아니다.');
  }
  let day1 = segments[0] as (typeof segments)[number];
  let day8Restart: Timeline['day8Restart'] = null;
  for (const event of segments) {
    if (event.kind === 'start' || event.returnDay === 1) {
      day1 = event;
      day8Restart = null;
    } else {
      day8Restart = event;
    }
  }
  const restarts = segments.filter((event): event is Extract<GateEvent, { kind: 'restart' }> => event.kind === 'restart');
  const total = restarts.length;
  return {
    t1: day1.effectiveAt,
    day8Restart,
    forwarding: ordered.filter(
      (event): event is Extract<GateEvent, { kind: 'forwarding_on' | 'forwarding_off' }> =>
        event.kind === 'forwarding_on' || event.kind === 'forwarding_off',
    ),
    restarts: {
      total,
      toDay1: restarts.filter((event) => event.returnDay === 1).length,
      toDay8: restarts.filter((event) => event.returnDay === 8).length,
      signal: total > AC0_RESTART_SIGNAL_THRESHOLD,
    },
  };
}

function forwardingStateAt(timeline: Timeline, at: Date): 'on' | 'off' | 'unrecorded' {
  let state: 'on' | 'off' | 'unrecorded' = 'unrecorded';
  for (const event of timeline.forwarding) {
    if (event.recordedAt.getTime() > at.getTime()) break;
    state = event.kind === 'forwarding_on' ? 'on' : 'off';
  }
  return state;
}

// ---------------------------------------------------------------------------
// 판정
// ---------------------------------------------------------------------------

interface ProofPlan {
  readonly start: Date;
  /** 이 시각 이후의 개입을 증명 구간 것으로 센다. */
  readonly watchFrom: Date;
  /** 이 시각 이후의 전달 메일은 누수다. 8일차 복귀여도 이 1일차 구간의 첫 OFF 기준(⑪). */
  readonly leakFrom: Date;
  /** 이 시각 이후의 규칙 ON 은 재가동이다. 이 1일차 구간의 첫 OFF(⑪). */
  readonly offAt: Date;
}

/**
 * **OFF 기록 시각 → 증명 구간 시작**: OFF 기록 이후 첫 KST 자정(자정 정각이면 그 자신). 정의는 이 함수 하나다 —
 * `docs/runbooks/ac0-shadow-log.md` §5 · `address-transition.md` "끄는 절차" 가 이것을 인용한다.
 *   - 비교일(보통 7일차) 23:00~24:00 KST 에 끄면 → 8일차 00:00 부터 증명, 첫 통과 판정은 15일차.
 *   - 8일차 00:00 이 지난 뒤(예: 00:05) 끄면 → 9일차 00:00 부터 증명, 첫 통과 판정은 16일차.
 *   - 비교일 끝 `AC0_OFF_EARLY_TOLERANCE_MS`(1시간) 전보다 이르면 관측 무효(⑤).
 */
export function ac0ProofStartForOff(offRecordedAt: Date): Date {
  return kstMidnightAtOrAfter(offRecordedAt);
}

/**
 * 증명 창들 — 증명 시작 이후 **끝난 연속 7일 창 전부**(8–14일차, 9–15일차, …). 활동 분모는 창마다 센다.
 * 판정 전에 조회 쪽이 창을 알아야 하므로 따로 노출한다. 끝난 증명일이 7일 미만이면 빈 배열.
 *
 * 왜 "마지막 7일" 하나가 아닌가: 15일차에 통과한 게이트가 20일차에 활동이 줄었다고 "증명 연장" 으로
 * 되돌아가면 안 된다 — 8–14일차의 7일이 이미 증거다. 반대로 개입·누수·규칙 재가동은 **지금까지 전부**
 * 본다(통과 뒤에 드러난 실패도 게이트를 다시 연다 — 프리모템 #5 "완료 선언 뒤에 드러나는 실패").
 */
export function ac0ActivityWindows(facts: ProofFacts): Ac0Window[] {
  const timeline = timelineOf(facts.events);
  return proofWindows(planProof(timeline, observe(timeline, facts), facts.asOf), facts.asOf);
}

function proofWindows(plan: ProofPlan | null, asOf: Date): Ac0Window[] {
  if (plan === null) return [];
  const days = completeDaysSince(plan.start, asOf);
  const windows: Ac0Window[] = [];
  for (let offset = 0; offset + AC0_PROOF_DAYS <= days; offset += 1) {
    windows.push({
      start: new Date(plan.start.getTime() + offset * DAY_MS),
      end: new Date(plan.start.getTime() + (offset + AC0_PROOF_DAYS) * DAY_MS),
    });
  }
  return windows;
}

interface ObservationResult {
  readonly verdictPart: Ac0Verdict['observation'];
  readonly comparisonEnd: Date | null;
  readonly earlyOff: Date | null;
}

function observe(timeline: Timeline, facts: ProofFacts): ObservationResult {
  const { t1 } = timeline;
  const completeDays = completeDaysSince(t1, facts.asOf);
  // ⑩ 관측 표본은 외부 발신 전달만. 내부 발신(sender null)은 누수 판정에만 쓴다.
  const external = facts.forwardedArrivals.filter(
    (arrival): arrival is ForwardedArrival & { readonly sender: string } => arrival.sender !== null,
  );
  const counted = countPerDay(
    t1,
    external.map((arrival) => arrival.at),
    completeDays + 1,
  );
  const dailyForwarded = counted.slice(0, completeDays);
  const todayForwarded = counted[completeDays] ?? 0;
  const senderSets = Array.from({ length: completeDays }, () => new Set<string>());
  for (const arrival of external) {
    senderSets[dayIndexFrom(t1, arrival.at)]?.add(arrival.sender);
  }
  const dailySenders = senderSets.map((senders) => senders.size);

  const baselineIndex = dailySenders.findIndex((count) => count >= AC0_MIN_BASELINE_SENDERS);
  const comparisonIndex = baselineIndex === -1 ? null : baselineIndex + AC0_OBSERVATION_DAYS - 1;
  const comparisonEnd = comparisonIndex === null ? null : new Date(t1.getTime() + (comparisonIndex + 1) * DAY_MS);

  let trend: Ac0Verdict['observation']['trend'] = 'pending';
  if (comparisonIndex !== null && comparisonIndex < completeDays) {
    const baseline = dailyForwarded[baselineIndex] ?? 0;
    const comparison = dailyForwarded[comparisonIndex] ?? 0;
    trend = 2 * comparison <= baseline ? 'passed' : 'failed';
  }

  // ⑤ 관측 도중의 OFF. 비교일을 아직 모르면(표본 미달) 관측의 끝도 모른다 — 그때의 OFF 는 전부 이르다.
  const offAllowedFrom = comparisonEnd === null ? Number.POSITIVE_INFINITY : comparisonEnd.getTime() - AC0_OFF_EARLY_TOLERANCE_MS;
  const earlyOffEvent = timeline.forwarding.find(
    (event) =>
      event.kind === 'forwarding_off' &&
      event.recordedAt.getTime() >= t1.getTime() &&
      event.recordedAt.getTime() < offAllowedFrom &&
      event.recordedAt.getTime() <= facts.asOf.getTime(),
  );

  return {
    verdictPart: {
      anchor: t1,
      // 관측 구간만 보인다 — 비교일이 정해졌으면 거기까지(그 뒤의 날은 증명·전환 구간이고 누수로 따로 센다).
      dailyForwarded: comparisonIndex === null ? dailyForwarded : dailyForwarded.slice(0, comparisonIndex + 1),
      dailySenders: comparisonIndex === null ? dailySenders : dailySenders.slice(0, comparisonIndex + 1),
      todayForwarded,
      baselineDay: baselineIndex === -1 ? null : baselineIndex + 1,
      comparisonDay: comparisonIndex === null ? null : comparisonIndex + 1,
      trend,
      onAtStart: forwardingStateAt(timeline, t1) === 'on',
    },
    comparisonEnd,
    earlyOff: earlyOffEvent?.recordedAt ?? null,
  };
}

function planProof(timeline: Timeline, observation: ObservationResult, asOf: Date): ProofPlan | null {
  const firstOff = planFromObservation(timeline, observation, asOf);
  if (timeline.day8Restart === null || firstOff === null) return firstOff;
  // 8일차 복귀: 증명 날짜와 개입 감시는 복귀 기록부터, 누수·재가동은 이 1일차 구간의 첫 OFF 부터(⑪).
  const restart = timeline.day8Restart;
  return { start: restart.effectiveAt, watchFrom: restart.recordedAt, leakFrom: firstOff.leakFrom, offAt: firstOff.offAt };
}

/** 관측 통과 뒤 첫 OFF 로 정해지는 증명 계획. 관측이 (현재 판정식으로) 통과하지 않으면 `null`. */
function planFromObservation(timeline: Timeline, observation: ObservationResult, asOf: Date): ProofPlan | null {
  // 관측이 통과하지 않았으면 증명 창은 없다 — 실패한 관측 뒤의 OFF 로 증명을 시작할 수 없다.
  if (
    observation.comparisonEnd === null ||
    observation.earlyOff !== null ||
    !observation.verdictPart.onAtStart ||
    observation.verdictPart.trend !== 'passed'
  ) {
    return null;
  }
  const allowedFrom = observation.comparisonEnd.getTime() - AC0_OFF_EARLY_TOLERANCE_MS;
  const off = timeline.forwarding.find(
    (event) =>
      event.kind === 'forwarding_off' &&
      event.recordedAt.getTime() >= allowedFrom &&
      event.recordedAt.getTime() <= asOf.getTime(),
  );
  if (off === undefined) return null;
  return {
    start: ac0ProofStartForOff(off.recordedAt),
    watchFrom: off.recordedAt,
    leakFrom: new Date(off.recordedAt.getTime() + AC0_LEAK_GRACE_MS),
    offAt: off.recordedAt,
  };
}

const STATUS_WITHOUT_SIGNAL: Readonly<Record<Ac0Status, string>> = {
  held: '판정 보류',
  not_yet_true: 'AC-0 미성립',
  waiting: '관측 대기',
  observing: '관측 중',
  observation_extended: '관측 연장',
  awaiting_switch: '전환 대기',
  proving: '증명 중',
  proof_extended: '증명 연장',
  passed: '통과',
  restart_required: '재시작 필요',
};

function restartFor(returnDay: 1 | 8, cause: RestartCause, detail: string): Ac0Restart {
  return { returnDay, cause, detail };
}

/**
 * 판정. `activities` 는 `ac0ActivityWindows` 가 준 창 **전부**를 같은 순서로 센 값이어야 한다.
 * 개수·창이 어긋나면 던진다 — 다른 창의 분모로 통과하는 것이 곧 공허 통과다.
 */
export function decideAc0(facts: Ac0Facts, activities: readonly Ac0Activity[]): Ac0Verdict {
  const { asOf } = facts;
  const timeline = timelineOf(facts.events);
  const { t1 } = timeline;
  const forwardingNow = forwardingStateAt(timeline, asOf);
  const observation = observe(timeline, facts);
  const proofPlan = planProof(timeline, observation, asOf);
  const expectedWindows = proofWindows(proofPlan, asOf);

  if (activities.length !== expectedWindows.length) {
    throw new Ac0InputError(
      `활동 분모가 증명 창과 맞지 않는다(창 ${String(expectedWindows.length)}개, 분모 ${String(activities.length)}개).`,
    );
  }
  expectedWindows.forEach((window, index) => {
    const given = activities[index] as Ac0Activity;
    if (given.window.start.getTime() !== window.start.getTime() || given.window.end.getTime() !== window.end.getTime()) {
      throw new Ac0InputError('활동 분모가 다른 창으로 계산됐다.');
    }
  });
  // 첫 충족 창이 증거다. 없으면 가장 최근 창을 보여 준다.
  const activity = activities.find((candidate) => candidate.satisfied) ?? activities[activities.length - 1] ?? null;
  const expectedWindow = activity?.window ?? null;

  const dayNumberSinceT1 = asOf.getTime() < t1.getTime() ? null : completeDaysSince(t1, asOf) + 1;
  const auxiliary = facts.auxiliaryArrivals.filter((at) => at.getTime() >= t1.getTime() && at.getTime() <= asOf.getTime());
  const observationInterventions = facts.interventions.filter(
    (record) => record.recordedAt.getTime() >= t1.getTime() && record.recordedAt.getTime() <= asOf.getTime(),
  );

  const base = {
    asOf,
    forwardingNow,
    observation: observation.verdictPart,
    auxiliary,
    restarts: timeline.restarts,
  };
  const emptyProof: Ac0Verdict['proof'] = {
    start: null,
    completeDays: 0,
    interventions: [],
    leaks: [],
    window: null,
    activity: null,
  };
  const verdict = (
    candidate: Ac0Status,
    phase: Ac0Phase,
    dayNumber: number | null,
    extra: {
      readonly restart?: Ac0Restart;
      readonly proof?: Ac0Verdict['proof'];
      readonly next: readonly NextLine[];
      readonly observationInterventions?: readonly InterventionRecord[];
    },
  ): Ac0Verdict => {
    let status = candidate;
    let restart = extra.restart ?? null;
    const next: NextLine[] = [];
    // ⑨ 재시작 신호 — 무엇보다 먼저. 이 게이트는 더 통과하지 않는다(머리말).
    if (timeline.restarts.signal) {
      status = 'not_yet_true';
      restart = null;
      next.push(
        line(
          'restart_signal',
          `재시작 ${String(timeline.restarts.total)}회 — ${String(AC0_RESTART_SIGNAL_THRESHOLD)}회 초과는 게이트 실패가 아니라 ` +
          '"AC-0 이 아직 참이 아니다" 신호다. P3·P4 로 되돌아가 원인을 고친다(§3.2). 이 게이트에 재시작을 더 쌓지 않는다 — ' +
          '고친 뒤 `pnpm ac0:start --new-gate` 로 새 게이트를 연다.',
          { restarts: timeline.restarts.total, threshold: AC0_RESTART_SIGNAL_THRESHOLD },
        ),
        line(
          'restart_signal_counterfactual',
          `(신호가 없었다면: ${STATUS_WITHOUT_SIGNAL[candidate]}${extra.restart === undefined ? '' : ` · ${extra.restart.cause}`})`,
          extra.restart === undefined ? { status: candidate } : { status: candidate, cause: extra.restart.cause },
        ),
      );
    } else if (auxiliary.length > 0 && candidate !== 'restart_required' && candidate !== 'waiting') {
      // ⑧ 판정식 불일치 의심 — 알려진 재시작 원인이 없을 때만. 통과를 포함해 진행 판정을 전부 보류한다.
      status = 'held';
      next.push(
        line(
          'held_classifier_mismatch',
          `판정 보류 — 게이트 구간에 판정식 불일치 의심 ${String(auxiliary.length)}건(X-Forwarded-* 는 사람 메일함/에이전트를 가리키는데 ` +
          '봉투가 판정식이 아는 전달 형태가 아니다). 판정식이 틀렸으면 전달·누수가 안 보이는 것이다 = 모른다. ' +
          '`pnpm ac0:probe` 로 원자료(⚠ 표시 행)를 보고 런북 `ac0-shadow-log.md` §4 표대로 `isForwardedFormOf` 를 실측값으로 고친다' +
          '(소급 적용 — 고치면 누수로 1일차가 되거나 보류가 풀린다).',
          { count: auxiliary.length },
        ),
        line('held_counterfactual', `(보류가 없었다면: ${STATUS_WITHOUT_SIGNAL[candidate]})`, { status: candidate }),
      );
    }
    return {
      ...base,
      status,
      phase,
      dayNumber,
      exitCode: status === 'passed' ? 0 : status === 'restart_required' || status === 'not_yet_true' ? 1 : 3,
      restart,
      proof: extra.proof ?? emptyProof,
      observationInterventions: extra.observationInterventions ?? observationInterventions,
      next: [...next, ...extra.next].map((entry) => entry.text),
      nextSteps: [...next, ...extra.next].map((entry) => entry.step),
    };
  };

  // ---- 1일차 이전 ----------------------------------------------------------
  if (asOf.getTime() < t1.getTime()) {
    const next =
      forwardingNow === 'on'
        ? [line('wait_day1_forwarding_on', '1일차 00:00 KST 를 기다린다. 전달 규칙 ON 이 기록돼 있다.')]
        : [line('forwarding_on_before_day1', '1일차 00:00 KST 전에 Gmail 전달 규칙을 켜고 `pnpm ac0:forwarding on` 으로 기록한다.')];
    return verdict('waiting', 'before', null, { next, observationInterventions: [] });
  }

  // ---- 관측 — restart(8) 이어도 현재 판정식으로 다시 산출한다(⑪: 소급으로 관측이 깨졌으면 1일차) ----
  {
    if (!observation.verdictPart.onAtStart) {
      return verdict('restart_required', 'observation', dayNumberSinceT1, {
        restart: restartFor(1, 'observation_invalid', '1일차 시작 시점에 전달 규칙 ON 기록이 없다 — 관측의 전제가 없다.'),
        next: [line('observation_no_on_restart', '전달 규칙을 켜고 `pnpm ac0:forwarding on` → `pnpm ac0:restart`(1일차 복귀).')],
      });
    }
    if (observation.earlyOff !== null) {
      return verdict('restart_required', 'observation', dayNumberSinceT1, {
        restart: restartFor(
          1,
          'observation_invalid',
          '비교일이 끝나기 전에 전달 규칙이 꺼졌다 — 그 뒤의 전달 0건은 전환이 아니라 규칙 OFF 의 결과다.',
        ),
        next: [line('observation_early_off_restart', '전달 규칙을 다시 켜고 `pnpm ac0:forwarding on` → `pnpm ac0:restart`(1일차 복귀).')],
      });
    }
    const { baselineDay, comparisonDay, trend } = observation.verdictPart;
    const observationNotes: NextLine[] = [];
    if (dayNumberSinceT1 !== null && dayNumberSinceT1 <= 5) {
      observationNotes.push(line('observation_only_days', '1~5일차는 관측 전용 — 개입 원인 수정 외의 작업을 하지 않는다(§3.2 V1③).'));
    }
    if (baselineDay === null) {
      const extended = completeDaysSince(t1, asOf) >= AC0_OBSERVATION_DAYS;
      return verdict(extended ? 'observation_extended' : 'observing', 'observation', dayNumberSinceT1, {
        next: [
          ...observationNotes,
          line(
            'baseline_not_yet',
            `아직 서로 다른 외부 발신자 ${String(AC0_MIN_BASELINE_SENDERS)}명 이상에게서 전달이 온 날이 없다 — 기준일이 없으면 추세도 없다(B2①).` +
              ' 전달 규칙을 끄지 않는다.',
            { minSenders: AC0_MIN_BASELINE_SENDERS },
          ),
          ...(extended
            ? [
                line(
                  'observation_extended_check_classifier',
                  '관측 연장 중. 전달이 계속 0 이면 판정식(`+caf_=`)부터 의심한다 — `pnpm ac0:probe`, 런북 §4 실측 절차.',
                ),
              ]
            : []),
        ],
      });
    }
    if (trend === 'pending') {
      const extended = baselineDay > 1;
      return verdict(extended ? 'observation_extended' : 'observing', 'observation', dayNumberSinceT1, {
        next: [
          ...observationNotes,
          line(
            'observation_pending_comparison',
            `기준일 ${String(baselineDay)}일차 → 비교일 ${String(comparisonDay)}일차. 비교일 끝 1시간 전까지 전달 규칙을 끄지 않는다.`,
            comparisonDay === null ? { baselineDay } : { baselineDay, comparisonDay },
          ),
        ],
      });
    }
    if (trend === 'failed') {
      return verdict('restart_required', 'observation', dayNumberSinceT1, {
        restart: restartFor(
          1,
          'observation_trend',
          `비교일 ${String(comparisonDay)}일차 전달이 기준일의 50%를 넘는다 — 전환 공지가 닿지 않은 상대가 남았다.`,
        ),
        next: [
          line(
            'observation_trend_failed_reannounce',
            '옛 주소로 보내는 상대에게 재공지(런북 2단계, 새 Idempotency-Key) → `pnpm ac0:restart`(1일차 복귀).',
          ),
        ],
      });
    }
  }

  if (proofPlan === null) {
    return verdict('awaiting_switch', 'switch', dayNumberSinceT1, {
      next: [
        line(
          'forwarding_off_now',
          'AC-b3 추세 통과. 이제 Gmail 전달 규칙을 끄고(필터 삭제 + 전달 주소 삭제) `pnpm ac0:forwarding off` 로 기록한다.',
        ),
        line('off_record_required', 'OFF 기록이 없으면 증명 구간은 시작하지 않는다 — 그 전의 개입 0건은 세지 않는다.'),
      ],
    });
  }

  // ---- 전환 대기 / 증명 ----------------------------------------------------------
  const inProof = (at: Date): boolean => at.getTime() >= proofPlan.watchFrom.getTime() && at.getTime() <= asOf.getTime();
  const interventions = facts.interventions.filter((record) => inProof(record.recordedAt));
  const leaks = facts.forwardedArrivals
    .map((arrival) => arrival.at)
    .filter((at) => at.getTime() >= proofPlan.leakFrom.getTime() && at.getTime() <= asOf.getTime());
  // ⑦ 증명 구간의 ON, 또는 restart(8) 재개 시점에 이미 ON 이던 상태(수정 기간에 켜 두고 안 끈 경우).
  // ⑪ ON 은 이 1일차 구간의 첫 OFF 뒤부터 전부 본다 — 8일차 복귀 전 수정 기간에 켰다 끈 것도 재가동이다.
  const reenabled =
    timeline.forwarding.find(
      (event) =>
        event.kind === 'forwarding_on' &&
        event.recordedAt.getTime() > proofPlan.offAt.getTime() &&
        event.recordedAt.getTime() <= asOf.getTime(),
    ) ?? (forwardingStateAt(timeline, proofPlan.watchFrom) === 'off' ? undefined : { recordedAt: proofPlan.watchFrom });
  const proofStarted = asOf.getTime() >= proofPlan.start.getTime();
  const completeProofDays = proofStarted ? completeDaysSince(proofPlan.start, asOf) : 0;
  const proofDayNumber = proofStarted ? AC0_OBSERVATION_DAYS + 1 + completeProofDays : dayNumberSinceT1;
  const proof: Ac0Verdict['proof'] = {
    start: proofPlan.start,
    completeDays: completeProofDays,
    interventions,
    leaks,
    window: expectedWindow,
    activity,
  };
  const preProof = observationInterventions.filter((record) => record.recordedAt.getTime() < proofPlan.watchFrom.getTime());

  // 재시작 원인 — 1일차 복귀가 8일차 복귀를 이긴다(같은 미해결 모집단으로 증명에 재진입하지 않게).
  if (leaks.length > 0) {
    return verdict('restart_required', proofStarted ? 'proof' : 'switch', proofDayNumber, {
      restart: restartFor(
        1,
        'forwarding_leak',
        `전달 규칙 OFF 기록 뒤에 전달 판정 메일 ${String(leaks.length)}건이 도착했다 — 규칙이 실제로 꺼지지 않았고, ` +
          '옛 주소로 보내는 상대가 남아 있다.',
      ),
      proof,
      observationInterventions: preProof,
      next: [
        line('leak_verify_removed', 'Gmail 필터와 전달 주소가 정말 삭제됐는지 확인한다(런북 "끄는 절차").'),
        line('leak_reannounce_restart', '보낸 상대에게 재공지 → 규칙 ON + `pnpm ac0:forwarding on` → `pnpm ac0:restart`(1일차 복귀).'),
      ],
    });
  }
  if (reenabled !== undefined) {
    return verdict('restart_required', proofStarted ? 'proof' : 'switch', proofDayNumber, {
      restart: restartFor(1, 'forwarding_reenabled', '증명 구간에 전달 규칙이 다시 켜졌다 — 안전망을 켠 채로는 증명이 아니다.'),
      proof,
      observationInterventions: preProof,
      next: [line('reenabled_restart', '`pnpm ac0:restart`(1일차 복귀). 관측을 규칙 ON 으로 다시 한다.')],
    });
  }
  if (interventions.length > 0) {
    const transition = interventions.find((record) => record.category === 'address_transition');
    const returnDay = transition === undefined ? 8 : 1;
    return verdict('restart_required', proofStarted ? 'proof' : 'switch', proofDayNumber, {
      restart: restartFor(
        returnDay,
        transition === undefined ? 'intervention_other' : 'intervention_address_transition',
        transition === undefined
          ? `증명 구간 개입 ${String(interventions.length)}건(주소 전환 아님) — 원인 수정 후 8일차부터.`
          : '증명 구간 개입 중 주소 전환 원인이 있다 — 관측이 걸렀어야 할 모집단이다. 재공지 후 1일차부터(B2②).',
      ),
      proof,
      observationInterventions: preProof,
      next:
        returnDay === 1
          ? [
              line(
                'intervention_transition_reannounce_restart',
                '해당 상대에게 재공지 → 규칙 ON + `pnpm ac0:forwarding on` → `pnpm ac0:restart`(1일차 복귀).',
              ),
            ]
          : [
              line(
                'intervention_fix_restart_day8',
                '원인을 이슈로 만들고 고친다 → 배포 뒤 `pnpm ac0:restart`(다음 KST 자정부터 8일차). 규칙은 OFF 그대로.',
              ),
            ],
    });
  }

  if (!proofStarted) {
    return verdict('awaiting_switch', 'switch', dayNumberSinceT1, {
      proof,
      observationInterventions: preProof,
      next: [line('proof_starts_next_midnight', `전달 규칙 OFF 기록됨. 증명 구간(8일차)은 다음 KST 자정에 시작한다.`)],
    });
  }

  if (completeProofDays < AC0_PROOF_DAYS) {
    return verdict('proving', 'proof', proofDayNumber, {
      proof,
      observationInterventions: preProof,
      next: [
        line(
          'proving_progress',
          `증명 ${String(completeProofDays)}/${String(AC0_PROOF_DAYS)}일 무개입. 사람 메일함에서 처리한 일이 생기면 즉시 \`pnpm ac0:intervention\`.`,
          { completeDays: completeProofDays, proofDays: AC0_PROOF_DAYS },
        ),
      ],
    });
  }

  if (activity === null || !activity.satisfied) {
    return verdict('proof_extended', 'proof', proofDayNumber, {
      proof,
      observationInterventions: preProof,
      next: [
        line(
          'proof_activity_shortfall',
          `개입 0건이지만 활동 분모 미달(${activity === null ? '분모 없음' : activity.shortfalls.join(' · ')}) — ` +
            '아무 일도 안 한 7일도 개입 0이다. 규칙 OFF 를 유지하고 증명을 연장한다(연속 7일 창 중 하나라도 충족하면 통과).',
        ),
      ],
    });
  }

  return verdict('passed', 'proof', proofDayNumber, {
    proof,
    observationInterventions: preProof,
    next: [line('passed_keep_off', 'AC-0 통과. 전달 규칙은 OFF 그대로 둔다 — 다시 켜는 순간 이 판정의 전제가 사라진다.')],
  });
}
