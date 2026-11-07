/**
 * 시스템 메일 — **한 통에 한 언어**(2026-10-10 진윤겸 결정 · 기본 영어)와 **코드만 로그인**("링크 로그인은 이제 삭제할거야").
 *   - 로그인 · 가입 확인 메일에는 URL 이 한 글자도 없다(text · html 모두) — 서명 토큰(`atk_login_` · `atk_signup_`)이 실릴 자리가 없다.
 *   - 6자리 코드는 본문 블록에 한 번(제 줄) + 제목에 한 번(2026-10-10 문구 개편 — 메일 앱의 "코드 복사"), 숨은 미리보기에는 없다.
 *     만료(분) · 요청하지 않았다면 무시 · 알려 주지 않는다는 안내가 그 언어로 있다.
 *   - 초대 메일은 링크 하나(초대 착지 — 세션을 만들지 않는다)와 초대자 주소만. 조직 이름의 자리가 없다(F-2).
 *   - 공용 틀은 블록 하나만 받는다 — 구분선 · 두 번째 `<div lang>` 이 없다. 영어 메일에 한글이 없다.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { SUPPORTED_MAIL_LOCALES } from '../../../src/i18n/locales';
import { renderInviteMail } from '../../../src/notify/invite-template';
import { renderOpsCodeMail } from '../../../src/notify/ops-code-template';
import { renderOwnerLoginMail } from '../../../src/notify/owner-login-template';
import { renderSignupMail } from '../../../src/notify/signup-template';
import { renderWelcomeMail } from '../../../src/notify/welcome-template';

const EXPIRES = new Date('2026-09-24T01:02:03.000Z');
const INVITE_LINK = 'https://console.atmark.ai/invite#t=atk_invite_k1.payload.sig';
const INVITER = 'lead@example.com';
const CODE = '042917';

describe.each([
  ['로그인', (code: string, locale: 'ko' | 'en') => renderOwnerLoginMail({ code, expiresAt: EXPIRES }, locale)],
  ['가입', (code: string, locale: 'ko' | 'en') => renderSignupMail({ code, expiresAt: EXPIRES }, locale)],
] as const)('%s 메일 — 코드만(링크 없음) · 한 언어', (_label, render) => {
  it('URL · 서명 토큰 · 쿼리 문자가 text 와 html 어디에도 없다', () => {
    for (const locale of SUPPORTED_MAIL_LOCALES) {
      const mail = render(CODE, locale);
      for (const part of [mail.text, mail.html, mail.subject]) {
        expect(part).not.toMatch(/https?:/);
        expect(part).not.toMatch(/atk_(login|signup)_/);
        expect(part).not.toContain('#t=');
      }
      expect(mail.text).not.toContain('?');
      expect(mail.html).not.toContain('<a ');
    }
  });

  it('코드는 본문에 한 번, 앞뒤 빈 줄로 따로 선다 · 제목에도 있다 · 미리보기에는 없다', () => {
    for (const locale of SUPPORTED_MAIL_LOCALES) {
      const mail = render(CODE, locale);
      expect(mail.subject.match(/[0-9]{6}/g)).toEqual([CODE]);
      const lines = mail.text.split('\n');
      const codeLine = lines.indexOf(CODE);
      expect(lines.filter((line) => line.includes(CODE))).toEqual([CODE]);
      expect(lines[codeLine - 1]).toBe('');
      expect(lines[codeLine + 1]).toBe('');
      const preheader = /<div class="ph"[^>]*>([^<&]*)/.exec(mail.html)?.[1] ?? '';
      expect(preheader).not.toContain(CODE);
    }
  });

  it('만료(분) · 무시 안내가 그 언어로 있다 · 대시(—) 없음', () => {
    const ko = render(CODE, 'ko').text;
    const en = render(CODE, 'en').text;
    expect(ko).toMatch(/[0-9]+분 뒤 만료됩니다/);
    expect(ko).toContain('무시하셔도 됩니다');

    expect(en).toMatch(/It expires in [0-9]+ minutes\./);
    expect(en).toContain('you can ignore this email');

    expect(en).not.toMatch(/[가-힣]/);
    expect(ko).not.toContain('ignore this email');
    for (const text of [ko, en]) expect(text).not.toContain('—');
  });

  it('본문은 짧다 — 꼬리 앞까지 30 낱말 이하 · 호스트 이름 · 보안 훈계 없음(2026-10-10 2차)', () => {
    for (const locale of SUPPORTED_MAIL_LOCALES) {
      const text = render(CODE, locale).text;
      const words = (text.split('\nAtmark · atmark.ai')[0] ?? '').split(/\s+/).filter(Boolean);
      expect(words.length).toBeLessThanOrEqual(30);
      expect(text).not.toMatch(/console\.atmark\.ai|Never share|알려 주지 마세요/);
    }
  });

  it.each(['12345', '1234567', 'abcdef', '12 456', '12345\n'])('6자리 숫자가 아닌 코드(%j)는 받지 않는다', (bad) => {
    expect(() => render(bad, 'en')).toThrow();
  });
});

describe('가입 메일 — 요청자 문자열의 자리가 없다', () => {
  it('렌더 입력은 코드 · 만료뿐이다(조직 이름 · 입력 이메일을 받을 칸이 없다)', () => {
    const input = { code: CODE, expiresAt: EXPIRES, organizationName: 'OO은행 보안팀: 즉시 클릭' };
    const ko = renderSignupMail(input, 'ko');
    expect(ko.text).not.toContain('OO은행');
    expect(ko.text).toContain('30분');
    expect(ko.text).toContain('가입 화면에 입력해 주세요');
    expect(renderSignupMail(input, 'en').text).toContain('Enter this code on the sign-up screen');
    expect(renderSignupMail(input, 'en').text).toContain('30 minutes');
  });
});

describe('초대 메일 — 링크 하나 · 조직 이름의 자리가 없다(창업자 결정 F-2) · 초대자 주소만', () => {
  it('링크는 초대 착지 하나 · 초대자 주소 · 로그인 "코드" 메일이 한 통 더 간다', () => {
    const input = { link: INVITE_LINK, inviterEmail: INVITER, expiresAt: EXPIRES, organizationName: 'OO은행 보안팀: 즉시 클릭' };
    const ko = renderInviteMail(input, 'ko');
    const en = renderInviteMail(input, 'en');
    for (const mail of [ko, en]) {
      expect(mail.text).not.toContain('OO은행');
      expect(mail.subject).not.toContain('OO은행');
      expect(mail.text).toContain(INVITER);
      expect(mail.text.match(/https?:\/\/\S*/g)).toEqual([INVITE_LINK]);
    }
    // 유효 기간은 본문에 · 미리보기는 다른 사실(코드로 로그인 — 2026-10-10 10차).
    expect(ko.text).toContain('초대를 열어 참여해 주세요. 7일 동안 유효합니다.');
    expect(en.text).toContain("Open the invitation to join their organization. It's valid for 7 days.");
    expect(en.html).toContain("You&#39;ll log in with a code sent to this address."); // 용어집 §6.4 — sign-in 금지
    expect(en.text).not.toMatch(/sign-in|sign in/i);
    expect(en.text).not.toMatch(/[가-힣]/);
  });
});

