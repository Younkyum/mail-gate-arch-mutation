/**
 * src/notify/quarantine-notice-template.ts — **격리 알림 메일의 고정 템플릿**(ADR-0016 2026-10-07 개정). 순수 함수 하나(보내지 않는다).
 *
 * 인젝션 방어가 에이전트의 받은 메일을 격리했을 때 조직 소유자에게 가는 한 통 — 에이전트당 15분 창 하나를 묶어서(간격의 정본은 마이그레이션 `quarantine_notice_record()` 의 `15 minutes`). **한 통에 한 언어**(2026-10-10 —
 * 받는 사람마다 그 사용자의 설정 `users.mail_locale` → 'en', 알림기가 고른다), 공용 틀 `mail-layout.ts`. 링크는 그 에이전트의 콘솔 수신 로그 하나(상수
 * 호스트 + 검사한 에이전트 id). 문구는 `QUARANTINE_NOTICE_COPY.<locale>` 에만 있다.
 *
 * **공격자가 고른 글자를 싣지 않는다.** 격리된 메일의 제목 · 본문 · 첨부 이름 · 보낸 사람 주소(로컬파트)는 이 함수의 입력에 칸이 없다. 실리는 것은:
 *   - 에이전트의 유효 대표 주소(모양 검사 · 모노), 없으면 이름(그 조직이 지은 글자 — `cleanAgentName` 으로 제어 · 보이지 않는 문자를 지우고 링크를 끊고 자른다).
 *   - 수(격리 · 위험 · 가입 · 자가 등록).
 *   - **가입 감지만** 서비스 도메인(최대 `MAX_SENDER_DOMAINS_SHOWN` 개 + 나머지 수) — **DMARC 인증된 From 의 도메인만**(알림기가 고른다 — 보안 리뷰 M2).
 *     공격자가 고를 수 있는 유일한 글자라 **모양을 엄격히 검사하고**(DB CHECK 와 같다) 맞지 않으면 버리고, `[.]` 로 끊어 싣는다.
 *   - 자가 등록만 새 에이전트의 주소(모양 검사 — 이름은 주소가 없을 때만 끊어서).
 * **짧게(2026-10-10 진윤겸)** — "지금 상황 → 할 일" 두 문장 + 버튼 하나. 판정 방식 · 묶음 간격 · 안전 기본값 같은 시스템 설명은 싣지 않는다(콘솔에 있다).
 * 입력의 기간 · 사유 수 · 보낸 곳 수 · 상한으로 못 알린 수는 알림기와의 계약이라 남겨 두지만 본문에 싣지 않는다. 하루 상한에 닿은 마지막 한 통만 작은 글씨 한 줄.
 * 과장 금지(copy-guard) — 한 일("격리했습니다")만 말한다. "막았다" · "공격" 이라고 단정하지 않는다(의심일 뿐이다).
 */

import { AGENT_ADDRESS_SHAPE, cleanAgentName, subjectLocalPart } from './domain-notice-template';
import type { MailCopyDictionary, MailLocale } from '../i18n/locales';
import { renderMail, type MailInline, type MailLine, type MailSection, type RenderedMail } from './mail-layout';

/** 콘솔 에이전트 수신 로그(`#/agents/{id}/logs/inbound` — 콘솔 라우터 `LOGT`). 호스트는 상수, id 는 32 hex 만. */
export const CONSOLE_AGENT_URL_PREFIX = 'https://console.atmark.ai/app#/agents/';
/** 본문에 싣는 도메인 수 상한 — 나머지는 수로만. */
export const MAX_SENDER_DOMAINS_SHOWN = 5;
/** 조직 하루(롤링 24시간) 알림 상한 — 넘으면 보내지 않고(`suppressed`) 다음 알림이 그 수를 말한다. 알림기와 문구가 같이 쓴다. */
export const QUARANTINE_NOTICES_PER_ORG_PER_DAY = 20;
/**
 * 조직 하루 **정보 알림**(가입 감지 `signup` · 자가 등록 `enroll` — 2026-10-08) 상한. 차단 · 위험 알림(`QUARANTINE_NOTICES_PER_ORG_PER_DAY`)과 따로 센다 —
 * 정보 알림이 차단 알림을 밀어내지 않는다.
 */
