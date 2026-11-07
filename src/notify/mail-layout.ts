/**
 * src/notify/mail-layout.ts — 시스템 메일(로그인·가입·초대·운영 코드·환영·승인·도메인·감시 알림)의 **공용 틀**. 순수 함수(보내지 않는다).
 *
 * 템플릿(`*-template.ts`)은 문장을 **구조**(`MailDocument` — 한 언어 블록 하나)로만 넘기고, 이 파일이 그 한 구조에서 **text/plain 과
 * text/html 두 파트를 함께** 만든다. 두 파트가 한 원본에서 나오므로 한쪽에만 있는 안전 문구(만료·1회·5번·무시·직원은 묻지 않는다)가 생길 자리가 없다.
 * 한 통에 한 언어 — 언어는 받는 사람마다 알림기가 고른다(`src/i18n/locales.ts` `resolveMailLocale`). 두 언어를 이어 붙일 자리가 타입에 없다.
 *
 * HTML 파트의 피싱 위험(보이는 글자와 실제 목적지가 다른 링크)을 구조로 닫는다:
 *   - 주 링크는 **한 통에 하나** + 버금 링크 하나까지. 버튼 아래에는 **호스트 이름**을 글자로, 버튼의 `aria-label` 에도 호스트를 싣고,
 *     text/plain 에는 "이름표 (호스트):" 다음 줄에 원문 URL. 링크 모양은 `assertMailLink` 가 본다(https · atmark.ai 호스트 · 쿼리 없음 · 안전 문자만).
 *   - 들어가는 값은 상수 문장 · 6자리 코드(`assertMailCode`) · 링크 · 시각 · 모양을 검사한 주소/도메인 · 끊은 이름뿐이다.
 *     그래도 **보간하는 모든 값을 HTML 이스케이프한다.**
 *   - 원격 자원 0 — 이미지·웹 폰트·추적 픽셀·외부 스타일시트가 없다. 색은 무채색뿐(`@` 도 잉크색), 파랑 0
 *     (메일 앱이 자동으로 거는 링크 색도 머리 스타일이 되돌린다).
 * 문의 전달(`contact-forward-template.ts`)은 발신자가 고른 문자열을 싣는다 — 이 틀을 쓰지 않고 text/plain 으로 남는다.
 *
 * 메일 앱 호환: 표 배치 · 인라인 스타일 · 폭 520. 머리의 `<style>` 은 다크 모드·좁은 화면·자동 링크 색 되돌리기만 맡는다 — 지원하지 않는
 * 앱에서는 흰 바탕의 인라인 스타일 그대로 읽힌다. 미리보기 문구(preheader)는 숨긴 상수 문장이고 **코드를 싣지 않는다**(뒤를 공백 문자로 채워
 * 본문의 코드가 목록 미리보기로 끌려 나오지 않게 한다).
 */

import type { MailLocale } from '../i18n/locales';

/** 코드 모양 — 템플릿이 받는 코드는 6자리 숫자뿐이다(다른 문자열이 본문에 들어갈 자리가 없게). */
const CODE_PATTERN = /^[0-9]{6}$/;

/** 템플릿 입력의 코드 검사 — 로그인·가입·운영 템플릿이 같이 쓴다. */
export function assertMailCode(code: string): string {
  if (!CODE_PATTERN.test(code)) throw new Error('메일 코드는 6자리 숫자여야 한다');
  return code;
}

/**
 * 링크 모양 — https · 호스트는 `atmark.ai` 또는 그 하위 · 쿼리(`?`)·자격증명·포트 없음 · URL 안전 문자만(따옴표·꺾쇠·공백이 들어갈 수
 * 없다). 링크는 상수 페이지 URL + 서명 토큰(fragment)이라 이 모양을 벗어나면 조립이 잘못된 것이다 — 보내지 않고 던진다.
 */
