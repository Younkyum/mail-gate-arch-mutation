/**
 * src/notify/approval-notification-template.ts — 소유자 승인 알림의 **고정 템플릿** (P2, §3.4 5조).
 *
 * **이 파일은 보내지 않는다.** 순수 함수만 있다 — 입력을 받아 제목 · 두 파트(text/plain + text/html)를 돌려준다. 보내는 것은
 * `approval-notifier.ts` 이고, 그 모듈의 공개 API 는 `approvalId` 하나만 받는다(전송단 export 는 Layer B 가 이름으로 두 파일에만 허락한다).
 *
 * ===========================================================================
 * ## 2026-10-10 개편(진윤겸) — 깔끔하게, 자세한 내용은 콘솔
 * ===========================================================================
 *
 * 메일은 "지금 상황(에이전트가 보내려 한다 · 보류했다 + 위험이면 사유 한 줄) → 할 일(언제까지 승인하지 않으면 보내지 않는다)" 과 주 버튼
 * **"Send anyway / 그래도 보내기"** 하나, 버금 링크 "콘솔에서 자세히 보기" 하나다. 공용 틀(`mail-layout.ts`)이 두 파트를 한 구조에서 만든다.
 *   - 주 버튼은 **승인 확인 페이지**(`GET /approve` — 상세와 확인 버튼만 그린다)로 간다. 보내기 · 거절은 그 페이지의 **POST** 다(메일 스캐너가 GET 을
 *     따라가도 아무 일도 일어나지 않는다 — `approval/magic-link.ts`).
 *   - 버금 링크는 그 에이전트의 콘솔 발신 로그(첫 메시지 상세) — 상수 호스트 + 모양을 검사한 id(`approvalConsoleLink`).
 *
 * ## injection 표면 — 에이전트가 쓴 문자열이 소유자 메일에 들어가지 않는다
 *
 * 예전 메일은 수신자 주소 · 제목 · 첨부 이름(에이전트가 정한 값)을 울타리 안에 무력화해 실었다. 이제 **메일에 싣지 않는다** — 그 값은 승인 확인 페이지와
 * 콘솔이 `textContent` 로만 보인다. 메일에 들어가는 것은:
 *   - 상수 문장 · 항목 수 · 만료 시각 · 위험 사유 한 줄(닫힌 코드 → 상수 문장, 에이전트 문자열 없음).
 *   - 에이전트를 가리키는 조각: 유효 대표 주소(모양 검사 · 모노), 없으면 이름을 `cleanAgentName` 으로 끊어서(제어 · 양방향 · 링크 · `@` 무력화 · 40자).
 *   - 링크 둘(상수 호스트 — `assertMailLink`). 제목은 **전부 고정 문자열**(항목 수만 — 에이전트 값 0).
 * 아래의 정화 함수(`neutralizeAgentText` · `sanitizeDisplayText` · `sanitizeDisplayBlock` · `visibleOneLine`)는 승인 페이지 · 콘솔 · 문의 전달이 함께 쓴다 — 여기
 * 그대로 둔다(두 벌이면 한쪽이 낡는다).
 */

import { orderedRiskReasons } from '../approval/risk-copy';
import type { MailCopyDictionary, MailLocale } from '../i18n/locales';
import type { InjectionRisk, RiskHoldReason } from '../policy/types';
import { AGENT_ADDRESS_SHAPE, cleanAgentName, subjectLocalPart } from './domain-notice-template';
import { kstHuman, renderMail, utcHuman, type MailInline, type MailLine, type RenderedMail } from './mail-layout';

/** 제목 표시 상한(코드포인트). 수신함에서 한 줄, 본문에서 두 줄 남짓. */
export const AGENT_SUBJECT_MAX_CHARS = 200;
/** 주소 표시 상한 — RFC 5321 경로 상한과 같다. */
export const RECIPIENT_MAX_CHARS = 254;
/** 에이전트 이름 표시 상한. `agents.name` 은 200자까지 가능하지만 한 줄을 넘기지 않는다. */
export const AGENT_NAME_MAX_CHARS = 80;
/** 표시 항목 수. 나머지는 "외 N건" — 전체는 승인 페이지에서 본다. */
export const MAX_ITEMS_SHOWN = 20;

const TRUNCATED = '…(잘림)';

/** 한 줄로 만들 문자 — C0·C1 제어문자(개행·탭 포함)와 줄/문단 구분자. */
const LINE_BREAKING = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/gu;

