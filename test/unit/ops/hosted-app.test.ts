/**
 * 호스팅 ops 라우터 — 가짜 DB 로 문장 순서를 본다(W-APP 수락 기준, `.omc/plans/ops-console.md` §4 P1).
 *   - Host 421 · 출처 · CSRF 는 DB 호출 0 · 첫 DB 문장은 `ops_session_touch`
 *   - 확인 입력이 틀리면 definer 호출 0 · 422
 *   - step-up 이 없으면 403 · 실패 기록은 ROLLBACK 뒤(별도 트랜잭션)
 *   - 42P01 · 권한 없음 → 503 `ops_unavailable` · 콘솔 닫힘 → 503 `ops_disabled`
 *   - P1 에 요금제 · 동결 · 정지 쓰기 라우트가 없다
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { resetLogSink, setLogSink } from '../../../src/observability/logger';
import { OPS_COOKIES } from '../../../src/ops/contract';
import { buildOpsPage, HOSTED_PAGE_CONFIG } from '../../../src/ops/console/page';
import { INTERNAL_MESSAGE, mapDbError } from '../../../src/ops/hosted/backend';
import { activationGrantOf, rejectOutcomeOf } from '../../../src/ops/review-shape';
import { handleOpsRequest } from '../../../src/ops/hosted/app';
import type { OpsHttpResult } from '../../../src/ops/hosted/http';
import { sessionHash } from '../../../src/ops/hosted/keys';
import { deps, event, fakePool, keys, ME, NONCE, OPERATOR, ORG, TOKEN, TOUCH_OK, type Responder } from './hosted-support';

const ORG_NAME: Responder = { match: /SELECT name FROM organizations WHERE id/, rows: [{ name: 'Acme 조직' }] };
const lines: string[] = [];

beforeEach(() => {
  lines.length = 0;
  setLogSink((line) => lines.push(line));
});
afterEach(() => resetLogSink());

const json = (result: OpsHttpResult): Record<string, unknown> => JSON.parse(result.body) as Record<string, unknown>;
const definers = (sql: readonly string[]): string[] => sql.filter((s) => /ops_(org_|decide|revoke_operator|record_failure|request_stepup)/.test(s));
const metrics = (): string[] => lines.filter((l) => l.includes('"_aws"')).map((l) => Object.keys(JSON.parse(l) as object).find((k) => k.startsWith('atmark.ops.')) ?? '');

describe('입구 — Host · 출처 · 페이지', () => {
  it('execute-api Host 는 421 · DB 호출 0', async () => {
    const fake = fakePool([TOUCH_OK]);
    const result = await handleOpsRequest(deps(fake), event({ path: '/api/dashboard', host: 'x1.execute-api.ap-northeast-2.amazonaws.com' }));
    expect(result.statusCode).toBe(421);
    expect(fake.sql).toEqual([]);
  });

  it('GET / — 해시 CSP · trusted types · no-store · 데이터 없음 · DB 호출 0', async () => {
    const fake = fakePool([]);
    const result = await handleOpsRequest(deps(fake), event({ path: '/', site: 'none', cookies: {} }));
    const built = buildOpsPage(HOSTED_PAGE_CONFIG);
    expect(result.statusCode).toBe(200);
    expect(result.body).toBe(built.html);
    expect(result.headers['content-security-policy']).toBe(built.csp);
    expect(built.csp).toMatch(/script-src 'sha256-[A-Za-z0-9+/=]+'/);
    expect(built.csp).toContain("require-trusted-types-for 'script'");
    expect(result.headers['cache-control']).toBe('no-store');
    expect(fake.sql).toEqual([]);
  });

  it('교차 출처 POST 는 403 · DB 호출 0', async () => {
    const fake = fakePool([TOUCH_OK]);
    const result = await handleOpsRequest(deps(fake), event({ path: `/api/orgs/${ORG}/review`, body: { decision: 'activate' }, origin: 'https://evil.example' }));
    expect(result.statusCode).toBe(403);
    expect(fake.sql).toEqual([]);
  });
});

describe('로그인 — 코드 요청 · 검증', () => {
  it('요청은 늘 202 · 논스 쿠키 · 모양이 틀린 주소는 DB 에 가지 않는다', async () => {
    const fake = fakePool([]);
    const kicks = { n: 0 };
    const bad = await handleOpsRequest(deps(fake, kicks), event({ path: '/api/auth/request', body: { email: 'not-an-email' }, cookies: {}, csrf: null }));
    expect(bad.statusCode).toBe(202);
    expect(fake.sql).toEqual([]);
    expect(kicks.n).toBe(0);
    const good = await handleOpsRequest(deps(fake, kicks), event({ path: '/api/auth/request', body: { email: ' Jin@Example.com ' }, cookies: {}, csrf: null }));
    expect(good.statusCode).toBe(202);
    expect(json(good)).toEqual(json(bad));
    expect(fake.sql).toEqual(['SELECT ops_request_code($1, $2, $3, $4)']);
    const [email, binding, client, lang] = fake.params[0] as string[];
    expect(email).toBe('jin@example.com');
    expect(binding).toMatch(/^[0-9a-f]{64}$/);
    expect(client).toBe(keys.clientKey('203.0.113.7'));
    expect(lang).toBe('ko');
    expect(kicks.n).toBe(1);
    expect(good.cookies?.[0]).toMatch(/^__Host-atmark_ops_login=[A-Za-z0-9_-]{43}; Path=\/; HttpOnly; Secure; SameSite=Strict; Max-Age=600$/);
    expect(metrics()).toContain('atmark.ops.code_requested');
  });

  it('이미 논스가 있으면 그 논스로 묶는다(다시 요청해도 앞 코드가 같은 브라우저에서 쓰인다)', async () => {
    const fake = fakePool([]);
    await handleOpsRequest(deps(fake), event({ path: '/api/auth/request', body: { email: 'jin@example.com' }, cookies: { [OPS_COOKIES.login]: NONCE }, csrf: null }));
    expect(fake.params[0]?.[1]).toBe(keys.binding(NONCE));
  });

  it('요청자 상한(AT429) → 429 · 콘솔 닫힘(AT503) → 503', async () => {
    const limited = fakePool([{ match: /ops_request_code/, error: { code: 'AT429', detail: 'rate_limited' } }]);
    const r1 = await handleOpsRequest(deps(limited), event({ path: '/api/auth/request', body: { email: 'jin@example.com' }, cookies: {}, csrf: null }));
    expect([r1.statusCode, json(r1)['error']]).toEqual([429, 'rate_limited']);
    const closed = fakePool([{ match: /ops_request_code/, error: { code: 'AT503', detail: 'ops_disabled' } }]);
    const r2 = await handleOpsRequest(deps(closed), event({ path: '/api/auth/request', body: { email: 'jin@example.com' }, cookies: {}, csrf: null }));
    expect([r2.statusCode, json(r2)['error']]).toEqual([503, 'ops_disabled']);
  });

  it('검증 — 논스 없음 · 코드 모양 틀림은 DB 없이 401 code_invalid', async () => {
    const fake = fakePool([]);
    const r1 = await handleOpsRequest(deps(fake), event({ path: '/api/auth/verify', body: { code: '123456' }, cookies: {}, csrf: null }));
    const r2 = await handleOpsRequest(deps(fake), event({ path: '/api/auth/verify', body: { code: '12345' }, cookies: { [OPS_COOKIES.login]: NONCE }, csrf: null }));
    for (const r of [r1, r2]) expect([r.statusCode, json(r)['error']]).toEqual([401, 'code_invalid']);
    expect(fake.sql).toEqual([]);
  });

  it('검증 — 로그인이면 세션 쿠키(8시간) + CSRF · 논스 쿠키를 지운다', async () => {
    const fake = fakePool([{ match: /ops_login_verify/, rows: [{ outcome: 'session', operator_id: ME, session_id: ME }] }]);
    const result = await handleOpsRequest(deps(fake), event({ path: '/api/auth/verify', body: { code: '123456' }, cookies: { [OPS_COOKIES.login]: NONCE }, csrf: null }));
    expect(result.statusCode).toBe(200);
    const [binding, client, code, hash, ua] = fake.params[0] as string[];
    expect([binding, client, code]).toEqual([keys.binding(NONCE), keys.clientKey('203.0.113.7'), '123456']);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(ua).toBe(keys.uaHash('Mozilla/5.0 test'));
    const session = result.cookies?.find((c) => c.startsWith('__Host-atmark_ops='));
    const token = /^__Host-atmark_ops=([A-Za-z0-9_-]{43});/.exec(session ?? '')?.[1] ?? '';
    expect(sessionHash(token)).toBe(hash);
    expect(session).toContain('Max-Age=28800');
    expect(json(result)).toEqual({ outcome: 'session', csrf: keys.csrf(token) });
    expect(result.cookies).toContain('__Host-atmark_ops_login=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0');
    expect(metrics()).toContain('atmark.ops.login_ok');
  });

  it('검증 — 틀림은 401 code_invalid(세션 쿠키 없음) · 접근 요청은 결과 한 단어, requested 만 알람 메트릭', async () => {
    const wrong = fakePool([{ match: /ops_login_verify/, rows: [{ outcome: 'invalid', operator_id: null, session_id: null }] }]);
    const r1 = await handleOpsRequest(deps(wrong), event({ path: '/api/auth/verify', body: { code: '000000' }, cookies: { [OPS_COOKIES.login]: NONCE }, csrf: null }));
    expect([r1.statusCode, json(r1)['error']]).toEqual([401, 'code_invalid']);
    expect(r1.cookies ?? []).toEqual([]);
    for (const outcome of ['requested', 'pending', 'cooldown', 'pending_cap']) {
      lines.length = 0;
      const fake = fakePool([{ match: /ops_login_verify/, rows: [{ outcome, operator_id: null, session_id: null }] }]);
      const r = await handleOpsRequest(deps(fake), event({ path: '/api/auth/verify', body: { code: '111111' }, cookies: { [OPS_COOKIES.login]: NONCE }, csrf: null }));
      expect(json(r)).toEqual({ outcome });
      expect(r.cookies?.some((c) => c.startsWith('__Host-atmark_ops='))).toBe(false);
      expect(metrics().includes('atmark.ops.access_requested')).toBe(outcome === 'requested');
    }
  });
});

describe('세션 뒤 — touch 가 첫 문장', () => {
  it('세션 쿠키가 없거나 모양이 틀리면 401 · DB 호출 0', async () => {
    const fake = fakePool([TOUCH_OK]);
    const r1 = await handleOpsRequest(deps(fake), event({ path: '/api/dashboard', cookies: {} }));
    const r2 = await handleOpsRequest(deps(fake), event({ path: '/api/dashboard', cookies: { [OPS_COOKIES.session]: 'short' } }));
    for (const r of [r1, r2]) expect([r.statusCode, json(r)['error']]).toEqual([401, 'session_invalid']);
    expect(fake.sql).toEqual([]);
  });

  it('CSRF 가 없거나 틀린 변경은 403 · DB 호출 0', async () => {
    const fake = fakePool([TOUCH_OK]);
    for (const csrf of [null, 'x', keys.csrf('Z'.repeat(43))]) {
      const r = await handleOpsRequest(deps(fake), event({ path: `/api/orgs/${ORG}/review`, body: { decision: 'activate', confirm: 'Acme 조직' }, csrf }));
      expect([r.statusCode, json(r)['error']]).toEqual([403, 'csrf_mismatch']);
    }
    expect(fake.sql).toEqual([]);
  });

  it('읽기 — 첫 문장이 ops_session_touch(해시 · UA 해시 · 요청자 키)', async () => {
    const fake = fakePool([TOUCH_OK]);
    const result = await handleOpsRequest(deps(fake), event({ path: '/api/review' }));
    expect(result.statusCode).toBe(200);
    expect(fake.sql[0]).toBe('SELECT operator_id, session_id, email, expires_at FROM ops_session_touch($1, $2, $3)');
    expect(fake.params[0]).toEqual([sessionHash(TOKEN), keys.uaHash('Mozilla/5.0 test'), keys.clientKey('203.0.113.7')]);
    expect(fake.sql[1]).toMatch(/FROM organizations o/);
  });

  it('touch 0행 → 401 + 세션 쿠키 지움 · 다음 문장 없음', async () => {
    const fake = fakePool([{ match: /ops_session_touch/, rows: [] }]);
    const result = await handleOpsRequest(deps(fake), event({ path: '/api/review' }));
    expect([result.statusCode, json(result)['error']]).toEqual([401, 'session_invalid']);
    expect(result.cookies).toContain('__Host-atmark_ops=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0');
    expect(fake.sql).toHaveLength(1);
  });

  it('/api/session — 주소 · CSRF · 대기 요청 수', async () => {
    const fake = fakePool([TOUCH_OK, { match: /count\(\*\)::int AS n FROM ops_operators/, rows: [{ n: 2 }] }]);
    const result = await handleOpsRequest(deps(fake), event({ path: '/api/session' }));
    expect(json(result)).toMatchObject({ email: 'jin@example.com', operatorId: ME, csrf: keys.csrf(TOKEN), pendingOperators: 2, idleMinutes: 30, maxHours: 8 });
  });

  it('배포 중간 — 표 없음(42P01) · 권한 없음(42501) · 함수 없음(42883) → 503 ops_unavailable, 던지지 않는다', async () => {
    for (const code of ['42P01', '42501', '42883']) {
      const fake = fakePool([{ match: /ops_session_touch/, error: { code } }]);
      const result = await handleOpsRequest(deps(fake), event({ path: '/api/dashboard' }));
      expect([result.statusCode, json(result)['error']], code).toEqual([503, 'ops_unavailable']);
    }
  });

  it('콘솔 닫힘 · 하드 잠금(AT503) → 503 ops_disabled', async () => {
    const fake = fakePool([{ match: /ops_session_touch/, error: { code: 'AT503', detail: 'ops_disabled' } }]);
    const result = await handleOpsRequest(deps(fake), event({ path: '/api/dashboard' }));
    expect([result.statusCode, json(result)['error']]).toEqual([503, 'ops_disabled']);
  });

  it('P1 에는 요금제 · 동결 · 정지 쓰기와 그 화면이 없다(404, definer 0)', async () => {
    const fake = fakePool([TOUCH_OK, ORG_NAME]);
    const calls: [string, unknown][] = [
      [`/api/orgs/${ORG}/plan`, { plan: 'pro', confirm: 'Acme 조직' }],
      [`/api/orgs/${ORG}/plan/release`, { confirm: 'Acme 조직' }],
      [`/api/orgs/${ORG}/freeze`, { on: true, confirm: ORG.slice(0, 8), ack: 'CONFIRM' }],
      [`/api/agents/${'a'.repeat(32)}/suspend`, { on: true, confirm: 'Acme 조직' }],
    ];
    for (const [path, body] of calls) {
      const r = await handleOpsRequest(deps(fake), event({ path, body }));
      expect(r.statusCode, path).toBe(404);
    }
    for (const path of ['/api/plans', '/api/killswitch']) expect((await handleOpsRequest(deps(fake), event({ path }))).statusCode).toBe(404);
    expect(definers(fake.sql)).toEqual([]);
  });
});

describe('쓰기 — 확인 입력 → definer 한 트랜잭션 → 실패 기록', () => {
  it('확인 입력이 틀리면 422 · definer 0 · 트랜잭션 0', async () => {
    const fake = fakePool([TOUCH_OK, ORG_NAME]);
    const bodies = [
      { decision: 'activate', confirm: 'Acme' },
      { decision: 'activate' },
      { decision: 'reject', confirm: 'Acme 조직', ack: 'CONFIRM' },
      { decision: 'reject', confirm: ORG.slice(0, 8) },
    ];
    for (const body of bodies) {
      const r = await handleOpsRequest(deps(fake), event({ path: `/api/orgs/${ORG}/review`, body }));
      expect([r.statusCode, json(r)['error']]).toEqual([422, 'confirmation_required']);
    }
    expect(definers(fake.sql)).toEqual([]);
    expect(fake.sql).not.toContain('BEGIN');
  });

  it('활성화 — BEGIN · ops_org_activate(세션 해시, 조직) · COMMIT · M2 매핑 · 메트릭', async () => {
    const fake = fakePool([
      TOUCH_OK,
      ORG_NAME,
      { match: /ops_org_activate/, rows: [{ from_status: 'pending_review', changed: true, grant: 'granted', from_plan: null, kept_plan: null, version: 1 }] },
    ]);
    const result = await handleOpsRequest(deps(fake), event({ path: `/api/orgs/${ORG}/review`, body: { decision: 'activate', confirm: ' Acme 조직 ' } }));
    expect(result.statusCode).toBe(200);
    expect(json(result)).toEqual({ outcome: { from: 'pending_review', changed: true, suspended: [], revokedTokens: 0, plan: { granted: true, fromPlan: null, version: 1 } } });
    expect(fake.sql.slice(2)).toEqual(['BEGIN', 'SELECT * FROM ops_org_activate($1, $2)', 'COMMIT']);
    expect(fake.params[3]).toEqual([sessionHash(TOKEN), ORG]);
    expect(fake.released).toBe(1);
    const emf = lines.find((l) => l.includes('atmark.ops.privileged_action')) ?? '';
    expect(JSON.parse(emf)).toMatchObject({ action: 'org.activate' });
  });

  it('거절 — step-up 이 없으면 403 step_up_required · ROLLBACK 뒤 실패 기록(별도 트랜잭션)', async () => {
    const fake = fakePool([TOUCH_OK, ORG_NAME, { match: /ops_org_reject/, error: { code: 'AT403', detail: 'step_up_required' } }]);
    const result = await handleOpsRequest(deps(fake), event({ path: `/api/orgs/${ORG}/review`, body: { decision: 'reject', confirm: ORG.slice(0, 8).toUpperCase(), ack: 'CONFIRM' } }));
    expect([result.statusCode, json(result)['error']]).toEqual([403, 'step_up_required']);
    expect(fake.sql.slice(2)).toEqual(['BEGIN', 'SELECT * FROM ops_org_reject($1, $2)', 'ROLLBACK', 'SELECT ops_record_failure($1, $2, $3, $4, $5, $6)']);
    expect(fake.params[5]).toEqual([sessionHash(TOKEN), keys.clientKey('203.0.113.7'), 'org.reject', ORG, null, 'step_up_required']);
    expect(metrics()).toEqual(expect.arrayContaining(['atmark.ops.write_failed', 'atmark.ops.step_up_required']));
  });

  it('거절 성공 — 정지한 에이전트(정렬) · 폐기한 토큰 수', async () => {
    const fake = fakePool([TOUCH_OK, ORG_NAME, { match: /ops_org_reject/, rows: [{ from_status: 'pending_review', changed: true, suspended: ['b'.repeat(32), 'a'.repeat(32)], revoked_tokens: 3 }] }]);
    const result = await handleOpsRequest(deps(fake), event({ path: `/api/orgs/${ORG}/review`, body: { decision: 'reject', confirm: ORG.slice(0, 8), ack: 'CONFIRM' } }));
    expect(json(result)).toEqual({ outcome: { from: 'pending_review', changed: true, suspended: ['a'.repeat(32), 'b'.repeat(32)], revokedTokens: 3, plan: null } });
  });

  it('실패 기록이 실패해도 원래 오류를 돌려준다', async () => {
    const fake = fakePool([
      TOUCH_OK,
      ORG_NAME,
      { match: /ops_org_activate/, error: { code: 'AT429', detail: 'ticket_cap' } },
      { match: /ops_record_failure/, error: { code: '57014' } },
    ]);
    const result = await handleOpsRequest(deps(fake), event({ path: `/api/orgs/${ORG}/review`, body: { decision: 'activate', confirm: 'Acme 조직' } }));
    expect([result.statusCode, json(result)['error']]).toEqual([429, 'ticket_cap']);
  });

  it('definer 안의 42501 + DETAIL ticket_violation(zz_ 트리거가 티켓 없는 쓰기를 거부) → 500 ticket_violation · 실패 기록 · error 로그', async () => {
    const fake = fakePool([TOUCH_OK, ORG_NAME, { match: /ops_org_activate/, error: { code: '42501', detail: 'ticket_violation' } }]);
    const result = await handleOpsRequest(deps(fake), event({ path: `/api/orgs/${ORG}/review`, body: { decision: 'activate', confirm: 'Acme 조직' } }));
    expect([result.statusCode, json(result)['error']]).toEqual([500, 'ticket_violation']);
    expect(fake.sql.slice(2)).toEqual(['BEGIN', 'SELECT * FROM ops_org_activate($1, $2)', 'ROLLBACK', 'SELECT ops_record_failure($1, $2, $3, $4, $5, $6)']);
    expect(fake.params.at(-1)?.[5]).toBe('ticket_violation');
    const logged = lines.map((l) => JSON.parse(l) as Record<string, unknown>).find((l) => l['event'] === 'ops.ticket_violation');
    expect(logged).toMatchObject({ level: 'error', route_id: 'ops', error_code: 'ticket_violation' });
    const emf = lines.find((l) => l.includes('atmark.ops.write_failed')) ?? '';
    expect(JSON.parse(emf)).toMatchObject({ code: 'ticket_violation' });
  });

  it('definer 의 맨 42501(DETAIL 없음 — 권한이 빠진 배포)은 ticket_violation 이 아니다 → 503 ops_unavailable · 실패 기록 없음', async () => {
    const fake = fakePool([TOUCH_OK, ORG_NAME, { match: /ops_org_activate/, error: { code: '42501' } }]);
    const result = await handleOpsRequest(deps(fake), event({ path: `/api/orgs/${ORG}/review`, body: { decision: 'activate', confirm: 'Acme 조직' } }));
    expect([result.statusCode, json(result)['error']]).toEqual([503, 'ops_unavailable']);
    expect(fake.sql).not.toContain('SELECT ops_record_failure($1, $2, $3, $4, $5, $6)');
    expect(lines.some((l) => l.includes('ops.ticket_violation'))).toBe(false);
  });

  it('ROLLBACK 이 실패하면 연결을 버린다(release(err)) · 그 연결로 실패 기록을 하지 않는다', async () => {
    const fake = fakePool([TOUCH_OK, ORG_NAME, { match: /ops_org_activate/, error: { code: 'AT429', detail: 'ticket_cap' } }, { match: /^ROLLBACK$/, error: { code: '08006' } }]);
    const result = await handleOpsRequest(deps(fake), event({ path: `/api/orgs/${ORG}/review`, body: { decision: 'activate', confirm: 'Acme 조직' } }));
    expect([result.statusCode, json(result)['error']]).toEqual([429, 'ticket_cap']);
    expect(fake.destroyed).toHaveLength(1);
    expect(fake.sql).not.toContain('SELECT ops_record_failure($1, $2, $3, $4, $5, $6)');
  });

  it('운영자 승인 — 확인 입력은 대상 주소 · 틀리면 422 definer 0 · 맞으면 ops_decide_request', async () => {
    const target: Responder = { match: /SELECT id, email, status, origin FROM ops_operators WHERE id/, rows: [{ id: OPERATOR, email: 'new@example.com', status: 'requested', origin: 'console' }] };
    const fake = fakePool([TOUCH_OK, target, { match: /ops_decide_request/, rows: [{ result: 'ok' }] }]);
    const wrong = await handleOpsRequest(deps(fake), event({ path: `/api/operators/${OPERATOR}/decision`, body: { decision: 'approve', confirm: 'other@example.com' } }));
    expect([wrong.statusCode, json(wrong)['error']]).toEqual([422, 'confirmation_required']);
    expect(definers(fake.sql)).toEqual([]);
    const ok = await handleOpsRequest(deps(fake), event({ path: `/api/operators/${OPERATOR}/decision`, body: { decision: 'approve', confirm: 'NEW@example.com' } }));
    expect(json(ok)).toEqual({ operatorId: OPERATOR, result: 'ok' });
    expect(fake.sql.slice(-3)).toEqual(['BEGIN', 'SELECT ops_decide_request($1, $2, $3) AS result', 'COMMIT']);
    expect(fake.params.at(-2)).toEqual([sessionHash(TOKEN), OPERATOR, 'approve']);
  });

  it('운영자 폐기 — 마지막 운영자면 403 last_operator(실패 기록)', async () => {
    const target: Responder = { match: /FROM ops_operators WHERE id/, rows: [{ id: ME, email: 'jin@example.com', status: 'active', origin: 'console' }] };
    const fake = fakePool([TOUCH_OK, target, { match: /ops_revoke_operator/, error: { code: 'AT403', detail: 'last_operator' } }]);
    const r = await handleOpsRequest(deps(fake), event({ path: `/api/operators/${ME}/revoke`, body: { confirm: 'jin@example.com' } }));
    expect([r.statusCode, json(r)['error']]).toEqual([403, 'last_operator']);
    expect(fake.sql.at(-1)).toBe('SELECT ops_record_failure($1, $2, $3, $4, $5, $6)');
    expect(fake.params.at(-1)?.[2]).toBe('operator.revoke');
  });
});

describe('경로 정규형(SEC-Info2)', () => {
  it('// · 끝 / · 빈 조각이 있는 경로는 404 · DB 호출 0 — 인증 라우트 스로틀 버킷을 우회하지 못한다', async () => {
    const fake = fakePool([TOUCH_OK]);
    const kicks = { n: 0 };
    for (const path of ['/api//auth/request', '/api/auth/request/', '//api/auth/request', '/api/auth//verify', '/api/review/', '//']) {
      const r = await handleOpsRequest(deps(fake, kicks), event({ path, body: { email: 'jin@example.com', code: '123456' }, cookies: {}, csrf: null }));
      expect(r.statusCode, path).toBe(404);
    }
    const page = await handleOpsRequest(deps(fake), event({ path: '//', site: 'none', cookies: {} }));
    expect(page.statusCode).toBe(404);
    expect(fake.sql).toEqual([]);
    expect(kicks.n).toBe(0);
  });
});

describe('step-up · 로그아웃', () => {
  it('step-up 요청 — 대상 참조를 돌려주고 메일러를 깨운다 · step-up 없는 행위는 거부', async () => {
    const kicks = { n: 0 };
    const fake = fakePool([TOUCH_OK, { match: /ops_request_stepup/, rows: [{ ref: 'K7QZ' }] }]);
    const r = await handleOpsRequest(deps(fake, kicks), event({ path: '/api/auth/step-up', body: { action: 'org.reject', org: ORG } }));
    expect(json(r)).toEqual({ action: 'org.reject', targetRef: 'K7QZ' });
    expect(fake.params[1]).toEqual([sessionHash(TOKEN), keys.clientKey('203.0.113.7'), 'org.reject', ORG, null]);
    expect(kicks.n).toBe(1);
    for (const body of [{ action: 'org.freeze_on', org: ORG }, { action: 'plan.set', org: ORG }, { action: 'operator.approve' }]) {
      const bad = await handleOpsRequest(deps(fake), event({ path: '/api/auth/step-up', body }));
      expect(bad.statusCode).toBe(400);
    }
  });

  it('step-up 검증 — 틀리면 401 code_invalid · 맞으면 행위와 참조', async () => {
    const ok = fakePool([TOUCH_OK, { match: /ops_stepup_verify/, rows: [{ outcome: 'ok', action: 'org.reject', target_ref: 'K7QZ' }] }]);
    const r1 = await handleOpsRequest(deps(ok), event({ path: '/api/auth/step-up/verify', body: { code: '123456' } }));
    expect(json(r1)).toEqual({ action: 'org.reject', targetRef: 'K7QZ' });
    const bad = fakePool([TOUCH_OK, { match: /ops_stepup_verify/, rows: [{ outcome: 'invalid', action: null, target_ref: null }] }]);
    const r2 = await handleOpsRequest(deps(bad), event({ path: '/api/auth/step-up/verify', body: { code: '123456' } }));
    expect([r2.statusCode, json(r2)['error']]).toEqual([401, 'code_invalid']);
  });

  it('로그아웃 — touch 없이 ops_session_revoke(콘솔이 닫혀 있어도) · 쿠키 지움', async () => {
    const fake = fakePool([{ match: /ops_session_revoke/, rows: [{ n: 1 }] }]);
    const r = await handleOpsRequest(deps(fake), event({ path: '/api/auth/logout', body: {} }));
    expect(json(r)).toEqual({ revoked: 1 });
    expect(fake.sql).toEqual(['SELECT ops_session_revoke($1, $2) AS n']);
    expect(r.cookies).toContain('__Host-atmark_ops=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0');
  });
});

describe('매핑', () => {
  it('SQLSTATE → HTTP(계약 표) · DETAIL 모양이 틀리면 기본 코드', () => {
    expect(mapDbError({ code: 'AT401', detail: 'session_invalid' })).toMatchObject({ status: 401, code: 'session_invalid' });
    expect(mapDbError({ code: 'AT404', detail: 'organization_not_found' })).toMatchObject({ status: 404, code: 'organization_not_found' });
    expect(mapDbError({ code: 'AT409', detail: 'not_requested' })).toMatchObject({ status: 409, code: 'not_requested' });
    expect(mapDbError({ code: 'AT403', detail: 'x; DROP' })).toMatchObject({ status: 403, code: 'forbidden' });
    expect(mapDbError({ code: '22023' })).toMatchObject({ status: 400, code: 'invalid_input' });
    expect(mapDbError(new Error('boom'))).toMatchObject({ status: 500, code: 'internal_error', message: INTERNAL_MESSAGE });
    expect(mapDbError({ code: '42501' })).toMatchObject({ status: 503, code: 'ops_unavailable' });
  });

  it('M2 — grant → plan', () => {
    expect(activationGrantOf({ grant: 'granted', from_plan: 'free', kept_plan: null, version: 2 })).toEqual({ granted: true, fromPlan: 'free', version: 2 });
    expect(activationGrantOf({ grant: 'disabled', from_plan: null, kept_plan: null, version: null })).toEqual({ granted: false, reason: 'disabled', plan: null });
    expect(activationGrantOf({ grant: 'kept', from_plan: null, kept_plan: 'pro', version: null })).toEqual({ granted: false, reason: 'kept', plan: 'pro' });
    expect(activationGrantOf({ grant: 'none', from_plan: null, kept_plan: null, version: null })).toBeNull();
    expect(rejectOutcomeOf({ from_status: 'pending_review', changed: true, suspended: ['b', 'a'], revoked_tokens: 2 })).toEqual({
      from: 'pending_review',
      changed: true,
      suspended: ['a', 'b'],
      revokedTokens: 2,
      plan: null,
    });
  });

  it('로그와 메트릭에 주소 · IP · 토큰이 없다', async () => {
    const fake = fakePool([{ match: /ops_request_code/, error: { code: 'XX000', message: 'jin@example.com 203.0.113.7' } }]);
    await handleOpsRequest(deps(fake), event({ path: '/api/auth/request', body: { email: 'jin@example.com' }, cookies: {}, csrf: null }));
    for (const line of lines) expect(line).not.toMatch(/jin@example\.com|203\.0\.113\.7|TTTT/);
  });
});

describe('요청자 IP 가 없으면 닫힌 채 실패한다(재확인 I-3)', () => {
  const withoutIp = (input: Parameters<typeof event>[0], ip: string | undefined) => {
    const base = event(input);
    const { sourceIp: _dropped, ...http } = base.requestContext.http;
    return { ...base, requestContext: { ...base.requestContext, http: ip === undefined ? http : { ...http, sourceIp: ip } } };
  };

  it.each([undefined, '', '   '])('sourceIp=%j — 인증 요청·검증·세션 API 전부 503 client_ip_unavailable · DB 호출 0(한 버킷으로 몰지 않는다)', async (ip) => {
    const cases = [
      { path: '/api/auth/request', body: { email: 'jin@example.com' }, cookies: {}, csrf: null },
      { path: '/api/auth/verify', body: { code: '123456' }, cookies: { [OPS_COOKIES.login]: NONCE }, csrf: null },
      { path: '/api/dashboard' },
      { path: '/api/auth/logout', body: {} },
    ] as const;
    for (const input of cases) {
      const fake = fakePool([TOUCH_OK]);
      const result = await handleOpsRequest(deps(fake), withoutIp(input, ip));
      expect([result.statusCode, json(result)['error']], input.path).toEqual([503, 'client_ip_unavailable']);
      expect(fake.sql, input.path).toEqual([]);
    }
    // 운영자가 알아차리게 오류 로그 한 줄 — 값(IP·주소) 없이.
    expect(lines.some((line) => line.includes('ops.client_ip_missing'))).toBe(true);
  });

  it('페이지(GET /)는 IP 없이도 그대로 — 데이터가 없고 요청자 키를 쓰지 않는다', async () => {
    const fake = fakePool([]);
    const result = await handleOpsRequest(deps(fake), withoutIp({ path: '/' }, undefined));
    expect(result.statusCode).toBe(200);
    expect(fake.sql).toEqual([]);
  });

  it('IP 가 있으면 요청자 키는 그 IP 의 HMAC 이다(unknown 이 아니다)', async () => {
    const fake = fakePool([{ match: /ops_request_code/, rows: [{}] }]);
    await handleOpsRequest(deps(fake), event({ path: '/api/auth/request', body: { email: 'jin@example.com' }, cookies: {}, csrf: null }));
    const params = fake.params[fake.sql.findIndex((sql) => sql.includes('ops_request_code'))] ?? [];
    expect(params[2]).toBe(keys.clientKey('203.0.113.7'));
    expect(params[2]).not.toBe(keys.clientKey('unknown'));
  });
});

describe('대기자 명단 쓰기(202609301520) — 확인 · 정의 함수 · 메트릭 · 실패 기록', () => {
  const ENTRY = '77777777-2222-4333-8444-555555555555';
  const ENTRY_EMAIL: Responder = { match: /SELECT email, status FROM waitlist_entries WHERE id/, rows: [{ email: 'wait@example.com', status: 'waiting' }] };

  it('확인 입력이 틀리면 422 · 정의 함수 0', async () => {
    const fake = fakePool([TOUCH_OK, ENTRY_EMAIL]);
    const result = await handleOpsRequest(deps(fake), event({ path: `/api/waitlist/${ENTRY}/invite`, body: { confirm: 'other@example.com' } }));
    expect([result.statusCode, json(result)['error']]).toEqual([422, 'confirmation_required']);
    expect(fake.sql.some((s) => /ops_waitlist_/.test(s))).toBe(false);
  });

  it('초대 성공 — BEGIN · ops_waitlist_invite · COMMIT · privileged_action{action=waitlist.invite}', async () => {
    const fake = fakePool([
      TOUCH_OK,
      ENTRY_EMAIL,
      { match: /ops_waitlist_invite\(/, rows: [{ entry_id: ENTRY, from_status: 'waiting', invite_expires_at: new Date('2026-10-12T12:00:00Z') }] },
    ]);
    const result = await handleOpsRequest(deps(fake), event({ path: `/api/waitlist/${ENTRY}/invite`, body: { confirm: 'WAIT@example.com' } }));
    expect(result.statusCode).toBe(200);
    expect(fake.sql.slice(2)).toEqual(['BEGIN', 'SELECT entry_id, from_status, invite_expires_at FROM ops_waitlist_invite($1, $2)', 'COMMIT']);
    const emf = lines.find((l) => l.includes('atmark.ops.privileged_action')) ?? '';
    expect(JSON.parse(emf)).toMatchObject({ action: 'waitlist.invite' });
  });

  it('지우기 실패(없는 항목) — ROLLBACK 뒤 실패 기록(행위 waitlist.remove) · write_failed · 404', async () => {
    const fake = fakePool([TOUCH_OK, ENTRY_EMAIL, { match: /ops_waitlist_remove/, error: { code: 'AT404', detail: 'entry_not_found' } }]);
    const result = await handleOpsRequest(deps(fake), event({ path: `/api/waitlist/${ENTRY}/remove`, body: { confirm: 'wait@example.com' } }));
    expect([result.statusCode, json(result)['error']]).toEqual([404, 'entry_not_found']);
    expect(fake.sql.slice(2)).toEqual(['BEGIN', 'SELECT ops_waitlist_remove($1, $2) AS from_status', 'ROLLBACK', 'SELECT ops_record_failure($1, $2, $3, $4, $5, $6)']);
    expect(fake.params[5]).toEqual([sessionHash(TOKEN), keys.clientKey('203.0.113.7'), 'waitlist.remove', null, null, 'entry_not_found']);
    expect(metrics()).toContain('atmark.ops.write_failed');
    expect(lines.some((l) => l.includes('atmark.ops.privileged_action'))).toBe(false);
  });

  it('가장 오래 기다린 N 명 — 확인 = 그 수 · privileged_action{action=waitlist.invite_oldest}', async () => {
    const fake = fakePool([TOUCH_OK, { match: /ops_waitlist_invite_oldest/, rows: [{ entry_id: ENTRY }, { entry_id: ORG }] }]);
    const wrong = await handleOpsRequest(deps(fake), event({ path: '/api/waitlist/invite-oldest', body: { n: 2, confirm: '3' } }));
    expect(wrong.statusCode).toBe(422);
    const ok = await handleOpsRequest(deps(fake), event({ path: '/api/waitlist/invite-oldest', body: { n: 2, confirm: '2' } }));
    expect(json(ok)).toEqual({ waitlist: { invited: 2 } });
    const emf = lines.find((l) => l.includes('atmark.ops.privileged_action')) ?? '';
    expect(JSON.parse(emf)).toMatchObject({ action: 'waitlist.invite_oldest' });
  });
});
