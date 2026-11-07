/**
 * 시스템 메일 문구 사전 — **모든 템플릿이 지원하는 모든 언어의 같은 키를 가진다**(콘솔 사전 `admin-i18n.test.ts` 의 ⓘ-1 과 같은 단언).
 *
 * 문구 작성자는 `src/notify/*-template.ts` 의 `…_COPY.<locale>` 만 고친다. 한 언어에만 키가 생기거나 빠지면(새 문단 · 지운 안내) 다른 언어의 메일이
 * 조용히 그 문장을 잃는다 — 여기서 빨개진다. 함수 값(보간 문구)은 키 집합을 같게, 깊이를 따라 내려가 본다. 등록부(`src/i18n/locales.ts`)의 언어가
 * 사전마다 정확히 있는지도 본다 — 언어를 하나 더하면 모든 사전이 그 언어를 채울 때까지 빨갛다.
 */

import { describe, expect, it } from 'vitest';

import { RISK_COPY, RISK_REASON_COPY } from '../../../src/approval/risk-copy';
import { DEFAULT_MAIL_LOCALE, isMailLocale, MAIL_LOCALE_LABELS, resolveMailLocale, SUPPORTED_MAIL_LOCALES } from '../../../src/i18n/locales';
import { APPROVAL_NOTIFICATION_COPY } from '../../../src/notify/approval-notification-template';
import { CONTACT_FORWARD_COPY, CONTACT_NOTIFY_COPY } from '../../../src/notify/contact-forward-template';
import { DOMAIN_NOTICE_COPY } from '../../../src/notify/domain-notice-template';
import { INVITE_COPY } from '../../../src/notify/invite-template';
import { OPS_ACTION_LABELS, OPS_CODE_COPY } from '../../../src/notify/ops-code-template';
import { OWNER_LOGIN_COPY } from '../../../src/notify/owner-login-template';
import { QUARANTINE_NOTICE_COPY } from '../../../src/notify/quarantine-notice-template';
import { SIGNUP_COPY } from '../../../src/notify/signup-template';
import { WAITLIST_COPY, WAITLIST_NOT_FOR_URLS, WAITLIST_SIGNUP_URLS } from '../../../src/notify/waitlist-template';
import { WELCOME_COPY } from '../../../src/notify/welcome-template';

/** 사전 하나의 모양 — 키 경로 집합(객체는 내려가고, 배열 · 문자열 · 함수는 잎). */
function shape(value: unknown, prefix = ''): string[] {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return [prefix];
  return Object.keys(value)
    .sort()
    .flatMap((key) => shape((value as Record<string, unknown>)[key], prefix === '' ? key : `${prefix}.${key}`));
}

/** 잎의 종류(문자열 · 배열 · 함수)도 언어마다 같아야 한다 — 한쪽만 함수면 보간 자리가 어긋난다. */
function kinds(value: unknown, prefix = ''): string[] {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return [`${prefix}:${Array.isArray(value) ? 'array' : typeof value}`];
  return Object.keys(value)
    .sort()
    .flatMap((key) => kinds((value as Record<string, unknown>)[key], prefix === '' ? key : `${prefix}.${key}`));
}

const DICTIONARIES: ReadonlyArray<readonly [string, Readonly<Record<string, unknown>>]> = [
  ['OWNER_LOGIN_COPY', OWNER_LOGIN_COPY],
  ['SIGNUP_COPY', SIGNUP_COPY],
  ['INVITE_COPY', INVITE_COPY],
  ['OPS_CODE_COPY', OPS_CODE_COPY],
  ['WAITLIST_COPY', WAITLIST_COPY],
  ['WAITLIST_SIGNUP_URLS', WAITLIST_SIGNUP_URLS],
  ['WAITLIST_NOT_FOR_URLS', WAITLIST_NOT_FOR_URLS],
  ['WELCOME_COPY', WELCOME_COPY],
  ['DOMAIN_NOTICE_COPY', DOMAIN_NOTICE_COPY],
  ['QUARANTINE_NOTICE_COPY', QUARANTINE_NOTICE_COPY],
  ['APPROVAL_NOTIFICATION_COPY', APPROVAL_NOTIFICATION_COPY],
  ['RISK_COPY', RISK_COPY],
  ['CONTACT_FORWARD_COPY', CONTACT_FORWARD_COPY],
  ['CONTACT_NOTIFY_COPY', CONTACT_NOTIFY_COPY],
  ['MAIL_LOCALE_LABELS', MAIL_LOCALE_LABELS],
];

