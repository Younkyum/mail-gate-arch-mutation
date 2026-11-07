/**
 * src/notify/contact-forward-template.ts — 문의 전달 메일의 **고정 틀**. 순수 함수 하나(보내지 않는다). US-009, ADR-0009.
 *
 * 받는 사람은 운영자 한 명(전달 주소)이다. **한 통에 한 언어**(2026-10-10) — 그 주소가 활성 운영자의 사용자 주소면 그 사용자의 설정, 아니면 'en'
 * (전달 모듈이 `atmark_operator_mail_locale` 로 고른다). 문구는 `CONTACT_FORWARD_COPY.<locale>` 에만 있다.
 * 틀에 들어가는 외부인 문자열은 전부 **텍스트로만**, 상한과 정화를 거쳐 들어간다:
 *   - 제목: 머리(`[Atmark 문의] ` · `[Atmark inquiry] `) + 원 제목(제어·양방향·제로폭 문자 제거, 공백 접기, 200자). 없으면 `(제목 없음)`.
 *   - 본문: 우리 머리 블록(원 발신자·날짜·받는 주소·판정·원문 위치) → 구분선 → 원 본문 텍스트(텍스트/plain 만 — HTML 을 렌더하지
 *     않는다, 첨부는 싣지 않고 개수만).
 * 머리 블록은 구분선 **위**에 있고 원 본문은 **아래**에 있다 — 원 본문이 머리 블록을 흉내 내도 구분선 아래라는 사실은 바뀌지 않는다.
 *
 * 2026-09-24 검증 F4·F5:
 *   - 표시 이름은 **주소와 다른 줄**에 "표시 이름(검증 안 됨)" 으로만 싣는다 — `"victim@bank.example" <x@attacker.example>` 가
 *     `보낸 사람: victim@bank.example <x@…>` 로 읽히지 않게. 회신이 가는 곳은 "보낸 사람(회신 대상)" 의 주소 하나다.
 *   - DMARC 가 `pass` 가 아니면(없음·gray 포함 — 받아들이긴 했다) 맨 윗줄에 경고 — 보낸 사람 주소가 위조됐을 수 있다.
 *   - 한 줄 칸은 승인 알림 틀의 `visibleOneLine`(제어 · 줄 구분자 → 공백, 양방향 · 제로폭 · 태그 문자 제거) 한 벌을 쓴다.
 *     본문은 `sanitizeDisplayBlock`(같은 규칙의 여러 줄 판)을 그대로 쓴다.
 *
 * 2026-09-24 최종 검증 L7:
 *   - `보낸 날짜`·`받은 시각` 도 `oneLine`(40자)을 지난다 — 문서는 앱 롤이 쓴 S3 객체라 그 칸에 개행이 있으면 머리 블록 줄을 흉내 낼 수 있다.
 *   - 회신 주소(= 보낸 사람) 도메인에 punycode 라벨(`xn--`)이 있으면 맨 윗줄에 경고 — 거부하지 않는다(국제화 도메인은 정상 발신자일
 *     수 있다). 운영자가 회신하는 곳이 `paypal.com` 이 아니라 `xn--pypal-4ve.com`(키릴 `а`) 일 수 있다는 것을 보이게 한다.
 */

import { domainToUnicode } from 'node:url';

import type { ContactForwardDocument } from '../contact/intake';
import type { MailCopyDictionary, MailLocale } from '../i18n/locales';
import { sanitizeDisplayBlock, visibleOneLine } from './approval-notification-template';
import { kst, utc } from './mail-layout';

/** 원 제목 상한(코드포인트). */
const SUBJECT_MAX_CHARS = 200;

/** 날짜 칸 상한(ISO 8601 은 24자). */
const DATE_MAX_CHARS = 40;

