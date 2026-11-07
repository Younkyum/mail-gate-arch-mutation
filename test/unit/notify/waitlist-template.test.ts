/**
 * 대기 확인 · 초대 메일 템플릿(202609301520 · `src/notify/waitlist-template.ts`) — 순수 함수.
 *
 * 되돌리면 빨개져야 하는 것: 한 언어 한 블록(구분선 없음 · 영어에 한글 없음) · 확인 메일은 링크·버튼이 없다 · 초대 메일의 링크는 언어별 가입 화면 +
 * `#invite=<받는 주소의 base64url>` 하나(쿼리 없음 — 공용 틀의 링크 모양) · 초대 유효 기간 14일이 본문에 있다(약관과 같다) · 본문에 `?` 가 없다.
 */

import { describe, expect, it } from 'vitest';

import { renderWaitlistMail, WAITLIST_COPY, WAITLIST_NOT_FOR_URLS, WAITLIST_SIGNUP_URLS, waitlistInviteLink } from '../../../src/notify/waitlist-template';

const EMAIL = 'wait.list+x@example.com';

describe('대기자 명단 메일 템플릿', () => {
  it.each(['ko', 'en'] as const)('확인 메일(%s) — 한 블록 · 링크·버튼 없음 · 쿼리 문자 없음', (lang) => {
    const mail = renderWaitlistMail({ kind: 'confirmation', email: EMAIL }, lang);
    expect(mail.subject).toBe(WAITLIST_COPY[lang].confirmation.subject);
    expect(mail.text).not.toMatch(/^─{20,}$/m);
    expect(mail.html).not.toMatch(/<a\b/);
    expect(mail.text).not.toContain('https://');
    expect(mail.text).not.toContain(EMAIL);
    expect(`${mail.text}${mail.html}`).not.toContain('?');
    if (lang === 'en') expect(`${mail.subject}${mail.text}`).not.toMatch(/[가-힣]/);
  });

  it.each(['ko', 'en'] as const)('초대 메일(%s) — 버튼 하나 = 가입 화면 + #invite=base64url(주소) · 14일 · 쿼리 없음', (lang) => {
    const mail = renderWaitlistMail({ kind: 'invitation', email: EMAIL }, lang);
    const link = waitlistInviteLink(lang, EMAIL);
    expect(link).toBe(`${WAITLIST_SIGNUP_URLS[lang]}#invite=${Buffer.from(EMAIL).toString('base64url')}`);
    expect(link).toMatch(/^https:\/\/atmark\.ai\/(kr\/)?signup#invite=[A-Za-z0-9_-]+$/);
    expect([...mail.html.matchAll(/href="([^"]+)"/g)].map((m) => m[1])).toEqual([link]);
    expect(mail.text).toContain(link);
    expect(mail.text).toContain(lang === 'ko' ? '14일' : '14 days');
    expect(`${mail.text}${mail.html}`).not.toContain('?');
    expect(mail.text).not.toMatch(/^─{20,}$/m);
    expect(WAITLIST_SIGNUP_URLS[lang]).toBe(lang === 'ko' ? 'https://atmark.ai/kr/signup' : 'https://atmark.ai/signup');
  });

  it.each([
    ['ko', '기다려 주셔서 감사합니다.', '가입한 뒤 에이전트를 하나 만들고, 내 메일함에서 그 주소로 메일을 보내 보세요.', '\nOnve 드림'],
    ['en', 'You can now create your Atmark account.', "Once you're in, create an agent and send it an email from your own inbox.", '\nOnve\n'],
  ] as const)('초대 메일(%s, 2026-10-10) — 인사 · 14일 → 버튼 → 첫 과제 → 서명 · 공용 도메인 이야기 없음 · 링크는 버튼 하나뿐', (lang, thanks, task, signOff) => {
    const mail = renderWaitlistMail({ kind: 'invitation', email: EMAIL }, lang);
    const link = waitlistInviteLink(lang, EMAIL);
    const at = (needle: string): number => mail.text.indexOf(needle);
    expect(at(thanks)).toBeGreaterThan(0);
    expect(at(lang === 'ko' ? '14일' : '14 days')).toBeGreaterThan(at(thanks));
    expect(at(link)).toBeGreaterThan(at(lang === 'ko' ? '14일' : '14 days'));
    expect(at(task)).toBeGreaterThan(at(link));
    expect(at(signOff)).toBeGreaterThan(at(task));
    expect([...mail.html.matchAll(/href="([^"]+)"/g)]).toHaveLength(1);
    expect(mail.text).not.toMatch(/[?]|utm_|ref=/);
    expect(mail.text).not.toMatch(/atmark\.ai 한 도메인|함께 씁니다|shares? (the|one) (atmark\.ai )?domain|감사해요/);
  });

  it('확인 메일은 순번("차례"·"your turn")을 약속하지 않는다 · 제목이 상황을 말한다', () => {
    const ko = renderWaitlistMail({ kind: 'invitation', email: EMAIL }, 'ko');
    const en = renderWaitlistMail({ kind: 'invitation', email: EMAIL }, 'en');
    expect(ko.subject).toBe('Atmark 초대장이 도착했습니다');
    expect(en.subject).toBe('Your Atmark invitation is here');
    const koConfirm = renderWaitlistMail({ kind: 'confirmation', email: EMAIL }, 'ko');
    const enConfirm = renderWaitlistMail({ kind: 'confirmation', email: EMAIL }, 'en');
    expect(`${koConfirm.subject}${koConfirm.text}`).not.toContain('차례');
    expect(`${enConfirm.subject}${enConfirm.text}`).not.toMatch(/your turn/i);
  });

  it.each(['ko', 'en'] as const)('확인 메일(%s, 2026-10-10) — 작은 팀 · 안정성을 위해 조금씩 · 명단에서 빼 달라는 답장 안내 없음 · 공용 도메인 이야기 없음', (lang) => {
    const mail = renderWaitlistMail({ kind: 'confirmation', email: EMAIL }, lang);
    expect(mail.text).toContain(lang === 'ko' ? '작은 팀이 운영하고 있어, 서비스 안정성을 위해 이용 범위를 조금씩 넓히고 있습니다' : "We're a small team, so we're opening access gradually to keep the service stable");
    expect(mail.text).not.toMatch(/빼 달라|remove you|함께 씁니다|shares the atmark\.ai domain|용도를 보고/);
    // "고맙다" 는 한 번만(2026-10-10 5차) — en 은 첫 줄 "Thanks for …" + 서명 "Thank you,", ko 는 첫 줄만 · 서명 "Onve 드림".
    expect(mail.text.match(lang === 'ko' ? /감사합니다/g : /Thank/g)).toHaveLength(1);
    // 영어 서명은 "Onve" 하나(2026-10-10 9차).
    if (lang === 'en') expect(mail.text).not.toContain('Thank you,');
  });

  it.each(['ko', 'en'] as const)('확인 메일(%s) — 먼저 발송(hold)이면 보류 문단 + 문서 링크 하나(버튼 + 같은 URL) · 초대 메일은 hold 를 무시한다', (lang) => {
    const mail = renderWaitlistMail({ kind: 'confirmation', email: EMAIL, hold: true }, lang);
    const url = WAITLIST_NOT_FOR_URLS[lang];
    expect(url).toBe(lang === 'ko' ? 'https://docs.atmark.ai/get-started/not-for' : 'https://docs.atmark.ai/en/get-started/not-for');
    expect([...mail.html.matchAll(/href="([^"]+)"/g)].map((m) => m[1])).toEqual([url]);
    expect(mail.text).toContain(url);
    expect(mail.text).toContain(lang === 'ko' ? '먼저 연락하지 않은 사람에게 보내는 용도는 아직 지원하지 않아, 지금은 초대해 드리기 어렵습니다.' : "Atmark isn't built for emailing people who haven't written to you first, so we can't invite you for that use.");
    expect(mail.text).not.toMatch(/한 도메인|one domain|custom domains/);
    expect(mail.subject).toBe(WAITLIST_COPY[lang].confirmation.subject);
    expect(`${mail.text}${mail.html}`).not.toContain('?');
    if (lang === 'en') expect(`${mail.subject}${mail.text}`).not.toMatch(/[가-힣]/);
    // hold=false 는 링크가 없는 평소 모양 그대로.
    expect(renderWaitlistMail({ kind: 'confirmation', email: EMAIL, hold: false }, lang).html).not.toMatch(/<a\b/);
    const invite = renderWaitlistMail({ kind: 'invitation', email: EMAIL, hold: true }, lang);
    expect(invite.text).not.toContain(url);
    expect(invite.text).toContain(waitlistInviteLink(lang, EMAIL));
  });
});
