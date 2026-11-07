/**
 * US-009(ADR-0009) — 문의 전달의 순수 부분(네트워크·DB 0).
 *
 *   - 받아들이기 전 판정(`precheckContactReceipt`): 스팸·바이러스는 정확히 PASS 만 · DMARC fail 거부 · 자동 응답·우리 도메인(루프) 거부.
 *   - 전달 주소 비밀 파서: 자리값·JSON 아님·키 다름·주소 아님·우리 도메인 → `null`(닫힌 쪽) · 로더는 유효한 값만 기억.
 *   - 틀: 제목 `[Atmark 문의] ` + 정화(개행·양방향·제로폭 제거, 200자) · 머리 블록은 구분선 위, 원 본문은 아래.
 *   - (전송면 `Reply-To` 헤더 안전은 `test/unit/mail/ses-transport.test.ts` — 전송단을 참조해도 되는 테스트 파일이 거기다.)
 *   - 워커: 전달 주소가 없으면 그 틱은 첫 건에서 멈춘다.
 *   - 상수 짝: 홈 `CONTACT_EMAIL` = 문의 주소 · 로컬파트 `support` 는 예약.
 */

import { describe, expect, it } from 'vitest';

import { createContactDestinationLoader, parseContactDestination } from '../../../src/contact/destination';
import {
  buildContactDocument,
  CONTACT_ADDRESS,
  CONTACT_TEXT_MAX_CHARS,
  contactSenderHash,
  CONTACT_RECIPIENT_ADDRESSES,
  intakeContactMail,
  isContactRecipient,
  isForwardableAddress,
  isOwnDomain,
  precheckContactReceipt,
  type ContactForwardDocument,
} from '../../../src/contact/intake';
import { RECEIVE_ONLY_ADDRESSES, RESERVED_LOCAL_PARTS } from '../../../src/identity/address';
import type { InboundReceipt } from '../../../src/inbound/receipt';
import type { ParsedInboundMessage } from '../../../src/mail/mime/parse';
import { INVISIBLE } from '../../../src/notify/approval-notification-template';
import {
  CONTACT_FORWARD_COPY,
  contactForwardSubject as contactForwardSubjectIn,
  renderContactForward as renderContactForwardIn,
} from '../../../src/notify/contact-forward-template';
import type { ContactForwarder, ContactForwardOutcome } from '../../../src/notify/contact-forwarder';
import { CONTACT_EMAIL } from '../../../src/site/constants';
import { runContactForwarder } from '../../../src/workers/contact-forwarder';

const PLACEHOLDER = JSON.stringify({ _unset: 'placeholder - filled by migrate handler or deploy runbook (docs/runbooks/deploy.md)' });

type ReceiptOverrides = Partial<Omit<InboundReceipt, 'verdicts'>> & { readonly verdicts?: Partial<InboundReceipt['verdicts']> };

function receipt(overrides: ReceiptOverrides = {}): InboundReceipt {
  const base: InboundReceipt = {
    sesMessageId: 'abc123',
    objectKey: 'inbound/raw/abc123',
    envelopeRecipients: [CONTACT_ADDRESS],
    envelopeSender: 'bounce@mail.example.com',
    receivedAt: new Date('2026-09-24T00:00:00.000Z'),
    verdicts: { spf: 'pass', dkim: 'pass', dmarc: 'pass', spam: 'pass', virus: 'pass' },
    dmarcFromDomains: ['mail.example.com'],
    headers: { autoSubmitted: false, forwardedFor: null, forwardedTo: null, truncated: false },
  } as unknown as InboundReceipt;
  return { ...base, ...overrides, verdicts: { ...base.verdicts, ...overrides.verdicts } } as InboundReceipt;
}

describe('문의 입구 — abuse@·postmaster@ (202609301540)', () => {
  it('거부 행의 수신자는 이 메일이 실제로 온 문의 주소들이다(support@ 로 고쳐 적지 않는다) · 에이전트 주소는 싣지 않는다', async () => {
    const calls: [string, string[], string | null][] = [];
    const context = {
      contact: {} as never,
      rawMail: {} as never,
      traceId: null,
      reject: async (reason: string, recipients: readonly string[], detail: string | null): Promise<void> => {
        calls.push([reason, [...recipients], detail]);
      },
    };
    const spam = receipt({ envelopeRecipients: ['abuse@atmark.ai', 'agent@atmark.ai', 'postmaster@atmark.ai'], verdicts: { spam: 'fail' } });
    expect(await intakeContactMail(context, spam, 'inbound/raw/abc123')).toBe('rejected');
    expect(calls).toEqual([['contact_not_forwarded', ['abuse@atmark.ai', 'postmaster@atmark.ai'], 'spam_verdict']]);
  });
});

