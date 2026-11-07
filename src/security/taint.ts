/**
 * src/security/taint.ts — **오염 분류**(ADR-0016 A). 에이전트가 무엇을 읽었는가 → T0 · T1 · T2. 순수 · 결정론 · I/O 없음.
 *
 * 읽기 라우트(상세 · 스레드 · 첨부 content · 인증 코드)가 본문을 돌려주기 **전에** 노출을 기록하고(M1), 발송 판정은 최근 노출로
 * 좁혀진다(`rules/risk-hold.ts`). 이 파일은 그중 "이 노출이 얼마나 위험한가" 와 "언제까지 유효한가" 의 산수만 갖는다.
 *
 * | 등급 | 뜻 | 효과 |
 * |---|---|---|
 * | `T2` | 보류 | 창 안의 발송이 `tainted_context` 로 사람에게 간다 |
 * | `T1` | 관측 | 기록만(메트릭·관찰 모드 보고) — 판정을 바꾸지 않는다 |
 * | `T0` | 깨끗 | 기록만 |
 *
 * **T2 규칙** (하나라도 참이면):
 *   1. 첨부 텍스트이고 위험도가 `low` 이상이거나 판정이 없다(`null`). 첨부는 읽을 때 처음 스캔되고 격리 경로를 타지 않는다 — 가장 큰 구멍.
 *   2. 위험도 `medium` 이상(어느 면이든). 보통 격리돼 에이전트에게 보이지 않지만, 보였다면 그 자체로 보류다.
 *   3. 본문이 `low` 이고 **완화되지 않은**(`damped=false`) 적중 계열 중 하나가 {exfiltration, agent_action, tool_invocation, override,
 *      concealment} 다 — 에이전트를 움직이는 쪽의 약한 표지 — 또는 {technique, obfuscation, encoded, evasion} 다 — 숨기거나 감싼 흔적(제로폭·태그
 *      문자·C1 교대·base64/16진수로 감싼 지시). 정상 메일이 쓸 이유가 없는 표지라 dev 음성 143(v3 에서 다국어 워크로드 1·경계 72통 추가) · 소진 v1 benign 30 에서 이 계열의 low 는 0건이다.
 *      인용·코드 안 메타 논의로 완화된 적중(보안 교육 메일)은 T1 이다.
 *   4. 본문 또는 첨부 텍스트이고 발신이 인증되지 않았다(`fromAuthenticated=false` — DMARC 통과만 참).
 *   5. 인증 코드 면이고 DMARC 가 `fail` 이다(위장한 발신자가 준 코드).
 *
 * **풀린 메일(2026-10-08 묶음 A):** 소유자가 콘솔에서 풀어 준 메일(`released=true` — 격리 또는 위험 보류였다)의 노출은 면 · 필드와 무관하게 **늘 T2** 다.
 * 풀기는 "에이전트가 읽어도 된다" 이지 "안전하다" 가 아니다 — 그 메일을 읽은 뒤의 발송은 사람이 본다.
 *
 * **신뢰 발신자 우회(같은 날):** 조직 목록과 같은 DMARC 인증된 From 의 메일(`trustedBypass=true`)은 본문 · 제목 면에서 **메일 스캐너 판정을 보지 않는다**
 * (위험도 `none` · 적중 없음으로 센다 — 규칙 2 · 3 · 제목 규칙이 서지 않는다). 첨부 텍스트(읽을 때 따로 스캔 · 규칙 1)와 인증 코드 면은 그대로다 —
 * 우회는 소유자가 고른 발신자의 **본문 판정**에만 걸린다. 미인증 규칙 4 는 우회가 DMARC 통과를 요구하므로 서지 않는다.
 *
 * **T1 규칙** (T2 가 아니면서): 위험도 `low`(뉴스레터형 — 위 계열 밖의 적중 또는 완화된 적중뿐) · 본문 판정 없음(`null`, P4 이전 행) ·
 * `sender_trust` 가 `unknown`/`blocked`/없음.
 *
 * **제목 면(`subject` — 목록 · 스레드 보기, 재검증 N1 리드 결정):** 위 규칙 대신 **하나만** — 위험도 `low` 이상이고 완화되지 않은 적중 계열이
 * 규칙 3 의 계열(에이전트를 움직이는 쪽 · 숨긴 흔적)이면 T2. 미인증 발신은 T1 이다(본문 면의 규칙 4 를 쓰지 않는다): 제목·발신자 한 줄은 지시를
 * 실어 나르기 좁고, 미인증 뉴스레터 한 통이 목록에 있는 것만으로 4시간 창을 열면 목록을 보는 에이전트의 모든 발송이 보류된다.
 * 그 밖은 본문 면의 T1 규칙과 같다.
 *
 * **창(진윤겸 결정 3):** T2 노출은 **에이전트 4시간**, 그리고 그 메일의 **스레드·발신자 7일** 동안 유효하다. 노출 시각이 지금보다
 * 미래인 행은 시각을 **지금 + 5분으로 잘라** 유효로 본다(fail closed — 잘못된 시각이 창을 닫게 두지 않는다). 5분보다 먼 미래 행은
 * 잘못된 행이므로 `futureExposureCount` 로 드러내 M1 이 알람을 건다(기록 시각은 DB `now()` 라 정상 경로에서는 생기지 않는다).
 */

