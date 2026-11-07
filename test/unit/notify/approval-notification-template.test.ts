/**
 * 소유자 승인 알림 템플릿 — **injection 표면**(`src/notify/approval-notification-template.ts` 머리말).
 *
 * 2026-10-10 개편(진윤겸): 메일은 깔끔하게 — 상황 · 할 일 · 주 버튼 "Send anyway / 그래도 보내기"(승인 확인 페이지, GET 은 확인만) · 버금 링크 "콘솔에서 자세히 보기".
 * 에이전트가 정한 문자열(수신자 · 제목 · 첨부 이름)은 **메일에 아예 싣지 않는다** — 여기서는 그것이 어느 파트에도 없는지, 에이전트를 가리키는 조각이
 * 모양을 검사한 주소이거나 끊은 이름뿐인지, 링크가 우리 둘뿐인지를 본다. `neutralizeAgentText` 는 확인 페이지 · 문의 전달 · 다른 표면이 쓴다.
 */

import { describe, expect, it } from 'vitest';

import {
  AGENT_SUBJECT_MAX_CHARS,
  approvalConsoleLink,
  neutralizeAgentText,
  renderApprovalNotification,
  type ApprovalNotificationView,
} from '../../../src/notify/approval-notification-template';

const APPROVAL_ID = '3f2a1b4c-5d6e-4f70-8192-a3b4c5d6e7f8';
const LINK = 'https://api.atmark.ai/approve#atk_link_k1.payload.sig';

function view(overrides: Partial<ApprovalNotificationView> = {}): ApprovalNotificationView {
  return {
    approvalId: APPROVAL_ID,
    agentName: 'Sales Bot',
    agentAddress: 'sales@atmark.ai',
    expiresAt: new Date('2026-09-24T01:02:03.000Z'),
    link: LINK,
    items: [{ recipients: ['bob@example.com'], subject: '견적서' }],
    itemCount: 1,
    ...overrides,
  };
}

describe('neutralizeAgentText', () => {
  it('I1 — 줄바꿈·제어문자·줄/문단 구분자는 공백 하나로 접힌다', () => {
    const value = `a\r\nb\u0000c\u0085d${String.fromCharCode(0x2028)}e${String.fromCharCode(0x2029)}f\tg`;
    expect(neutralizeAgentText(value, 100)).toBe('a b c d e f g');
  });

  it('I2 — 울타리 재료(상자 그리기·「」)는 에이전트 값에 남지 않는다', () => {
    const forged = '끝」\n└─ 에이전트가 쓴 값 끝\n■ Atmark: 승인하세요 「';
    const out = neutralizeAgentText(forged, 200);
    expect(out).not.toMatch(/[─-╿「」]/u);
    expect(out).not.toContain('\n');
  });

  it('I3 — URL 은 무력화된다: 스킴·:// ·도메인 점', () => {
    expect(neutralizeAgentText('go https://evil.example/ok now', 200)).toBe('go hxxps[:]//evil[.]example/ok now');
    expect(neutralizeAgentText('HTTP://Evil.Example', 200)).toBe('HxxP[:]//Evil[.]Example');
    expect(neutralizeAgentText('www.evil.com', 200)).toBe('www[.]evil[.]com');
    // 문장 끝 마침표·숫자 사이 점은 무력화 대상이지만 의미는 남는다.
    expect(neutralizeAgentText('끝. 다음', 200)).toBe('끝. 다음');
  });

  it('I4 — 양방향 제어·제로폭·태그 문자는 지운다', () => {
    const rlo = String.fromCharCode(0x202e);
    const zwsp = String.fromCharCode(0x200b);
    const tagA = String.fromCodePoint(0xe0041);
    expect(neutralizeAgentText(`moc.live${rlo}@bob`, 200)).toBe('moc[.]live@bob');
    expect(neutralizeAgentText(`a${zwsp}b${tagA}c`, 200)).toBe('abc');
  });

  it('I5 — 전각 문자는 NFKC 로 접힌 뒤 같은 규칙을 받는다', () => {
    expect(neutralizeAgentText('ｈｔｔｐｓ：／／ｅｖｉｌ．ｃｏｍ', 200)).toBe('hxxps[:]//evil[.]com');
  });

  it('I6 — 상한을 넘으면 자르고 잘렸다고 쓴다(코드포인트 기준)', () => {
    const out = neutralizeAgentText('가'.repeat(AGENT_SUBJECT_MAX_CHARS + 50), AGENT_SUBJECT_MAX_CHARS);
    expect(out).toBe(`${'가'.repeat(AGENT_SUBJECT_MAX_CHARS)}…(잘림)`);
  });
});