const WATCH_INFO_NOTICES_PER_ORG_PER_DAY = 10;
/** 조직 하루 **자가 등록** 알림 상한 — 가입 알림과 따로 센다(가입 홍수가 "새 에이전트가 생겼다" 를 누르지 못하게, 적대 검증 D2-J040). 자가 등록 자체가 하루 20 이하다. */
const ENROLL_NOTICES_PER_ORG_PER_DAY = 10;
/**
 * 조직 하루 **정책 변경 요청** 알림 상한(ADR-0007 2026-10-13) — 다른 종류와 따로 센다(요청 홍수가 차단 · 가입 알림을 밀어내지 않게, 그 반대도). 요청 자체가
 * 에이전트당 하루 20 · 결정 대기 5 이하다. 상한을 넘은 요청도 콘솔에는 그대로 보인다.
 */
const POLICY_REQUEST_NOTICES_PER_ORG_PER_DAY = 10;
/** 자가 등록 알림 한 통에 싣는 새 에이전트 수 상한 — 나머지는 수로만. */
export const MAX_ENROLLED_AGENTS_SHOWN = 5;
/** 콘솔 감시 탭(묶음 G). 호스트 상수. */
const CONSOLE_WATCH_URL = 'https://console.atmark.ai/app#/watch';

/** 알림 창 종류 — `quarantine_notices.kind`. */
export type QuarantineNoticeKind = 'block' | 'risk' | 'signup' | 'enroll' | 'policy_request';

/** 하루 상한을 함께 세는 종류 묶음. */
export function noticeKindsOfGroup(kind: QuarantineNoticeKind): readonly QuarantineNoticeKind[] {
  // 차단은 위험과도 따로 센다(적대 검증 N-001 — 위험 알림 20통이 차단 알림을 밀어내면 안 된다. 차단은 항상 알린다).
  // 가입 알림(공격자가 메일로 만들 수 있다)과 자가 등록 알림도 서로 따로 센다(적대 검증 D2-J040 / D3-I058 — 가입 홍수가 "새 에이전트가 생겼다" 를 누르지 못하게).
  return [kind];
}

/** 그 종류 묶음의 조직 하루 상한. */
export function orgDailyCapOf(kind: QuarantineNoticeKind): number {
  if (kind === 'signup') return WATCH_INFO_NOTICES_PER_ORG_PER_DAY;
  if (kind === 'enroll') return ENROLL_NOTICES_PER_ORG_PER_DAY;
  if (kind === 'policy_request') return POLICY_REQUEST_NOTICES_PER_ORG_PER_DAY;
  return QUARANTINE_NOTICES_PER_ORG_PER_DAY;
}

const AGENT_ID_SHAPE = /^[0-9a-f]{32}$/;
/** 보낸 사람 도메인 모양 — `quarantine_notice_items.sender_domain` CHECK 와 같다. */
const SENDER_DOMAIN_SHAPE = /^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+([a-z]{2,63}|xn--[a-z0-9-]{1,59})$/;

/** 공격자가 고른 도메인이 본문에 실려도 되는 모양인가(DB CHECK 와 같은 규칙 — 한 번 더 본다). */
export function isDisplayableSenderDomain(value: string): boolean {
  return value.length <= 253 && SENDER_DOMAIN_SHAPE.test(value);
}

/** 메일 앱의 자동 링크를 끊는다(`evil.example` → `evil[.]example`). 모양 검사를 지난 값만 받는다. */
export function defangDomain(domain: string): string {
  return domain.replace(/\./g, '[.]');
}

