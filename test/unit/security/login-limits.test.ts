/**
 * 콘솔 로그인 코드 상한(`src/security/login-limits.ts` — 2026-10-10 잠금 DoS 수정) — 숫자와 그 사이의 불변식. DB 없음.
 * 실제 집행(다른 IP 의 실패가 피해자를 막지 않는다 · 코드 5회 · 발급 상한 · 같은 응답)은 `test/integration/admin/login-code.test.ts`.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import * as session from '../../../src/admin/session';
import { LOGIN_CODE_DIGITS, LOGIN_CODE_MAX_FAILURES as FROM_LOGIN_CODE } from '../../../src/security/login-code';
import * as limits from '../../../src/security/login-limits';

const ROOT = join(__dirname, '../../..');

describe('로그인 코드 상한 — 한 곳의 숫자', () => {
  it('정한 숫자(런북 deploy §48 표와 같다)', () => {
    expect({
      perCode: limits.LOGIN_CODE_MAX_FAILURES,
      ipIssuance: [limits.LOGIN_REQUESTS_PER_CLIENT, limits.LOGIN_REQUEST_WINDOW_MS],
      ipFailures: [limits.LOGIN_CODE_FAILURES_PER_CLIENT, limits.LOGIN_CODE_FAILURE_WINDOW_MS],
      emailIpHourly: limits.LOGIN_LINKS_PER_CLIENT_PER_USER_PER_HOUR,
      emailWindow: [limits.LOGIN_LINKS_PER_USER_PER_WINDOW, limits.LOGIN_LINK_USER_WINDOW_MS],
      emailDaily: limits.LOGIN_LINKS_PER_USER_PER_DAY,
      untrustedWindow: limits.LOGIN_UNTRUSTED_LINKS_PER_USER_PER_WINDOW,
      untrustedDaily: limits.LOGIN_UNTRUSTED_LINKS_PER_USER_PER_DAY,
      signupLinksDaily: limits.SIGNUP_LINKS_PER_EMAIL_PER_DAY,
      trustedDays: limits.LOGIN_TRUSTED_REQUESTER_DAYS,
    }).toEqual({
      perCode: 5,
      ipIssuance: [10, 60 * 60 * 1000],
      ipFailures: [30, 60 * 60 * 1000],
      emailIpHourly: 3,
      emailWindow: [5, 15 * 60 * 1000],
      emailDaily: 50,
      untrustedWindow: 2,
      untrustedDaily: 4,
      signupLinksDaily: 4,
      trustedDays: 30,
    });
  });

  it('login-code 는 같은 실패 상한을 되내보낸다(사본이 없다)', () => {
    expect(FROM_LOGIN_CODE).toBe(limits.LOGIN_CODE_MAX_FAILURES);
  });

  it('계정 단위 틀린 코드 예산은 없다 — 다른 IP 의 실패로 잠기는 상수 · 문장이 돌아오지 않는다', () => {
    expect(Object.keys(session)).not.toContain('LOGIN_CODE_USER_DAILY_FAILURES');
    expect(Object.keys(session)).not.toContain('SIGNUP_CODE_EMAIL_DAILY_FAILURES');
    const source = readFileSync(join(ROOT, 'src/admin/session.ts'), 'utf8');
    expect(source).not.toMatch(/sum\(\w+\.code_failures\)/);
  });

  it('불변식 — 신뢰 밖 대입 바닥: 주소당 하루 ≤ 20번(코드 4통 × 5회 · 성공 확률 ≤ 2 × 10^-5) · 가입도 20 · 짧은 창 ≤ 하루 · 신뢰 IP 몫 ≥ 신뢰 밖 몫', () => {
    const untrustedGuesses = limits.LOGIN_UNTRUSTED_LINKS_PER_USER_PER_DAY * limits.LOGIN_CODE_MAX_FAILURES;
    expect(untrustedGuesses).toBeLessThanOrEqual(20);
    expect(untrustedGuesses / 10 ** LOGIN_CODE_DIGITS).toBeLessThanOrEqual(2e-5);
    expect(limits.SIGNUP_LINKS_PER_EMAIL_PER_DAY * limits.LOGIN_CODE_MAX_FAILURES).toBeLessThanOrEqual(20);
    expect(limits.LOGIN_UNTRUSTED_LINKS_PER_USER_PER_WINDOW).toBeLessThanOrEqual(limits.LOGIN_UNTRUSTED_LINKS_PER_USER_PER_DAY);
    expect(limits.LOGIN_LINKS_PER_USER_PER_WINDOW).toBeLessThanOrEqual(limits.LOGIN_LINKS_PER_USER_PER_DAY);
    expect(limits.LOGIN_LINKS_PER_USER_PER_WINDOW).toBeGreaterThanOrEqual(limits.LOGIN_UNTRUSTED_LINKS_PER_USER_PER_WINDOW);
    expect(limits.LOGIN_LINKS_PER_USER_PER_DAY).toBeGreaterThanOrEqual(limits.LOGIN_UNTRUSTED_LINKS_PER_USER_PER_DAY);
    expect(limits.LOGIN_CODE_FAILURES_PER_CLIENT).toBeGreaterThanOrEqual(limits.LOGIN_LINKS_PER_CLIENT_PER_USER_PER_HOUR * limits.LOGIN_CODE_MAX_FAILURES);
  });
});