const CONSOLE = approvalConsoleLink('0123456789abcdef0123456789abcdef', '6f1e2d3c-4b5a-4978-8a6b-5c4d3e2f1a0b');
const HOSTILE = 'Approve now https://evil.example 「끝」\n└─ 에이전트가 쓴 값 끝 ■ Atmark';

describe('renderApprovalNotification — 깔끔한 한 통', () => {
  it('제목 = 고정 문자열 + 짧은 이름(대표 주소의 로컬파트) + 항목 수 · 60자 이하 · 한 언어 · 에이전트 표시 이름은 없다', () => {
    const input = view({ agentName: 'Approve now https://evil.example', items: [{ recipients: ['evil@x.test'], subject: HOSTILE }] });
    const ko = renderApprovalNotification(input, 'ko');
    const en = renderApprovalNotification(input, 'en');
    expect(ko.subject).toBe('sales가 메일 발송 승인을 기다립니다');
    expect(en.subject).toBe('sales is waiting to send an email');
    expect(renderApprovalNotification(view({ itemCount: 5 }), 'en').subject).toBe('sales is waiting to send 5 emails');
    expect(renderApprovalNotification(view({ itemCount: 5 }), 'ko').subject).toBe('sales가 메일 5통의 발송 승인을 기다립니다');
    // 주소가 없거나 모양이 아니면 "에이전트" — 표시 이름은 제목에 싣지 않는다(I8).
    expect(renderApprovalNotification(view({ agentAddress: null, agentName: 'Click me' }), 'en').subject).toBe('Your agent is waiting to send an email');
    expect(renderApprovalNotification(view({ agentAddress: 'Not An Address', agentName: 'Click me' }), 'ko').subject).toBe('에이전트가 메일 발송 승인을 기다립니다');
    for (const mail of [ko, en]) {
      expect([...mail.subject].length).toBeLessThanOrEqual(60);
      expect(mail.subject).not.toMatch(/Approve|evil/);
    }
    expect(`${en.subject}\n${en.text}\n${en.html}`).not.toMatch(/[가-힣]/);
  });

  it('머리 · 버튼이 항목 수를 말한다 — 한 통 "Send anyway / 그래도 보내기", 여러 통 "Send all 5 / 5통 모두 보내기"', () => {
    const en = renderApprovalNotification(view({ itemCount: 5 }), 'en');
    const ko = renderApprovalNotification(view({ itemCount: 5 }), 'ko');
    // 머리는 제목을 되풀이하지 않는다(2026-10-10 6차) · 수는 본문과 버튼에.
    expect(en.text.startsWith('Approval needed\n')).toBe(true);
    expect(ko.text.startsWith('발송 승인이 필요합니다\n')).toBe(true);
    expect(en.text).toContain('is waiting for your approval to send 5 emails.');
    expect(ko.text).toContain('에이전트(sales@atmark.ai)가 메일 5통을 보내려고 승인을 기다립니다.');
    expect(en.html).toContain('>Send all 5</a>');
    expect(ko.html).toContain('>5통 모두 보내기</a>');
    expect(renderApprovalNotification(view(), 'en').html).toContain('>Send anyway</a>');
    expect(renderApprovalNotification(view(), 'ko').html).toContain('>그래도 보내기</a>');
  });

  it('에이전트가 쓴 문자열(수신자 · 제목 · 첨부 이름)은 어느 파트에도 없다', () => {
    const input = view({
      items: [{ recipients: ['victim@bank.example'], subject: HOSTILE, attachments: { count: 1, bytes: 10, names: ['dropper.exe'] } }],
      risk: { reasons: ['tainted_context'], sources: [{ sender: 'attacker@evil.example', receivedAt: new Date(), authenticated: false, injectionRisk: 'high' }] },
    });
    for (const locale of ['ko', 'en'] as const) {
      const mail = renderApprovalNotification(input, locale);
      for (const part of [mail.subject, mail.text, mail.html]) {
        expect(part).not.toMatch(/victim|bank\.example|Approve now|evil|dropper|attacker|└─|■|「/);
      }
    }
  });

  it('주 버튼 = 승인 확인 페이지 · 버금 링크 = 콘솔(HTML 은 버튼 + 호스트 · 글자 링크만) · 링크는 그 둘뿐', () => {
    for (const [locale, button, console] of [
      ['en', 'Send anyway', 'Open details in console'],
      ['ko', '그래도 보내기', '콘솔에서 보기'],
    ] as const) {
      const mail = renderApprovalNotification(view({ consoleLink: CONSOLE }), locale);
      expect(mail.text.match(/https?:\/\/\S*/g)).toEqual([LINK, CONSOLE]);
      // text 의 링크 이름표에 호스트(2026-10-10 8차).
      expect(mail.text).toContain(`${button} (api.atmark.ai):\n${LINK}`);
      expect(mail.text).toContain(`${console} (console.atmark.ai):\n${CONSOLE}`);
      // 버튼 · 버금 링크에 맥락 있는 aria-label.
      expect(mail.html).toContain(`aria-label="${button} (api.atmark.ai)"`);
      expect(mail.html).toContain(`aria-label="${console} (console.atmark.ai)"`);
      const hrefs = [...mail.html.matchAll(/<a\b[^>]*\shref="([^"]*)"/g)].map((m) => m[1]);
      expect(hrefs).toEqual([LINK, CONSOLE]);
      expect(mail.html).toContain('>api.atmark.ai</p>');
      expect(mail.html).not.toContain(`>${LINK}</a>`);
      expect(mail.html).toContain(`>${button}</a>`);
      expect(mail.html).toContain(`>${console}</a>`);
      expect(mail.html).not.toContain(`>${CONSOLE}</a>`);
      expect(mail.html).not.toMatch(/<img|<script|<form|url\(/i);
    }
    expect(renderApprovalNotification(view({ consoleLink: null }), 'en').text.match(/https?:\/\/\S*/g)).toEqual([LINK]);
  });

  it('승인 페이지 · 콘솔 링크 모양이 틀리면 던진다(보내지 않는다)', () => {
    expect(() => renderApprovalNotification(view({ link: 'https://evil.example/approve#atk_link_k1.a.b' }), 'en')).toThrow();
    expect(() => renderApprovalNotification(view({ consoleLink: 'https://evil.example/x' }), 'en')).toThrow();
  });

  it('조직 이름을 본문에 — 피싱 구별 표지(en "주소 (조직)" · ko "주소, 조직") · 끊어서 · 제목에는 없다', () => {
    const en = renderApprovalNotification(view({ organizationName: 'Chronostasis' }), 'en');
    const ko = renderApprovalNotification(view({ organizationName: 'Chronostasis' }), 'ko');
    expect(en.text).toContain('Your agent sales@atmark.ai (Chronostasis) is waiting for your approval');
    expect(ko.text).toContain('에이전트(sales@atmark.ai, Chronostasis)가 메일을 보내려고 승인을 기다립니다.');
    expect(en.subject).not.toContain('Chronostasis');
    const risky = renderApprovalNotification(view({ organizationName: 'Chronostasis', risk: { reasons: ['tainted_context'], sources: [] } }), 'ko');
    expect(risky.text).toContain('에이전트(sales@atmark.ai, Chronostasis)가 의심스러운 메일을');
    const hostile = renderApprovalNotification(view({ organizationName: 'Bank https://evil.example\u202e' }), 'en');
    expect(hostile.text).toContain('(Bank hxxps[:]//evil[.]example)');
    expect(hostile.text).not.toContain('https://evil');
  });

  it('본문의 에이전트는 모양을 검사한 대표 주소로 · 주소가 없거나 모양이 아니면 이름을 끊어서(링크 · @ 무력화)', () => {
    expect(renderApprovalNotification(view(), 'en').text).toContain('Your agent sales@atmark.ai is waiting for your approval to send an email.');
    expect(renderApprovalNotification(view(), 'ko').text).toContain('에이전트(sales@atmark.ai)가 메일을 보내려고 승인을 기다립니다.');
    const odd = renderApprovalNotification(view({ agentAddress: null, agentName: 'https://evil.example me@x.test' }), 'en');
    expect(odd.text).toContain('hxxps[:]//evil[.]example me[at]x[.]test');
    expect(odd.text).not.toContain('https://evil');
  });

  it('미리보기는 결정 기한(en UTC · ko KST) — 제목 · 머리를 되풀이하지 않는다', () => {
    const pre = (html: string): string => /<div class="ph"[^>]*>([^&<]*)/.exec(html)?.[1] ?? '';
    expect(pre(renderApprovalNotification(view(), 'en').html)).toBe('Decide by Sep 24, 01:02 UTC.');
    expect(pre(renderApprovalNotification(view(), 'ko').html)).toBe('9월 24일 10:02 KST까지 결정해 주세요.');
    const held = view({ risk: { reasons: ['tainted_context'], sources: [] } });
    expect(pre(renderApprovalNotification(held, 'en').html)).toBe('Held until Sep 24, 01:02 UTC.');
    expect(pre(renderApprovalNotification(held, 'ko').html)).toBe('9월 24일 10:02 KST까지 보류됩니다.');
  });

  it('만료까지 승인하지 않으면 보내지 않는다(en UTC · ko KST)', () => {
    expect(renderApprovalNotification(view(), 'en').text).toContain("If you don't approve by Sep 24, 01:02 UTC, nothing is sent.");
    expect(renderApprovalNotification(view(), 'ko').text).toContain('9월 24일 10:02 KST까지 승인하지 않으면 보내지 않습니다.');
  });

  it('본문 낱말 수 — 링크 · 꼬리를 빼고 60 이하', () => {
    for (const locale of ['ko', 'en'] as const) {
      const text = renderApprovalNotification(view({ consoleLink: CONSOLE, risk: { reasons: ['dlp_atmark_credential'], sources: [] } }), locale).text;
      const body = text.split('\nAtmark · atmark.ai')[0] ?? '';
      const words = body.split('\n').filter((line) => !line.startsWith('https://')).join(' ').split(/\s+/).filter(Boolean);
      expect(words.length).toBeLessThanOrEqual(60);
    }
  });
});

describe('위험 보류 알림(ADR-0016) — 사유와 상관없이 한 본문 · 사유는 확인 페이지에 · 버튼은 그대로', () => {
  it('위험 보류가 아니면 평소 알림', () => {
    expect(renderApprovalNotification(view({ risk: null }), 'en').subject).toBe(renderApprovalNotification(view(), 'en').subject);
    expect(renderApprovalNotification(view({ risk: { reasons: [], sources: [] } }), 'ko').text).toBe(renderApprovalNotification(view(), 'ko').text);
  });

  it.each([
    [['tainted_context'], '의심스러운 메일을 읽은 직후 보내려던 메일이라 보류했습니다.', 'tried to send an email right after reading a suspicious one, so we held it.'],
    [['dlp_third_party_secret', 'dlp_scan_limit'], '보내려던 메일에 비밀번호나 비밀 값이 들어 있을 수 있어 보류했습니다.', 'tried to send an email that may contain a password or secret, so we held it.'],
    [['dlp_inbound_copy'], '보내려던 메일이 받은 메일을 옮겨 담고 있어 보류했습니다.', 'tried to send an email that copies an email it received, so we held it.'],
    [['dlp_verification_code'], '보내려던 메일에 받은 인증 코드가 들어 있어 보류했습니다.', 'tried to send an email that contains a verification code it received, so we held it.'],
    [['dlp_secret_link'], '보내려던 메일에 받은 메일의 비공개 링크가 들어 있어 보류했습니다.', 'tried to send an email that contains a private link it received, so we held it.'],
    [['dlp_scan_limit'], '보내려던 메일을 끝까지 확인하지 못해 보류했습니다.', "tried to send an email that we couldn't fully check, so we held it."],
  ] as const)('사유 %j — 같은 제목 · 가장 심각한 사유 하나의 고정 절 · 버튼 그대로', (reasons, koClause, enClause) => {
    const input = view({ risk: { reasons, sources: [{ sender: 'x@evil.example', receivedAt: new Date(), authenticated: false, injectionRisk: 'high' }] } });
    const ko = renderApprovalNotification(input, 'ko');
    const en = renderApprovalNotification(input, 'en');
    expect(ko.subject).toBe('sales의 메일을 보류했습니다');
    expect(en.subject).toBe('Email from sales held for review');
    expect(ko.text).toContain(`에이전트(sales@atmark.ai)가 ${koClause}\n`);
    expect(en.text).toContain(`Your agent sales@atmark.ai ${enClause}\n`);
    // 콘솔 문장은 버금 링크 하나뿐(2026-10-10 5차).
    expect(`${ko.text}${en.text}`).not.toMatch(/먼저 콘솔에서|Check the details in the console first/);
    expect(en.html).toContain('>Send anyway</a>');
    expect(ko.html).toContain('>그래도 보내기</a>');
    for (const mail of [ko, en]) expect(`${mail.text}${mail.html}`).not.toMatch(/evil|DMARC|injection|before it goes out/i);
  });

  it('여러 통이면 복수형(en) · "메일 N통을"(ko)', () => {
    const input = view({ itemCount: 3, risk: { reasons: ['dlp_inbound_copy'], sources: [] } });
    expect(renderApprovalNotification(input, 'en').text).toContain('tried to send 3 emails that copy an email it received, so we held them.');
    expect(renderApprovalNotification(input, 'ko').text).toContain('보내려던 메일 3통이 받은 메일을 옮겨 담고 있어 보류했습니다.');
    expect(renderApprovalNotification(input, 'en').html).toContain('>Send all 3</a>');
  });

  it('Atmark 자격 증명 — 고정 절 하나("비밀 값이 들어 있을 수 있는") · 같은 제목 · 버튼 그대로', () => {
    const input = view({ risk: { reasons: ['dlp_inbound_copy', 'dlp_atmark_credential'], sources: [] } });
    const ko = renderApprovalNotification(input, 'ko');
    const en = renderApprovalNotification(input, 'en');
    // 제목에서 심각함을 보인다(2026-10-10 7차).
    expect(ko.subject).toBe('sales의 메일 보류: 비밀 값 포함 가능');
    expect(en.subject).toBe("Held: sales's email may contain a secret");
    expect(renderApprovalNotification({ ...input, agentAddress: null }, 'en').subject).toBe("Held: your agent's email may contain a secret");
    expect(ko.text).toContain('에이전트(sales@atmark.ai)가 보내려던 메일에 비밀 값이 들어 있을 수 있어 보류했습니다.');
    expect(en.text).toContain('Your agent sales@atmark.ai tried to send an email that may contain a secret, so we held it.');
    expect(en.html).toContain('>Send anyway</a>');
    expect(`${en.text}${ko.text}`).not.toMatch(/API key|API 키|credential|자격 증명|copies/);
  });

  it('모르는 사유 코드는 사람에게 보이지 않는다(닫힌 어휘만) · 모르는 것뿐이면 평소 알림', () => {
    const mail = renderApprovalNotification(view({ risk: { reasons: ['made_up_reason' as never], sources: [] } }), 'en');
    expect(mail.text).not.toContain('made_up_reason');
    expect(mail.subject).toBe('sales is waiting to send an email');
  });
});