/**
 * 보이지 않거나 표시 순서를 바꾸는 문자 — **지운다.**
 * 소프트 하이픈, 아랍 문자 표시(ALM), 한글 채움, 몽골 자유 변이 선택자, 제로폭·LRM/RLM, 양방향 삽입·재정의,
 * 단어 결합자~보이지 않는 연산자·양방향 격리, 변이 선택자, BOM, 반각 한글 채움, 특수 영역, 태그 문자, 변이 선택자 보충.
 * 문의 전달 틀(`contact-forward-template.ts`)도 `visibleOneLine` · `sanitizeDisplayBlock` 으로 이 한 벌을 쓴다(두 벌이면 한쪽이 낡는다 —
 * 내보내는 것은 `test/unit/contact/contact-forward.test.ts` 가 같은 한 벌인지 보기 위해서다 — 죽은 export 가 아니다).
 * `g` 플래그 정규식이다: `.replace` 로만 쓴다(`.test` 는 `lastIndex` 때문에 번갈아 틀린다).
 */
export const INVISIBLE =
  /[\u00ad\u061c\u115f\u1160\u17b4\u17b5\u180b-\u180f\u200b-\u200f\u202a-\u202e\u2060-\u206f\u3164\ufe00-\ufe0f\ufeff\uffa0\ufff0-\ufffb\u{e0000}-\u{e007f}\u{e0100}-\u{e01ef}]/gu;

/** 울타리 재료 — 상자 그리기 문자와 우리가 인용부로 쓰는 「」. 에이전트 값에서는 존재할 수 없다. */
const FENCE_MATERIAL = /[\u2500-\u257f\u300c\u300d]/gu;

/** I1 + I4 — 한 줄로 접고, 보이지 않거나 표시 순서를 바꾸는 문자를 지운다. 승인 페이지 · 메일 · 문의 전달의 공통 부분. */
export function visibleOneLine(value: string): string {
  return value.replace(LINE_BREAKING, ' ').replace(INVISIBLE, '').replace(/\s+/gu, ' ').trim();
}

/** I6 — 코드포인트 단위로 자르고, 잘랐다는 사실을 적는다. */
function truncated(value: string, maxChars: number): string {
  const codePoints = [...value];
  if (codePoints.length <= maxChars) return value;
  return codePoints.slice(0, maxChars).join('') + TRUNCATED;
}

/**
 * **승인 페이지 미리보기**(`approval/magic-link.ts`)가 에이전트 값을 싣기 전에 부르는 정화 — I1(한 줄) · I4(양방향·
 * 제로폭·태그 문자 제거) · I6(상한). 알림 메일(`neutralizeAgentText`)과 **같은 규칙·같은 함수**다: 두 벌이면 한쪽이
 * 낡는다(검증 V1 MINOR-3 — 페이지가 수신자를 무력화 없이 보였다). 소유자가 결정하는 곳은 페이지이고, 메일에서
 * 지운 U+202E 가 페이지에서 살아 있으면 `moc.live@bob` 이 `bob@evil.com` 으로 읽힌다.
 *
 * 메일과 다른 둘 — 일부러다:
 *   - **NFKC 를 하지 않는다.** 페이지는 결정 화면이다 — 전각 `ｂｏｂ@` 을 `bob@` 으로 바꿔 보이면 실제로 가는
 *     주소와 다른 주소를 보여 준다. 메일의 NFKC 는 무력화(I3·I5) 패턴이 전각을 놓치지 않게 하려는 것이다.
 *   - **무력화(I3)·울타리 제거(I2)를 하지 않는다.** 페이지는 `textContent` 로만 그린다(자동 링크화 없음, HTML 없음)
 *     — 울타리도 없다. 주소를 `[.]` 로 바꾸면 소유자가 도메인을 읽기 어렵다.
 */
export function sanitizeDisplayText(value: string, maxChars: number): string {
  return truncated(visibleOneLine(value), maxChars);
}

/** 여러 줄 표시에서 지울 제어문자 — `LINE_BREAKING` 에서 줄바꿈(`\n`)과 탭(`\t`)만 뺀 것. */
const BLOCK_CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/gu;

