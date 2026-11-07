/**
 * 시스템 메일 HTML 파트(`src/notify/mail-layout.ts` 공용 틀 — 로그인·가입·초대·운영 코드, 2026-09-28).
 *
 * 되돌리면 빨개져야 하는 것:
 *   - 템플릿 모두 text/plain 과 text/html 을 함께 낸다 · **한 통에 한 언어**(2026-10-10) · 코드는 두 파트에 한 번씩 + 제목에 한 번(문구 개편) · 숨은 미리보기 문장에는 없다.
 *   - 꼬리: `Atmark · atmark.ai` + 왜 받는가 한 줄(두 파트 모두).
 *   - 로그인 · 가입 확인 · 운영 코드 메일에는 링크가 없다(코드만 — 2026-10-10). 초대 메일의 링크는 href 로 두 번(버튼 + 원문 URL) · 원문 URL 은 보이는 글자 = href ·
 *     그 밖의 `http` 가 없다(원격 자원 0 — img·link·url()·@import 0).
 *   - 완전 무채색(워드마크 `@` 도 잉크색 — 주황 없음) · 파랑 0 · 쿼리 문자(`?`) 0.
 *   - 보간 값은 이스케이프된다(초대자 주소) · 모양이 틀린 링크·코드는 던진다.
 *   - 문의 전달은 여전히 text/plain 만(발송 호출에 `html` 이 없다). 승인 알림은 2026-10-10 부터 이 틀(에이전트 문자열 없이).
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { OPS_ACTIONS } from '../../../src/ops/contract';
import { assertMailLink, escapeHtml, MAIL_FOOTER_SIGNATURE, renderMail } from '../../../src/notify/mail-layout';
import { renderInviteMail } from '../../../src/notify/invite-template';
import { renderOpsCodeMail } from '../../../src/notify/ops-code-template';
import { renderOwnerLoginMail } from '../../../src/notify/owner-login-template';
import { renderSignupMail } from '../../../src/notify/signup-template';
import { renderWelcomeMail, WELCOME_CONSOLE_URL, WELCOME_COPY, WELCOME_SETUP_GUIDE_URLS } from '../../../src/notify/welcome-template';

const EXPIRES = new Date('2026-09-24T01:02:03.000Z');
const INVITE_LINK = 'https://console.atmark.ai/invite#t=atk_invite_k1.payload.sig';
const CODE = '042917';

interface Case {
  readonly label: string;
  readonly locale: 'ko' | 'en';
  readonly mail: { readonly subject: string; readonly text: string; readonly html: string };
  readonly link: string | null;
  readonly code: string | null;
}

const CASES: readonly Case[] = (['ko', 'en'] as const).flatMap((locale): Case[] => [
  { label: `로그인(${locale})`, locale, mail: renderOwnerLoginMail({ code: CODE, expiresAt: EXPIRES }, locale), link: null, code: CODE },
  { label: `가입(${locale})`, locale, mail: renderSignupMail({ code: CODE, expiresAt: EXPIRES }, locale), link: null, code: CODE },
  { label: `초대(${locale})`, locale, mail: renderInviteMail({ link: INVITE_LINK, inviterEmail: 'lead@example.com', expiresAt: EXPIRES }, locale), link: INVITE_LINK, code: null },
  { label: `운영 로그인(${locale})`, locale, mail: renderOpsCodeMail({ purpose: 'login', code: CODE, expiresAt: EXPIRES }, locale), link: null, code: CODE },
  { label: `운영 접근 요청(${locale})`, locale, mail: renderOpsCodeMail({ purpose: 'access_request', code: CODE, expiresAt: EXPIRES }, locale), link: null, code: CODE },
  {
    label: `운영 step-up(${locale})`,
    locale,
    mail: renderOpsCodeMail({ purpose: 'step_up', code: CODE, expiresAt: EXPIRES, action: 'org.freeze_on', targetRef: 'PH5K' }, locale),
    link: null,
    code: CODE,
  },
]);

function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

/** 숨은 미리보기 문장(본문 첫 `div.ph`)의 글자. */
function preheader(html: string): string {
  const match = /<div class="ph"[^>]*>([\s\S]*?)<\/div>/.exec(html);
  if (match?.[1] === undefined) throw new Error('미리보기 문장이 없다');
  return match[1];
}

