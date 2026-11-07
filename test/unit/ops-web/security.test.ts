/**
 * 운영자 웹 화면(`pnpm admin:web`) 요청 검문 — 순수 함수.
 *
 * 되돌리면 빨개져야 하는 것:
 *   - 비밀은 32바이트 base64url(43자) · 매번 다르다.
 *   - Host 는 정확히 `127.0.0.1:<포트>` 하나 — `localhost` · 다른 이름(DNS rebinding) · 다른 포트 · 없음은 403.
 *   - Origin 이 있으면 같은 오리진만 · `Sec-Fetch-Site: cross-site` 는 403 · `none` 은 페이지 탐색에서만.
 *   - `/api/*` 는 예외 없이 `x-ops-token`(없음·틀림 401 — 쿠키는 보지 않는다) · POST 는 Origin 필수 · 정적 페이지는 토큰 없이 GET 만.
 *   - 부트스트랩 토큰은 한 번만 — 틀림·재사용·만료를 구분해 돌려준다(서버가 탈취 신호로 닫는다).
 *   - 세션 타이머: 유휴(마지막 요청 뒤)와 절대 수명 중 먼저 오는 것 하나로 한 번 닫는다.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  allowedHost,
  BIND_HOST,
  BootstrapToken,
  checkAuth,
  checkOrigin,
  randomSecret,
  safeEqual,
  SessionTimer,
  TOKEN_HEADER,
  type RequestFacts,
} from '../../../scripts/ops-web/security';

const PORT = 43123;
const TOKEN = randomSecret();
const HOST = `127.0.0.1:${String(PORT)}`;

function facts(overrides: Partial<RequestFacts> = {}): RequestFacts {
  return { method: 'GET', path: '/api/orgs', host: HOST, origin: undefined, secFetchSite: 'same-origin', token: TOKEN, ...overrides };
}

describe('비밀', () => {
  it('32바이트 base64url · 매번 다르다', () => {
    const a = randomSecret();
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(a, 'base64url')).toHaveLength(32);
    expect(a).not.toBe(randomSecret());
  });

  it('safeEqual — 같을 때만 참(길이가 달라도 예외 없이 거짓)', () => {
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abd')).toBe(false);
    expect(safeEqual('abc', 'abcd')).toBe(false);
  });

  it('바인드는 IPv4 루프백 하나 · 받는 Host 도 그것 하나 · 토큰 헤더 이름', () => {
    expect(BIND_HOST).toBe('127.0.0.1');
    expect(allowedHost(PORT)).toBe(HOST);
    expect(TOKEN_HEADER).toBe('x-ops-token');
  });
});

describe('checkOrigin — Host · Origin · Sec-Fetch-Site', () => {
  it('허용: 127.0.0.1:포트 · 같은 오리진', () => {
    expect(checkOrigin(facts(), PORT, false)).toEqual({ ok: true });
    expect(checkOrigin(facts({ origin: `http://${HOST}` }), PORT, false)).toEqual({ ok: true });
  });

  it.each([
    ['localhost', `localhost:${String(PORT)}`],
    ['DNS rebinding(공격자 이름)', `evil.example:${String(PORT)}`],
    ['다른 포트', `127.0.0.1:${String(PORT + 1)}`],
    ['포트 없음', '127.0.0.1'],
    ['IPv6', `[::1]:${String(PORT)}`],
    ['없음', undefined],
  ])('거부: %s', (_label, host) => {
    expect(checkOrigin(facts({ host }), PORT, false)).toEqual({ ok: false, status: 403, code: 'bad_host' });
  });

  it('Origin 이 다르면 403(다른 사이트 · 다른 포트 · localhost · null)', () => {
    for (const origin of ['http://evil.example', `http://127.0.0.1:${String(PORT + 1)}`, `http://localhost:${String(PORT)}`, 'null']) {
      expect(checkOrigin(facts({ origin }), PORT, false)).toEqual({ ok: false, status: 403, code: 'bad_origin' });
    }
  });

  it('Sec-Fetch-Site: cross-site·same-site 는 403 · none 은 페이지 탐색에서만', () => {
    expect(checkOrigin(facts({ secFetchSite: 'cross-site' }), PORT, true)).toMatchObject({ ok: false, code: 'cross_site' });
    expect(checkOrigin(facts({ secFetchSite: 'same-site' }), PORT, false)).toMatchObject({ ok: false, code: 'cross_site' });
    expect(checkOrigin(facts({ secFetchSite: 'none' }), PORT, false)).toMatchObject({ ok: false, code: 'cross_site' });
    expect(checkOrigin(facts({ secFetchSite: 'none', path: '/' }), PORT, true)).toEqual({ ok: true });
  });
});

describe('checkAuth — 세션 토큰 헤더(앰비언트 자격 증명 0)', () => {
  it('/api/* 는 토큰 없음·틀림 401 — /api/session 도 예외 없다', () => {
    expect(checkAuth(facts(), TOKEN)).toEqual({ ok: true });
    for (const path of ['/api/orgs', '/api/session']) {
      expect(checkAuth(facts({ path, token: undefined }), TOKEN)).toEqual({ ok: false, status: 401, code: 'unauthenticated' });
      expect(checkAuth(facts({ path, token: randomSecret() }), TOKEN)).toEqual({ ok: false, status: 401, code: 'unauthenticated' });
    }
  });

  it('POST 는 Origin 필수 · 그 밖의 메서드는 405', () => {
    expect(checkAuth(facts({ method: 'POST' }), TOKEN)).toEqual({ ok: false, status: 403, code: 'origin_required' });
    expect(checkAuth(facts({ method: 'POST', origin: `http://${HOST}` }), TOKEN)).toEqual({ ok: true });
    for (const method of ['PUT', 'DELETE', 'PATCH', 'OPTIONS']) expect(checkAuth(facts({ method }), TOKEN)).toMatchObject({ status: 405 });
  });

  it('정적 페이지는 토큰 없이 GET 만(데이터 없음)', () => {
    expect(checkAuth(facts({ path: '/', token: undefined }), TOKEN)).toEqual({ ok: true });
    expect(checkAuth(facts({ path: '/', method: 'POST', token: undefined }), TOKEN)).toMatchObject({ status: 405 });
  });
});

describe('부트스트랩 토큰', () => {
  it('한 번만 · 틀림/재사용/만료를 구분한다', () => {
    const value = randomSecret();
    const token = new BootstrapToken(value, 1_000, 60_000);
    expect(token.consume(null, 1_000)).toBe('mismatch');
    expect(token.consume(randomSecret(), 1_000)).toBe('mismatch');
    expect(token.consume(value, 2_000)).toBe('ok');
    expect(token.used).toBe(true);
    expect(token.consume(value, 2_000)).toBe('used');
    expect(new BootstrapToken(value, 1_000, 60_000).consume(value, 61_001)).toBe('expired');
  });
});

describe('세션 타이머', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('유휴 — 마지막 요청 뒤 idle 만큼 지나면 한 번 닫는다 · 요청이 오면 미뤄진다', () => {
    vi.useFakeTimers();
    const onEnd = vi.fn();
    const timer = new SessionTimer(30 * 60_000, 8 * 3_600_000, onEnd, () => Date.now());
    timer.start();
    vi.advanceTimersByTime(20 * 60_000);
    timer.touch();
    vi.advanceTimersByTime(20 * 60_000);
    expect(onEnd).not.toHaveBeenCalled();
    expect(timer.remaining()).toBe(10 * 60_000);
    vi.advanceTimersByTime(10 * 60_000);
    expect(onEnd).toHaveBeenCalledWith('idle');
    vi.advanceTimersByTime(10 * 3_600_000);
    expect(onEnd).toHaveBeenCalledTimes(1);
  });

  it('절대 수명 — 요청이 계속 와도 max 가 지나면 닫는다', () => {
    vi.useFakeTimers();
    const onEnd = vi.fn();
    const timer = new SessionTimer(30 * 60_000, 2 * 3_600_000, onEnd, () => Date.now());
    timer.start();
    for (let i = 0; i < 12; i += 1) {
      vi.advanceTimersByTime(10 * 60_000);
      timer.touch();
    }
    expect(onEnd).toHaveBeenCalledTimes(1);
    expect(onEnd).toHaveBeenCalledWith('lifetime');
  });

  it('stop 뒤에는 닫지 않는다', () => {
    vi.useFakeTimers();
    const onEnd = vi.fn();
    const timer = new SessionTimer(1000, 5000, onEnd, () => Date.now());
    timer.start();
    timer.stop();
    vi.advanceTimersByTime(10_000);
    expect(onEnd).not.toHaveBeenCalled();
  });
});