export interface QuarantineNoticeView {
  readonly agentId: string;
  readonly agentName: string;
  /** 유효 대표 주소 — 없으면(도메인을 잃었다) `null`. */
  readonly agentAddress: string | null;
  /** 이 창의 격리 수(스캐너 격리 + 판정 없음). */
  readonly messageCount: number;
  /** 그중 판정 없이(검사 오류) 격리된 수. */
  readonly scannerErrorCount: number;
  readonly firstAt: Date;
  readonly lastAt: Date;
  /** DMARC 인증된 보낸 사람 도메인(많은 순) — 검사는 이 함수가 다시 한다. */
  readonly senderDomains: readonly string[];
  /** 인증된 도메인 종류의 전체 수. */
  readonly senderDomainCount: number;
  /** 인증되지 않은(또는 도메인 모양이 틀린) 보낸 곳의 수 — 도메인은 싣지 않는다. */
  readonly unverifiedSenderCount: number;
  /** 하루 상한 때문에 따로 알리지 못한 **이 조직**의 격리 수(조직의 직전 알림 뒤). */
  readonly suppressedCount: number;
  /** 그 격리가 온 에이전트 수. */
  readonly suppressedAgentCount: number;
  /** 이 한 통이 조직 하루 상한에 닿는 마지막 알림인가 — 이후 최대 24시간 멈춘다고 말한다. */
  readonly capReached: boolean;
  /**
   * 알림 종류(2026-10-08) — `block`(차단 등급 = 격리, 생략 시) · `risk`(위험 등급 — 에이전트 설정 `risk_notify`). 위험 알림은 같은 창 · 상한 · 도메인 규칙을 쓰고
   * 문구만 다르다(보류 · 전달 수).
   */
  readonly kind?: QuarantineNoticeKind;
  /** 위험 알림만 — 그중 에이전트 설정 `hold` 로 숨긴(보류) 수. 나머지는 전달했다. */
  readonly heldCount?: number;
  /**
   * 자가 등록 알림만 — 이 창에서 만든 에이전트(이름 · 유효 대표 주소, 최대 `MAX_ENROLLED_AGENTS_SHOWN`). 이름은 **에이전트가 지었다**(받은 메일에 휘둘렸을 수 있다) —
   * `cleanAgentName` 으로 제어 · 보이지 않는 문자를 지우고 자르며, 주소는 모양 검사를 지난 것만 싣는다.
   */
  readonly enrolledAgents?: readonly { readonly name: string; readonly address: string | null }[];
}

/** 에이전트를 가리키는 조각 — 유효 대표 주소(모노, 모양 검사)가 있으면 그것, 없으면 정화한 이름. */
type AgentRef = MailInline;

interface CountedCopy {
  /** 제목 — 에이전트 짧은 이름(대표 주소 로컬파트 — 모양 검사, 없으면 `null`)이 앞에. */
  readonly subject: (short: string | null, count: number) => string;
  /** 머리 — 제목을 그대로 되풀이하지 않는다. */
  readonly heading: string;
  /** 숨은 미리보기 — 제목 · 머리 · 본문에 없는 사실 하나. */
  readonly preheader: string;
  /** 지금 상황 + 할 일(한 문단) — 에이전트 · 수. */
  readonly body: (agent: AgentRef, count: number) => MailLine;
  readonly buttonLabel: string;
}

interface SignupNoticeCopy {
  readonly subject: (short: string | null) => string;
  readonly heading: string;
  readonly preheader: string;
  /** "에이전트가 <도메인> 외 N곳에 가입한 것 같습니다. 확인해 주세요." — 도메인 조각(무력화한 모노)을 받는다. */
  readonly body: (agent: AgentRef, services: readonly MailInline[]) => MailLine;
  readonly unknownService: string;
  readonly moreServices: (rest: number) => string;
  readonly buttonLabel: string;
}

interface EnrollNoticeCopy {
  readonly subject: (short: string | null, count: number) => string;
  readonly heading: string;
  readonly preheader: string;
  /** 수는 제목에 있다 — 본문은 되풀이하지 않는다("…가 만든 에이전트:"). */
  readonly situation: (creator: AgentRef) => MailLine;
  readonly more: (rest: number) => string;
  readonly action: string;
  readonly buttonLabel: string;
}

export interface QuarantineNoticeCopy {
  readonly block: CountedCopy;
  readonly risk: CountedCopy;
  readonly signup: SignupNoticeCopy;
  readonly enroll: EnrollNoticeCopy;
  /**
   * 정책 변경 요청(ADR-0007 2026-10-13) — 에이전트가 자기 정책의 변경을 부탁했다. **수와 링크만** — 바꾸려는 값 · 이유는 에이전트가 쓴 글자라 싣지 않는다
   * (ADR-0016 "에이전트가 만든 문자열을 경고 문구에 넣지 않는다"). 차이 · 이유 · 위험 경고는 콘솔이 보인다.
   */
  readonly policyRequest: CountedCopy;
}