describe('메일 언어 등록부', () => {
  it('지원 언어 = en · ko · 기본값 en · 모르는 값은 건너뛰고 기본값으로', () => {
    expect([...SUPPORTED_MAIL_LOCALES].sort()).toEqual(['en', 'ko']);
    expect(DEFAULT_MAIL_LOCALE).toBe('en');
    expect(resolveMailLocale(null, undefined, 'fr', 'ko')).toBe('ko');
    expect(resolveMailLocale('ko', 'en')).toBe('ko');
    expect(resolveMailLocale()).toBe('en');
    expect(resolveMailLocale('KO', 'toString', '__proto__')).toBe('en');
    expect(isMailLocale('en')).toBe(true);
    expect(isMailLocale('constructor')).toBe(false);
  });
});

describe.each(DICTIONARIES)('%s — 지원 언어마다 같은 모양', (_name, dictionary) => {
  it('언어 키 = 등록부의 언어(빠짐 · 남는 언어 없음)', () => {
    expect(Object.keys(dictionary).sort()).toEqual([...SUPPORTED_MAIL_LOCALES].sort());
  });

  it('키 경로 집합과 잎의 종류가 언어마다 같다(기본 언어 기준)', () => {
    const base = dictionary[DEFAULT_MAIL_LOCALE];
    for (const locale of SUPPORTED_MAIL_LOCALES) {
      expect(shape(dictionary[locale]), `${_name}.${locale}`).toEqual(shape(base));
      expect(kinds(dictionary[locale]), `${_name}.${locale}`).toEqual(kinds(base));
    }
  });
});

describe('언어별 값이 사전 밖 표에 있는 것 — 행마다 지원 언어가 다 있다', () => {
  it.each([
    ['OPS_ACTION_LABELS', OPS_ACTION_LABELS],
    ['RISK_REASON_COPY', RISK_REASON_COPY],
  ] as const)('%s', (_name, table) => {
    for (const row of Object.values(table)) expect(Object.keys(row).sort()).toEqual([...SUPPORTED_MAIL_LOCALES].sort());
  });
});

describe('영어 사전에 한글이 없다(문자열 잎)', () => {
  function strings(value: unknown): string[] {
    if (typeof value === 'string') return [value];
    if (Array.isArray(value)) return value.flatMap(strings);
    if (value !== null && typeof value === 'object') return Object.values(value).flatMap(strings);
    return [];
  }
  it.each(DICTIONARIES.filter(([name]) => name !== 'MAIL_LOCALE_LABELS'))('%s.en', (_name, dictionary) => {
    expect(strings(dictionary['en']).filter((text) => /[가-힣]/.test(text))).toEqual([]);
  });
});

/**
 * 곧은 따옴표만(2026-10-10 5차) — 문구 사전에 둥근 따옴표(’ “ ”)가 없다. 함수 잎(보간 문구)은 원문을 본다(함수 본문 글자).
 * 메일 앱마다 둥근 따옴표 글꼴이 달라 같은 메일에서 두 모양이 섞여 보인다.
 */
describe('문구 사전에 둥근 따옴표가 없다', () => {
  function leaves(value: unknown): string[] {
    if (typeof value === 'string') return [value];
    if (typeof value === 'function') return [String(value)];
    if (Array.isArray(value)) return value.flatMap(leaves);
    if (value !== null && typeof value === 'object') return Object.values(value).flatMap(leaves);
    return [];
  }
  it.each(DICTIONARIES)('%s', (_name, dictionary) => {
    expect(leaves(dictionary).filter((text) => /[’“”]/.test(text))).toEqual([]);
  });
  it('위험 사유 문구(확인 페이지와 함께 쓴다)도', () => {
    expect(leaves(RISK_REASON_COPY).filter((text) => /[’“”]/.test(text))).toEqual([]);
  });
});