const LINK_PATTERN = /^https:\/\/(?:[a-z0-9-]+\.)*atmark\.ai\/[A-Za-z0-9._~/#=-]*$/;

export function assertMailLink(link: string): string {
  if (!LINK_PATTERN.test(link)) throw new Error('메일 링크는 atmark.ai 의 https URL 이어야 한다(쿼리·따옴표·공백 없음)');
  return link;
}

export function kst(at: Date): string {
  return `${new Date(at.getTime() + 9 * 3_600_000).toISOString().slice(0, 16).replace('T', ' ')} KST`;
}

const MONTHS_EN = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;

/** 고객 메일의 날짜(2026-10-10 9차) — en `Oct 12, 09:30 UTC`. 연도는 싣지 않는다(기한은 며칠 안이다). 운영자 메일은 `utc` 그대로. */
export function utcHuman(at: Date): string {
  const iso = at.toISOString();
  return `${MONTHS_EN[at.getUTCMonth()] ?? ''} ${String(at.getUTCDate())}, ${iso.slice(11, 16)} UTC`;
}

/** 고객 메일의 날짜 — ko `10월 12일 18:30 KST`. */
export function kstHuman(at: Date): string {
  const k = new Date(at.getTime() + 9 * 3_600_000);
  return `${String(k.getUTCMonth() + 1)}월 ${String(k.getUTCDate())}일 ${k.toISOString().slice(11, 16)} KST`;
}

export function utc(at: Date): string {
  return `${at.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

/**
 * 문장 조각 — 평문 · 모노(주소 · 참조) · 굵게(초대자 주소) · `host`. text/plain 에서는 `host` 말고는 글자 그대로 이어 붙는다.
 * `host` — 바깥 서비스 도메인 · 새 에이전트 주소처럼 메일 앱이 자동 링크를 걸 수 있는 이름(가입 감지 · 자가 등록).
 *   - text/plain: 점을 `[.]` 로 끊는다(평문 앱은 무엇이든 링크로 만든다).
 *   - text/html: 보이는 글자는 그대로(`github.com`)이고, 점 하나하나를 인라인 요소로 감싼다(`github<span>.</span>com`). 자동 링크기는 한 텍스트
 *     노드 안의 `이름.이름` 을 찾는다 — 점이 다른 노드에 있으면 이어진 도메인으로 보지 않는다. 보이지 않는 문자를 넣지 않으므로 복사하면
 *     `github.com` 그대로다. 그래도 링크가 걸리는 앱을 위해 머리 스타일이 자동 링크 색 · 밑줄을 글자색으로 되돌린다.
 */
export type MailInline = string | { readonly mono: string } | { readonly strong: string } | { readonly host: string };

/** 한 줄(text/plain 한 줄 = HTML 한 문장). */
export type MailLine = string | readonly MailInline[];

/**
 * 한 통의 블록(한 언어). 순서: 머리 문장 → (step-up) 확인 항목 → 코드 → 안내 → (편지) 본문 문단들 → 링크 → (편지) 맺음 문단들 → 작은 글씨 문단들.
 */
export interface MailSection {
  readonly lang: MailLocale;
  /** 첫 줄은 제목 크기, 나머지는 본문. 비우면 제목이 없다(편지 모양 — 환영 메일). */
  readonly lead: readonly MailLine[];
  readonly facts?: readonly { readonly label: string; readonly value: MailInline }[];
  /** 코드와 그 위의 작은 이름표(HTML 만 — text/plain 에서는 코드 한 줄). */
  readonly code?: { readonly label: string; readonly value: string };
  readonly body?: readonly MailLine[];
  /** 본문 크기 문단 여럿(편지 — 환영 메일). 링크 앞에 선다. */
  readonly paragraphs?: readonly (readonly MailLine[])[];
  /** 본문 크기 문단 여럿 — 링크 **뒤**(편지의 맺음: 답장 안내 · 서명). */
  readonly closing?: readonly (readonly MailLine[])[];
  /** 버튼 글자(HTML 만). href 는 문서의 `link` 하나다. */
  readonly buttonLabel?: string;
  /** 작은 글씨 문단들(만료 · 5회 · 무시 · 코드를 묻지 않는다). */
  readonly notes: readonly (readonly MailLine[])[];
}

export interface MailDocument {
  readonly subject: string;
  /** 숨은 미리보기 문장 — **코드를 넣지 않는다.** */
  readonly preheader: string;
  /** 한 통의 주 링크(버튼 하나). 없으면(코드 메일) 버튼도 원문 URL 도 없다. */
  readonly link: string | null;
  /** 버금 링크(승인 메일의 콘솔 링크 · 환영 메일의 설정 안내) — 버튼 아래 작은 글자 링크. 모양 검사는 주 링크와 같다. 주 링크가 없으면 쓸 수 없다. */
  readonly secondaryLink?: { readonly href: string; readonly label: string } | null;
  /** 받는 사람의 언어 하나로 쓴 블록 하나(`test/unit/notify/mail-locale-dictionaries.test.ts` 가 다른 언어가 새지 않는지 본다). */
  readonly section: MailSection;
}

export interface RenderedMail {
  readonly subject: string;
  readonly text: string;
  readonly html: string;
}

// ---------------------------------------------------------------------------
// text/plain
// ---------------------------------------------------------------------------

function inlineText(part: MailInline): string {
  if (typeof part === 'string') return part;
  if ('host' in part) return part.host.replace(/\./g, '[.]');
  return 'mono' in part ? part.mono : part.strong;
}

function lineText(line: MailLine): string {
  return typeof line === 'string' ? line : line.map(inlineText).join('');
}

/** 꼬리 첫 줄 — 보내는 곳. 모든 시스템 메일이 같다. */
export const MAIL_FOOTER_SIGNATURE = 'Atmark · atmark.ai';

function sectionText(section: MailSection, link: string | null, secondary: MailDocument['secondaryLink']): string[] {
  const out: string[] = section.lead.length > 0 ? [...section.lead.map(lineText), ''] : [];
  if (section.facts !== undefined && section.facts.length > 0) {
    out.push(...section.facts.map((fact) => `${fact.label}: ${inlineText(fact.value)}`), '');
  }
  if (section.code !== undefined) out.push(section.code.value, '');
  if (section.body !== undefined && section.body.length > 0) out.push(...section.body.map(lineText), '');
  for (const paragraph of section.paragraphs ?? []) out.push(...paragraph.map(lineText), '');
  // 버튼 글자를 text/plain 에도 — "Send anyway (api.atmark.ai):" 다음 줄에 URL. 받는 사람이 URL 을 읽기 전에 목적지 호스트를 본다.
  if (link !== null) {
    if (section.buttonLabel !== undefined) out.push(`${section.buttonLabel} (${new URL(link).host}):`);
    out.push(link, '');
  }
  if (secondary !== undefined && secondary !== null) out.push(`${secondary.label} (${new URL(secondary.href).host}):`, secondary.href, '');
  for (const paragraph of section.closing ?? []) out.push(...paragraph.map(lineText), '');
  for (const paragraph of section.notes) out.push(...paragraph.map(lineText), '');
  out.push(MAIL_FOOTER_SIGNATURE);
  return out;
}

// ---------------------------------------------------------------------------
// text/html
// ---------------------------------------------------------------------------

const HTML_ESCAPES: Readonly<Record<string, string>> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/** HTML 이스케이프 — 본문·속성 어디에 들어가도 안전한 다섯 글자. 보간하는 **모든** 값이 여기를 지난다. */
export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => HTML_ESCAPES[char] ?? char);
}

/** 글꼴 — 원격 폰트를 싣지 않는다. 설치된 Pretendard 가 있으면 쓰고, 없으면 시스템 고딕. */
const SANS = "Pretendard,-apple-system,BlinkMacSystemFont,'Apple SD Gothic Neo','Malgun Gothic','Segoe UI',sans-serif";
const MONO = "ui-monospace,SFMono-Regular,'SF Mono',Menlo,Consolas,'Liberation Mono',monospace";

/**
 * 색 — 사이트 밝은 벌(`src/site/styles.ts` `SITE_LIGHT`)의 무채색 값. 주황은 없다 — 워드마크 `@` 도 잉크색.
 * 다크 값은 `SITE_DARK` 에서 — 머리 스타일의 `@media (prefers-color-scheme: dark)` 가 쓴다.
 */
const INK = '#171717';
const TEXT = '#3A3A3A';
const MUTED = '#6B6B6B';
const LINE = '#E8E8E8';
const WELL = '#F7F7F7';
const PAPER = '#FFFFFF';

/**
 * 워드마크 — 로고 가로 조합(`src/ui/brand.ts`)의 소문자 "atmark" 를 **글자로** 쓴다(2026-09-30). 로고 그림은 싣지 않는다: 메일 앱 다수가
 * SVG 를 지우고(Gmail·Outlook), 원격 PNG 는 기본 차단 + 열람 추적 신호가 되며 이 틀의 "원격 자원 0" 원칙(머리말)을 깬다. 글자는 모든 앱·
 * 이미지 차단·다크 모드(`.fg`)에서 그대로 읽힌다.
 */
const WORDMARK =
  `<span class="fg" style="font-family:${SANS};font-size:22px;line-height:24px;font-weight:800;letter-spacing:-0.045em;color:${INK};white-space:nowrap">atmark</span>`;

function inlineHtml(part: MailInline): string {
  if (typeof part === 'string') return escapeHtml(part);
  if ('mono' in part) return `<span style="font-family:${MONO};font-size:0.92em">${escapeHtml(part.mono)}</span>`;
  if ('host' in part) {
    const pieces = part.host.split('.').map(escapeHtml).join('<span class="hd">.</span>');
    return `<span class="host" style="font-family:${MONO};font-size:0.92em">${pieces}</span>`;
  }
  return `<strong class="fg" style="font-weight:700;color:${INK}">${escapeHtml(part.strong)}</strong>`;
}

function lineHtml(line: MailLine): string {
  return typeof line === 'string' ? escapeHtml(line) : line.map(inlineHtml).join('');
}

function headingHtml(line: MailLine): string {
  return (
    `<h1 class="fg" style="margin:0 0 20px;font-family:${SANS};font-size:21px;line-height:30px;font-weight:700;letter-spacing:-0.02em;color:${INK};word-break:keep-all;overflow-wrap:anywhere">` +
    `${lineHtml(line)}</h1>`
  );
}

// 한국어 줄바꿈: 제목 · 문단은 `word-break:keep-all`(어절 단위로만 줄을 바꾼다) + `overflow-wrap:anywhere`(긴 주소 · 도메인은 그 안에서 끊는다).
function paragraphHtml(lines: readonly MailLine[], size: 'body' | 'note'): string {
  const style =
    size === 'body'
      ? `margin:0 0 20px;font-family:${SANS};font-size:15px;line-height:24px;color:${TEXT};word-break:keep-all;overflow-wrap:anywhere`
      : `margin:0 0 10px;font-family:${SANS};font-size:13px;line-height:20px;color:${MUTED};word-break:keep-all;overflow-wrap:anywhere`;
  return `<p class="${size === 'body' ? 'tx' : 'mt'}" style="${style}">${lines.map(lineHtml).join('<br>')}</p>`;
}

function factsHtml(facts: NonNullable<MailSection['facts']>): string {
  const rows = facts
    .map(
      (fact) =>
        `<tr><td class="mt" style="padding:0 16px 6px 0;font-family:${SANS};font-size:13px;line-height:22px;color:${MUTED};white-space:nowrap;vertical-align:top">${escapeHtml(fact.label)}</td>` +
        `<td class="fg" style="padding:0 0 6px;font-family:${SANS};font-size:15px;line-height:22px;font-weight:600;color:${INK}">${inlineHtml(fact.value)}</td></tr>`,
    )
    .join('');
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 16px;border-collapse:collapse">${rows}</table>`;
}

/** 코드 — 한 통의 주인공. 고정폭 · 넓은 자간 · 한 번 누르면 통째로 선택(`user-select:all`). 자간은 복사되는 글자를 바꾸지 않는다. */
function codeHtml(code: NonNullable<MailSection['code']>): string {
  return (
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 20px;border-collapse:separate">` +
    `<tr><td class="well" bgcolor="${WELL}" style="padding:18px 20px 20px;background:${WELL};border:1px solid ${LINE};border-radius:12px">` +
    `<div class="mt" style="margin:0 0 6px;font-family:${SANS};font-size:12px;line-height:16px;font-weight:500;color:${MUTED}">${escapeHtml(code.label)}</div>` +
    `<div class="fg code" style="font-family:${MONO};font-size:34px;line-height:44px;font-weight:600;letter-spacing:0.18em;color:${INK};font-variant-numeric:tabular-nums;-webkit-user-select:all;user-select:all;white-space:nowrap">${escapeHtml(assertMailCode(code.value))}</div>` +
    `</td></tr></table>`
  );
}

/**
 * 버튼(밝은 글자 · 어두운 바탕 — 서브픽셀 번짐이 첫 글자 옆에 잔상을 남겨 grayscale 안티앨리어싱) + 그 아래 **호스트 이름만** 작은 글자로
 * (긴 원문 URL 은 text/plain 파트에만). 호스트는 링크가 아닌 글자다 — 받는 사람이 버튼이 어디로 가는지 볼 수 있다.
 */
function linkHtml(link: string, label: string): string {
  const href = escapeHtml(link);
  const host = escapeHtml(new URL(link).host);
  return (
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 12px;border-collapse:separate">` +
    `<tr><td class="btn" bgcolor="${INK}" style="background:${INK};border:1px solid ${INK};border-radius:999px">` +
    `<a class="btnl" href="${href}" target="_blank" aria-label="${escapeHtml(label)} (${host})" style="display:inline-block;-webkit-font-smoothing:antialiased;-moz-osx-font-smoothing:grayscale;padding:13px 26px;font-family:${SANS};font-size:15px;line-height:20px;font-weight:600;color:${PAPER};text-decoration:none;border-radius:999px">${escapeHtml(label)}</a>` +
    `</td></tr></table>` +
    `<p class="mt" style="margin:0 0 24px;font-family:${MONO};font-size:13px;line-height:18px;color:${MUTED}">${host}</p>`
  );
}

/** 버금 링크 — 작은 글자 링크 하나. 원문 URL 은 HTML 에 싣지 않는다(콘솔 딥 링크는 길다) — text/plain 파트에 글자 그대로 있다. */
function secondaryLinkHtml(secondary: NonNullable<MailDocument['secondaryLink']>): string {
  const href = escapeHtml(secondary.href);
  return (
    `<p class="tx" style="margin:0 0 24px;font-family:${SANS};font-size:14px;line-height:22px;color:${TEXT}">` +
    `<a class="fg" href="${href}" target="_blank" aria-label="${escapeHtml(secondary.label)} (${escapeHtml(new URL(secondary.href).host)})" style="color:${INK};text-decoration:underline;font-weight:600">${escapeHtml(secondary.label)}</a></p>`
  );
}

function sectionHtml(section: MailSection, link: string | null, secondary: MailDocument['secondaryLink']): string {
  const [first, ...rest] = section.lead;
  const parts: string[] = [];
  if (first !== undefined) parts.push(headingHtml(first));
  if (rest.length > 0) parts.push(paragraphHtml(rest, 'body'));
  if (section.facts !== undefined && section.facts.length > 0) parts.push(factsHtml(section.facts));
  if (section.code !== undefined) parts.push(codeHtml(section.code));
  if (section.body !== undefined && section.body.length > 0) parts.push(paragraphHtml(section.body, 'body'));
  for (const paragraph of section.paragraphs ?? []) parts.push(paragraphHtml(paragraph, 'body'));
  if (link !== null) {
    if (section.buttonLabel === undefined) throw new Error('링크가 있는 메일의 블록에는 버튼 글자가 있어야 한다');
    parts.push(linkHtml(link, section.buttonLabel));
    if (secondary !== undefined && secondary !== null) parts.push(secondaryLinkHtml(secondary));
  }
  for (const paragraph of section.closing ?? []) parts.push(paragraphHtml(paragraph, 'body'));
  for (const paragraph of section.notes) parts.push(paragraphHtml(paragraph, 'note'));
  return `<div lang="${section.lang}">${parts.join('')}</div>`;
}

const HAIRLINE = `<div class="ln" style="height:0;line-height:0;font-size:0;border-top:1px solid ${LINE}">&nbsp;</div>`;

/**
 * 머리 스타일 — 없어도 읽힌다(인라인이 기본). 하는 일 셋:
 *   1. 메일 앱이 날짜·주소·URL 에 자동으로 거는 링크를 글자색 그대로(파랑 0) — Apple(`x-apple-data-detectors`) · Gmail(`u + #body`) · Outlook.com.
 *   2. 좁은 화면에서 여백·코드 크기를 줄인다.
 *   3. 다크 모드 — `SITE_DARK` 의 무채색으로 뒤집는다(Apple Mail · iOS · Outlook.com `[data-ogsc]`). 지원하지 않는 앱은 흰 바탕 그대로이거나
 *      앱이 알아서 뒤집는다 — 두 경우 모두 무채색이라 읽힌다.
 */
const HEAD_STYLE = [
  ':root{color-scheme:light dark;supported-color-schemes:light dark}',
  'body{margin:0!important;padding:0!important;-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%}',
  'table{border-collapse:collapse}',
  'a[x-apple-data-detectors]{color:inherit!important;text-decoration:none!important;font-size:inherit!important;font-family:inherit!important;font-weight:inherit!important;line-height:inherit!important}',
  'u + #body a,#MessageViewBody a{color:inherit;text-decoration:none;font-size:inherit;font-family:inherit;font-weight:inherit;line-height:inherit}',
  '@media only screen and (max-width:560px){.px{padding-left:20px!important;padding-right:20px!important}.pt{padding-top:28px!important}.code{font-size:30px!important;line-height:40px!important;letter-spacing:0.14em!important}}',
  '@media (prefers-color-scheme:dark){' +
    '.bg{background:#0E0E0E!important}.fg{color:#EDEDED!important}.tx{color:#C9C9C9!important}.mt{color:#A0A0A0!important}' +
    '.ln{border-color:#2C2C2C!important}.well{background:#171717!important;border-color:#2C2C2C!important}' +
    '.btn{background:#EDEDED!important;border-color:#EDEDED!important}.btnl{color:#0E0E0E!important}}',
  '[data-ogsc] .fg{color:#EDEDED!important}[data-ogsc] .tx{color:#C9C9C9!important}[data-ogsc] .mt{color:#A0A0A0!important}[data-ogsc] .btnl{color:#0E0E0E!important}',
  '[data-ogsb] .bg{background:#0E0E0E!important}[data-ogsb] .well{background:#171717!important}[data-ogsb] .btn{background:#EDEDED!important;border-color:#EDEDED!important}',
].join('\n');

/** Outlook(Windows)은 글꼴 목록의 첫 이름이 없으면 명조로 떨어진다 — 조건부 주석으로 있는 글꼴을 먼저 준다. */
const MSO_STYLE =
  "<!--[if mso]><style>body,table,td,p,a,h1,h2,div,span,strong{font-family:'Malgun Gothic','Segoe UI',sans-serif!important}.code{font-family:Consolas,monospace!important}</style><![endif]-->";

/** 미리보기 뒤를 채우는 보이지 않는 글자 — 목록 미리보기가 본문(코드)까지 끌어오지 않게. */
const PREHEADER_FILL = '&#847;&zwnj;&nbsp;'.repeat(90);

function documentHtml(doc: MailDocument): string {
  return [
    '<!DOCTYPE html>',
    `<html lang="${doc.section.lang}">`,
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    '<meta name="x-apple-disable-message-reformatting">',
    '<meta name="format-detection" content="telephone=no,date=no,address=no,email=no,url=no">',
    '<meta name="color-scheme" content="light dark">',
    '<meta name="supported-color-schemes" content="light dark">',
    `<title>${escapeHtml(doc.subject)}</title>`,
    `<style>\n${HEAD_STYLE}\n</style>`,
    MSO_STYLE,
    '</head>',
    `<body id="body" class="body bg" style="margin:0;padding:0;background:${PAPER}">`,
    `<div class="ph" style="display:none;max-height:0;max-width:0;overflow:hidden;opacity:0;mso-hide:all;font-size:1px;line-height:1px;color:${PAPER}">${escapeHtml(doc.preheader)}${PREHEADER_FILL}</div>`,
    `<table role="presentation" class="bg" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${PAPER}" style="width:100%;background:${PAPER}">`,
    '<tr><td align="center" class="pt" style="padding:44px 12px 48px">',
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:520px">`,
    `<tr><td class="px" style="padding:0 28px 36px">${WORDMARK}</td></tr>`,
    `<tr><td class="px" style="padding:0 28px">${sectionHtml(doc.section, doc.link, doc.secondaryLink)}</td></tr>`,
    `<tr><td class="px" style="padding:26px 28px 0">${HAIRLINE}</td></tr>`,
    `<tr><td class="px mt" style="padding:16px 28px 0;font-family:${SANS};font-size:13px;line-height:18px;color:${MUTED}">${escapeHtml(MAIL_FOOTER_SIGNATURE)}</td></tr>`,
    '</table>',
    '</td></tr>',
    '</table>',
    '</body>',
    '</html>',
  ].join('\n');
}

/** 한 구조에서 두 파트를 만든다(끝 줄은 `MAIL_FOOTER_SIGNATURE`). 링크 · 코드 모양이 틀리면 던진다 — 보내지 않는다. */
export function renderMail(doc: MailDocument): RenderedMail {
  const link = doc.link === null ? null : assertMailLink(doc.link);
  const secondary = doc.secondaryLink ?? null;
  if (secondary !== null) {
    if (link === null) throw new Error('버금 링크는 주 링크가 있는 메일에만 쓴다');
    assertMailLink(secondary.href);
  }
  if (doc.section.code !== undefined) assertMailCode(doc.section.code.value);
  return { subject: doc.subject, text: sectionText(doc.section, link, secondary).join('\n'), html: documentHtml(doc) };
}
