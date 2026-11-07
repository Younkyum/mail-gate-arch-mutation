/**
 * src/ops/console/board-rules.ts — 주간 운영판의 **판정 규칙**(순수 함수 · import 0). 문턱 · 사다리 · 발송량 하한 · 퍼센트 규칙(분모 20) · 코호트 창.
 * 숫자는 마케팅 계획 2026-09-30 §9.2 · §6.2. DB 읽기는 `board.ts`, 화면은 `page.ts` 가 이 결과를 그리기만 한다. 가짜 데이터 미리보기
 * (`scripts/ui/ops-preview.ts` — DB · admin 모듈을 import 하지 않는다)도 이 파일을 그대로 쓴다.
 */

/** 내부 조직 — 코호트 · 북극성에서 뺀다(계획 §6.1). 가드레일은 빼지 않는다(SES 평판은 계정 하나다). */
export const INTERNAL_ORG_IDS: readonly string[] = [
  'f37fa0fd-231f-4cfe-8540-067eee3e7538', // Chronostasis — 운영자 조직(지원 수신함 support@ 포함)
];

/** 계획 §9.2 · §4.2 의 숫자. 하한은 초기값이고 8주차에 한 번 조정한다(계획). */
export const BOARD_RULES = {
  /** 증량 판정 하한 — 2주 누적 외부 발신. */
  volumeFloor14d: 200,
  /** 런칭 조건 하한 — 4주 누적 외부 발신(참고 표시). */
  volumeFloor28d: 1000,
  complaintsL1: 1,
  complaintsL2: 2,
  hardBounceRateL2: 0.02,
  waitlistHardBouncesL1: 3,
  orgDailyRecipientsL1: 20,
  newOrgShareL1: 0.3,
  newOrgShareMinSends7d: 200,
  harvestDomainsL1: 30,
  harvestCodeCallsL1: 100,
  gmailDailyPeakL2: 1000,
  /** 퍼센트를 싣는 최소 분모. */
  percentMinDenominator: 20,
  /** A 등급 내부 SLA(일). */
  gradeASlaDays: 7,
} as const;

export type BoardLevel = 'L0' | 'L1' | 'L2';
/** fired = 문턱을 넘었다 · clear = 넘지 않았다 · insufficient = 0건인데 하한 미달 · not_evaluated = 조건(발신 200통) 미달 · unobserved = DB 가 볼 수 없다. */
export type SignalStatus = 'fired' | 'clear' | 'insufficient' | 'not_evaluated' | 'unobserved';

export interface Ratio {
  readonly n: number;
  readonly d: number;
  /** 정수 퍼센트. 분모가 20 미만(0 포함)이면 `null` — 화면은 n/N 만 그린다. */
  readonly pct: number | null;
}

export function ratio(n: number, d: number): Ratio {
  return { n, d, pct: d >= BOARD_RULES.percentMinDenominator ? Math.round((n * 100) / d) : null };
}

/** 사람 문장 — `3/12` 또는 `30/40 (75%)`. */
export function ratioText(r: Ratio): string {
  return r.pct === null ? `${String(r.n)}/${String(r.d)}` : `${String(r.n)}/${String(r.d)} (${String(r.pct)}%)`;
}

export interface BoardSignal {
  readonly key: string;
  /** 넘으면 오르는 단계. */
  readonly level: Exclude<BoardLevel, 'L0'>;
  readonly label: string;
  readonly status: SignalStatus;
  /** 관측값 한 줄(건수와 분모). */
  readonly value: string;
  /** 문턱을 넘은 조직 id(있을 때만). */
  readonly organizations: readonly string[];
}

export interface ManualCheck {
  readonly key: string;
  readonly level: 'L1' | 'L2' | 'L3';
  readonly label: string;
  readonly url: string | null;
}

