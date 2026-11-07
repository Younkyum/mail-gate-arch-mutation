/**
 * 문의 라우팅(`src/contact/routing.ts`) · 알림만 틀(`renderContactNotify`) — 순수 함수. 2026-09-30.
 *
 * 되돌리면 빨개져야 하는 것:
 *   - 모드 넷의 표(에이전트 수신 · intake · 알림만)와 기본값 `forward`. 없거나 빈 값 = 기본값, 틀린 값 = 기본값 + invalid.
 *   - 알림만: 원 제목(정화)과 보낸 사람 도메인만 — 본문·보낸 사람 주소·표시 이름·받는 주소·첨부 수 없음 · 두 언어 · punycode 도메인은 유니코드 표기 곁들임.
 */

import { domainToUnicode } from 'node:url';

import { describe, expect, it } from 'vitest';

import type { ContactForwardDocument } from '../../../src/contact/intake';
import {
  CONTACT_ROUTING_DEFAULT,
  CONTACT_ROUTING_ENV,
  CONTACT_ROUTING_MODES,
  forwardsNotifyOnly,
  readContactRouting,
  routesContactToAgent,
  runsContactIntake,
} from '../../../src/contact/routing';
import { CONTACT_NOTIFY_COPY, renderContactNotify as renderContactNotifyIn } from '../../../src/notify/contact-forward-template';

describe('문의 라우팅 — 모드 표', () => {
  it('기본은 forward · 모드 넷의 표', () => {
    expect(CONTACT_ROUTING_ENV).toBe('ATMARK_CONTACT_ROUTING');
    expect(CONTACT_ROUTING_DEFAULT).toBe('forward');
    const table = Object.fromEntries(
      CONTACT_ROUTING_MODES.map((mode) => [mode, [routesContactToAgent(mode), runsContactIntake(mode), forwardsNotifyOnly(mode)]]),
    );
    expect(table).toEqual({
      forward: [false, true, false],
      agent_and_forward: [true, true, false],
      agent_and_notify: [true, true, true],
      agent: [true, false, false],
    });
  });

  it('환경 읽기 — 없음·빈 값은 기본값 · 틀린 값은 기본값 + invalid(기동을 멈추지 않는다)', () => {
    expect(readContactRouting({})).toEqual({ mode: 'forward', invalid: false });
    expect(readContactRouting({ [CONTACT_ROUTING_ENV]: '  ' })).toEqual({ mode: 'forward', invalid: false });
    for (const mode of CONTACT_ROUTING_MODES) expect(readContactRouting({ [CONTACT_ROUTING_ENV]: ` ${mode} ` })).toEqual({ mode, invalid: false });
    for (const bad of ['AGENT', 'agent-and-forward', 'true', 'notify']) {
      expect(readContactRouting({ [CONTACT_ROUTING_ENV]: bad }), bad).toEqual({ mode: 'forward', invalid: true });
    }
  });
});

function documentOf(overrides: Partial<ContactForwardDocument> = {}): ContactForwardDocument {
  return {
    version: 1,
    sesMessageId: '0100abc-def-000000',
    receivedAt: '2026-09-30T01:00:00.000Z',
    fromAddress: 'Kim.Customer+tag@Mail.Example.COM',
    fromName: '김고객',
    to: ['support@atmark.ai'],
    date: '2026-09-30T00:59:00.000Z',
    subject: '결제 문의',
    text: '카드 번호는 1234-5678 입니다. 비밀 본문.',
    textTruncated: false,
    textSource: 'plain',
    attachmentCount: 2,
    dmarc: 'pass',
    ...overrides,
  };
}

describe('renderContactNotify — 알림만(한 통에 한 언어)', () => {
  const both = (document: ContactForwardDocument): { ko: ReturnType<typeof renderContactNotifyIn>; en: ReturnType<typeof renderContactNotifyIn> } => ({
    ko: renderContactNotifyIn(document, 'ko'),
    en: renderContactNotifyIn(document, 'en'),
  });

  it('원 제목 + 보낸 사람 도메인(소문자)만 · 본문·주소·표시 이름·첨부 수 없음 · Atmark 에서 회신 · 언어마다', () => {
    const { ko, en } = both(documentOf());
    expect(ko.subject).toBe(`${CONTACT_NOTIFY_COPY.ko.subjectPrefix}결제 문의`);
    expect(en.subject).toBe(`${CONTACT_NOTIFY_COPY.en.subjectPrefix}결제 문의`);
    expect(ko.text).toContain('보낸 사람 도메인: mail.example.com');
    expect(en.text).toContain('Sender domain: mail.example.com');
    expect(ko.text).toContain('제목: 결제 문의');
    expect(en.text).toContain('Subject: 결제 문의');
    expect(ko.text).toContain('답장은 콘솔의 지원 에이전트 수신함에서 해 주세요');
    expect(en.text).toContain("Reply from the support agent's inbox in the console");
    expect(en.text.replace('결제 문의', '')).not.toMatch(/[가-힣]/);
    for (const rendered of [ko, en]) {
      for (const secret of ['카드 번호', '비밀 본문', 'Kim.Customer', 'kim.customer', '김고객', '첨부', 'attachment', '0100abc']) {
        expect(rendered.text, secret).not.toContain(secret);
      }
    }
  });

  it('제목 정화(개행·보이지 않는 문자 · 200자) · 제목 없음 · punycode 도메인은 유니코드 표기를 곁들인다', () => {
    const injected = renderContactNotifyIn(documentOf({ subject: '안녕\r\nBcc: x@evil.example\u200b' }), 'en');
    expect(injected.subject).not.toMatch(/[\r\n\u200b]/);
    expect(injected.text.split('\n').filter((line) => line.startsWith('Bcc:'))).toEqual([]);
    expect(renderContactNotifyIn(documentOf({ subject: 'a'.repeat(500) }), 'en').subject.length).toBeLessThanOrEqual(CONTACT_NOTIFY_COPY.en.subjectPrefix.length + 201);
    const untitled = both(documentOf({ subject: null }));
    expect(untitled.ko.subject).toBe(`${CONTACT_NOTIFY_COPY.ko.subjectPrefix}(제목 없음)`);
    expect(untitled.en.subject).toBe(`${CONTACT_NOTIFY_COPY.en.subjectPrefix}(no subject)`);
    expect(untitled.ko.text).toContain('제목: (제목 없음)');
    expect(untitled.en.text).toContain('Subject: (no subject)');
    const puny = renderContactNotifyIn(documentOf({ fromAddress: 'a@xn--pypal-4ve.com' }), 'ko');
    expect(puny.text).toContain(`보낸 사람 도메인: xn--pypal-4ve.com (${domainToUnicode('xn--pypal-4ve.com')})`);
    expect(domainToUnicode('xn--pypal-4ve.com')).not.toBe('paypal.com');
  });
});