describe('공용 틀은 블록 하나만 받는다 — 두 언어를 이어 붙일 자리가 없다', () => {
  const NOTIFY_DIR = resolve(__dirname, '../../../src/notify');

  it('공용 틀(renderMail)을 쓰는 템플릿 아홉 — 모두 `section:` 하나로 부른다(`sections` · 구분선 상수가 없다)', () => {
    const users = readdirSync(NOTIFY_DIR)
      .filter((name) => name.endsWith('.ts') && name !== 'mail-layout.ts')
      .filter((name) => /\brenderMail\(/.test(readFileSync(resolve(NOTIFY_DIR, name), 'utf8')))
      .sort();
    expect(users).toEqual([
      'approval-notification-template.ts',
      'domain-notice-template.ts',
      'invite-template.ts',
      'ops-code-template.ts',
      'owner-login-template.ts',
      'quarantine-notice-template.ts',
      'signup-template.ts',
      'waitlist-template.ts',
      'welcome-template.ts',
    ]);
    for (const name of readdirSync(NOTIFY_DIR).filter((file) => file.endsWith('.ts'))) {
      const source = readFileSync(resolve(NOTIFY_DIR, name), 'utf8');
      expect(source, name).not.toMatch(/\bsections\s*:/);
      expect(source, name).not.toContain('BILINGUAL_MAIL_SEPARATOR');
    }
  });

  it('메일마다 `<div lang>` 하나 · 그 언어가 `<html lang>` · 영어 메일에 한글이 없다', () => {
    for (const locale of SUPPORTED_MAIL_LOCALES) {
      const other = locale === 'ko' ? 'en' : 'ko';
      const mails = [
        renderOwnerLoginMail({ code: CODE, expiresAt: EXPIRES }, locale),
        renderSignupMail({ code: CODE, expiresAt: EXPIRES }, locale),
        renderInviteMail({ link: INVITE_LINK, inviterEmail: INVITER, expiresAt: EXPIRES }, locale),
        renderOpsCodeMail({ purpose: 'login', code: CODE, expiresAt: EXPIRES }, locale),
        renderWelcomeMail(locale),
      ];
      for (const mail of mails) {
        expect(mail.html).toContain(`<html lang="${locale}">`);
        expect(mail.html).toContain(`<div lang="${locale}">`);
        expect(mail.html).not.toContain(`<div lang="${other}">`);
        expect(mail.text).not.toMatch(/^─{20,}$/m);
        if (locale === 'en') {
          expect(mail.text).not.toMatch(/[가-힣]/);
          expect(mail.subject).not.toMatch(/[가-힣]/);
        } else {
          expect(mail.subject).toMatch(/[가-힣]/);
        }
      }
    }
  });
});