/** DB 가 볼 수 없는 신호 — 수동 확인(계산하지 않는다). URL 은 API 로만 싣는다(페이지 HTML 은 외부 URL 0). */
export const BOARD_MANUAL_CHECKS: readonly ManualCheck[] = [
  {
    key: 'postmaster',
    level: 'L3',
    label: 'Google Postmaster(atmark.ai · 거래성 서브도메인): 스팸률 7일 평균 0.1% 이상이면 L2, 도메인 평판 Low/Bad 면 L3. 데이터가 없으면 "미관측"으로 적는다.',
    url: 'https://postmaster.google.com',
  },
  { key: 'spamhaus', level: 'L3', label: 'Spamhaus DBL(그리고 SURBL · URIBL) 조회: atmark.ai 등재면 L3.', url: 'https://check.spamhaus.org/' },
  {
    key: 'ses',
    level: 'L3',
    label: 'SES 계정 평판 · 알람(불만 0.1% · 반송 4%) · AWS 검토/probation 통지: 하나라도 있으면 L3.',
    url: 'https://ap-northeast-2.console.aws.amazon.com/ses/home?region=ap-northeast-2#/reputation',
  },
  { key: 'abuse', level: 'L1', label: 'abuse@ · postmaster@ 신고(지원 수신함): 1건이면 L1.', url: null },
  { key: 'subdomain', level: 'L1', label: 'onve@ 거래성 메일 서브도메인 격리 상태(증량 선행조건).', url: null },
];

interface OrgValue {
  readonly organizationId: string;
  readonly value: number;
}

/** `ops_weekly_board().guard` 의 모양. */
export interface BoardGuardRaw {
  readonly externalSends: { readonly d7: number; readonly d14: number; readonly d28: number; readonly newOrgD7: number };
  readonly sesComplaints: number;
  readonly sesBounces: number;
  readonly systemComplaints: number;
  readonly systemHardBounces: number;
  readonly waitlistHardBounces: number;
  readonly gmailDailyPeak: number;
  readonly allModeCount: number;
  /** id 20개까지(수는 `allModeCount`). */
  readonly allModeOrgs: readonly string[];
  readonly dailyRecipientsTop: readonly OrgValue[];
  readonly harvestTop: readonly OrgValue[];
}

export type Steps<T> = Readonly<Record<'signedUp' | 'agent' | 'mcp' | 'inbound' | 'read' | 'deny' | 'reply' | 'retained', T>>;

export interface CohortRaw {
  readonly week: string;
  readonly invited: number;
  readonly open7: number;
  readonly open14: number;
  readonly global: Steps<number>;
  readonly beta: Steps<number>;
}


export interface Ladder {
  readonly level: BoardLevel;
  /** 화면의 판정 — 사다리 단계, 또는 L0 인데 하한 미달이면 `insufficient`(초록이 아니다). */
  readonly verdict: BoardLevel | 'insufficient';
  readonly belowFloor: boolean;
  readonly signals: readonly BoardSignal[];
}

const LEVEL_RANK: Readonly<Record<BoardLevel, number>> = { L0: 0, L1: 1, L2: 2 };

