/**
 * login-mailer 깨우기(`kickLoginMailer`) — outbox 에 행을 적을 수 있는 네 라우트가 **커밋 뒤에만**, **받아들인 요청마다** 부르는지. DB 없이
 * (`admin/session.ts` · `admin/ops/members.ts` 의 트랜잭션 함수를 가짜로 바꾼다 — 그 함수가 돌아왔다 = 트랜잭션이 커밋됐다).
 *
 *   - 로그인 · 가입 · 초대 claim: `accepted` 면 한 번(일치 여부와 무관 — 열거 방지), `rate_limited`(429)·`invalid`(401) 면 0번.
 *   - 초대: 초대 행이 커밋되면 한 번 · 연산이 던지면(409 등) 0번.
 *   - 트랜잭션이 끝나기 **전에는** 부르지 않는다(순서).
 *   - 깨우기가 던져도 응답은 같다(삼킨다 · 로그 한 줄 — 값 없음).
 *   - 의존성이 없으면(로컬·테스트) 부르지 않고 응답은 같다.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AdminCall, AdminDependencies, OwnerSession } from '../../../src/admin/context';
import { resetLogSink, setLogSink } from '../../../src/observability/logger';

const order: string[] = [];

vi.mock('../../../src/admin/session', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/admin/session')>();
  return {
    ...actual,
    requestLogin: vi.fn(),
    requestSignup: vi.fn(),
    verifySignup: vi.fn(),
    claimInvite: vi.fn(),
  };
});
vi.mock('../../../src/admin/ops/members', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/admin/ops/members')>();
  return { ...actual, inviteMemberOp: vi.fn() };
});

const session = await import('../../../src/admin/session');
const members = await import('../../../src/admin/ops/members');
const { handleLoginRequest } = await import('../../../src/admin/routes/session');
const { handleSignupRequest, handleSignupVerify } = await import('../../../src/admin/routes/signup');
const { handleClaimInvite, handleInviteMember } = await import('../../../src/admin/routes/members');
const { AdminInputError } = await import('../../../src/admin/ops/errors');

const NONCE = 'n'.repeat(43);
const OWNER: OwnerSession = { id: 's1', organizationId: 'o1', userId: 'u1', role: 'owner' };

/** 커밋이 끝난 뒤 결과를 돌려주는 가짜 트랜잭션 — 끝나는 순간을 `order` 에 적는다. */
function committed<T>(value: T): () => Promise<T> {
  return async () => {
    await Promise.resolve();
    order.push('commit');
    return value;
  };
}

function call(kick: (() => Promise<void>) | undefined, body: unknown, withSession = false): AdminCall {
  const deps = {
    pool: {} as never,
    loginKeys: {} as never,
    custody: () => {
      throw new Error('unused');
    },
    outboundContent: {} as never,
    now: () => new Date('2026-09-27T00:00:00Z'),
    ...(kick === undefined ? {} : { kickLoginMailer: kick }),
  } as AdminDependencies;
  return {
    deps,
    request: {
      method: 'POST',
      path: '/api/x',
      headers: {},
      query: {},
      body,
      cookies: {},
      sourceIp: '203.0.113.7',
      requestId: 'req-1',
    },
    params: {},
    session: withSession ? OWNER : null,
    sessionToken: null,
  };
}

let kicks: number;
const kick = (): Promise<void> => {
  kicks += 1;
  order.push('kick');
  return Promise.resolve();
};

beforeEach(() => {
  kicks = 0;
  order.length = 0;
  vi.mocked(session.requestLogin).mockReset();
  vi.mocked(session.requestSignup).mockReset();
  vi.mocked(session.verifySignup).mockReset();
  vi.mocked(session.claimInvite).mockReset();
  vi.mocked(members.inviteMemberOp).mockReset();
});
afterEach(() => resetLogSink());