/** 전달(원문 포함) 메일의 문구. */
export interface ContactForwardCopy {
  readonly subjectPrefix: string;
  readonly noSubject: string;
  /** 머리 블록과 원 본문 사이 — 원 본문이 머리 블록을 흉내 내도 이 줄 아래라는 사실은 바뀌지 않는다. */
  readonly bodySeparator: string;
  /** 보낸 사람 인증(DMARC)이 `pass` 가 아닐 때 머리 블록 맨 위(F4). */
  readonly dmarcWarning: string;
  /** 회신 주소 도메인에 punycode 라벨이 있을 때 머리 블록 맨 위(L7). 뒤에 도메인 두 표기가 붙는다. */
  readonly punycodeWarning: string;
  readonly punycodeDomain: (ascii: string, unicode: string) => string;
  readonly notConvertible: string;
  /** 지금 상황 → 할 일(이 메일에 답장하면 보낸 사람에게 간다). */
  readonly intro: readonly string[];
  readonly fromLabel: string;
  /** 표시 이름 줄의 머리(F4) — 표시 이름은 발신자가 마음대로 적는 값이다. */
  readonly displayNameLabel: string;
  readonly dateLabel: string;
  readonly receivedLabel: string;
  readonly toLabel: string;
  readonly none: string;
  /** 보낸 사람 확인(DMARC pass 여부) 줄 — 용어 없이 예/아니오. */
  readonly senderCheck: (passed: boolean) => string;
  /** 시각 표기(UTC · KST). */
  readonly time: (at: Date) => string;
  readonly attachments: (count: number) => string;
  readonly rawLabel: string;
  readonly truncated: string;
  readonly noBody: string;
}

/** 알림만(제목 + 보낸 사람 도메인) 메일의 문구. */
export interface ContactNotifyCopy {
  readonly subjectPrefix: string;
  readonly noSubject: string;
  /** 지금 상황 → 할 일(콘솔의 지원 에이전트 수신함에서 답장 — 이 메일에 답장하면 보낸 사람에게 가지 않는다). */
  readonly intro: readonly string[];
  readonly subjectLabel: string;
  readonly senderDomainLabel: string;
  readonly notConvertible: string;
}

// ===========================================================================
// ✎ 문의 전달 · 알림 문구(운영자에게 가는 메일) — 문구 작성자가 고치는 곳. 2026-10-10 개편: 지금 상황 → 할 일, 낱말은 쉽게.
// ===========================================================================

export const CONTACT_FORWARD_COPY: MailCopyDictionary<ContactForwardCopy> = {
  en: {
    subjectPrefix: '[Atmark inquiry] ',
    noSubject: '(no subject)',
    bodySeparator: '----- Inquiry (forwarded text) -----',
    dmarcWarning: "Caution: we couldn't verify the sender's address, so it may be forged. Check the original before you reply.",
    punycodeWarning: "Caution: the sender's domain uses international characters, so it may imitate a well-known domain.",
    punycodeDomain: (ascii, unicode) => `  Domain: ${ascii} (shown as: ${unicode})`,
    notConvertible: '(not convertible)',
    intro: ['A new inquiry came in to support@atmark.ai.', 'Reply to this email to answer the sender.'],
    fromLabel: 'From',
    displayNameLabel: 'Display name (unverified)',
    dateLabel: 'Sent',
    receivedLabel: 'Received',
    toLabel: 'To',
    none: '(none)',
    senderCheck: (passed) => `Sender verified: ${passed ? 'yes' : 'no'}`,
    time: (at) => utc(at),
    attachments: (count) => `Attachments: ${String(count)}${count > 0 ? ' (not forwarded, kept with the original)' : ''}`,
    rawLabel: 'Original message ID',
    truncated: 'The inquiry is long, so only the beginning is forwarded. The full text is in the original.',
    noBody: '(no text)',
  },
  ko: {
    subjectPrefix: '[Atmark 문의] ',
    noSubject: '(제목 없음)',
    bodySeparator: '----- 문의 내용 (전달된 텍스트) -----',
    dmarcWarning: '주의: 보낸 사람 주소를 확인하지 못해 위조됐을 수 있습니다. 답장하기 전에 원문을 확인하세요.',
    punycodeWarning: '주의: 보낸 사람 도메인에 국제 문자가 쓰여, 잘 알려진 도메인을 흉내 낸 것일 수 있습니다.',
    punycodeDomain: (ascii, unicode) => `  도메인: ${ascii} (보이는 모양: ${unicode})`,
    notConvertible: '(변환 불가)',
    intro: ['support@atmark.ai로 새 문의가 왔습니다.', '이 메일에 답장하면 보낸 사람에게 바로 갑니다.'],
    fromLabel: '보낸 사람',
    displayNameLabel: '표시 이름(검증 안 됨)',
    dateLabel: '보낸 날짜',
    receivedLabel: '받은 시각',
    toLabel: '받는 주소',
    none: '(없음)',
    senderCheck: (passed) => `보낸 사람 확인: ${passed ? '됨' : '안 됨'}`,
    time: (at) => kst(at),
    attachments: (count) => `첨부: ${String(count)}개${count > 0 ? ' (전달하지 않음, 원문에 보관)' : ''}`,
    rawLabel: '원문 메시지 ID',
    truncated: '문의가 길어 앞부분만 전달했습니다. 전체는 원문에 있습니다.',
    noBody: '(내용 없음)',
  },
};

