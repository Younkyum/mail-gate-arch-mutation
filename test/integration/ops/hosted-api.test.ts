/**
 * 호스팅 ops API — 진짜 DB(0500 · 0510) · `atmark_ops` 로그인 풀. W-APP 수락 기준 중 DB 가 필요한 것:
 *   - 로그인: 코드 요청 202 → (메일러 대신 다이제스트) → 검증 → `__Host-` 세션 쿠키 + CSRF · 틀린 코드 401 과 실패 수 +1
 *   - 읽기 화면 전부가 `atmark_ops` 의 컬럼 GRANT 로 돈다(대시보드 · 검토 대기열 · 조직 · 조직 상세 · 감사 · 운영자 · 세션)
 *   - CSRF 없음 403 · 로그아웃 뒤 401
 *   - `console_enabled = false` → 503 `ops_disabled`, 함수가 없는 DB(배포 중간) → 503 `ops_unavailable`
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { readReviewQueue } from '../../../src/ops/console/reads';
import { listPendingReviewOp } from '../../../src/ops/core/review';

import { addCliOperator, APP_URL, Browser, lockOps, OWNER_URL, openHarness, pendingOrg, releaseOps, setConsole, testEmail, type OpsHarness } from './hosted-support';

const AVAILABLE = OWNER_URL.trim() !== '' && APP_URL.trim() !== '';

describe.skipIf(!AVAILABLE)('호스팅 ops API(로컬 DB)', () => {
  let h: OpsHarness;
  let operator: { id: string; email: string };

  beforeAll(async () => {
    h = await openHarness();
    await lockOps(h.owner);
    operator = await addCliOperator(h.owner);
  });

  afterAll(async () => {
    await releaseOps();
    await h.close();
  });

  it('로그인 — 요청 202(모르는 주소도 같다) · 다이제스트 뒤 검증 → 세션 쿠키 + CSRF · 메일러를 깨운다', async () => {
    const stranger = new Browser(h);
    const unknown = await stranger.call('POST', '/api/auth/request', { email: 'nobody-ops-it@invalid' });
    const b = new Browser(h);
    const known = await b.call('POST', '/api/auth/request', { email: operator.email });
    expect([unknown.status, known.status]).toEqual([202, 202]);
    expect(known.json).toEqual(unknown.json);
    const kicksBefore = h.kicks.n;
    const verified = await b.login(operator.email, h.owner);
    expect(h.kicks.n).toBeGreaterThan(kicksBefore);
    expect(verified['outcome']).toBe('session');
    expect(b.hasSession).toBe(true);
    const session = await b.call('GET', '/api/session');
    expect(session.status).toBe(200);
    expect(session.json).toMatchObject({ email: operator.email, operatorId: operator.id, csrf: b.csrf });
  });

  it('틀린 코드 → 401 code_invalid · 도전의 실패 수 +1 · 세션 없음', async () => {
    const email = (await addCliOperator(h.owner)).email;
    const b = new Browser(h);
    await b.call('POST', '/api/auth/request', { email });
    const { deliverCode } = await import('./hosted-support');
    const id = await deliverCode(h.owner, { email }, '111111');
    const wrong = await b.call('POST', '/api/auth/verify', { code: '222222' });
    expect([wrong.status, wrong.json['error']]).toEqual([401, 'code_invalid']);
    expect(b.hasSession).toBe(false);
    const row = await h.owner.query<{ code_failures: number }>('SELECT code_failures FROM ops_login_challenges WHERE id = $1', [id]);
    expect(row.rows[0]?.code_failures).toBe(1);
    const right = await b.call('POST', '/api/auth/verify', { code: '111111' });
    expect(right.status).toBe(200);
  });

  it('읽기 화면 전부가 atmark_ops 권한으로 돈다', async () => {
    const b = new Browser(h);
    await b.login((await addCliOperator(h.owner)).email, h.owner);
    const org = await pendingOrg(h.owner);
    for (const [path, query] of [
      ['/api/dashboard', undefined],
      // 주간 운영판(202610010900) — 정의 함수 EXECUTE + 대기자 명단 칸 GRANT.
      ['/api/board', undefined],
      ['/api/review', undefined],
      ['/api/orgs', 'q=검토'],
      [`/api/orgs/${org.id}`, undefined],
      ['/api/audit', 'source=all&limit=50'],
      ['/api/audit', `source=ops&org=${org.id}`],
      ['/api/catalog', undefined],
      ['/api/operators', undefined],
    ] as const) {
      const r = await b.call('GET', path, undefined, query === undefined ? {} : { query });
      expect(r.status, `${path} ${JSON.stringify(r.json)}`).toBe(200);
    }
    const review = await b.call('GET', '/api/review');
    expect((review.json['items'] as { id: string }[]).some((item) => item.id === org.id)).toBe(true);
    const operators = await b.call('GET', '/api/operators');
    expect((operators.json['items'] as unknown[]).length).toBeGreaterThan(0);
  });

  it('검토 대기열 — 화면(readReviewQueue)과 CLI(listPendingReviewOp)가 같은 조직을 같은 순서로', async () => {
    await pendingOrg(h.owner);
    await pendingOrg(h.owner);
    const client = await h.owner.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
      const cli = await listPendingReviewOp(client);
      const screen = (await readReviewQueue(client)).body as { items: { id: string; agents: number }[] };
      await client.query('COMMIT');
      expect(cli.length).toBeGreaterThanOrEqual(2);
      expect(screen.items.map((item) => [item.id, item.agents])).toEqual(cli.map((row) => [row.id, row.agents]));
    } finally {
      client.release();
    }
  });

  it('CSRF 없는 변경 → 403 · 교차 출처 → 403 · 로그아웃 뒤 401', async () => {
    const b = new Browser(h);
    await b.login((await addCliOperator(h.owner)).email, h.owner);
    const org = await pendingOrg(h.owner);
    const noCsrf = await b.call('POST', `/api/orgs/${org.id}/review`, { decision: 'activate', confirm: org.name }, { csrf: null });
    expect([noCsrf.status, noCsrf.json['error']]).toEqual([403, 'csrf_mismatch']);
    const cross = await b.call('POST', `/api/orgs/${org.id}/review`, { decision: 'activate', confirm: org.name }, { origin: 'https://console.atmark.ai' });
    expect(cross.status).toBe(403);
    const cookie = b.jar.get('__Host-atmark_ops') ?? '';
    const out = await b.call('POST', '/api/auth/logout', {});
    expect(out.json).toEqual({ revoked: 1 });
    b.jar.set('__Host-atmark_ops', cookie);
    const after = await b.call('GET', '/api/session');
    expect([after.status, after.json['error']]).toEqual([401, 'session_invalid']);
  });

  it('UA 가 바뀌면 세션이 끝난다(DB 가 폐기)', async () => {
    const b = new Browser(h, 'Browser A');
    await b.login((await addCliOperator(h.owner)).email, h.owner);
    const other = new Browser(h, 'Browser B', b.ip);
    for (const [k, v] of b.jar) other.jar.set(k, v);
    const moved = await other.call('GET', '/api/session');
    expect(moved.status).toBe(401);
    const back = await b.call('GET', '/api/session');
    expect(back.status).toBe(401);
  });

  it('console_enabled = false → 요청 · 세션 모두 503 ops_disabled · 로그아웃은 된다', async () => {
    const b = new Browser(h);
    await b.login((await addCliOperator(h.owner)).email, h.owner);
    await setConsole(h.owner, false);
    try {
      const read = await b.call('GET', '/api/dashboard');
      expect([read.status, read.json['error']]).toEqual([503, 'ops_disabled']);
      const request = await new Browser(h).call('POST', '/api/auth/request', { email: testEmail() });
      expect([request.status, request.json['error']]).toEqual([503, 'ops_disabled']);
      const out = await b.call('POST', '/api/auth/logout', {});
      expect(out.status).toBe(200);
    } finally {
      await setConsole(h.owner, true);
    }
  });

  it('배포 중간(함수가 보이지 않는 DB) → 503 ops_unavailable · 던지지 않는다', async () => {
    const hidden = await openHarness({ opsPoolOptions: { options: '-c search_path=pg_catalog' } });
    try {
      const b = new Browser(hidden);
      b.jar.set('__Host-atmark_ops', 'T'.repeat(43));
      const read = await b.call('GET', '/api/dashboard');
      expect([read.status, read.json['error']]).toEqual([503, 'ops_unavailable']);
      const request = await new Browser(hidden).call('POST', '/api/auth/request', { email: testEmail() });
      expect([request.status, request.json['error']]).toEqual([503, 'ops_unavailable']);
    } finally {
      await hidden.close();
    }
  });
});