/**
 * **여러 줄** 표시 정화 — 관리 콘솔 발신 로그 상세의 본문(US-004, `<pre>` 류에 `textContent` 로 그린다). 한 줄 판
 * (`sanitizeDisplayText`)과 **같은 `INVISIBLE`** 을 지운다(I4 — 양방향·제로폭·태그 문자. 두 벌이면 한쪽이 낡는다). 다른 점은
 * 줄바꿈을 살린다는 것뿐이다: CRLF·CR·U+2028/2029 → `\n`, 탭은 그대로, 나머지 C0·C1 제어문자는 지운다. 길이 상한은 호출자가
 * 따로 건다(잘렸다는 사실을 문자열이 아니라 플래그로 싣기 위해).
 */
export function sanitizeDisplayBlock(value: string): string {
  return value.replace(/\r\n?|[\u2028\u2029]/gu, '\n').replace(BLOCK_CONTROL, '').replace(INVISIBLE, '');
}

/**
 * 에이전트가 정한 문자열 하나를 **표시해도 안전한 한 줄**로 만든다.
 *
 * 순서가 의미를 갖는다: NFKC(전각→반각) → 줄 깨기 제거 → 보이지 않는 문자 제거 → 울타리 재료 제거 →
 * 공백 접기 → 무력화 → 자르기. 무력화를 자르기 **앞**에 두는 이유: 잘린 꼬리에 `https://` 의 앞부분만
 * 남아 무력화 패턴을 비껴가는 경우를 없앤다. 앞의 둘(I1·I4)은 승인 페이지(`sanitizeDisplayText`)와 공유한다.
 */