describe('문의 입구 — 받아들이기 전 판정', () => {
  it.each([
    [{}, null],
    // DMARC 가 없거나 gray 면 통과(개인 도메인) — fail 만 거부.
    [{ verdicts: { dmarc: 'gray' } }, null],
    [{ verdicts: { dmarc: 'disabled' } }, null],
    [{ verdicts: { spam: 'fail' } }, 'spam_verdict'],
    [{ verdicts: { spam: 'gray' } }, 'spam_verdict'],
    [{ verdicts: { spam: 'processing_failed' } }, 'spam_verdict'],
    [{ verdicts: { virus: 'gray' } }, 'virus_verdict'],
    [{ verdicts: { virus: 'fail' } }, 'virus_verdict'],
    [{ verdicts: { dmarc: 'fail' } }, 'dmarc_fail'],
    [{ headers: { autoSubmitted: true, forwardedFor: null, forwardedTo: null, truncated: false } }, 'auto_submitted'],
    [{ envelopeSender: 'x@atmark.ai' }, 'loop_own_domain'],
    [{ envelopeSender: 'bounce@send.atmark.ai' }, 'loop_own_domain'],
    [{ dmarcFromDomains: ['atmark.ai'] }, 'loop_own_domain'],
  ] as const)('%j → %s', (overrides, code) => {
    expect(precheckContactReceipt(receipt(overrides as never))).toBe(code);
  });

  it('주소 판정 — 문의 주소 · 우리 도메인 · Reply-To 로 내보낼 수 있는 주소', () => {
    expect(isContactRecipient('SUPPORT@atmark.ai')).toBe(true);
    expect(isContactRecipient('support@atmark.ai.evil.example')).toBe(false);
    // 202609301540 — RFC 2142 역할 주소도 문의 경로(수신 전용). 다른 예약 로컬파트·고객 도메인의 같은 로컬파트는 아니다.
    expect([...CONTACT_RECIPIENT_ADDRESSES]).toEqual([CONTACT_ADDRESS, ...RECEIVE_ONLY_ADDRESSES]);
    expect(isContactRecipient('abuse@atmark.ai')).toBe(true);
    expect(isContactRecipient('POSTMASTER@atmark.ai')).toBe(true);
    for (const other of ['hostmaster@atmark.ai', 'security@atmark.ai', 'abuse@agents.example.com', 'xabuse@atmark.ai']) expect(isContactRecipient(other), other).toBe(false);
    expect(isOwnDomain('a@atmark.ai')).toBe(true);
    expect(isOwnDomain('a@mail.atmark.ai')).toBe(true);
    expect(isOwnDomain('notatmark.ai')).toBe(false); // 접미사 일치가 아니라 하위 도메인만
    expect(isOwnDomain('a@atmark.ai.example.com')).toBe(false);
    expect(isForwardableAddress('a.b+c@example.test')).toBe(true);
    for (const bad of ['a@b@c.test', 'a b@example.test', 'a@example.test\r\nBcc: x@y.test', '"a"@example.test', '<a@example.test>', 'a@example.test,b@example.test', 'a@', '@a.test']) {
      expect(isForwardableAddress(bad), bad).toBe(false);
    }
  });

  it('주소 판정(검증 F4) — ASCII dot-atom 만 · RFC 2047 encoded-word(`=?`) 로컬파트 거부', () => {
    // 검토자 증거(ew.ts): 파서가 From 주소로 돌려준 값들 — 클라이언트가 encoded-word 를 풀면 다른 주소로 보인다.
    for (const bad of [
      '=?utf-8?q?victim=40bank.example=3e=00?=@attacker.example',
      '=?utf-8?b?dmljdGltQGJhbmsuY29t?=@attacker.example',
      'x=?utf-8?q?y?=@attacker.example',
      'a?=@example.test',
      '.a@example.test',
      'a.@example.test',
      'a..b@example.test',
      'a@example',
      'a@-example.test',
      'a@example-.test',
      'a@[127.0.0.1]',
      'a@example.test.',
      '한글@example.test',
      'a@exämple.test',
      `${'a'.repeat(65)}@example.test`,
      'a(c)@example.test',
      'a\\b@example.test',
    ]) {
      expect(isForwardableAddress(bad), bad).toBe(false);
    }
    for (const good of ['a@example.test', 'first.last+tag@mail.example.test', "o'brien@example.test", 'A_B-c@Example.TEST', `${'a'.repeat(64)}@example.test`, 'x=y@example.test']) {
      expect(isForwardableAddress(good), good).toBe(true);
    }
    expect(contactSenderHash('A@Example.test')).toBe(contactSenderHash(' a@example.test '));
    expect(contactSenderHash('a@example.test')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('문서 — 본문 상한 · 첨부는 개수만', () => {
    const mail = {
      from: { address: 'a@example.test', name: 'A' },
      to: [{ address: CONTACT_ADDRESS, name: null }],
      subject: 's',
      date: null,
      text: 'x'.repeat(CONTACT_TEXT_MAX_CHARS + 10),
      textSource: 'plain',
      attachments: [{ index: 0 }, { index: 1 }],
    } as unknown as ParsedInboundMessage;
    const doc = buildContactDocument('abc123', new Date('2026-09-24T00:00:00Z'), mail, 'pass');
    expect([...doc.text]).toHaveLength(CONTACT_TEXT_MAX_CHARS);
    expect(doc.textTruncated).toBe(true);
    expect(doc.attachmentCount).toBe(2);
    expect(Object.keys(doc)).not.toContain('attachments');
  });
});

describe('전달 주소 비밀 — 실패는 전부 닫힌 쪽(null)', () => {
  it.each([
    [PLACEHOLDER, null],
    ['not json', null],
    ['[]', null],
    ['{"to": 1}', null],
    ['{"to":"x"}', null],
    ['{"to":"x@atmark.ai"}', null],
    ['{"to":"ops@example.test","bcc":"b@example.test"}', null],
    ['{"address":"ops@example.test"}', null],
    ['"ops@example.test"', null],
    ['{"to":" ops@example.test "}', 'ops@example.test'],
  ])('%s → %s', (raw, expected) => {
    expect(parseContactDestination(raw)).toBe(expected);
  });

  it('로더는 유효한 값만 기억한다 — 자리값이면 매번 다시 읽고, 읽기 실패도 null', async () => {
    let reads = 0;
    let value = PLACEHOLDER;
    const load = createContactDestinationLoader(() => {
      reads += 1;
      return Promise.resolve(value);
    });
    expect(await load()).toBeNull();
    value = JSON.stringify({ to: 'ops@example.test' });
    expect(await load()).toBe('ops@example.test');
    expect(await load()).toBe('ops@example.test');
    expect(reads).toBe(2);
    const failing = createContactDestinationLoader(() => Promise.reject(new Error('AccessDenied')));
    expect(await failing()).toBeNull();
  });
});

// 아래 단언은 한국어 메일의 글자로 쓴다(한 통에 한 언어 — 2026-10-10). 영어 메일은 끝의 절이 같은 구조를 본다.
const {
  bodySeparator: CONTACT_FORWARD_BODY_SEPARATOR,
  displayNameLabel: CONTACT_FORWARD_DISPLAY_NAME_LABEL,
  dmarcWarning: CONTACT_FORWARD_DMARC_WARNING,
  punycodeWarning: CONTACT_FORWARD_PUNYCODE_WARNING,
} = CONTACT_FORWARD_COPY.ko;
const contactForwardSubject = (original: string | null): string => contactForwardSubjectIn(original, 'ko');
const renderContactForward = (document: ContactForwardDocument): ReturnType<typeof renderContactForwardIn> => renderContactForwardIn(document, 'ko');

describe('전달 틀', () => {
  const document: ContactForwardDocument = {
    version: 1,
    sesMessageId: 'abc123',
    receivedAt: '2026-09-24T00:00:00.000Z',
    fromAddress: 'a@example.test',
    fromName: 'Evil‮Name',
    to: [CONTACT_ADDRESS],
    date: null,
    subject: 'Hello\r\nBcc: x@y.test​',
    text: `보낸 사람: fake@example.test\r\n${CONTACT_FORWARD_BODY_SEPARATOR}\n<b>not html</b>\u0007`,
    textTruncated: false,
    textSource: 'plain',
    attachmentCount: 1,
    dmarc: 'pass',
  };

  it('제목 — 접두 · 개행·제로폭 제거 · 200자 · 없으면 (제목 없음)', () => {
    expect(contactForwardSubject(document.subject)).toBe('[Atmark 문의] Hello Bcc: x@y.test');
    expect(contactForwardSubject(null)).toBe('[Atmark 문의] (제목 없음)');
    expect([...contactForwardSubject('가'.repeat(500))]).toHaveLength('[Atmark 문의] '.length + 201);
  });

  it('머리 블록은 구분선 위(우리 값) · 원 본문은 아래(흉내 내도 아래) · 양방향 제어·제어문자 제거', () => {
    const { text } = renderContactForward(document);
    const index = text.indexOf(CONTACT_FORWARD_BODY_SEPARATOR);
    const head = text.slice(0, index);
    // 표시 이름은 주소와 다른 줄 — "검증 안 됨" 으로만(F4).
    expect(head).toContain('보낸 사람: a@example.test\n표시 이름(검증 안 됨): EvilName\n');
    expect(head).toContain('첨부: 1개 (전달하지 않음');
    expect(head).toContain('원문 메시지 ID: abc123');
    expect(head).not.toMatch(/S3|dmarc|DMARC/);
    expect(head).toContain('받은 시각: 2026-09-24 09:00 KST');
    expect(head).not.toContain('fake@example.test');
    expect(text.slice(index)).toContain('보낸 사람: fake@example.test');
    expect(text).not.toMatch(/[‮​\x07\r]/);
    // DMARC pass — 경고 없음.
    expect(text).not.toContain(CONTACT_FORWARD_DMARC_WARNING);
  });

  it('검증 F4 — 표시 이름 사칭(`"victim@bank.example" <x@attacker>`)은 "표시 이름(검증 안 됨)" 줄로만 · 보낸 사람 줄은 주소 하나', () => {
    const { text } = renderContactForward({ ...document, fromAddress: 'x@attacker.example', fromName: 'victim@bank.example' });
    const head = text.slice(0, text.indexOf(CONTACT_FORWARD_BODY_SEPARATOR));
    expect(head).toContain('보낸 사람: x@attacker.example\n');
    expect(head).toContain(`${CONTACT_FORWARD_DISPLAY_NAME_LABEL}: victim@bank.example\n`);
    expect(head).not.toMatch(/보낸 사람: [^\n]*victim@bank\.example/);
    // 표시 이름이 없거나 정화 뒤 비면 그 줄이 없다.
    for (const fromName of [null, '\u200b\u202e']) {
      expect(renderContactForward({ ...document, fromName }).text).not.toContain(CONTACT_FORWARD_DISPLAY_NAME_LABEL);
    }
  });

  it.each(['fail', 'gray', 'none', 'disabled', 'PASS', ''])('검증 F4 — DMARC %j(≠ pass) 면 맨 윗줄에 경고', (dmarc) => {
    const { text } = renderContactForward({ ...document, dmarc });
    expect(text.split('\n')[0]).toBe(CONTACT_FORWARD_DMARC_WARNING);
  });

  it('최종 검증 L7 — 보낸 날짜·받은 시각도 한 줄로(개행으로 머리 블록 줄을 흉내 내지 못한다) · 40자', () => {
    const forged = '2026-09-24\n보낸 사람: ceo@bank.example\r\nDMARC: pass';
    const { text } = renderContactForward({ ...document, date: forged, receivedAt: forged });
    const head = text.slice(0, text.indexOf(CONTACT_FORWARD_BODY_SEPARATOR));
    expect(head.split('\n').filter((line) => line.startsWith('보낸 사람:'))).toEqual(['보낸 사람: a@example.test']);
    expect(head.split('\n').filter((line) => line.startsWith('보낸 사람 확인:'))).toEqual(['보낸 사람 확인: 됨']);
    expect(head).toContain('보낸 날짜: 2026-09-24 보낸 사람: ceo@bank.example DMARC…\n');
    expect(head).toContain('받은 시각: 2026-09-24 보낸 사람: ceo@bank.example DMARC…\n');
    expect(renderContactForward(document).text).toContain('보낸 날짜: (없음)\n');
  });

  it('최종 검증 L7 — 회신 주소 도메인이 punycode(xn--)면 맨 위 경고 + 두 표기 · 거부하지 않는다 · 아니면 경고 없음', () => {
    const { text } = renderContactForward({ ...document, fromAddress: 'billing@xn--pypal-4ve.test' });
    const lines = text.split('\n');
    expect(lines[0]).toBe(CONTACT_FORWARD_PUNYCODE_WARNING);
    expect(lines[1]).toBe('  도메인: xn--pypal-4ve.test (보이는 모양: p\u0430ypal.test)');
    expect(text).toContain('보낸 사람: billing@xn--pypal-4ve.test\n');
    // 하위 도메인 라벨·대문자도 같다. DMARC 경고가 있으면 그 아래에 온다.
    const nested = renderContactForward({ ...document, fromAddress: 'a@mail.XN--pypal-4ve.test', dmarc: 'gray' }).text.split('\n');
    expect(nested[0]).toBe(CONTACT_FORWARD_DMARC_WARNING);
    expect(nested[2]).toBe(CONTACT_FORWARD_PUNYCODE_WARNING);
    // 변환할 수 없는 라벨도 경고는 한다.
    expect(renderContactForward({ ...document, fromAddress: 'a@xn--zz.example' }).text.split('\n')[0]).toBe(CONTACT_FORWARD_PUNYCODE_WARNING);
    // 로컬파트의 xn-- 는 도메인이 아니다.
    for (const fromAddress of ['a@example.test', 'xn--a@example.test', 'a@example-xn--.test']) {
      expect(renderContactForward({ ...document, fromAddress }).text, fromAddress).not.toContain(CONTACT_FORWARD_PUNYCODE_WARNING);
    }
  });

  it('검증 F5 — 승인 알림 틀과 같은 INVISIBLE 한 벌: U+061C(ALM)·U+00AD·U+3164·U+FE0F·태그 문자·U+2066 이 제목·표시 이름·본문에서 사라진다', () => {
    const hidden = ['\u061c', '\u00ad', '\u3164', '\ufe0f', '\u{e0041}', '\u2066', '\u180e', '\uffa0'];
    const dirty = `a${hidden.join('')}b`;
    const { subject, text } = renderContactForward({ ...document, subject: dirty, fromName: dirty, text: `line1\n${dirty}\u2028line3` });
    expect(subject).toBe('[Atmark 문의] ab');
    expect(text).toContain(`${CONTACT_FORWARD_DISPLAY_NAME_LABEL}: ab\n`);
    for (const ch of hidden) {
      expect(subject.includes(ch), `subject ${ch.codePointAt(0)?.toString(16) ?? ''}`).toBe(false);
      expect(text.includes(ch), `text ${ch.codePointAt(0)?.toString(16) ?? ''}`).toBe(false);
    }
    // 본문은 줄바꿈을 살린다(U+2028 → 개행).
    expect(text).toContain('line1\nab\nline3');
    // 같은 정규식 객체다 — 두 벌이 아니다.
    expect(INVISIBLE.test('\u061c')).toBe(true);
    INVISIBLE.lastIndex = 0;
  });
});

describe('전달 워커', () => {
  it('전달 주소가 없으면 첫 건에서 멈춘다 — 행 수만큼 로그·메트릭을 뿜지 않는다', async () => {
    const calls: string[] = [];
    const forwarder: ContactForwarder = {
      forward: (id: string): Promise<ContactForwardOutcome> => {
        calls.push(id);
        return Promise.resolve('unconfigured');
      },
    };
    const db = { query: () => Promise.resolve({ rows: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] }) } as never;
    const report = await runContactForwarder({ db, forwarder, now: () => new Date() });
    expect(calls).toEqual(['a']);
    expect(report.unconfigured).toBe(1);
  });
});

describe('상수 짝', () => {
  it('홈 CONTACT_EMAIL = 문의 주소 · 로컬파트 support 는 에이전트에게 발급할 수 없다', () => {
    expect(CONTACT_EMAIL).toBe(CONTACT_ADDRESS);
    expect(RESERVED_LOCAL_PARTS).toContain('support');
  });
});

describe('전달 틀 — 영어(운영자의 메일 언어가 en 이거나 고르지 않았을 때)', () => {
  const document: ContactForwardDocument = {
    version: 1,
    sesMessageId: 'abc123',
    receivedAt: '2026-09-24T00:00:00.000Z',
    fromAddress: 'billing@xn--pypal-4ve.test',
    fromName: 'victim@bank.example',
    to: [CONTACT_ADDRESS],
    date: null,
    subject: null,
    text: '본문',
    textTruncated: false,
    textSource: 'plain',
    attachmentCount: 0,
    dmarc: 'fail',
  };

  it('같은 구조 · 머리 블록에 한글이 없다(원 본문은 그대로) · 경고 둘이 맨 위', () => {
    const en = CONTACT_FORWARD_COPY.en;
    const { subject, text } = renderContactForwardIn(document, 'en');
    expect(subject).toBe('[Atmark inquiry] (no subject)');
    const lines = text.split('\n');
    expect(lines[0]).toBe(en.dmarcWarning);
    expect(lines[2]).toBe(en.punycodeWarning);
    const head = text.slice(0, text.indexOf(en.bodySeparator));
    expect(head).not.toMatch(/[가-힣]/);
    expect(head).toContain(`${en.displayNameLabel}: victim@bank.example\n`);
    expect(text.slice(text.indexOf(en.bodySeparator))).toContain('본문');
  });
});