export const CONTACT_NOTIFY_COPY: MailCopyDictionary<ContactNotifyCopy> = {
  en: {
    subjectPrefix: '[Atmark inquiry notice] ',
    noSubject: '(no subject)',
    intro: [
      'A new inquiry came in to support@atmark.ai.',
      "Reply from the support agent's inbox in the console. Replies to this email don't reach the sender.",
    ],
    subjectLabel: 'Subject',
    senderDomainLabel: 'Sender domain',
    notConvertible: '(not convertible)',
  },
  ko: {
    subjectPrefix: '[Atmark 문의 알림] ',
    noSubject: '(제목 없음)',
    intro: ['support@atmark.ai로 새 문의가 왔습니다.', '답장은 콘솔의 지원 에이전트 수신함에서 해 주세요. 이 메일에 답장하면 보낸 사람에게 가지 않습니다.'],
    subjectLabel: '제목',
    senderDomainLabel: '보낸 사람 도메인',
    notConvertible: '(변환 불가)',
  },
};

// ===========================================================================

/** 주소의 도메인 라벨 중 하나라도 `xn--` 로 시작하면 그 도메인(소문자), 아니면 `null`. */
function punycodeDomainOf(address: string): string | null {
  const domain = address.slice(address.lastIndexOf('@') + 1).toLowerCase();
  return domain.split('.').some((label) => label.startsWith('xn--')) ? domain : null;
}

function oneLine(value: string, maxChars: number): string {
  const cleaned = visibleOneLine(value);
  const points = [...cleaned];
  return points.length > maxChars ? `${points.slice(0, maxChars).join('')}…` : cleaned;
}

/**
 * 시각 칸 — ISO 8601 처럼 읽히는 값이면 받는 사람의 표기(UTC · KST)로, 아니면 한 줄로 접은 원래 글자(40자). 원 메일 머리의 Date 는 바깥 값이라
 * 모양이 아무것이나 될 수 있다 — 읽히지 않으면 손대지 않고 접기만 한다(머리 블록 줄을 흉내 내지 못한다, L7).
 */
function timeLine(value: string, copy: ContactForwardCopy): string {
  const folded = oneLine(value, DATE_MAX_CHARS);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/.test(folded)) return folded;
  const at = new Date(folded);
  return Number.isNaN(at.getTime()) ? folded : copy.time(at);
}

/** 원 제목 한 줄(200자) — 비면 `noSubject`. */
function cleanSubject(original: string | null, noSubject: string): string {
  const cleaned = original === null ? '' : oneLine(original, SUBJECT_MAX_CHARS);
  return cleaned === '' ? noSubject : cleaned;
}