/** 가입 감지 알림에 이름을 싣는 서비스 수 — 나머지는 수로만(2026-10-10 2차 — "github[.]com 외 4곳"). */
const MAX_SIGNUP_SERVICES_SHOWN = 1;
/** 자가 등록 알림 본문에 싣는 새 에이전트 주소 수 — 나머지는 수로만. */
const MAX_ENROLLED_AGENTS_LISTED = 3;

const plural = (n: number, word: string): string => `${word}${n === 1 ? '' : 's'}`;

// ===========================================================================
// ✎ 감시 알림 문구(격리 · 위험 · 가입 감지 · 자가 등록) — 문구 작성자가 고치는 곳. `?` 를 쓰지 않는다.
//   2026-10-10 개편: 짧게 — 지금 상황 → 할 일(한 문단). 시스템 규칙(묶음 간격 · 판정 방식 · 상한 · 안전 기본값)은 싣지 않는다. 자세한 내용은 콘솔.
//   낱말: 받은 메일은 격리(quarantine) · 보내는 메일은 보류(hold). "의심스러운 / suspicious" 로 통일. 콘솔 이름: 수신 로그(inbound log) · 감시(Watch).
//   과장 금지(copy-guard) — 한 일("격리했습니다")만 말한다. "막았다" · "공격" 이라고 단정하지 않는다.
// ===========================================================================

export const QUARANTINE_NOTICE_COPY: MailCopyDictionary<QuarantineNoticeCopy> = {
  en: {
    block: {
      subject: (short, n) => `${short === null ? '' : `${short}: `}${n === 1 ? `${short === null ? 'S' : 's'}uspicious email quarantined` : `${String(n)} suspicious emails quarantined`}`,
      heading: 'Mail quarantined',
      preheader: "Your agent can't see quarantined mail.",
      body: (agent, n) =>
        n === 1
          ? ['An incoming email to ', agent, ' was quarantined as suspicious. Check the verdict in the inbound log.']
          : [`${String(n)} incoming emails to `, agent, ' were quarantined as suspicious. Check the verdicts in the inbound log.'],
      buttonLabel: 'Open inbound log',
    },
    risk: {
      subject: (short, n) => `${short === null ? '' : `${short}: `}${n === 1 ? `${short === null ? 'A' : 'a'} suspicious email reached your agent` : `${String(n)} suspicious emails reached your agent`}`,
      heading: 'Suspicious mail arrived',
      preheader: 'Review them before your agent acts on them.',
      body: (agent, n) =>
        n === 1
          ? ['An incoming email to ', agent, ' looks suspicious. Review it in the inbound log.']
          : [`${String(n)} incoming emails to `, agent, ' look suspicious. Review them in the inbound log.'],
      buttonLabel: 'Open inbound log',
    },
    signup: {
      subject: (short) => (short === null ? 'Your agent may have signed up for a service' : `${short}: may have signed up for a service`),
      heading: 'New sign-up spotted',
      preheader: 'Check that you expected it.',
      body: (agent, services) => ['Your agent ', agent, ' seems to have signed up for ', ...services, '. Review it in the Watch tab.'],
      unknownService: 'an outside service',
      moreServices: (rest) => ` and ${String(rest)} other ${plural(rest, 'service')}`,
      buttonLabel: 'Open Watch tab',
    },
    enroll: {
      subject: (short, n) => `${short === null ? 'Your agent' : `${short}:`} created ${n === 1 ? 'a new agent' : `${String(n)} new agents`}`,
      heading: 'New agents created',
      preheader: 'Check that you expected them.',
      situation: (creator) => ['Your agent ', creator, ' created:'],
      more: (rest) => `and ${String(rest)} other ${plural(rest, 'agent')}`,
      action: "If you didn't expect this, review them in the console.",
      buttonLabel: 'Open Watch tab',
    },
    policyRequest: {
      subject: (short, n) => `${short === null ? 'Your agent' : `${short}:`} asks to change its email policy${n === 1 ? '' : ` (${String(n)} requests)`}`,
      heading: 'Policy change requested',
      preheader: 'Nothing changes until you approve.',
      body: (agent, n) =>
        n === 1
          ? ['Your agent ', agent, ' asked to change its email policy. Nothing changes until you approve. Review the exact change in the console.']
          : ['Your agent ', agent, ` made ${String(n)} requests to change its email policy. Nothing changes until you approve. Review them in the console.`],
      buttonLabel: 'Review request',
    },
  },
  ko: {
    block: {
      subject: (short, n) => `${short === null ? '' : `${short}: `}의심스러운 메일 ${String(n)}통 격리`,
      heading: '메일을 격리했습니다',
      preheader: '격리\u00a0메일은 에이전트가 볼 수 없습니다.',
      // 고정 낱말(수신 로그)은 줄이 갈라지지 않게 줄바꿈 없는 공백(U+00A0).
      body: (agent, n) => [agent, ` 앞으로 온 메일 ${String(n)}통이 의심스러워 격리했습니다. 수신\u00a0로그에서 판정을 확인해 주세요.`],
      buttonLabel: '수신 로그 열기',
    },
    risk: {
      subject: (short, n) => `${short === null ? '' : `${short}: `}의심스러운 메일 ${String(n)}통이 에이전트에 도착했습니다`,
      heading: '의심스러운 메일이 왔습니다',
      preheader: '에이전트가 처리하기 전에 확인해 주세요.',
      body: (agent, n) => [agent, ` 앞으로 의심스러운 메일 ${String(n)}통이 왔습니다. 수신\u00a0로그에서 확인해 주세요.`],
      buttonLabel: '수신 로그 열기',
    },
    signup: {
      subject: (short) => `${short ?? '에이전트'}: 서비스에 가입한 것 같습니다`,
      heading: '새 가입을 발견했습니다',
      preheader: '직접 시킨 일인지 확인해 주세요.',
      body: (agent, services) => ['에이전트(', agent, ')가 ', ...services, '에 가입한 것 같습니다. 감시 탭에서 확인해 주세요.'],
      unknownService: '바깥 서비스',
      moreServices: (rest) => ` 외 ${String(rest)}곳`,
      buttonLabel: '감시 탭 열기',
    },
    enroll: {
      subject: (short, n) => `${short ?? '에이전트'}: 새 에이전트 ${String(n)}개 생성`,
      heading: '새 에이전트가 생겼습니다',
      preheader: '직접 만든 에이전트인지 확인해 주세요.',
      situation: (creator) => ['에이전트(', creator, ')가 만든 에이전트:'],
      more: (rest) => `외 ${String(rest)}개`,
      action: '예상하지 못한 일이라면 콘솔에서 확인해 주세요.',
      buttonLabel: '감시 탭 열기',
    },
    policyRequest: {
      subject: (short, n) => `${short ?? '에이전트'}: 메일 정책 변경 요청${n === 1 ? '' : ` ${String(n)}건`}`,
      heading: '정책 변경을 요청했습니다',
      preheader: '승인하기 전에는 아무것도 바뀌지 않습니다.',
      body: (agent, n) => [
        '에이전트(',
        agent,
        `)가 메일 정책 변경을 ${n === 1 ? '' : `${String(n)}건 `}요청했습니다. 승인하기 전에는 아무것도 바뀌지 않습니다. 콘솔에서 바뀌는 내용을 확인해 주세요.`,
      ],
      buttonLabel: '요청 확인',
    },
  },
};