import type { RuleFamily } from './injection/rule-types';
import type { InjectionRisk } from './injection/scanner';

export type TaintLevel = 'T0' | 'T1' | 'T2';

/**
 * 노출이 일어난 읽기 면(M1 의 읽기 라우트). 넷(상세 · 스레드 · 첨부 content · 인증 코드)에 **첨부 다운로드 URL** 을 더했다 — URL 을 받은 에이전트는
 * 우리가 스캔하지 않은 바이트를 읽을 수 있으므로 판정 없는 첨부 텍스트(`null` → T2)로 센다.
 */
export type ExposureSurface = 'message_detail' | 'message_list' | 'thread' | 'attachment_content' | 'attachment_url' | 'verification_code';

/**
 * 무엇이 에이전트에게 보였나. `body` 는 제목 포함. `subject` 는 제목·발신자만(목록 · 스레드 보기 — 리뷰 M1) — 등급 규칙은 머리말 "제목 면"
 * (재검증 N1: 에이전트를 움직이는·숨긴 계열의 `low` 이상만 T2, 미인증은 T1).
 */
export type ExposureField = 'body' | 'subject' | 'attachment_text' | 'verification_code';

export type AuthVerdict = 'pass' | 'fail' | 'gray' | 'processing_failed' | 'disabled' | 'unknown';

export type SenderTrustLevel = 'blocked' | 'unknown' | 'seen' | 'seed' | 'approved';

export interface TaintFinding {
  readonly family: RuleFamily;
  /** 인용·코드 안 메타 논의로 완화됐다(`SecurityFinding.damped`). */
  readonly damped: boolean;
}

export interface TaintInput {
  readonly surface: ExposureSurface;
  readonly field: ExposureField;
  /** `null` = 판정 없음(스캐너 예외 · P4 이전 행 · 아직 스캔 안 한 첨부). `none` 이 아니다. */
  readonly injectionRisk: InjectionRisk | null;
  readonly findings: readonly TaintFinding[];
  readonly auth: {
    readonly spf: AuthVerdict;
    readonly dkim: AuthVerdict;
    readonly dmarc: AuthVerdict;
    /** DMARC 통과만 `true`(`inbound_messages.from_authenticated`). */
    readonly fromAuthenticated: boolean;
  };
  /** `null` = P4 이전 행. */
  readonly senderTrust: SenderTrustLevel | null;
  /** 소유자가 풀어 준 메일이다(`inbound_messages.released_at` 있음) — 늘 T2. 생략은 거짓. */
  readonly released?: boolean;
  /** 신뢰 발신자 우회가 적용된 메일이다(`inbound_messages.trusted_bypass`) — 본문 · 제목 면의 메일 판정을 보지 않는다. 생략은 거짓. */
  readonly trustedBypass?: boolean;
}

/** 본문 `low` 를 보류로 올리는 계열 — 에이전트를 움직이는 쪽(T2 규칙 3). */
export const ACTIONABLE_FAMILIES: ReadonlySet<RuleFamily> = new Set<RuleFamily>([
  'exfiltration',
  'agent_action',
  'tool_invocation',
  'override',
  'concealment',
  'narrative',
]);

/** 숨기거나 감싼 흔적 — 본문 `low` 를 보류로 올린다(T2 규칙 3). `evasion`(v3 — 판정기를 부르는 "이 메일은 안전" 문구)도 판정을 피하려는 흔적이다. */
export const CONCEALED_FAMILIES: ReadonlySet<RuleFamily> = new Set<RuleFamily>(['technique', 'obfuscation', 'encoded', 'evasion']);

const RISK_ORDER: Readonly<Record<InjectionRisk, number>> = { none: 0, low: 1, medium: 2, high: 3 };