/** 색 값(`#RGB`·`#RRGGBB`) — `&#847;` 같은 문자 참조는 빼고. */
function hexColors(html: string): string[] {
  return [...html.matchAll(/(?<!&)#([0-9a-fA-F]{6}|[0-9a-fA-F]{3})\b/g)].map((m) => (m[1] ?? '').toUpperCase());
}

function isAchromatic(hex: string): boolean {
  const full = hex.length === 3 ? [...hex].map((c) => c + c).join('') : hex;
  return full.slice(0, 2) === full.slice(2, 4) && full.slice(2, 4) === full.slice(4, 6);
}

describe.each(CASES)('$label 메일 — HTML 파트', ({ mail, link, code, locale }) => {
  it('두 파트가 함께 있다 · HTML 은 문서 한 벌(color-scheme 선언 · 원격 자원 0)', () => {
    expect(mail.text.length).toBeGreaterThan(0);
    expect(mail.html.startsWith('<!DOCTYPE html>\n<html lang="')).toBe(true);
    expect(mail.html).toContain('<meta name="color-scheme" content="light dark">');
    expect(mail.html).not.toMatch(/<img|<link|<script|<iframe|<object|@import|url\(|\ssrc=|background=/i);
    expect(mail.html).not.toContain('?');
  });

  it('코드는 한 번씩(두 파트 모두) + 제목에 한 번 · 미리보기 문장에는 없다', () => {
    const title = /<title>([^<]*)<\/title>/.exec(mail.html)?.[1] ?? '';
    expect(title).toBe(escapeHtml(mail.subject));
    expect(mail.subject.match(/[0-9]{6}/g) ?? []).toEqual(code === null ? [] : [code]);
    expect(preheader(mail.html)).not.toMatch(/[0-9]{6}/);
    expect(preheader(mail.html).length).toBeGreaterThan(0);
    if (code === null) return;
    expect(count(mail.text, code)).toBe(1);
    // 본문 한 번 + `<title>`(= 제목) 한 번.
    expect(count(mail.html, code)).toBe(2);
    expect(count(mail.html.slice(mail.html.indexOf('<body')), code)).toBe(1);
    // 코드는 미리보기 문장보다 뒤에 있다(목록 미리보기가 코드를 끌어오지 않게 사이를 채운다).
    expect(mail.html.lastIndexOf(code)).toBeGreaterThan(mail.html.indexOf('<div class="ph"') + preheader(mail.html).length);
  });

  it('링크: 버튼 + 호스트 이름 · 그 밖의 http 없음 · 코드 메일은 링크 0', () => {
    const urls = mail.html.match(/https?:\/\/[^\s"'<>)]*/g) ?? [];
    if (link === null) {
      expect(urls).toEqual([]);
      expect(mail.text).not.toMatch(/https?:\/\//);
      expect(mail.html).not.toContain('<a ');
      return;
    }
    expect(new Set(urls)).toEqual(new Set([link]));
    // 버튼 하나 · 그 아래는 호스트 이름만 글자로(2026-10-10 3차 — 긴 원문 URL 은 text 파트에만).
    expect(count(mail.html, `href="${link}"`)).toBe(1);
    expect(mail.html).toContain(`>${new URL(link).host}</p>`);
    // 모든 <a> 의 href 는 그 링크 하나다(mailto·다른 호스트 0).
    const hrefs = [...mail.html.matchAll(/<a\b[^>]*\shref="([^"]*)"/g)].map((m) => m[1]);
    expect(hrefs).toEqual([link]);
    expect(mail.text.match(/https?:\/\/\S*/g)).toEqual([link]);
  });

  it('색: 완전 무채색 — 주황 없음, 워드마크 `@` 는 잉크색 · 파랑 0 · 모든 링크에 색을 명시', () => {
    const colors = hexColors(mail.html);
    expect(colors.length).toBeGreaterThan(0);
    for (const color of colors) {
      expect(isAchromatic(color), `#${color}`).toBe(true);
    }
    expect(count(mail.html.toUpperCase(), 'F97316')).toBe(0);
    expect(mail.html).not.toMatch(/orange/i);
    expect(mail.html).toContain(';color:#171717;white-space:nowrap">atmark</span>');
    expect(mail.html).not.toMatch(/\bblue\b|rgb\(|hsl\(/i);
    for (const anchor of mail.html.match(/<a\b[^>]*>/g) ?? []) expect(anchor).toMatch(/style="[^"]*color:#[0-9A-F]{6}/);
  });

  it('한 언어 블록(lang) · 안전 문구가 그 언어로 HTML 에도 있다 · 꼬리 한 줄', () => {
    expect(mail.html).toContain(`<html lang="${locale}">`);
    expect(mail.html).toContain(`<div lang="${locale}">`);
    expect(mail.html).not.toContain(`<div lang="${locale === 'ko' ? 'en' : 'ko'}">`);
    if (locale === 'ko') {
      expect(mail.html).toContain('무시하셔도 됩니다');
      if (code !== null) expect(mail.html).toMatch(/[0-9]+분 뒤 만료됩니다/);
    } else {
      expect(mail.html).toContain('ignore this email');
      expect(mail.html).not.toMatch(/[가-힣]/);
      if (code !== null) expect(mail.html).toMatch(/It expires in [0-9]+ minutes\./);
    }
    // 꼬리는 한 줄(2026-10-10 5차 — 받는 사람 줄 삭제).
    expect(mail.text.split('\n').at(-1)).toBe(MAIL_FOOTER_SIGNATURE);
    expect(mail.html).toContain(`>${escapeHtml(MAIL_FOOTER_SIGNATURE)}</td></tr>`);
  });
});

describe('운영 코드 메일 — HTML 도 한 언어 · step-up 은 행위·참조를 코드 위에', () => {
  it('en 이면 <html lang="en"> · 영어 미리보기 문장', () => {
    const mail = renderOpsCodeMail({ purpose: 'login', code: CODE, expiresAt: EXPIRES }, 'en');
    expect(mail.html).toContain('<html lang="en">');
    expect(mail.html).not.toContain('<div lang="ko">');
    expect(preheader(mail.html).startsWith('It works only once.')).toBe(true);
  });

  it.each(OPS_ACTIONS)('step-up %s: 행위 라벨·대상 참조가 코드보다 앞(언어마다)', (action) => {
    for (const locale of ['ko', 'en'] as const) {
      const mail = renderOpsCodeMail({ purpose: 'step_up', code: CODE, expiresAt: EXPIRES, action, targetRef: 'PH5K' }, locale);
      const block = mail.html.slice(mail.html.indexOf(`<div lang="${locale}">`));
      expect(block.indexOf('PH5K')).toBeGreaterThan(0);
      expect(block.indexOf('PH5K')).toBeLessThan(block.indexOf(CODE));
      expect(preheader(mail.html)).not.toContain(CODE);
    }
  });
});

describe('이스케이프 — 보간 값은 모두 HTML 글자로만', () => {
  it('초대자 주소에 꺾쇠·따옴표·앰퍼샌드가 있어도 태그·속성이 되지 않는다', () => {
    const hostile = `x"><img src=x onerror=alert(1)>&'@example.com`;
    const mail = renderInviteMail({ link: INVITE_LINK, inviterEmail: hostile, expiresAt: EXPIRES }, 'en');
    expect(mail.html).not.toContain('<img');
    expect(mail.html).not.toContain(hostile);
    expect(mail.html).toContain('x&quot;&gt;&lt;img src=x onerror=alert(1)&gt;&amp;&#39;@example.com');
    // text/plain 은 글자 그대로(HTML 이 아니다).
    expect(mail.text).toContain(hostile);
  });

  it('escapeHtml 은 다섯 글자를 바꾼다', () => {
    expect(escapeHtml(`<a href="x">'&'</a>`)).toBe('&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;');
  });

  it.each([
    'http://console.atmark.ai/login#t',
    'https://console.atmark.ai/login?t=abc',
    'https://evil.example/login#t',
    'https://console.atmark.ai.evil.example/login#t',
    'https://console.atmark.ai/login#"><script>',
    'https://console.atmark.ai/login# t',
    'https://user@console.atmark.ai/login',
    'https://console.atmark.ai:8443/login',
  ])('모양이 틀린 링크(%j)는 던진다', (bad) => {
    expect(() => assertMailLink(bad)).toThrow();
    expect(() => renderInviteMail({ link: bad, inviterEmail: 'lead@example.com', expiresAt: EXPIRES }, 'en')).toThrow();
  });

  it('우리 링크 모양은 통과한다', () => {
    for (const link of [INVITE_LINK, WELCOME_CONSOLE_URL, 'https://console.atmark.ai/app#/domains']) expect(assertMailLink(link)).toBe(link);
  });

  it('틀 자체도 코드 모양을 본다(템플릿을 거치지 않아도)', () => {
    const section = { lang: 'ko' as const, lead: ['x'], code: { label: 'c', value: '12a456' }, notes: [] };
    expect(() => renderMail({ subject: 's', preheader: 'p', link: null, section })).toThrow();
  });

  it('버금 링크 — 주 링크가 있어야 하고 모양 검사를 지난다 · 보이는 URL = href', () => {
    const section = { lang: 'en' as const, lead: ['x'], buttonLabel: 'Go', notes: [] };
    const base = { subject: 's', preheader: 'p', section };
    expect(() => renderMail({ ...base, link: null, secondaryLink: { href: INVITE_LINK, label: 'More' } })).toThrow();
    expect(() => renderMail({ ...base, link: INVITE_LINK, secondaryLink: { href: 'https://evil.example/x', label: 'More' } })).toThrow();
    const mail = renderMail({ ...base, link: INVITE_LINK, secondaryLink: { href: WELCOME_CONSOLE_URL, label: 'More' } });
    expect([...mail.html.matchAll(/<a\b[^>]*\shref="([^"]*)"/g)].map((m) => m[1])).toEqual([INVITE_LINK, WELCOME_CONSOLE_URL]);
    expect(mail.html).not.toContain(`>${WELCOME_CONSOLE_URL}</a>`);
    expect(mail.text).toContain(`More (console.atmark.ai):\n${WELCOME_CONSOLE_URL}`);
    expect(mail.html).toContain('border:1px solid #171717');
    expect(mail.html).toContain('.btn{background:#EDEDED!important;border-color:#EDEDED!important}');
  });
});

describe('HTML 파트를 싣는 모듈은 틀을 쓰는 알림기뿐이다', () => {
  const source = (path: string): string => readFileSync(resolve(__dirname, '../../..', path), 'utf8');

  it.each([
    'src/notify/owner-login-notifier.ts',
    'src/notify/signup-notifier.ts',
    'src/notify/invite-notifier.ts',
    'src/notify/ops-code-notifier.ts',
    'src/notify/welcome-notifier.ts',
    'src/notify/approval-notifier.ts',
  ])(
    '%s 는 렌더된 html 을 넘긴다',
    (path) => {
      expect(source(path)).toContain('html: rendered.html,');
    },
  );

  it.each(['src/notify/contact-forwarder.ts'])('%s 는 html 을 넘기지 않는다(바깥 사람의 문자열을 싣는 메일)', (path) => {
    // 발송 호출의 `html:` 칸이 없다(문의 전달면은 타입에도 그 칸이 없다).
    expect(source(path)).not.toMatch(/\bhtml\s*:/);
  });
});

describe.each(['ko', 'en'] as const)('환영 메일(%s) — 한 언어 편지 · 같은 공용 틀', (lang) => {
  const mail = renderWelcomeMail(lang);
  const copy = WELCOME_COPY[lang];

  it('두 파트 · 문서 한 벌 · 원격 자원 0 · 쿼리 문자 0 · <html lang> 이 받는 사람의 언어', () => {
    expect(mail.text.length).toBeGreaterThan(0);
    expect(mail.html.startsWith(`<!DOCTYPE html>\n<html lang="${lang}">`)).toBe(true);
    expect(mail.html).not.toMatch(/<img|<link|<script|<iframe|<object|@import|url\(|\ssrc=|background=/i);
    expect(mail.html).not.toContain('?');
    expect(mail.text).not.toContain('?');
    expect(mail.subject).toBe(copy.subject);
    expect(/<title>([^<]*)<\/title>/.exec(mail.html)?.[1]).toBe(escapeHtml(copy.subject));
    expect(preheader(mail.html)).toBe(escapeHtml(copy.preheader) + '&#847;&zwnj;&nbsp;'.repeat(90));
    expect(mail.text).not.toContain(copy.preheader);
  });

  it('링크 둘 — 콘솔 버튼(+ 호스트 이름) · 설정 안내 문서(글자 링크, 그 언어의 문서) · text 에 한 번씩', () => {
    const guide = WELCOME_SETUP_GUIDE_URLS[lang];
    expect(guide).toBe(lang === 'ko' ? 'https://docs.atmark.ai/connect/overview' : 'https://docs.atmark.ai/en/connect/overview');
    const urls = mail.html.match(/https?:\/\/[^\s"'<>)]*/g) ?? [];
    expect(new Set(urls)).toEqual(new Set([WELCOME_CONSOLE_URL, guide]));
    const hrefs = [...mail.html.matchAll(/<a\b[^>]*\shref="([^"]*)"/g)].map((m) => m[1]);
    expect(hrefs).toEqual([WELCOME_CONSOLE_URL, guide]);
    expect(mail.html).toContain('>console.atmark.ai</p>');
    expect(mail.text.match(/https?:\/\/\S*/g)).toEqual([WELCOME_CONSOLE_URL, guide]);
    expect(mail.html).toContain(`>${escapeHtml(copy.buttonLabel)}</a>`);
  });

  it('무채색 · 파랑 0 · 모든 링크에 색 명시 · 워드마크 잉크색', () => {
    for (const color of hexColors(mail.html)) expect(isAchromatic(color), `#${color}`).toBe(true);
    expect(mail.html).not.toMatch(/\bblue\b|rgb\(|hsl\(|orange/i);
    expect(mail.html).toContain(';color:#171717;white-space:nowrap">atmark</span>');
    for (const anchor of mail.html.match(/<a\b[^>]*>/g) ?? []) expect(anchor).toMatch(/style="[^"]*color:#[0-9A-F]{6}/);
  });

  it('편지 모양: 제목 크기 머리 문장 없음 · 문구가 순서대로(인사 → 소개 → 시작 단계 → 버튼 → 답장 → 서명 → 꼬리) · 다른 언어 블록 없음', () => {
    expect(mail.html).not.toContain('<h1');
    expect(mail.html).toContain(`<div lang="${lang}">`);
    expect(mail.html).not.toContain(`<div lang="${lang === 'ko' ? 'en' : 'ko'}">`);
    const order = [copy.greeting, copy.intro, WELCOME_CONSOLE_URL, copy.reply, ...copy.signOff, MAIL_FOOTER_SIGNATURE];
    // 앞 조각 뒤에서부터 차례로 찾는다(서명 "Onve" 는 인사말에도 있다).
    let cursor = 0;
    for (const part of order) {
      const at = mail.text.indexOf(part, cursor);
      expect(at, part).toBeGreaterThanOrEqual(cursor);
      cursor = at + part.length;
    }
    for (const part of [copy.greeting, copy.intro, copy.reply]) expect(mail.html).toContain(escapeHtml(part));
  });
});

// 2026-10-10 개편(진윤겸) — 15분 통화 · "제가 직접 읽고 답장드립니다" 삭제 · "감사합니다"(감사해요 금지) · 타사 제품 이름 없음.
describe('환영 메일 문구 — 2026-10-10 개편본 그대로', () => {
  it('영어', () => {
    const en = renderWelcomeMail('en').text;
    expect(en).toBe(
      [
        "Hi, I'm Younkyum 'Onve' Jin, and I built Atmark. Thank you for signing up.",
        '',
        'Create an agent in the console, then connect it to your AI agent using the setup guide.',
        '',
        'Open console (console.atmark.ai):',
        WELCOME_CONSOLE_URL,
        '',
        'Read the setup guide (docs.atmark.ai):',
        WELCOME_SETUP_GUIDE_URLS.en,
        '',
        'If anything gets in your way, just reply.',
        '',
        'Onve',
        '',
        'Atmark · atmark.ai',
      ].join('\n'),
    );
    expect(renderWelcomeMail('en').subject).toBe('Welcome to Atmark');
  });

  it('한국어', () => {
    const ko = renderWelcomeMail('ko').text;
    expect(ko).toBe(
      [
        "안녕하세요. Atmark를 만든 Younkyum 'Onve' Jin입니다. 가입해 주셔서 감사합니다.",
        '',
        '콘솔에서 에이전트를 만들고, 설정 안내에 따라 쓰는 AI 에이전트에 연결해 보세요.',
        '',
        '콘솔 열기 (console.atmark.ai):',
        WELCOME_CONSOLE_URL,
        '',
        '설정 안내 보기 (docs.atmark.ai):',
        WELCOME_SETUP_GUIDE_URLS.ko,
        '',
        '막히는 곳이 있으면 답장해 주세요.',
        '',
        'Onve 드림',
        '',
        'Atmark · atmark.ai',
      ].join('\n'),
    );
    expect(renderWelcomeMail('ko').subject).toBe('Atmark에 오신 것을 환영합니다');
  });

  it('감사해요 · 15분 통화 · 직접 읽고 답장 · 타사 제품 이름이 없다', () => {
    for (const lang of ['ko', 'en'] as const) {
      const text = renderWelcomeMail(lang).text;
      expect(text).not.toMatch(/감사해요|15분|15-minute|직접 읽|read every reply|Claude|Codex|Cursor|MCP|쓰시는/);
      // 고맙다는 말은 한 번(2026-10-10 6차).
      expect(text.match(lang === 'ko' ? /감사합니다/g : /Thank you/g)).toHaveLength(1);
      const words = (text.split('\nAtmark · atmark.ai')[0] ?? '').split('\n').filter((line) => !line.startsWith('https://')).join(' ').split(/\s+/).filter(Boolean);
      expect(words.length).toBeLessThanOrEqual(50);
    }
  });
});