// ===========================================================================

function agentRef(view: QuarantineNoticeView): AgentRef {
  return view.agentAddress === null ? cleanAgentName(view.agentName) : { mono: view.agentAddress };
}

/** 가입 감지 — 인증된 서비스 도메인(모양 검사 · `[.]` 로 끊음) 최대 `MAX_SIGNUP_SERVICES_SHOWN` 개 + 나머지 수. 없으면 "바깥 서비스". */
function serviceParts(view: QuarantineNoticeView, copy: SignupNoticeCopy): MailInline[] {
  const shown = view.senderDomains.filter(isDisplayableSenderDomain).slice(0, Math.min(MAX_SIGNUP_SERVICES_SHOWN, MAX_SENDER_DOMAINS_SHOWN));
  if (shown.length === 0) return [copy.unknownService];
  // HTML 은 자연스러운 도메인(점마다 인라인 요소 — 자동 링크 방지) · text 는 `[.]`(`MailInline` host — 2026-10-10 진윤겸 결정).
  const parts: MailInline[] = shown.flatMap((domain, index): MailInline[] => (index === 0 ? [{ host: domain }] : [', ', { host: domain }]));
  const rest = Math.max(0, view.senderDomainCount - shown.length);
  if (rest > 0) parts.push(copy.moreServices(rest));
  return parts;
}