/** 노출 하나의 등급. */
export function classifyTaint(input: TaintInput): TaintLevel {
  if (input.released === true) return 'T2';
  // 우회는 메일 판정(본문 · 제목 면)에만 — 첨부 텍스트 · 인증 코드 면의 판정은 그대로 본다.
  const bypass = input.trustedBypass === true && input.auth.fromAuthenticated && (input.field === 'body' || input.field === 'subject');
  const risk = bypass ? 'none' : input.injectionRisk;
  const findings = bypass ? [] : input.findings;
  const rank = risk === null ? null : RISK_ORDER[risk];

  const moving = findings.some((f) => !f.damped && (ACTIONABLE_FAMILIES.has(f.family) || CONCEALED_FAMILIES.has(f.family)));
  if (input.field === 'subject') {
    if (rank !== null && rank >= RISK_ORDER.low && moving) return 'T2';
    if (!input.auth.fromAuthenticated || (rank !== null && rank >= RISK_ORDER.medium)) return 'T1';
  }
  if (input.field === 'attachment_text' && (rank === null || rank >= RISK_ORDER.low)) return 'T2';
  if (input.field !== 'subject' && rank !== null && rank >= RISK_ORDER.medium) return 'T2';
  const textual = input.field === 'body' || input.field === 'subject';
  if (input.field === 'body' && risk === 'low' && moving) return 'T2';
  if ((input.field === 'body' || input.field === 'attachment_text') && !input.auth.fromAuthenticated) return 'T2';
  if (input.field === 'verification_code' && input.auth.dmarc === 'fail') return 'T2';

  if (risk === 'low') return 'T1';
  if (risk === null && textual) return 'T1';
  if (input.senderTrust === null || input.senderTrust === 'unknown' || input.senderTrust === 'blocked') return 'T1';
  return 'T0';
}

/** 여러 노출(스레드 면)의 최댓값. 빈 목록은 `T0`. */
export function maxTaint(levels: readonly TaintLevel[]): TaintLevel {
  if (levels.includes('T2')) return 'T2';
  if (levels.includes('T1')) return 'T1';
  return 'T0';
}

// ---------------------------------------------------------------------------
// 창 (진윤겸 결정 3)
// ---------------------------------------------------------------------------

const HOUR_MS = 60 * 60 * 1000;
/** 에이전트 창 — T2 를 읽은 뒤 이 에이전트의 모든 발송. */
export const AGENT_TAINT_WINDOW_MS = 4 * HOUR_MS;
/** 스레드·발신자 창 — T2 메일의 스레드에서의 발송, 그 발신자에게의 발송. */
export const THREAD_SENDER_TAINT_WINDOW_MS = 7 * 24 * HOUR_MS;

/** 기록된 노출 한 줄(M1 `agent_exposures`). T2 만 창을 연다. */
export interface TaintExposure {
  readonly level: TaintLevel;
  readonly exposedAt: Date;
  /** 노출된 메일의 권한용 스레드. 없으면 `null`. */
  readonly threadId: string | null;
  /** 노출된 메일의 발신 주소(소문자, `+tag` 보존). */
  readonly senderAddress: string;
}

/** 미래 시각 허용 한도(시계 어긋남). */
export const FUTURE_EXPOSURE_TOLERANCE_MS = 5 * 60 * 1000;

function within(exposure: TaintExposure, now: Date, windowMs: number): boolean {
  if (exposure.level !== 'T2') return false;
  // 미래 시각은 지금 + 5분으로 자른다 — 버리지 않는다(fail closed). 자른 시각에서 창을 센다.
  const at = Math.min(exposure.exposedAt.getTime(), now.getTime() + FUTURE_EXPOSURE_TOLERANCE_MS);
  return now.getTime() - at < windowMs;
}

/** 허용 한도(5분)보다 먼 미래 시각의 T2 노출 수 — 잘라서 유효로 두되 잘못된 행이다. M1 이 메트릭·알람으로 드러낸다. */
export function futureExposureCount(exposures: readonly TaintExposure[], now: Date): number {
  return exposures.filter((e) => e.level === 'T2' && e.exposedAt.getTime() - now.getTime() > FUTURE_EXPOSURE_TOLERANCE_MS).length;
}

/** 지금 이 에이전트가 4시간 창 안에 있나. */
export function agentTaintActive(exposures: readonly TaintExposure[], now: Date): boolean {
  return exposures.some((e) => within(e, now, AGENT_TAINT_WINDOW_MS));
}

/** 이 스레드가 7일 창 안에서 오염됐나. `threadId` 가 없으면 거짓. */
export function threadTaintActive(exposures: readonly TaintExposure[], threadId: string | null, now: Date): boolean {
  if (threadId === null) return false;
  return exposures.some((e) => e.threadId === threadId && within(e, now, THREAD_SENDER_TAINT_WINDOW_MS));
}

/**
 * 7일 창 안의 오염 발신자(소문자, 정렬). 단위는 **주소**다 — 등록 도메인 단위로 넓히면 무료 메일(`gmail.com`) 하나가 그 도메인의 모든 수신자를
 * 7일 보류로 끌고 간다(ADR-0016 "발신자 창의 단위").
 */
export function taintedSenders(exposures: readonly TaintExposure[], now: Date): string[] {
  const all = new Set<string>();
  for (const e of exposures) if (within(e, now, THREAD_SENDER_TAINT_WINDOW_MS)) all.add(e.senderAddress.toLowerCase());
  return [...all].sort();
}
