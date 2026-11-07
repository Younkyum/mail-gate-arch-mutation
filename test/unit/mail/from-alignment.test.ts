/**
 * `src/mail/events/from-alignment.ts` — SES 이벤트의 **헤더 From 대 발신 주소**(2026-09-24 최종 검증 M3b).
 *
 * 되돌리면 빨개져야 하는 것:
 *   - 헤더 From 의 주소가 발신 주소(`mail.source`)와 다르면 `mismatch` — raw MIME 의 From 을 바꿔 보낸 메일.
 *   - 헤더 From 에 예약 주소(login@·support@)가 있는데 발신 주소가 그 예약 주소가 아니면 `reserved` — 표시 이름 사칭·공백/제어문자
 *     변형 포함. login-mailer·contact-forwarder 의 정상 메일(발신 = 예약 주소 자신)은 `aligned`.
 *   - 예약 주소 목록이 런타임 상수와 같다.
 */

import { describe, expect, it } from 'vitest';

import { CONTACT_ADDRESS } from '../../../src/contact/intake';
import { checkFromAlignment, RESERVED_FROM_ADDRESSES } from '../../../src/mail/events/from-alignment';
import { sesEventFromAlignment } from '../../../src/mail/events/ses-event';
import { OWNER_LOGIN_FROM_ADDRESS } from '../../../src/notify/owner-login-notifier';

/** 환영 메일 발신 — CDK `WELCOME_MAIL_FROM_ADDRESS` 와 같은 값(`compute-stack.test.ts` 가 CDK 쪽 일치를 본다). */
const WELCOME_MAIL_FROM_ADDRESS = 'onve@atmark.ai';

const mail = (source: unknown, from: unknown): unknown => ({ source, commonHeaders: from === undefined ? {} : { from } });

describe('checkFromAlignment (M3b)', () => {
  it('예약 주소 목록 = 런타임 상수(로그인 발신 · 문의 주소 · 환영 메일 발신 onve@ — ADR-0006 2026-09-30 개정)', () => {
    expect([...RESERVED_FROM_ADDRESSES].sort()).toEqual([OWNER_LOGIN_FROM_ADDRESS, CONTACT_ADDRESS, WELCOME_MAIL_FROM_ADDRESS].sort());
  });

  it('onve@ — login-mailer·지원 에이전트의 정상 메일(발신 = 헤더)은 aligned · 다른 발신 주소의 헤더·표시 이름에 onve@ 가 있으면 reserved', () => {
    expect(checkFromAlignment(mail('onve@atmark.ai', ['onve@atmark.ai']))).toBe('aligned');
    expect(checkFromAlignment(mail('agent@atmark.ai', ['"onve@atmark.ai" <agent@atmark.ai>']))).toBe('reserved');
    expect(checkFromAlignment(mail('agent@atmark.ai', ['onve@atmark.ai']))).toBe('reserved');
    // 예약 주소로 끝나는 에이전트 주소는 예약 주소가 아니다(앞 글자가 로컬파트 글자).
    expect(checkFromAlignment(mail('xonve@atmark.ai', ['xonve@atmark.ai']))).toBe('aligned');
  });

  it('정상: 에이전트·알림·로그인·문의 전달 — 헤더 From = 발신 주소', () => {
    expect(checkFromAlignment(mail('agent@atmark.ai', ['agent@atmark.ai']))).toBe('aligned');
    expect(checkFromAlignment(mail('notify@atmark.ai', ['notify@atmark.ai']))).toBe('aligned');
    expect(checkFromAlignment(mail('login@atmark.ai', ['login@atmark.ai']))).toBe('aligned');
    expect(checkFromAlignment(mail('support@atmark.ai', ['support@atmark.ai']))).toBe('aligned');
    // 대소문자·꺾쇠만 다른 같은 주소는 같다.
    expect(checkFromAlignment(mail('agent@atmark.ai', ['<Agent@atmark.ai>']))).toBe('aligned');
    // 예약 로컬파트로 **끝나는** 에이전트 주소는 예약 주소가 아니다.
    expect(checkFromAlignment(mail('xlogin@atmark.ai', ['xlogin@atmark.ai']))).toBe('aligned');
    expect(checkFromAlignment(mail('my.support@atmark.ai', ['my.support@atmark.ai']))).toBe('aligned');
  });

  it('mismatch: 헤더 From 의 주소가 다르다 · 둘이다 · 문자열이 아니다', () => {
    expect(checkFromAlignment(mail('agent@atmark.ai', ['other@atmark.ai']))).toBe('mismatch');
    expect(checkFromAlignment(mail('agent@atmark.ai', ['agent@atmark.ai', 'b@atmark.ai']))).toBe('mismatch');
    expect(checkFromAlignment(mail('agent@atmark.ai', [42]))).toBe('mismatch');
    expect(checkFromAlignment(mail('agent@atmark.ai', ['Bank <ceo@bank.example>']))).toBe('mismatch');
  });

  it('reserved: 예약 주소를 헤더 From 에 싣되 발신 주소가 그 주소가 아니다 — 맨 주소·표시 이름·공백/제어/보이지 않는 문자 변형', () => {
    for (const from of [
      'login@atmark.ai',
      'LOGIN@atmark.ai',
      '"login@atmark.ai" <agent@atmark.ai>',
      'Atmark <support@atmark.ai>',
      '\tlogin@atmark.ai',
      'lo\u000bgin@atmark.ai',
      'log­in@atmark.ai',
      'sup​port@atmark.ai',
    ]) {
      expect(checkFromAlignment(mail('agent@atmark.ai', [from])), JSON.stringify(from)).toBe('reserved');
    }
    // 발신 주소가 예약 주소의 변형이면(정확히 그 주소가 아니면) 정상 주체가 아니다.
    expect(checkFromAlignment(mail('LOGIN@atmark.ai', ['LOGIN@atmark.ai']))).toBe('reserved');
    expect(checkFromAlignment(mail('\tlogin@atmark.ai', ['login@atmark.ai']))).toBe('reserved');
    // login-mailer 가 support@ 를 헤더에 싣는 것도 어긋남이다.
    expect(checkFromAlignment(mail('login@atmark.ai', ['support@atmark.ai']))).toBe('reserved');
  });

  it('unknown: source 나 commonHeaders.from 이 없다 — 판정하지 않는다', () => {
    expect(checkFromAlignment(undefined)).toBe('unknown');
    expect(checkFromAlignment(mail(undefined, ['a@atmark.ai']))).toBe('unknown');
    expect(checkFromAlignment(mail('a@atmark.ai', undefined))).toBe('unknown');
    expect(checkFromAlignment(mail('a@atmark.ai', []))).toBe('unknown');
  });

  it('sesEventFromAlignment: SNS 봉투 안의 본문에서 mail 을 꺼내 판정한다 · 깨진 본문은 unknown', () => {
    const body = JSON.stringify({ eventType: 'Send', mail: mail('agent@atmark.ai', ['login@atmark.ai']) });
    expect(sesEventFromAlignment(JSON.stringify({ Type: 'Notification', Message: body }))).toBe('reserved');
    expect(sesEventFromAlignment(body)).toBe('reserved');
    expect(sesEventFromAlignment('not json')).toBe('unknown');
    expect(sesEventFromAlignment(JSON.stringify({ Type: 'Notification', Message: 'not json' }))).toBe('unknown');
  });
});