/** 가드레일 신호 → 사다리. 순수 함수(DB 없음). */
export function ladderOf(g: BoardGuardRaw): Ladder {
  const sends = g.externalSends;
  const belowFloor = sends.d14 < BOARD_RULES.volumeFloor14d;
  const zeroOr = (fired: boolean, observed: number): SignalStatus => (fired ? 'fired' : observed === 0 && belowFloor ? 'insufficient' : 'clear');
  const signals: BoardSignal[] = [];

  const complaints = g.sesComplaints + g.systemComplaints;
  const complaintText = `관측된 불만 ${String(complaints)}건(SES FBL 기준, Gmail 미포함 · 에이전트 메일 ${String(g.sesComplaints)} · 시스템 메일 ${String(g.systemComplaints)}), 외부 발신 ${String(sends.d7)}통/7일`;
  signals.push({
    key: 'complaints',
    level: complaints >= BOARD_RULES.complaintsL2 ? 'L2' : 'L1',
    label: '관측된 불만: 1건이면 L1, 주 2건 이상이면 L2',
    status: zeroOr(complaints >= BOARD_RULES.complaintsL1, complaints),
    value: complaintText,
    organizations: [],
  });

  const bounceRate = ratio(g.sesBounces, sends.d7);
  const bounceFired = sends.d7 > 0 ? g.sesBounces / sends.d7 >= BOARD_RULES.hardBounceRateL2 : g.sesBounces > 0;
  signals.push({
    key: 'hard_bounce_rate',
    level: 'L2',
    label: '하드 바운스 2% 이상',
    status: zeroOr(bounceFired, g.sesBounces),
    // 문턱(2%) 옆이라 정수 반올림을 쓰지 않는다(1.56% 가 "2%" 로 보이면 "아님" 과 어긋나 보인다) — 소수 한 자리. 분모 20 미만은 퍼센트 없음 그대로.
    value: `반송 ${String(bounceRate.n)}/${String(bounceRate.d)}${bounceRate.pct === null ? '' : ` (${((bounceRate.n * 100) / bounceRate.d).toFixed(1)}%)`}(반송 건/외부 발신 통, 7일 · 반송 유형은 저장하지 않아 전부 하드로 센다)`,
    organizations: [],
  });

  signals.push({
    key: 'gmail_daily_peak',
    level: 'L2',
    label: 'Gmail 수신자 일 최대 1,000 초과',
    status: g.gmailDailyPeak > BOARD_RULES.gmailDailyPeakL2 ? 'fired' : 'clear',
    value: `Gmail 수신자 하루 최대 ${String(g.gmailDailyPeak)}통(7일, KST 일)`,
    organizations: [],
  });

  signals.push({
    key: 'waitlist_hard_bounces',
    level: 'L1',
    label: 'onve@ 확인·초대 메일 하드 바운스 주 3건 이상',
    status: g.waitlistHardBounces >= BOARD_RULES.waitlistHardBouncesL1 ? 'fired' : 'clear',
    value: `대기자 주소 하드 바운스 ${String(g.waitlistHardBounces)}건 · 시스템 메일 전체 ${String(g.systemHardBounces)}건(7일)`,
    organizations: [],
  });

  signals.push({
    key: 'all_mode_switch',
    level: 'L1',
    label: '가입 14일 안에 발신 모드를 전체로 바꾼 조직',
    status: g.allModeCount > 0 ? 'fired' : 'clear',
    value: `${String(g.allModeCount)}곳(7일 · unrestricted · blocklist_only)${g.allModeCount > g.allModeOrgs.length ? ` · id 는 ${String(g.allModeOrgs.length)}곳까지` : ''}`,
    organizations: g.allModeOrgs,
  });

  const daily = g.dailyRecipientsTop.filter((o) => o.value >= BOARD_RULES.orgDailyRecipientsL1);
  signals.push({
    key: 'org_daily_recipients',
    level: 'L1',
    label: '한 조직이 하루 서로 다른 외부 수신자 20명 이상',
    status: daily.length > 0 ? 'fired' : 'clear',
    value: `최대 ${String(g.dailyRecipientsTop[0]?.value ?? 0)}명/일(7일) · 넘은 조직 ${String(daily.length)}곳`,
    organizations: daily.map((o) => o.organizationId),
  });

  const share = ratio(sends.newOrgD7, sends.d7);
  const shareEvaluated = sends.d7 >= BOARD_RULES.newOrgShareMinSends7d;
  signals.push({
    key: 'new_org_share',
    level: 'L1',
    label: '가입 7일 이내 조직의 외부 발신 비중 30% 이상(주간 200통 이상일 때)',
    status: !shareEvaluated ? 'not_evaluated' : sends.newOrgD7 / sends.d7 >= BOARD_RULES.newOrgShareL1 ? 'fired' : 'clear',
    value: shareEvaluated ? `${ratioText(share)}(7일)` : `해당 없음: 주간 외부 발신 ${String(sends.d7)}통 < 200`,
    organizations: [],
  });

  const harvest = g.harvestTop.filter((o) => o.value >= BOARD_RULES.harvestDomainsL1);
  signals.push({
    key: 'harvest_domains',
    level: 'L1',
    label: '인증코드 수집 신호: 조직별 7일 수신 발신 도메인 30곳 이상',
    status: harvest.length > 0 ? 'fired' : 'clear',
    value: `최대 ${String(g.harvestTop[0]?.value ?? 0)}곳(7일) · 넘은 조직 ${String(harvest.length)}곳`,
    organizations: harvest.map((o) => o.organizationId),
  });
  signals.push({
    key: 'harvest_code_calls',
    level: 'L1',
    label: '인증코드 수집 신호: get_verification_code 100회 이상',
    status: 'unobserved',
    value: '미관측: 호출 기록을 저장하지 않는다',
    organizations: [],
  });

  const level = signals.filter((s) => s.status === 'fired').reduce<BoardLevel>((top, s) => (LEVEL_RANK[s.level] > LEVEL_RANK[top] ? s.level : top), 'L0');
  return { level, verdict: level === 'L0' && belowFloor ? 'insufficient' : level, belowFloor, signals };
}

