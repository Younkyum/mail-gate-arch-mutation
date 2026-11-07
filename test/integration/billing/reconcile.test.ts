/**
 * 결제 reconcile(`src/billing/reconcile.ts`, 계획 §3-5 · §Step 3 수용 기준 3) — 실제 Postgres · `atmark_billing` 롤 · 가짜 공급자 · 가짜 시계.
 *
 *   ① 여러 틱에 걸친 커서 이어 가기(목록 → stale → orgs → done) · 예산이 다 되면 커서 저장 뒤 `progress` · 24시간 안 다시 부르면 `idle`.
 *      목록에서 본 변화(해지)가 반영되고, 목록에 없는 해지(stale 단계)도 잡힌다 — 가짜 공급자는 id 목록도 페이지로 끊고(2개) 상태를 주지 않으면
 *      해지를 뺀다: stale 단계가 `next` 를 따르고 상태 다섯을 명시해야 통과한다(예전에는 DB 에 남은 다른 테스트의 구독과 무작위 id 순서에 따라
 *      한 묶음에 이 테스트의 구독이 셋 이상 들면 뒤쪽 해지가 빠졌다 — 전체 스위트에서만 보이던 실패의 근본 원인). 새 판도 앞 판의 completed_at 을 잇는다.
 *   ② 운영자 행 불변(지배해도·못 해도) · 유예 만료 → `grace_expired` 한 번(두 번째 판은 noop). 결정 시각은 DB now() 라(L-1) 유예 시작을 DB 에서 과거로 옮긴다.
 *   ③ 웹훅 누락: 2시간~7일 전 변화에 이벤트가 없으면 `billing.webhook_missed` · 이벤트가 있으면 아니다.
 *   ④ 스위치 꺼짐 → 건너뜀(`reconcile_skipped` · 알람 메트릭 0) · 켜졌는데 키 자리표시 → `provider_auth_failed`.
 *   ⑤ Paddle 호출 순간 열린 DB 트랜잭션 0.
 *   ⑥ 한 조직이 실패해도(DB 오류) 그 조직만 되돌리고 `reconcile_org_failed` + SQLSTATE 로그(조직 id 없음) · 나머지 조직은 반영 · 판은 끝난다(M-3).
 *      교착·직렬화 실패(40P01·40001)는 한 번 다시 해 풀리면 실패가 아니다 · 연결 오류(08xxx)는 틱을 던져 커서가 그 조직을 넘지 않는다(N-5).
 *   ⑦ stale 한 묶음이 `RECONCILE_STALE_MAX_PAGES`(5쪽)를 넘으면 메트릭 `reconcile_skipped` + 로그 뒤 그 묶음을 넘기고 틱을 끝낸다(N-4).
 *   ⑧ 단일 실행(코드 리뷰 M10): 다른 세션이 실행 잠금을 쥐고 있으면 `concurrent` · 공급자 호출 0 · 커서 불변. 커서 저장은 run_id CAS 다.
 *      `concurrent` 마다 메트릭 `billing.reconcile_concurrent` · 수동 restart 가 `concurrent` 로 끝나면 응답 `restartApplied: false` + 경고 로그(N5).
 *   ⑨ 재검토 N5: 한 틱 = 전용 연결 하나 — 풀이 커도(3) 잠금 해제가 같은 세션에서 일어나 틱 뒤 다른 세션이 곧바로 잡는다 · 틱마다 마지막 완료의
 *      나이(`billing.reconcile_completed_age_seconds`)를 낸다(스위치 꺼짐이면 0).
 *
 * **이 파일은 프로세스 사이에서 직렬화된다**(코드 리뷰 M10 가설 A). `billing_reconcile_state` 는 한 행(id = 1)이고 테스트마다 판을 새로 연다 —
 * 작업자 여럿이 같은 TEST_DATABASE_URL 에서 `test:mod` 를 동시에 돌리면 이 파일이 여러 벌 겹쳐 서로의 판·커서를 덮는다. `beforeAll` 이 세션
 * advisory 잠금(`test:billing_reconcile_state`)을 쥐고 `afterAll` 이 푼다. 운영 실행 잠금(`billing_reconcile_run`)과는 다른 키다.
 */