/** 원 제목 → 전달 제목. */
export function contactForwardSubject(original: string | null, locale: MailLocale): string {
  const copy = CONTACT_FORWARD_COPY[locale];
  return `${copy.subjectPrefix}${cleanSubject(original, copy.noSubject)}`;
}

export interface RenderedContactForward {
  readonly subject: string;
  readonly text: string;
}

export function renderContactForward(document: ContactForwardDocument, locale: MailLocale): RenderedContactForward {
  const copy = CONTACT_FORWARD_COPY[locale];
  const displayName = document.fromName === null ? '' : oneLine(document.fromName, 100);
  const body = sanitizeDisplayBlock(document.text);
  const punycode = punycodeDomainOf(document.fromAddress);
  const punycodeLines =
    punycode === null
      ? []
      : [copy.punycodeWarning, copy.punycodeDomain(oneLine(punycode, 254), oneLine(domainToUnicode(punycode) || copy.notConvertible, 254)), ''];
  return {
    subject: contactForwardSubject(document.subject, locale),
    text: [
      ...(document.dmarc === 'pass' ? [] : [copy.dmarcWarning, '']),
      ...punycodeLines,
      ...copy.intro,
      '',
      `${copy.fromLabel}: ${oneLine(document.fromAddress, 254)}`,
      ...(displayName === '' ? [] : [`${copy.displayNameLabel}: ${displayName}`]),
      `${copy.dateLabel}: ${document.date === null ? copy.none : timeLine(document.date, copy)}`,
      `${copy.receivedLabel}: ${timeLine(document.receivedAt, copy)}`,
      `${copy.toLabel}: ${document.to.length === 0 ? copy.none : oneLine(document.to.join(', '), 600)}`,
      copy.senderCheck(document.dmarc === 'pass'),
      copy.attachments(document.attachmentCount),
      `${copy.rawLabel}: ${oneLine(document.sesMessageId, 120)}`,
      ...(document.textTruncated ? [copy.truncated] : []),
      '',
      copy.bodySeparator,
      '',
      body === '' ? copy.noBody : body,
    ].join('\n'),
  };
}

// ---------------------------------------------------------------------------
// 알림만(2026-09-30) — `ATMARK_CONTACT_ROUTING=agent_and_notify`
// ---------------------------------------------------------------------------

/** 보낸 사람 주소 → 도메인 한 줄(소문자). punycode 면 유니코드 표기를 곁들인다 — 운영자가 비슷한 모양의 도메인을 알아보게. */
function senderDomainLine(address: string, notConvertible: string): string {
  const domain = oneLine(address.slice(address.lastIndexOf('@') + 1).toLowerCase(), 254);
  const punycode = punycodeDomainOf(address);
  return punycode === null ? domain : `${domain} (${oneLine(domainToUnicode(punycode) || notConvertible, 254)})`;
}

/**
 * **알림만** — 지원 에이전트 수신함(`support@atmark.ai`)이 원문을 받고, 운영자 메일함에는 "문의가 왔다" 만 간다. 싣는 것은 **원 제목과 보낸 사람
 * 도메인** 둘뿐이다: 본문·보낸 사람 주소·표시 이름·받는 주소·첨부 이름 없음, Reply-To 없음(전달 모듈이 `null` 로 보낸다). 회신은 Atmark(MCP ·
 * 콘솔)에서 한다 — 메일함에서 회신하면 원 발신자가 아니라 support@ 로 간다. 한 언어.
 */
export function renderContactNotify(document: ContactForwardDocument, locale: MailLocale): RenderedContactForward {
  const copy = CONTACT_NOTIFY_COPY[locale];
  const subject = cleanSubject(document.subject, copy.noSubject);
  return {
    subject: `${copy.subjectPrefix}${subject}`,
    text: [
      ...copy.intro,
      '',
      `${copy.subjectLabel}: ${subject}`,
      `${copy.senderDomainLabel}: ${senderDomainLine(document.fromAddress, copy.notConvertible)}`,
    ].join('\n'),
  };
}