const DAY_MS = 24 * 60 * 60 * 1000;
const KST_OFFSET_MS = 9 * 60 * 60 * 1000;

/** ISO 주 열쇠(`2026-W41`, KST) → 그 주 월요일 00:00 KST(UTC 시각). 모양이 아니면 `null`. */
export function isoWeekStartKst(key: string): Date | null {
  const m = /^(\d{4})-W(\d{2})$/.exec(key);
  if (m === null) return null;
  const year = Number(m[1]);
  const week = Number(m[2]);
  if (week < 1 || week > 53) return null;
  const jan4 = Date.UTC(year, 0, 4);
  const mondayOfWeek1 = jan4 - ((new Date(jan4).getUTCDay() + 6) % 7) * DAY_MS;
  return new Date(mondayOfWeek1 + (week - 1) * 7 * DAY_MS - KST_OFFSET_MS);
}

export interface CohortRow {
  readonly week: string;
  readonly weekStart: string | null;
  /** 7일 측정 창이 닫히지 않았다 — 초대가 아직 살아 있을 수 있거나(주 시작 + 21일 전) 가입 7일이 안 된 조직이 있다. */
  readonly windowOpen: boolean;
  /** 2주차 유지(8~14일) 창이 닫히지 않았다. */
  readonly retentionOpen: boolean;
  readonly openOrgs: number;
  readonly invited: number;
  /** Beta 가 아닌 조직. `signedUp` 의 분모는 초대 수(Beta 초대 포함), 나머지 단계의 분모는 가입 수. */
  readonly global: Steps<Ratio>;
  /** Beta 조직(요금제 행 beta). 모든 단계의 분모는 Beta 가입 수(`signedUp.d` = 가입 수). */
  readonly beta: Steps<Ratio>;
}

const STEP_KEYS = ['agent', 'mcp', 'inbound', 'read', 'deny', 'reply', 'retained'] as const;

function steps(raw: Steps<number>, signedUpOf: number): Steps<Ratio> {
  const out: Record<string, Ratio> = { signedUp: ratio(raw.signedUp, signedUpOf) };
  for (const key of STEP_KEYS) out[key] = ratio(raw[key], raw.signedUp);
  return out as Steps<Ratio>;
}

export function cohortRowOf(raw: CohortRaw, now: Date): CohortRow {
  const start = isoWeekStartKst(raw.week);
  const t = now.getTime();
  return {
    week: raw.week,
    weekStart: start === null ? null : start.toISOString(),
    windowOpen: (start !== null && t < start.getTime() + 21 * DAY_MS) || raw.open7 > 0,
    retentionOpen: (start !== null && t < start.getTime() + 28 * DAY_MS) || raw.open14 > 0,
    openOrgs: raw.open7,
    invited: raw.invited,
    global: steps(raw.global, raw.invited),
    beta: steps(raw.beta, raw.beta.signedUp),
  };
}