import type { Pool, PoolClient } from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { PROVIDER_GRACE_DAYS } from '../../../src/billing/constants';
import { RECONCILE_STALE_AFTER_MS, RECONCILE_STALE_MAX_PAGES, reconcileCompletedAgeSeconds, runReconcile } from '../../../src/billing/reconcile';
import type { ListSubscriptionsQuery, SubscriptionPage } from '../../../src/billing/provider';
import { processBillingMessage, type BillingSyncDependencies } from '../../../src/billing/sync';
import { loadReconcileState, saveReconcileState } from '../../../src/db/repositories/billing';
import { adminRolePool, AVAILABLE, ownerPool } from '../admin/support';
import { billingOrg, billingPool, captureMetrics, failingPool, FakeProvider, message, ourCheckout, subscription, transaction } from './support';

const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;

describe.skipIf(!AVAILABLE)('결제 reconcile — 커서 · 운영자 행 불변 · 유예 만료 · 웹훅 누락', () => {
  let owner: Pool;
  let admin: Pool;
  let billing: Pool;
  let metrics: ReturnType<typeof captureMetrics>;
  let serial: PoolClient;
  beforeAll(async () => {
    owner = ownerPool();
    admin = adminRolePool();
    billing = billingPool();
    serial = await owner.connect();
    await serial.query(`SELECT pg_advisory_lock(hashtext('test:billing_reconcile_state'))`);
  }, 120_000);
  afterAll(async () => {
    await serial.query(`SELECT pg_advisory_unlock(hashtext('test:billing_reconcile_state'))`);
    serial.release();
    await Promise.all([owner.end(), admin.end(), billing.end()]);
  });
  afterEach(() => metrics?.restore());

  function deps(provider: FakeProvider | null, allow: readonly string[], now: () => Date = () => new Date(), enabled = true): BillingSyncDependencies {
    return { pool: billing, environment: 'sandbox', enabled, provider, sandboxAllowlist: allow, now };
  }

  /** 가짜 시계 — 대기(300ms)만 시간을 쓴다. */
  function clock() {
    let t = 0;
    return { elapsedMs: () => t, sleep: (ms: number) => ((t += ms), Promise.resolve()) };
  }

  async function entitlement(organizationId: string) {
    const row = await owner.query<{ plan_code: string; source: string; cause: string; version: string }>(
      'SELECT plan_code, source, cause, version::text AS version FROM org_entitlements WHERE organization_id = $1',
      [organizationId],
    );
    return row.rows[0] ?? null;
  }

  async function subStatus(id: string): Promise<string | undefined> {
    return (await owner.query<{ status: string }>('SELECT status FROM billing_subscriptions WHERE provider_subscription_id = $1', [id])).rows[0]?.status;
  }

  /** 결속까지(이벤트 한 번). */
  async function bound(provider: FakeProvider, d: BillingSyncDependencies, plan: 'beta' | null, sub: Partial<Parameters<typeof subscription>[0]> = {}) {
    const org = await billingOrg(owner, plan);
    const txn = await ourCheckout(admin, org);
    const s = subscription({ organizationId: org.id, updatedAt: new Date(Date.now() - DAY), ...sub });
    provider.put(s, transaction({ id: txn, subscriptionId: s.id, customDataOrganizationId: org.id }));
    expect(await processBillingMessage({ ...d, sandboxAllowlist: [...d.sandboxAllowlist, org.id] }, message({ subscriptionId: s.id, occurredAt: s.updatedAt.toISOString() }))).toBe('done');
    return { org, sub: s };
  }

  it('① 여러 틱에 걸친 커서 · 목록의 변화와 목록 밖 해지(stale) 반영 · 완료 뒤 24시간은 idle', async () => {
    metrics = captureMetrics();
    const provider = new FakeProvider('sandbox', billing);
    provider.pageSize = 2;
    const allow: string[] = [];
    const orgs = [];
    for (let i = 0; i < 7; i += 1) {
      const made = await bound(provider, deps(provider, allow), null);
      allow.push(made.org.id);
      orgs.push(made);
    }
    const [first, second] = orgs;
    if (first === undefined || second === undefined) throw new Error('준비 실패');
    // 웹훅 없이 바뀐 것: 하나는 목록에 남은 채 past_due→ 해지 예정(목록에 보인다), 하나는 해지(목록에서 사라진다 — stale 단계가 잡는다).
    provider.put({ ...first.sub, scheduledChange: { action: 'cancel', effectiveAt: new Date(Date.now() + 10 * DAY) }, updatedAt: new Date(Date.now() - 20 * HOUR) });
    provider.put({ ...second.sub, status: 'canceled', updatedAt: new Date(Date.now() - 20 * HOUR) });

    const d = deps(provider, allow);
    const c = clock();
    const tick1 = await runReconcile(d, { restart: true, clock: c, budgetMs: 200 });
    expect(tick1).toMatchObject({ status: 'progress', phase: 'list' });
    const saved = await owner.query<{ phase: string; paddle_cursor: string | null }>('SELECT phase, paddle_cursor FROM billing_reconcile_state WHERE id = 1');
    expect(saved.rows[0]?.phase).toBe('list');
    expect(saved.rows[0]?.paddle_cursor).not.toBeNull();

    let last = tick1;
    for (let i = 0; i < 10 && last.status === 'progress'; i += 1) last = await runReconcile(d, { clock: clock(), budgetMs: 200 });
    expect(last).toMatchObject({ status: 'completed', phase: 'done' });
    const sched = await owner.query<{ scheduled_change_action: string | null }>('SELECT scheduled_change_action FROM billing_subscriptions WHERE provider_subscription_id = $1', [first.sub.id]);
    expect(sched.rows[0]?.scheduled_change_action).toBe('cancel');
    expect(await subStatus(second.sub.id)).toBe('canceled');
    // 해지된 구독의 조직 — provider 행이 Free 로(원인 reconcile).
    expect(await entitlement(second.org.id)).toMatchObject({ plan_code: 'free', source: 'provider', cause: 'reconcile', version: '2' });
    expect(await entitlement(first.org.id)).toMatchObject({ plan_code: 'pro', version: '1' });
    // stale 단계는 상태 다섯을 명시했다(비우면 이 가짜는 해지를 뺀다).
    expect(provider.calls.filter((name) => name === 'listSubscriptions').length).toBeGreaterThan(1);
    // 24시간 안에 다시 부르면 아무것도 하지 않는다.
    const calls = provider.calls.length;
    expect(await runReconcile(d, { clock: clock() })).toMatchObject({ status: 'idle' });
    expect(provider.calls.length).toBe(calls);
    expect(provider.violations).toEqual([]);
    // 새 판(restart)은 앞 판의 completed_at 을 잇는다(L-5) — 진행 중에도 "마지막 완료" 가 지워지지 않는다.
    const done = await owner.query<{ completed_at: Date }>('SELECT completed_at FROM billing_reconcile_state WHERE id = 1');
    const restarted = await runReconcile(d, { restart: true, clock: c, budgetMs: 0 });
    expect(restarted.status).toBe('progress');
    const carried = await owner.query<{ phase: string; completed_at: Date | null }>('SELECT phase, completed_at FROM billing_reconcile_state WHERE id = 1');
    expect(carried.rows[0]).toEqual({ phase: 'list', completed_at: done.rows[0]?.completed_at });
    for (let i = 0; i < 20 && (await owner.query<{ phase: string }>('SELECT phase FROM billing_reconcile_state WHERE id = 1')).rows[0]?.phase !== 'done'; i += 1) {
      await runReconcile(d, { clock: clock(), budgetMs: 200 });
    }
  });

  it('② 운영자 행은 reconcile 이 덮지 않는다 · 유예 만료는 grace_expired 한 번', async () => {
    metrics = captureMetrics();
    const provider = new FakeProvider('sandbox', billing);
    const allow: string[] = [];
    // 운영자 beta 행 + 결속된 pro 활성(이벤트에서 이미 보류됐다).
    const held = await bound(provider, deps(provider, allow), 'beta');
    allow.push(held.org.id);
    // 유예 중인 provider 행 — 기간 시작 1일 전.
    const t0 = Date.now();
    const lapsing = await bound(provider, deps(provider, allow), null, { status: 'past_due', currentPeriodStart: new Date(t0 - DAY), updatedAt: new Date(t0 - 12 * HOUR) });
    allow.push(lapsing.org.id);
    expect(await entitlement(lapsing.org.id)).toMatchObject({ plan_code: 'pro', source: 'provider', version: '1' });

    // 유예(14일)가 지났다 — 결정 시각은 DB now() 라(L-1) λ 시계를 옮기는 대신 유예 시작을 15일 전으로 옮긴다(소유자 롤 — 순서 칸은 그대로).
    // reconcile 의 목록 스냅숏은 min(기간 시작, 이미 적힌 값) 이라 옮긴 값이 남는다.
    await owner.query(`UPDATE billing_subscriptions SET past_due_since = now() - interval '15 days' WHERE provider_subscription_id = $1`, [lapsing.sub.id]);
    const report = await runReconcile(deps(provider, allow), { restart: true, clock: clock() });
    expect(report.status).toBe('completed');
    expect(await entitlement(held.org.id)).toMatchObject({ plan_code: 'beta', source: 'default', version: '1' });
    expect(await entitlement(lapsing.org.id)).toMatchObject({ plan_code: 'free', source: 'provider', cause: 'grace_expired', version: '2' });
    const grace = await owner.query<{ grace_until: Date | null }>('SELECT grace_until FROM org_entitlements WHERE organization_id = $1', [lapsing.org.id]);
    expect(grace.rows[0]?.grace_until).toBeNull();
    // 두 번째 판 — 쓸 것이 없다.
    await runReconcile(deps(provider, allow), { restart: true, clock: clock() });
    expect(await entitlement(lapsing.org.id)).toMatchObject({ version: '2' });
    expect(PROVIDER_GRACE_DAYS).toBe(14);
    expect(provider.violations).toEqual([]);
  });

  it('③ 웹훅 누락 — 2시간~7일 전 변화에 이벤트가 없으면 webhook_missed · 이벤트가 있거나 너무 최근·오래된 변화는 아니다', async () => {
    metrics = captureMetrics();
    const provider = new FakeProvider('sandbox', billing);
    const allow: string[] = [];
    const heard = await bound(provider, deps(provider, allow), null, { updatedAt: new Date(Date.now() - 3 * HOUR) });
    allow.push(heard.org.id);
    // 결속은 됐지만 그 뒤 Paddle 쪽 변화(3시간 전)에 웹훅이 오지 않았다.
    const silent = await bound(provider, deps(provider, allow), null, { updatedAt: new Date(Date.now() - 5 * DAY) });
    allow.push(silent.org.id);
    provider.put({ ...silent.sub, updatedAt: new Date(Date.now() - 3 * HOUR) });
    // 너무 최근(30분) · 너무 오래(8일)는 판정하지 않는다.
    const recent = await bound(provider, deps(provider, allow), null, { updatedAt: new Date(Date.now() - 8 * DAY) });
    allow.push(recent.org.id);
    provider.put({ ...recent.sub, updatedAt: new Date(Date.now() - 30 * 60 * 1000) });
    const old = await bound(provider, deps(provider, allow), null, { updatedAt: new Date(Date.now() - 9 * DAY) });
    allow.push(old.org.id);
    provider.put({ ...old.sub, updatedAt: new Date(Date.now() - 8 * DAY) });

    const report = await runReconcile(deps(provider, allow), { restart: true, clock: clock() });
    expect(report.missed).toBe(1);
    expect(metrics.count('atmark.billing.webhook_missed')).toBe(1);
  });

  it('⑥ 한 조직이 DB 오류로 실패해도 그 조직만 되돌리고 메트릭 + SQLSTATE 로그(조직 id 없음) · 나머지 조직은 반영 · 판은 끝난다', async () => {
    metrics = captureMetrics();
    const provider = new FakeProvider('sandbox', billing);
    const allow: string[] = [];
    const broken = await bound(provider, deps(provider, allow), null);
    const healthy = await bound(provider, deps(provider, allow), null);
    allow.push(broken.org.id, healthy.org.id);
    // 둘 다 웹훅 없이 해지됐다.
    for (const made of [broken, healthy]) provider.put({ ...made.sub, status: 'canceled', updatedAt: new Date(Date.now() - HOUR) });
    // broken 조직의 재계산 잠금에서 교착(40P01)이 난다 — 그 트랜잭션만 되돌려진다.
    const failing = failingPool(billing, broken.org.id, '40P01');
    const report = await runReconcile({ ...deps(provider, allow), pool: failing }, { restart: true, clock: clock() });
    expect(report.status).toBe('completed');
    expect(await entitlement(healthy.org.id)).toMatchObject({ plan_code: 'free', source: 'provider', version: '2' });
    expect(await entitlement(broken.org.id)).toMatchObject({ plan_code: 'pro', version: '1' });
    expect(metrics.count('atmark.billing.reconcile_org_failed')).toBe(1);
    const failed = metrics.lines.filter((line) => line.includes('"billing.reconcile_org_failed"'));
    expect(failed).toHaveLength(1);
    expect(JSON.parse(failed[0] ?? '{}')).toMatchObject({ error_code: '40P01' });
    expect(metrics.lines.filter((line) => line.includes(broken.org.id))).toEqual([]);
    expect(provider.violations).toEqual([]);
  });

  it('⑥ N-5 — 교착(40P01)·직렬화 실패(40001)는 한 번 다시 해 풀리면 실패 메트릭 없이 반영된다', async () => {
    for (const state of ['40P01', '40001']) {
      metrics = captureMetrics();
      const provider = new FakeProvider('sandbox', billing);
      const allow: string[] = [];
      const flaky = await bound(provider, deps(provider, allow), null);
      allow.push(flaky.org.id);
      provider.put({ ...flaky.sub, status: 'canceled', updatedAt: new Date(Date.now() - HOUR) });
      const failing = failingPool(billing, flaky.org.id, state, 1);
      const report = await runReconcile({ ...deps(provider, allow), pool: failing }, { restart: true, clock: clock() });
      expect(report.status, state).toBe('completed');
      expect(failing.failures(), state).toBe(1);
      expect(await entitlement(flaky.org.id), state).toMatchObject({ plan_code: 'free', source: 'provider', version: '2' });
      expect(metrics.count('atmark.billing.reconcile_org_failed'), state).toBe(0);
      metrics.restore();
    }
  });

  it('⑥ N-5 — 연결 오류(08006)는 틱을 던진다(sync_failed) · 커서는 그 조직을 넘지 않는다 · 다음 틱이 그 조직을 반영한다', async () => {
    metrics = captureMetrics();
    const provider = new FakeProvider('sandbox', billing);
    const allow: string[] = [];
    const cut = await bound(provider, deps(provider, allow), null);
    allow.push(cut.org.id);
    provider.put({ ...cut.sub, status: 'canceled', updatedAt: new Date(Date.now() - HOUR) });
    const failing = failingPool(billing, cut.org.id, '08006');
    await expect(runReconcile({ ...deps(provider, allow), pool: failing }, { restart: true, clock: clock() })).rejects.toMatchObject({ code: '08006' });
    expect(metrics.count('atmark.billing.sync_failed')).toBe(1);
    expect(metrics.count('atmark.billing.reconcile_org_failed')).toBe(0);
    const saved = await owner.query<{ phase: string; org_cursor: string | null }>('SELECT phase, org_cursor FROM billing_reconcile_state WHERE id = 1');
    expect(saved.rows[0]?.phase).toBe('orgs');
    const cursor = saved.rows[0]?.org_cursor ?? null;
    expect(cursor === null || cursor < cut.org.id, `커서 ${String(cursor)} 가 ${cut.org.id} 를 넘었다`).toBe(true);
    expect(await entitlement(cut.org.id)).toMatchObject({ plan_code: 'pro', version: '1' });
    // 연결이 돌아오면 다음 틱이 저장된 커서에서 이어 그 조직을 반영한다.
    const next = await runReconcile(deps(provider, allow), { clock: clock() });
    expect(next.status).toBe('completed');
    expect(await entitlement(cut.org.id)).toMatchObject({ plan_code: 'free', source: 'provider', version: '2' });
  });

  it('⑦ N-4 — stale 한 묶음이 5쪽을 넘으면 reconcile_skipped + 로그 · 그 묶음을 넘기고(커서 = 묶음 끝) 틱을 끝낸다 · 다음 틱은 다음 묶음부터', async () => {
    metrics = captureMetrics();
    const provider = new FakeProvider('sandbox', billing);
    const allow: string[] = [];
    const made = await bound(provider, deps(provider, allow), null);
    allow.push(made.org.id);
    // id 조회는 언제나 `next` 를 준다(공급자 이상) — 따라가면 끝나지 않는다.
    const staleQueries: ListSubscriptionsQuery[] = [];
    const list = provider.listSubscriptions.bind(provider);
    provider.listSubscriptions = (query: ListSubscriptionsQuery): Promise<SubscriptionPage> => {
      if (query.ids === undefined) return list(query);
      staleQueries.push(query);
      return Promise.resolve({ items: [], next: `sub_${'z'.repeat(26)}` });
    };
    const report = await runReconcile(deps(provider, allow), { restart: true, clock: clock() });
    expect(report).toMatchObject({ status: 'progress', phase: 'stale' });
    expect(staleQueries).toHaveLength(RECONCILE_STALE_MAX_PAGES);
    expect(RECONCILE_STALE_MAX_PAGES).toBe(5);
    expect(metrics.count('atmark.billing.reconcile_skipped')).toBe(1);
    const logged = metrics.lines.filter((line) => line.includes('"billing.reconcile_stale_pages"'));
    expect(logged).toHaveLength(1);
    const firstChunk = staleQueries[0]?.ids ?? [];
    const saved = await owner.query<{ phase: string; paddle_cursor: string | null }>('SELECT phase, paddle_cursor FROM billing_reconcile_state WHERE id = 1');
    expect(saved.rows[0]).toEqual({ phase: 'stale', paddle_cursor: firstChunk[firstChunk.length - 1] });
    // 다음 틱은 넘긴 묶음 뒤에서 시작한다(같은 묶음을 다시 돌지 않는다).
    staleQueries.length = 0;
    await runReconcile(deps(provider, allow), { clock: clock() });
    const cursor = saved.rows[0]?.paddle_cursor ?? '';
    expect(staleQueries.every((query) => (query.ids ?? []).every((id) => id > cursor))).toBe(true);
  });

  it('④ 스위치 꺼짐 → 건너뜀(알람 메트릭 0 — 키가 자리표시여도) · 켜졌는데 키 자리표시 → provider_auth_failed', async () => {
    metrics = captureMetrics();
    const provider = new FakeProvider('sandbox', billing);
    expect(await runReconcile(deps(null, [], undefined, false))).toMatchObject({ status: 'skipped' });
    expect(await runReconcile(deps(provider, [], undefined, false))).toMatchObject({ status: 'skipped' });
    expect(metrics.count('atmark.billing.reconcile_skipped')).toBe(2);
    expect(metrics.count('atmark.billing.provider_auth_failed')).toBe(0);
    expect(provider.calls).toEqual([]);
    expect(await runReconcile(deps(null, []))).toMatchObject({ status: 'auth_failed' });
    expect(metrics.count('atmark.billing.provider_auth_failed')).toBe(1);
  });

  it('⑧ M10 단일 실행 — 다른 세션이 실행 잠금을 쥐면 concurrent(공급자 호출 0 · 커서 불변 · 알람 메트릭 0) · 풀리면 다시 돈다 · 커서 저장은 run_id CAS', async () => {
    metrics = captureMetrics();
    const provider = new FakeProvider('sandbox', billing);
    const other = await owner.connect();
    try {
      await other.query(`SELECT pg_advisory_lock(hashtextextended('billing_reconcile_run', 0))`);
      const before = await loadReconcileState(owner);
      expect(await runReconcile(deps(provider, []), { restart: true, clock: clock() })).toMatchObject({ status: 'concurrent', phase: null, restartApplied: false });
      expect(provider.calls).toEqual([]);
      expect(await loadReconcileState(owner)).toEqual(before);
      expect(metrics.count('atmark.billing.sync_failed')).toBe(0);
      // N5 — concurrent 는 메트릭을 올리고, 수동 restart 가 적용되지 않았다는 사실이 응답과 경고 로그로 보인다.
      expect(metrics.count('atmark.billing.reconcile_concurrent')).toBe(1);
      expect(metrics.lines.filter((line) => line.includes('"billing.reconcile_restart_not_applied"'))).toHaveLength(1);
      // restart 없는 틱의 concurrent 는 restartApplied 가 null 이다.
      expect(await runReconcile(deps(provider, []), { clock: clock() })).toMatchObject({ status: 'concurrent', restartApplied: null });
      expect(metrics.count('atmark.billing.reconcile_concurrent')).toBe(2);
      await other.query(`SELECT pg_advisory_unlock(hashtextextended('billing_reconcile_run', 0))`);
    } finally {
      other.release();
    }
    const ran = await runReconcile(deps(provider, []), { restart: true, clock: clock(), budgetMs: 0 });
    expect(ran.status).toBe('progress');
    expect(ran.restartApplied).toBe(true);
    // 틱이 끝나면 잠금을 풀었다 — 다른 세션이 곧바로 잡을 수 있다.
    const probe = await owner.query<{ locked: boolean }>(
      `SELECT pg_try_advisory_lock(hashtextextended('billing_reconcile_run', 0)) AS locked, pg_advisory_unlock(hashtextextended('billing_reconcile_run', 0))`,
    );
    expect(probe.rows[0]?.locked).toBe(true);

    // CAS — 기대한 판(run_id)이 아니면 0행이고 행은 그대로다(다른 실행이 새 판을 연 뒤의 늦은 저장).
    const current = await loadReconcileState(billing);
    if (current === null) throw new Error('판이 없다');
    const { id: _id, ...row } = current;
    expect(await saveReconcileState(billing, { ...row, phase: 'done' }, '00000000-0000-4000-8000-000000000000')).toBe(false);
    expect(await loadReconcileState(billing)).toEqual(current);
    expect(await saveReconcileState(billing, row, current.run_id)).toBe(true);
    // 판을 끝내 둔다(다른 테스트가 idle·새 판을 예측할 수 있게) — ① 끝과 같은 방식.
    for (let i = 0; i < 20 && (await loadReconcileState(owner))?.phase !== 'done'; i += 1) {
      await runReconcile(deps(provider, []), { clock: clock(), budgetMs: 200 });
    }
  });
  it('⑨ N5 — 풀이 커도(3) 잠금·작업·해제가 전용 연결 하나에서: 틱 뒤 다른 세션이 곧바로 잡는다 · 연결은 하나만 빌린다 · 완료 나이를 낸다', async () => {
    metrics = captureMetrics();
    const wide = billingPool(3);
    try {
      const provider = new FakeProvider('sandbox', wide);
      let peak = 0;
      const list = provider.listSubscriptions.bind(provider);
      provider.listSubscriptions = (query: ListSubscriptionsQuery): Promise<SubscriptionPage> => {
        peak = Math.max(peak, wide.totalCount);
        return list(query);
      };
      const wideDeps: BillingSyncDependencies = { pool: wide, environment: 'sandbox', enabled: true, provider, sandboxAllowlist: [], now: () => new Date() };
      for (let i = 0; i < 3; i += 1) {
        const report = await runReconcile(wideDeps, { restart: i === 0, clock: clock(), budgetMs: i === 0 ? 1 : 200 });
        expect(['progress', 'completed', 'idle']).toContain(report.status);
        const probe = await owner.query<{ locked: boolean }>(
          `SELECT pg_try_advisory_lock(hashtextextended('billing_reconcile_run', 0)) AS locked, pg_advisory_unlock(hashtextextended('billing_reconcile_run', 0))`,
        );
        expect(probe.rows[0]?.locked, `틱 ${String(i)} 뒤 잠금이 풀리지 않았다`).toBe(true);
      }
      // 한 틱은 연결 하나만 쓴다(풀이 3 이어도 둘째 연결을 열지 않는다).
      expect(peak).toBe(1);
      expect(provider.violations).toEqual([]);
      expect(metrics.lines.filter((line) => line.includes('"billing.reconcile_lock_release_missed"'))).toEqual([]);
      // 틱마다 완료 나이를 낸다(진행 중이면 앞 판의 완료 시각을 이어받으므로 — L-5 — 값은 그 판의 나이다).
      const ageOf = (line: string): unknown => (JSON.parse(line) as Record<string, unknown>)['atmark.billing.reconcile_completed_age_seconds'];
      const ageLines = (): string[] => metrics.lines.filter((line) => line.includes('"atmark.billing.reconcile_completed_age_seconds"'));
      expect(ageLines()).toHaveLength(3);
      for (const line of ageLines()) expect(typeof ageOf(line)).toBe('number');
      // 판을 끝내면 나이는 26시간보다 훨씬 작다.
      for (let i = 0; i < 20 && (await loadReconcileState(owner))?.phase !== 'done'; i += 1) {
        await runReconcile(wideDeps, { clock: clock(), budgetMs: 200 });
      }
      await runReconcile(wideDeps, { clock: clock() });
      expect(Number(ageOf(ageLines().at(-1) ?? '{}'))).toBeLessThan(RECONCILE_STALE_AFTER_MS / 1000 / 2);
      // 스위치가 꺼져 있으면 0(대조를 기대하지 않는다 — 결측이 아니라 0 을 내 stale 알람을 울리지 않는다).
      await runReconcile({ ...wideDeps, enabled: false });
      expect(ageOf(ageLines().at(-1) ?? '{}')).toBe(0);
    } finally {
      await wide.end();
    }
  });

  it('완료 나이 계산 — 완료 시각 → 없으면 시작 시각 → 판이 없으면 0', () => {
    const now = new Date('2026-09-26T12:00:00Z');
    expect(reconcileCompletedAgeSeconds(null, now)).toBe(0);
    expect(reconcileCompletedAgeSeconds({ completed_at: new Date('2026-09-25T10:00:00Z'), started_at: new Date('2026-09-26T11:00:00Z') }, now)).toBe(26 * 3600);
    expect(reconcileCompletedAgeSeconds({ completed_at: null, started_at: new Date('2026-09-26T11:00:00Z') }, now)).toBe(3600);
    expect(reconcileCompletedAgeSeconds({ completed_at: new Date('2026-09-26T13:00:00Z'), started_at: now }, now)).toBe(0);
  });
});
