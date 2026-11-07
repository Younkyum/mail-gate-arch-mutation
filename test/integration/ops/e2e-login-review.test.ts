/**
 * G5 — 로컬 e2e 한 편(`.omc/plans/ops-console.md` §4 검증 게이트): 코드 → 세션 → 활성화(window + ref) → 거절(once + ref) → 접근 요청 → 승인 →
 * 폐기 → 401 → `console_enabled = false` 면 503. 진짜 DB(0500 · 0510)와 `atmark_ops` 로그인 풀, 메일은 보내지 않는다(소유자가 다이제스트를 적는다).
 * `ops-role-lock`(migrate λ · RDS 마스터)은 이 파일 밖이다 — W-DB 의 migrate 테스트가 본다.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  addCliOperator,
  APP_URL,
  Browser,
  inRolledBackOps,
  lockOps,
  OWNER_URL,
  openHarness,
  pendingOrg,
  releaseOps,
  setConsole,
  testEmail,
  type OpsHarness,
} from './hosted-support';

const AVAILABLE = OWNER_URL.trim() !== '' && APP_URL.trim() !== '';

describe.skipIf(!AVAILABLE)('G5 — 로그인 · 검토 · 운영자 관리(로컬 e2e)', () => {
  let h: OpsHarness;

  beforeAll(async () => {
    h = await openHarness();
    await lockOps(h.owner);
  });

  afterAll(async () => {
    await releaseOps();
    await h.close();
  });

  it('한 편', async () => {
    // ① 코드 → 세션
    const founder = await addCliOperator(h.owner);
    const a = new Browser(h);
    expect((await a.login(founder.email, h.owner))['outcome']).toBe('session');

    // ② 활성화 — step-up 없으면 403 → window step-up(대상 참조가 요청과 검증에서 같다) → 200 · 티켓과 효과가 같은 커밋 · 감사에 보인다
    const org = await pendingOrg(h.owner);
    const blocked = await a.call('POST', `/api/orgs/${org.id}/review`, { decision: 'activate', confirm: org.name });
    expect([blocked.status, blocked.json['error']]).toEqual([403, 'step_up_required']);
    const failures = await h.owner.query(`SELECT 1 FROM ops_actions WHERE kind = 'failure' AND organization_id = $1 AND code = 'step_up_required'`, [org.id]);
    expect(failures.rowCount).toBe(1);
    const ref = await a.stepUp(h.owner, founder.id, 'org.activate', { org: org.id });
    expect(ref.requested).toMatch(/^[0-9A-Z]{4}$/);
    expect(ref.verified).toBe(ref.requested);
    const activated = await a.call('POST', `/api/orgs/${org.id}/review`, { decision: 'activate', confirm: org.name });
    expect(activated.status, JSON.stringify(activated.json)).toBe(200);
    expect(activated.json['outcome']).toMatchObject({ from: 'pending_review', changed: true, suspended: [], revokedTokens: 0 });
    const status = await h.owner.query<{ review_status: string }>('SELECT review_status FROM organizations WHERE id = $1', [org.id]);
    expect(status.rows[0]?.review_status).toBe('active');
    const ticket = await h.owner.query<{ id: string }>(`SELECT id FROM ops_actions WHERE kind = 'ticket' AND action = 'org.activate' AND organization_id = $1`, [org.id]);
    expect(ticket.rowCount).toBe(1);
    const effects = await h.owner.query('SELECT table_name, op FROM ops_action_effects WHERE action_id = $1', [ticket.rows[0]?.id]);
    expect(effects.rows).toEqual(expect.arrayContaining([expect.objectContaining({ table_name: 'organizations' })]));
    const audit = await a.call('GET', '/api/audit', undefined, { query: `source=ops&org=${org.id}` });
    const actions = (audit.json['items'] as { action: string; detail: string | null; actor: string }[]).map((item) => item.action);
    expect(actions).toEqual(expect.arrayContaining(['ticket:org.activate', 'failure:org.activate']));
    const ticketRow = (audit.json['items'] as { action: string; detail: string | null; actor: string }[]).find((item) => item.action === 'ticket:org.activate');
    expect(ticketRow?.detail).toContain('organizations');
    expect(ticketRow?.actor).toBe(founder.email);

    // window — 같은 (행위, 조직)은 10분 동안 다시 묻지 않는다 · 다른 조직은 다시 묻는다
    const other = await pendingOrg(h.owner);
    const otherBlocked = await a.call('POST', `/api/orgs/${other.id}/review`, { decision: 'activate', confirm: other.name });
    expect(otherBlocked.json['error']).toBe('step_up_required');

    // ③ 거절 — once step-up(대상 참조) → 200 · 같은 허가로 다른 조직 거절은 403. 전역 하루 10(append-only 티켓)을 소모하지 않도록 **롤백되는**
    //    트랜잭션 안에서 돈다(CR-M2) — 그 안에서는 지난 거절 이력을 비우므로 성공 경로를 늘 결정적으로 본다.
    const rejectRef = await a.stepUp(h.owner, founder.id, 'org.reject', { org: other.id }, '975310');
    expect(rejectRef.verified).toBe(rejectRef.requested);
    const third = await pendingOrg(h.owner);
    await inRolledBackOps(h, async (tx, client) => {
      const inTx = new Browser(tx, undefined, a.ip);
      for (const [k, v] of a.jar) inTx.jar.set(k, v);
      inTx.csrf = a.csrf;
      const rejected = await inTx.call('POST', `/api/orgs/${other.id}/review`, { decision: 'reject', confirm: other.id.slice(0, 8), ack: 'CONFIRM' });
      expect(rejected.status, JSON.stringify(rejected.json)).toBe(200);
      expect(rejected.json['outcome']).toMatchObject({ from: 'pending_review', changed: true, suspended: [], revokedTokens: 0, plan: null });
      const state = await client.query<{ review_status: string }>('SELECT review_status FROM organizations WHERE id = $1', [other.id]);
      expect(state.rows[0]?.review_status).toBe('rejected');
      const tickets = await client.query(`SELECT 1 FROM ops_actions WHERE kind = 'ticket' AND action = 'org.reject' AND organization_id = $1`, [other.id]);
      expect(tickets.rowCount).toBe(1);
      const again = await inTx.call('POST', `/api/orgs/${third.id}/review`, { decision: 'reject', confirm: third.id.slice(0, 8), ack: 'CONFIRM' });
      expect([again.status, again.json['error']]).toEqual([403, 'step_up_required']);
    });
    const undone = await h.owner.query<{ review_status: string }>('SELECT review_status FROM organizations WHERE id = $1', [other.id]);
    expect(undone.rows[0]?.review_status).toBe('pending_review');

    // ④ 접근 요청 — 모르는 주소가 코드를 검증한 뒤에만 requested
    const newcomer = testEmail();
    const b = new Browser(h);
    const requestedBefore = await h.owner.query('SELECT 1 FROM ops_operators WHERE email = $1', [newcomer]);
    expect(requestedBefore.rowCount).toBe(0);
    const access = await b.login(newcomer, h.owner, '112233');
    expect(access).toEqual({ outcome: 'requested' });
    expect(b.hasSession).toBe(false);
    const pending = await h.owner.query<{ id: string; status: string; origin: string }>('SELECT id, status, origin FROM ops_operators WHERE email = $1', [newcomer]);
    expect(pending.rows[0]).toMatchObject({ status: 'requested', origin: 'console' });
    const newcomerId = pending.rows[0]?.id as string;
    const listed = await a.call('GET', '/api/session');
    expect(Number(listed.json['pendingOperators'])).toBeGreaterThanOrEqual(1);

    // ⑤ 승인 — 확인 입력이 틀리면 422(definer 0) · once step-up → 승인 → active
    const typo = await a.call('POST', `/api/operators/${newcomerId}/decision`, { decision: 'approve', confirm: 'someone@example.com' });
    expect([typo.status, typo.json['error']]).toEqual([422, 'confirmation_required']);
    await a.stepUp(h.owner, founder.id, 'operator.approve', { operator: newcomerId }, '445566');
    const approved = await a.call('POST', `/api/operators/${newcomerId}/decision`, { decision: 'approve', confirm: newcomer });
    expect(approved.status, JSON.stringify(approved.json)).toBe(200);
    const active = await h.owner.query<{ status: string }>('SELECT status FROM ops_operators WHERE id = $1', [newcomerId]);
    expect(active.rows[0]?.status).toBe('active');

    // 새 운영자가 로그인한다
    const c = new Browser(h);
    expect((await c.login(newcomer, h.owner, '778899'))['outcome']).toBe('session');
    expect((await c.call('GET', '/api/session')).status).toBe(200);

    // ⑥ 폐기 → 그 운영자의 세션은 곧바로 401
    await a.stepUp(h.owner, founder.id, 'operator.revoke', { operator: newcomerId }, '101010');
    const revoked = await a.call('POST', `/api/operators/${newcomerId}/revoke`, { confirm: newcomer });
    expect(revoked.status, JSON.stringify(revoked.json)).toBe(200);
    const gone = await c.call('GET', '/api/session');
    expect([gone.status, gone.json['error']]).toEqual([401, 'session_invalid']);

    // CLI 출신 운영자(창업자)는 콘솔에서 폐기되지 않는다
    await a.stepUp(h.owner, founder.id, 'operator.revoke', { operator: founder.id }, '202020');
    const cli = await a.call('POST', `/api/operators/${founder.id}/revoke`, { confirm: founder.email });
    expect([cli.status, cli.json['error']]).toEqual([403, 'cli_operator']);
    expect((await a.call('GET', '/api/session')).status).toBe(200);

    // ⑦ 콘솔을 닫으면 503
    await setConsole(h.owner, false);
    try {
      const closed = await a.call('GET', '/api/dashboard');
      expect([closed.status, closed.json['error']]).toEqual([503, 'ops_disabled']);
    } finally {
      await setConsole(h.owner, true);
    }
  });
});