export function neutralizeAgentText(value: string, maxChars: number): string {
  const oneLine = visibleOneLine(value.normalize('NFKC'))
    .replace(FENCE_MATERIAL, ' ')
    .replace(/\s+/gu, ' ')
    .trim();

  const defanged = oneLine
    .replace(/(h)tt(p)/giu, '$1xx$2')
    .replace(/:\/\//gu, '[:]//')
    .replace(/(?<=[\p{L}\p{N}])\.(?=[\p{L}\p{N}])/gu, '[.]');

  return truncated(defanged, maxChars);
}

/** 알림에 싣는 항목 하나 — 발송 시도 1건. 값은 전부 **에이전트가 정한 그대로**(아직 무력화 전)다. */
export interface ApprovalNotificationItem {
  readonly recipients: readonly string[];
  /** `messages.subject`. 제목 없는 메일은 `null`. */
  readonly subject: string | null;
  /**
   * 첨부 요약(메일 기본기 2차 · 보안 리뷰 L5) — 개수 · 총 바이트 · 파일명(자리 순). 파일명은 **에이전트가 정한 값**이라 울타리 안에서 무력화한다.
   * 없거나 개수 0 이면 줄을 싣지 않는다.
   */
  readonly attachments?: { readonly count: number; readonly bytes: number; readonly names: readonly string[] };
}

/** 첨부 파일명을 몇 개까지 보이는가(나머지는 개수로). */
export const MAX_ATTACHMENT_NAMES_SHOWN = 3;
/** 첨부 파일명 한 개의 표시 상한(코드포인트). */
export const ATTACHMENT_NAME_MAX_CHARS = 80;

/** 위험 보류 출처 메일 한 통(오염 맥락) — 메타만. 발신 주소는 바깥 값이라 울타리 안에서 무력화한다. 제목·본문은 싣지 않는다. */
export interface RiskSourceMail {
  readonly sender: string;
  readonly receivedAt: Date;
  /** DMARC 통과(`inbound_messages.from_authenticated`). */
  readonly authenticated: boolean;
  /** 수신 스캐너 위험도. `null` = 판정 없음. */
  readonly injectionRisk: InjectionRisk | null;
}

/** 위험 보류(ADR-0016) — 사유는 닫힌 코드, 출처는 메타뿐. 에이전트가 쓴 문자열이 없다. */
export interface ApprovalRiskView {
  readonly reasons: readonly RiskHoldReason[];
  /** 최근 읽은 T2 메일(최대 `MAX_RISK_SOURCES_SHOWN`). 오염 맥락이 아니면 빈 목록. */
  readonly sources: readonly RiskSourceMail[];
}

/** 출처 메일 표시 상한. */
export const MAX_RISK_SOURCES_SHOWN = 3;

/** 렌더 입력. **여기 있는 것은 전부 DB 에서 다시 읽은 값이다**(`approval-notifier.ts`). */
export interface ApprovalNotificationView {
  readonly approvalId: string;
  readonly agentName: string;
  /**
   * 조직 이름(2026-10-10 8차) — 본문에 "에이전트(주소, 조직)" 로 싣는 피싱 구별 표지. 이 메일은 그 조직의 주 소유자에게만 간다(이름을 지은 사람).
   * 그래도 `cleanAgentName` 으로 제어 · 보이지 않는 문자를 지우고 링크 · `@` 를 끊고 40자로 자른다. 없으면 싣지 않는다. 제목에는 싣지 않는다.
   */
  readonly organizationName?: string | null;
  /** 유효 대표 주소 — 없으면(도메인을 잃었다) `null`(문구의 "주소 없음"). */
  readonly agentAddress: string | null;
  /** `approval_requests.expires_at` — 링크 토큰의 만료와 같은 값이다. */
  readonly expiresAt: Date;
  readonly link: string;
  /**
   * 콘솔에서 이 요청을 보는 곳(2026-10-10) — 그 에이전트의 발신 로그(첫 항목이 있으면 그 메시지 상세). 상수 호스트 + 모양을 검사한 id 만
   * (`approvalConsoleLink`). 없으면(id 모양이 아니다) 싣지 않는다.
   */
  readonly consoleLink?: string | null;
  /** 앞에서부터 최대 `MAX_ITEMS_SHOWN` 건. */
  readonly items: readonly ApprovalNotificationItem[];
  /** 전체 항목 수(배치면 `items.length` 보다 클 수 있다). */
  readonly itemCount: number;
  /** 위험 보류면 사유·출처(ADR-0016). 아니면 `null` — 예전 알림 그대로. */
  readonly risk?: ApprovalRiskView | null;
}

/** 콘솔 에이전트 로그 — 호스트는 상수, 에이전트 id 는 32 hex, 메시지 id 는 uuid 만(`approvalConsoleLink`). */
const APPROVAL_CONSOLE_AGENT_URL_PREFIX = 'https://console.atmark.ai/app#/agents/';
const AGENT_ID_SHAPE = /^[0-9a-f]{32}$/;
const MESSAGE_ID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * 승인 요청의 콘솔 딥 링크 — 그 에이전트의 발신 로그, 첫 메시지 id 가 있으면 그 상세(콘솔 라우터 `#/agents/{id}/logs/outbound/{entry}` — 상세에 승인
 * 요청 id 가 보인다). 모양이 아니면 `null`(싣지 않는다 — 조립이 잘못된 값을 메일에 옮기지 않는다).
 */
export function approvalConsoleLink(agentId: string, firstMessageId: string | null): string | null {
  if (!AGENT_ID_SHAPE.test(agentId)) return null;
  const base = `${APPROVAL_CONSOLE_AGENT_URL_PREFIX}${agentId}/logs/outbound`;
  return firstMessageId !== null && MESSAGE_ID_SHAPE.test(firstMessageId) ? `${base}/${firstMessageId}` : base;
}

/** 한 언어의 고정 문구. 에이전트 값은 여기 없다 — 자리(`agent` · `short`)만 받는다. 언어마다 키 집합이 같다(타입이 강제한다). */
interface NotificationCopy {
  /** 제목 — 고정 문자열 + 에이전트 짧은 이름(대표 주소의 로컬파트 — 모양 검사, 없으면 "에이전트") + 항목 수. */
  readonly subject: (short: string | null, count: number) => string;
  /** 위험 보류 제목. 사유는 싣지 않는다. */
  readonly riskSubject: (short: string | null) => string;
  /** 머리 — 제목을 그대로 되풀이하지 않는다. */
  readonly heading: string;
  readonly riskHeading: string;
  /** 숨은 미리보기 — 결정 기한(en UTC · ko KST). 평소는 "결정해 주세요", 보류는 "그때까지 보류". */
  readonly preheader: (at: Date) => string;
  readonly riskPreheader: (at: Date) => string;
  /** 자격 증명 적중의 제목 — 심각함을 제목에서 보인다. */
  readonly credentialSubject: (short: string | null) => string;
  /** 지금 상황 — 승인을 기다린다(평소). `agent` — 에이전트 조각들(en: `주소 (조직)`, ko: `주소, 조직`). */
  readonly situation: (agent: readonly MailInline[], count: number) => MailLine;
  /** 지금 상황 + 할 일 — 보류했다(위험). 가장 심각한 사유 하나의 고정 절이 붙는다 — 상황을 말할 뿐 판정 방식은 말하지 않는다. */
  readonly riskSituation: (agent: readonly MailInline[], count: number, reason: RiskHoldReason) => MailLine;
  /** 사유별 고정 절(닫힌 어휘 → 상수). en 은 "an email" 뒤에 붙는 절 · ko 는 "에이전트(…)가" 뒤의 문장 끝까지. */
  readonly reasonClause: Readonly<Record<RiskHoldReason, (count: number) => string>>;
  /** 만료 — 그때까지 승인하지 않으면 보내지 않는다. */
  readonly action: (at: Date) => string;
  /** 주 버튼 — 한 통이면 "그래도 보내기", 여러 통이면 "N통 모두 보내기". 확인 페이지가 열리고, 보내기는 그 페이지의 POST 다. */
  readonly buttonLabel: (count: number) => string;
  readonly consoleLabel: string;
  /** 에이전트 + 조직 이름 — en `주소 (조직)` · ko `주소, 조직`(괄호 안). */
  readonly withOrganization: (agent: MailInline, organization: string) => readonly MailInline[];
}

// ===========================================================================
// ✎ 승인 알림 문구 — 문구 작성자가 고치는 곳. 위험 사유의 자세한 문장은 확인 페이지(`src/approval/risk-copy.ts`)에만 있다.
//   키 집합이 같다는 것은 `test/unit/notify/mail-locale-dictionaries.test.ts` 가 런타임에도 본다. `?` 를 쓰지 않는다.
// ===========================================================================

export const APPROVAL_NOTIFICATION_COPY: MailCopyDictionary<NotificationCopy> = {
  ko: {
    subject: (short, count) => `${short ?? '에이전트'}가 ${count === 1 ? '메일' : `메일 ${String(count)}통의`} 발송 승인을 기다립니다`,
    riskSubject: (short) => `${short ?? '에이전트'}의 메일을 보류했습니다`,
    heading: '발송 승인이 필요합니다',
    riskHeading: '확인이 필요한 메일입니다',
    preheader: (at) => `${kstHuman(at)}까지 결정해 주세요.`,
    riskPreheader: (at) => `${kstHuman(at)}까지 보류됩니다.`,
    credentialSubject: (short) => `${short ?? '에이전트'}의 메일 보류: 비밀 값 포함 가능`,
    situation: (agent, count) => ['에이전트(', ...agent, `)가 ${count === 1 ? '메일을' : `메일 ${String(count)}통을`} 보내려고 승인을 기다립니다.`],
    riskSituation: (agent, count, reason) => ['에이전트(', ...agent, `)가 ${APPROVAL_NOTIFICATION_COPY.ko.reasonClause[reason](count)}`],
    reasonClause: {
      dlp_atmark_credential: (n) => `보내려던 ${mailKo(n)}에 비밀 값이 들어 있을 수 있어 보류했습니다.`,
      dlp_third_party_secret: (n) => `보내려던 ${mailKo(n)}에 비밀번호나 비밀 값이 들어 있을 수 있어 보류했습니다.`,
      dlp_verification_code: (n) => `보내려던 ${mailKo(n)}에 받은 인증 코드가 들어 있어 보류했습니다.`,
      dlp_secret_link: (n) => `보내려던 ${mailKo(n)}에 받은 메일의 비공개 링크가 들어 있어 보류했습니다.`,
      dlp_inbound_copy: (n) => `보내려던 ${mailKo(n)}이 받은 메일을 옮겨 담고 있어 보류했습니다.`,
      dlp_scan_limit: (n) => `보내려던 ${mailKo(n)}을 끝까지 확인하지 못해 보류했습니다.`,
      tainted_context: (n) => `의심스러운 메일을 읽은 직후 보내려던 ${mailKo(n)}이라 보류했습니다.`,
    },
    action: (at) => `${kstHuman(at)}까지 승인하지 않으면 보내지 않습니다.`,
    buttonLabel: (count) => (count === 1 ? '그래도 보내기' : `${String(count)}통 모두 보내기`),
    consoleLabel: '콘솔에서 보기',
    withOrganization: (agent, organization) => [agent, `, ${organization}`],
  },
  en: {
    subject: (short, count) => `${short ?? 'Your agent'} is waiting to send ${count === 1 ? 'an email' : `${String(count)} emails`}`,
    riskSubject: (short) => `Email from ${short ?? 'your agent'} held for review`,
    heading: 'Approval needed',
    riskHeading: 'Held for your review',
    preheader: (at) => `Decide by ${utcHuman(at)}.`,
    riskPreheader: (at) => `Held until ${utcHuman(at)}.`,
    credentialSubject: (short) => `Held: ${short === null ? "your agent's" : `${short}'s`} email may contain a secret`,
    situation: (agent, count) => ['Your agent ', ...agent, ` is waiting for your approval to send ${count === 1 ? 'an email' : `${String(count)} emails`}.`],
    riskSituation: (agent, count, reason) => [
      'Your agent ',
      ...agent,
      ` tried to send ${count === 1 ? 'an email' : `${String(count)} emails`}${APPROVAL_NOTIFICATION_COPY.en.reasonClause[reason](count)}, so we held ${count === 1 ? 'it' : 'them'}.`,
    ],
    reasonClause: {
      dlp_atmark_credential: () => ' that may contain a secret',
      dlp_third_party_secret: () => ' that may contain a password or secret',
      dlp_verification_code: (n) => ` that ${n === 1 ? 'contains' : 'contain'} a verification code it received`,
      dlp_secret_link: (n) => ` that ${n === 1 ? 'contains' : 'contain'} a private link it received`,
      dlp_inbound_copy: (n) => ` that ${n === 1 ? 'copies' : 'copy'} an email it received`,
      dlp_scan_limit: () => " that we couldn't fully check",
      tainted_context: () => ' right after reading a suspicious one',
    },
    action: (at) => `If you don't approve by ${utcHuman(at)}, nothing is sent.`,
    buttonLabel: (count) => (count === 1 ? 'Send anyway' : `Send all ${String(count)}`),
    consoleLabel: 'Open details in console',
    withOrganization: (agent, organization) => [agent, ` (${organization})`],
  },
};

/** "메일" · "메일 N통" — 한국어 사유 절의 명사(뒤에 붙는 조사 에 · 이 · 을 · 이라는 두 꼴 모두 같은 모양이다). */
function mailKo(count: number): string {
  return count === 1 ? '메일' : `메일 ${String(count)}통`;
}


/**
 * 승인 알림 한 통 — **한 통에 한 언어**(받는 사람 = 조직 주 소유자의 설정 → 'en'). **에이전트가 쓴 문자열(수신자 · 제목 · 첨부 이름 · 표시 이름)은
 * 제목에 없고**, 본문에는 대표 주소(모양 검사)나 끊은 이름만 있다. 위험 보류는 사유와 상관없이 한 문장 — 사유는 확인 페이지가 보인다.
 * 주 링크 = 승인 확인 페이지(GET 은 확인 페이지만 — 보내기 · 거절은 그 페이지의 POST 버튼), 버금 링크 = 콘솔 딥 링크(있으면).
 */
export function renderApprovalNotification(view: ApprovalNotificationView, locale: MailLocale): RenderedMail {
  const copy = APPROVAL_NOTIFICATION_COPY[locale];
  const reasons = orderedRiskReasons(view.risk?.reasons ?? []);
  const risky = reasons.length > 0;
  // 가장 심각한 사유 하나(`RISK_REASON_ORDER`)의 고정 절 — 사유가 여럿이어도 한 절.
  const top = reasons[0] ?? null;
  const count = Math.max(1, view.itemCount);
  const address = view.agentAddress !== null && AGENT_ADDRESS_SHAPE.test(view.agentAddress) ? view.agentAddress : null;
  const agentOnly: MailInline = address === null ? cleanAgentName(view.agentName) : { mono: address };
  const org = view.organizationName === undefined || view.organizationName === null ? null : cleanAgentName(view.organizationName);
  const agent: readonly MailInline[] = org === null ? [agentOnly] : copy.withOrganization(agentOnly, org);
  const consoleLink = view.consoleLink ?? null;
  // 제목의 짧은 이름(I8) — 주소가 없으면 `null`, 문구가 "에이전트" 로 쓴다.
  const short = address === null ? null : subjectLocalPart(address);
  const subject = !risky ? copy.subject(short, count) : top === 'dlp_atmark_credential' ? copy.credentialSubject(short) : copy.riskSubject(short);
  return renderMail({
    subject,
    preheader: risky ? copy.riskPreheader(view.expiresAt) : copy.preheader(view.expiresAt),
    link: view.link,
    secondaryLink: consoleLink === null ? null : { href: consoleLink, label: copy.consoleLabel },
    section: {
      lang: locale,
      lead: [risky ? copy.riskHeading : copy.heading],
      paragraphs: [[top !== null ? copy.riskSituation(agent, count, top) : copy.situation(agent, count)], [copy.action(view.expiresAt)]],
      buttonLabel: copy.buttonLabel(count),
      notes: [],
    },
  });
}