describe('login-mailer 깨우기 — 커밋 뒤 · 받아들인 요청마다 · 상한에는 없다', () => {
  it('POST /api/login: accepted → 커밋 뒤 한 번 · 202 · rate_limited → 0번 · 429', async () => {
    vi.mocked(session.requestLogin).mockImplementationOnce(committed({ kind: 'accepted' as const, nonce: NONCE }));
    const accepted = await handleLoginRequest(call(kick, { email: 'someone@example.com' }));
    expect(accepted.status).toBe(202);
    expect(order).toEqual(['commit', 'kick']);

    vi.mocked(session.requestLogin).mockImplementationOnce(committed({ kind: 'rate_limited' as const }));
    const limited = await handleLoginRequest(call(kick, { email: 'someone@example.com' }));
    expect(limited.status).toBe(429);
    expect(kicks).toBe(1);
  });

  it('POST /api/login: 없는 주소·모양 아닌 입력도 accepted 면 똑같이 깨운다(열거 방지 — 응답·호출 수가 같다)', async () => {
    const responses = [];
    for (const email of ['owner@example.com', 'nobody@example.com', 42]) {
      vi.mocked(session.requestLogin).mockImplementationOnce(committed({ kind: 'accepted' as const, nonce: NONCE }));
      const response = await handleLoginRequest(call(kick, { email }));
      responses.push({ status: response.status, body: response.body });
    }
    expect(kicks).toBe(3);
    expect(new Set(responses.map((r) => JSON.stringify(r))).size).toBe(1);
  });

  it('POST /api/signup: accepted → 커밋 뒤 한 번 · rate_limited → 0번 · 모양 오류(400, 던짐) → 0번', async () => {
    vi.mocked(session.requestSignup).mockImplementationOnce(
      committed({ kind: 'accepted' as const, signupNonce: NONCE, loginNonce: NONCE }),
    );
    expect((await handleSignupRequest(call(kick, { email: 'a@example.com', organizationName: 'A', consent: true }))).status).toBe(202);
    expect(order).toEqual(['commit', 'kick']);

    vi.mocked(session.requestSignup).mockImplementationOnce(committed({ kind: 'rate_limited' as const }));
    expect((await handleSignupRequest(call(kick, { email: 'a@example.com', organizationName: 'A', consent: true }))).status).toBe(429);

    vi.mocked(session.requestSignup).mockRejectedValueOnce(new AdminInputError('x', 'invalid_email'));
    await expect(handleSignupRequest(call(kick, { email: 'bad', organizationName: 'A', consent: true }))).rejects.toThrow(AdminInputError);
    expect(kicks).toBe(1);
  });

  it('POST /api/signup: 환영 메일 언어(202609301510) — 본문 lang → 콘솔 언어 쿠키 → Accept-Language 순으로 requestSignup 에 넘긴다', async () => {
    const langs: string[] = [];
    vi.mocked(session.requestSignup).mockImplementation((_pool, _keys, input) => {
      langs.push(input.lang);
      return Promise.resolve({ kind: 'accepted' as const, signupNonce: NONCE, loginNonce: NONCE });
    });
    const body = { email: 'a@example.com', organizationName: 'A', consent: true };
    const withRequest = (b: unknown, headers: Record<string, string>, cookies: Record<string, string>): AdminCall => {
      const base = call(kick, b);
      return { ...base, request: { ...base.request, headers, cookies } };
    };
    await handleSignupRequest(withRequest({ ...body, lang: 'en' }, { 'accept-language': 'ko-KR' }, { '__Host-atmark_lang': 'ko' }));
    await handleSignupRequest(withRequest({ ...body, lang: 'ko' }, { 'accept-language': 'en-US' }, {}));
    await handleSignupRequest(withRequest(body, { 'accept-language': 'ko-KR' }, { '__Host-atmark_lang': 'en' }));
    await handleSignupRequest(withRequest({ ...body, lang: 'fr' }, { 'accept-language': 'en-US,ko;q=0.5' }, {}));
    await handleSignupRequest(withRequest(body, {}, {}));
    expect(langs).toEqual(['en', 'ko', 'en', 'en', 'ko']);
  });

  it('POST /api/signup/verify: 세션이 열리면(커밋 뒤) 한 번 — 새 가입의 환영 메일 행 · 거부(401)·상한(409·429) → 0번', async () => {
    const opened = {
      kind: 'session' as const,
      session: OWNER,
      token: 't'.repeat(43),
      csrf: 'c',
      next: 'app' as const,
    };
    vi.mocked(session.verifySignup).mockImplementationOnce(committed(opened));
    expect((await handleSignupVerify(call(kick, { token: 't' }))).status).toBe(200);
    expect(order).toEqual(['commit', 'kick']);
    for (const outcome of [{ kind: 'rejected' as const }, { kind: 'capacity' as const }, { kind: 'rate_limited' as const }, { kind: 'browser_missing' as const }]) {
      vi.mocked(session.verifySignup).mockImplementationOnce(committed(outcome));
      expect((await handleSignupVerify(call(kick, { token: 't' }))).status).toBeGreaterThanOrEqual(400);
    }
    expect(kicks).toBe(1);
  });

  it('POST /api/invites/claim: accepted → 커밋 뒤 한 번 · invalid(401)·rate_limited(429) → 0번', async () => {
    vi.mocked(session.claimInvite).mockImplementationOnce(committed({ kind: 'accepted' as const, nonce: NONCE }));
    expect((await handleClaimInvite(call(kick, { token: 't' }))).status).toBe(202);
    expect(order).toEqual(['commit', 'kick']);

    vi.mocked(session.claimInvite).mockImplementationOnce(committed({ kind: 'invalid' as const }));
    expect((await handleClaimInvite(call(kick, { token: 't' }))).status).toBe(401);
    vi.mocked(session.claimInvite).mockImplementationOnce(committed({ kind: 'rate_limited' as const }));
    expect((await handleClaimInvite(call(kick, { token: 't' }))).status).toBe(429);
    expect(kicks).toBe(1);
  });

  it('POST /api/members/invites: 초대 행 커밋 뒤 한 번 · 201 · 연산이 던지면(409) 0번', async () => {
    const invite = {
      id: 'i1',
      email: 'new@example.com',
      erased: false,
      role: 'member' as const,
      createdAt: '2026-09-27T00:00:00.000Z',
      expiresAt: '2026-10-04T00:00:00.000Z',
      status: 'pending' as const,
    };
    vi.mocked(members.inviteMemberOp).mockImplementationOnce(committed(invite));
    expect((await handleInviteMember(call(kick, { email: 'new@example.com', role: 'member' }, true))).status).toBe(201);
    expect(order).toEqual(['commit', 'kick']);

    vi.mocked(members.inviteMemberOp).mockRejectedValueOnce(new AdminInputError('x', 'invite_limit', 409));
    await expect(handleInviteMember(call(kick, { email: 'new@example.com', role: 'member' }, true))).rejects.toThrow(AdminInputError);
    expect(kicks).toBe(1);
  });

  it('깨우기가 던져도 요청은 성공하고 응답은 같다 — 로그 한 줄(결말·오류 종류만, 주소 없음)', async () => {
    const lines: string[] = [];
    setLogSink((line) => lines.push(line));
    vi.mocked(session.requestLogin).mockImplementation(committed({ kind: 'accepted' as const, nonce: NONCE }));
    const ok = await handleLoginRequest(call(kick, { email: 'someone@example.com' }));
    const failing = await handleLoginRequest(
      call(() => Promise.reject(new Error('someone@example.com boom')), { email: 'someone@example.com' }),
    );
    expect(failing.status).toBe(ok.status);
    expect(failing.body).toBe(ok.body);
    const logged = lines.filter((line) => line.includes('"runtime.login_mailer_kick"'));
    expect(logged).toHaveLength(1);
    expect(logged[0]).toContain('"outcome":"failed"');
    expect(lines.join('\n')).not.toContain('someone@example.com');
  });

  it('의존성이 없으면(로컬·테스트) 부르지 않고 응답은 같다', async () => {
    vi.mocked(session.requestLogin).mockImplementation(committed({ kind: 'accepted' as const, nonce: NONCE }));
    const without = await handleLoginRequest(call(undefined, { email: 'someone@example.com' }));
    expect(without.status).toBe(202);
    expect(order).toEqual(['commit']);
  });
});