// 하루 상한 줄은 어느 감시 알림에도 싣지 않는다 — 본문이 이미 콘솔로 보낸다(콘솔 문장은 한 통에 하나).
function countedSection(view: QuarantineNoticeView, c: CountedCopy, lang: MailLocale): MailSection {
  return { lang, lead: [c.heading], paragraphs: [[c.body(agentRef(view), view.messageCount)]], buttonLabel: c.buttonLabel, notes: [] };
}

function signupSection(view: QuarantineNoticeView, c: SignupNoticeCopy, lang: MailLocale): MailSection {
  return { lang, lead: [c.heading], paragraphs: [[c.body(agentRef(view), serviceParts(view, c))]], buttonLabel: c.buttonLabel, notes: [] };
}

function enrollSection(view: QuarantineNoticeView, c: EnrollNoticeCopy, lang: MailLocale): MailSection {
  const n = Math.max(1, view.messageCount);
  const agents = (view.enrolledAgents ?? []).slice(0, Math.min(MAX_ENROLLED_AGENTS_LISTED, MAX_ENROLLED_AGENTS_SHOWN));
  const rest = Math.max(0, n - agents.length);
  // 새 에이전트는 주소(우리가 만든 값 — 모양 검사)만 싣는다. 이름은 에이전트가 지은 글자라 주소가 없을 때만 끊어 싣는다(`cleanAgentName`).
  const lines: MailLine[] = agents.map((agent): MailLine => {
    const address = agent.address !== null && AGENT_ADDRESS_SHAPE.test(agent.address) ? agent.address : null;
    return address === null ? [`· ${cleanAgentName(agent.name)}`] : ['· ', { host: address }];
  });
  return {
    lang,
    lead: [c.heading],
    paragraphs: [[c.situation(agentRef(view))], ...(lines.length > 0 ? [[...lines, ...(rest > 0 ? [c.more(rest)] : [])]] : []), [c.action]],
    buttonLabel: c.buttonLabel,
    notes: [],
  };
}

/** 감시 알림 한 통 — 한 언어. 링크는 그 에이전트의 콘솔 수신 로그(차단 · 위험) 또는 감시 탭(가입 · 자가 등록) 하나. */
export function renderQuarantineNotice(view: QuarantineNoticeView, locale: MailLocale): RenderedMail {
  if (!AGENT_ID_SHAPE.test(view.agentId)) throw new Error('에이전트 id 모양이 아니다');
  if (!Number.isInteger(view.messageCount) || view.messageCount < 1) throw new Error('격리 수는 1 이상의 정수여야 한다');
  const address = view.agentAddress !== null && AGENT_ADDRESS_SHAPE.test(view.agentAddress) ? view.agentAddress : null;
  const safe: QuarantineNoticeView = { ...view, agentAddress: address };
  const copy = QUARANTINE_NOTICE_COPY[locale];
  const short = address === null ? null : subjectLocalPart(address);
  const n = view.messageCount;
  if (view.kind === 'signup') {
    return renderMail({ subject: copy.signup.subject(short), preheader: copy.signup.preheader, link: CONSOLE_WATCH_URL, section: signupSection(safe, copy.signup, locale) });
  }
  if (view.kind === 'enroll') {
    return renderMail({ subject: copy.enroll.subject(short, n), preheader: copy.enroll.preheader, link: CONSOLE_WATCH_URL, section: enrollSection(safe, copy.enroll, locale) });
  }
  if (view.kind === 'policy_request') {
    // 링크는 그 에이전트의 이메일 화면(요청 · 차이 · 승인이 있는 곳 — 콘솔 라우터 `#/agents/{id}/email`).
    const emailTab = `${CONSOLE_AGENT_URL_PREFIX}${view.agentId}/email`;
    return renderMail({
      subject: copy.policyRequest.subject(short, n),
      preheader: copy.policyRequest.preheader,
      link: emailTab,
      section: countedSection(safe, copy.policyRequest, locale),
    });
  }
  const counted = view.kind === 'risk' ? copy.risk : copy.block;
  const inboundLog = `${CONSOLE_AGENT_URL_PREFIX}${view.agentId}/logs/inbound`;
  return renderMail({ subject: counted.subject(short, n), preheader: counted.preheader, link: inboundLog, section: countedSection(safe, counted, locale) });
}
