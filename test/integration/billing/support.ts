/**
 * sync·reconcile 통합 테스트의 공용 부품 — 실제 Postgres(`atmark_billing` 롤 풀 · 소유자·admin 롤 풀) + **가짜 공급자**(Paddle 호출 0).
 *
 * 가짜 공급자는 부를 때마다 **billing 풀에서 빌려 간 연결 중 트랜잭션 안(`T`·`E`)인 것이 없는지** 본다(계획 §3-5 "Paddle 호출은 DB 트랜잭션
 * 밖에서만"). reconcile 은 한 틱 동안 전용 연결 하나를 쥐므로(재검토 N5) "빌려 간 연결이 있다" 만으로는 위반이 아니다 — 그 연결의
 * 트랜잭션 상태(`getTransactionStatus`)를 본다. 어긴 호출은 `violations` 에 남는다.
 *
 * 실제 Paddle 을 흉내 내는 세 가지:
 *   - 목록은 **모든 질의에서** `pageSize` 로 끊고 `next` 를 준다(id 필터도) — 호출자가 `next` 를 따르지 않으면 뒤쪽이 빠진다.
 *   - 상태 필터를 주지 않으면 `canceled` 를 **뺀다**(공급자 기본값이 해지를 빼는 경우를 가정 — 해지를 보려는 호출은 상태를 명시해야 한다).
 *   - 고객은 이메일로 다시 쓴다(`customerFor(email)`) — 같은 사람이 두 조직에서 결제하면 같은 `ctm_` 가 온다(H-1).
 */

import { randomBytes } from 'node:crypto';

import type { Pool, PoolClient } from 'pg';

import { createOrganizationOp } from '../../../src/admin/ops/agents';
import type { PaddleEnvironment } from '../../../src/billing/constants';
import type { PaidPlanCode } from '../../../src/billing/plans';
import {
  ProviderNotFoundError,
  type BillingProviderApi,
  type CreatePortalSessionInput,
  type CreateTransactionInput,
  type ListSubscriptionsQuery,
  type NormalizedSubscription,
  type NormalizedTransaction,
  type ProviderSubscriptionStatus,
  type SubscriptionPage,
} from '../../../src/billing/provider';
import type { BillingSyncMessage } from '../../../src/billing/queue-message';
import { createPool } from '../../../src/db/client';
import { insertCheckout } from '../../../src/db/repositories/billing';
import { setLogSink } from '../../../src/observability/logger';
import { APP_URL, suffix, userIdOf } from '../admin/support';
import { grantPlan } from '../../support/entitlements';

export const id26 = (): string => randomBytes(13).toString('hex');
export const sha = (): string => randomBytes(32).toString('hex');

function roleUrl(explicit: string | undefined, role: string): string {
  if (explicit !== undefined && explicit.trim() !== '') return explicit;
  if (APP_URL.trim() === '') return '';
  const url = new URL(APP_URL);
  url.username = role;
  url.password = '';
  return url.toString();
}

/** 운영 sync λ 와 같은 롤 · 같은 풀 크기(1). reconcile 이 풀 크기에 기대지 않는지(재검토 N5) 보는 테스트만 `max` 를 키운다. */
export function billingPool(max = 1): Pool {
  return createPool(roleUrl(process.env['TEST_BILLING_DATABASE_URL'], 'atmark_billing'), { max });
}

/** 활성 조직(소유자 롤로 만든다) — 요금제 행을 줄 수 있다(`default`/`backfill`). */
export async function billingOrg(owner: Pool, plan: 'beta' | 'free' | 'pro' | null = null): Promise<{ id: string; userId: string; ownerEmail: string }> {
  const ownerEmail = `bill-sync-${suffix()}@example.com`;
  const created = await createOrganizationOp(owner, { name: `bill-sync-${suffix()}`, ownerEmail });
  if (plan !== null) await grantPlan(owner, created.id, plan);
  return { id: created.id, userId: await userIdOf(owner, ownerEmail), ownerEmail };
}

/** 콘솔 체크아웃과 같은 경로(admin 롤)로 우리 거래 한 행. */
export async function ourCheckout(admin: Pool, org: { id: string; userId: string }, plan: PaidPlanCode = 'pro', environment: PaddleEnvironment = 'sandbox'): Promise<string> {
  const transactionId = `txn_${id26()}`;
  await insertCheckout(admin, { organizationId: org.id, provider: 'paddle', environment, transactionId, plan, createdByUserId: org.userId });
  return transactionId;
}

export function subscription(overrides: Partial<NormalizedSubscription> & { readonly organizationId: string | null }): NormalizedSubscription {
  const { organizationId, ...rest } = overrides;
  return {
    provider: 'paddle',
    environment: 'sandbox',
    id: `sub_${id26()}`,
    customerId: `ctm_${id26()}`,
    status: 'active',
    priceId: `pri_${id26()}`,
    planCode: 'pro',
    currentPeriodStart: new Date('2026-09-25T00:00:00.000Z'),
    currentPeriodEnd: new Date('2026-10-25T00:00:00.000Z'),
    scheduledChange: null,
    updatedAt: new Date('2026-09-25T00:00:01.000Z'),
    customDataOrganizationId: organizationId,
    ...rest,
  };
}

export function transaction(overrides: Partial<NormalizedTransaction> & { readonly id: string }): NormalizedTransaction {
  return {
    provider: 'paddle',
    environment: 'sandbox',
    status: 'completed',
    subscriptionId: null,
    customerId: null,
    customDataOrganizationId: null,
    createdAt: new Date('2026-09-25T00:00:00.000Z'),
    checkoutUrl: null,
    ...overrides,
  };
}

const BORROWED = new WeakMap<Pool, Set<PoolClient>>();

/** 이 풀에서 지금 빌려 간 연결(풀의 acquire·release 이벤트로 센다 — 풀마다 리스너 한 쌍). */
function borrowedClients(pool: Pool): ReadonlySet<PoolClient> {
  const known = BORROWED.get(pool);
  if (known !== undefined) return known;
  const borrowed = new Set<PoolClient>();
  pool.on('acquire', (client) => borrowed.add(client));
  pool.on('release', (_error, client) => borrowed.delete(client));
  BORROWED.set(pool, borrowed);
  return borrowed;
}

/** 가짜 공급자 — 구독·거래 표 · 호출 기록 · 다음 호출 실패 주입 · 트랜잭션 밖 단언. */
export class FakeProvider implements BillingProviderApi {
  readonly provider = 'paddle' as const;
  readonly subscriptions = new Map<string, NormalizedSubscription>();
  readonly transactions = new Map<string, NormalizedTransaction>();
  readonly calls: string[] = [];
  readonly violations: string[] = [];
  /** 다음 호출(들)이 던질 오류 — 앞에서부터 하나씩 쓴다. */
  readonly failures: Error[] = [];
  /** 목록 페이지 크기(테스트가 작게 해 여러 페이지를 만든다). */
  pageSize = 50;
  /** 이메일 → 고객(Paddle 은 같은 이메일에 같은 고객을 준다). */
  private readonly customers = new Map<string, string>();

  /** 지금 빌려 간 billing 풀 연결. */
  private readonly borrowed: ReadonlySet<PoolClient>;

  constructor(
    readonly environment: PaddleEnvironment,
    pool: Pool,
  ) {
    this.borrowed = borrowedClients(pool);
  }

  /** 이 이메일의 고객 id — 처음이면 만든다. */
  customerFor(email: string): string {
    const known = this.customers.get(email);
    if (known !== undefined) return known;
    const made = `ctm_${id26()}`;
    this.customers.set(email, made);
    return made;
  }

  put(sub: NormalizedSubscription, origin?: NormalizedTransaction): void {
    this.subscriptions.set(sub.id, sub);
    if (origin !== undefined) this.transactions.set(origin.id, origin);
  }

  private enter(name: string): void {
    this.calls.push(name);
    if ([...this.borrowed].some((client) => client.getTransactionStatus() === 'T' || client.getTransactionStatus() === 'E')) this.violations.push(name);
    const failure = this.failures.shift();
    if (failure !== undefined) throw failure;
  }

  fetchSubscription(id: string): Promise<NormalizedSubscription> {
    try {
      this.enter('fetchSubscription');
    } catch (error) {
      return Promise.reject(error as Error);
    }
    const found = this.subscriptions.get(id);
    return found === undefined ? Promise.reject(new ProviderNotFoundError()) : Promise.resolve(found);
  }

  listSubscriptions(query: ListSubscriptionsQuery): Promise<SubscriptionPage> {
    try {
      this.enter('listSubscriptions');
    } catch (error) {
      return Promise.reject(error as Error);
    }
    // 상태를 주지 않으면 해지를 뺀다(공급자 기본값 가정).
    const statuses: readonly ProviderSubscriptionStatus[] = query.statuses ?? ['active', 'trialing', 'past_due', 'paused'];
    const all = [...this.subscriptions.values()]
      .filter(
        (sub) =>
          statuses.includes(sub.status) &&
          (query.ids === undefined || query.ids.includes(sub.id)) &&
          (query.customerId === undefined || query.customerId === sub.customerId),
      )
      .sort((a, b) => (a.id < b.id ? -1 : 1))
      .filter((sub) => query.after === undefined || query.after === null || sub.id > query.after);
    const items = all.slice(0, this.pageSize);
    const last = items[items.length - 1];
    return Promise.resolve({ items, next: all.length > items.length && last !== undefined ? last.id : null });
  }

  fetchTransaction(id: string): Promise<NormalizedTransaction> {
    try {
      this.enter('fetchTransaction');
    } catch (error) {
      return Promise.reject(error as Error);
    }
    const found = this.transactions.get(id);
    return found === undefined ? Promise.reject(new ProviderNotFoundError()) : Promise.resolve(found);
  }

  listTransactionsBySubscription(subscriptionId: string): Promise<readonly NormalizedTransaction[]> {
    try {
      this.enter('listTransactionsBySubscription');
    } catch (error) {
      return Promise.reject(error as Error);
    }
    return Promise.resolve(
      [...this.transactions.values()].filter((txn) => txn.subscriptionId === subscriptionId).sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime()),
    );
  }

  createTransaction(_input: CreateTransactionInput): Promise<NormalizedTransaction> {
    return Promise.reject(new Error('sync 는 거래를 만들지 않는다'));
  }

  cancelTransaction(_id: string): Promise<void> {
    return Promise.reject(new Error('sync 는 거래를 취소하지 않는다'));
  }

  createPortalSession(_input: CreatePortalSessionInput): Promise<{ readonly url: string }> {
    return Promise.reject(new Error('sync 는 포털을 열지 않는다'));
  }
}

/** 이벤트 메시지(큐 메시지 모양 — 진단 칸 없음). */
export function message(overrides: Partial<BillingSyncMessage> = {}): BillingSyncMessage {
  return {
    v: 1,
    provider: 'paddle',
    environment: 'sandbox',
    eventId: `evt_${id26()}`,
    eventType: 'subscription.updated',
    occurredAt: '2026-09-25T00:00:02.000Z',
    notificationId: null,
    payloadSha256: sha(),
    subscriptionId: null,
    transactionId: null,
    customerId: null,
    receivedAt: '2026-09-25T00:00:03.000Z',
    ...overrides,
  };
}

/** 로그 줄(EMF 메트릭 포함)을 모은다 — `count(name)` 은 그 메트릭이 난 횟수 · `lines` 는 모든 줄. 끝나면 `restore()`. */
export function captureMetrics(): { count: (name: string) => number; lines: readonly string[]; restore: () => void } {
  const lines: string[] = [];
  const restore = setLogSink((line) => lines.push(line));
  return {
    lines,
    count: (name) =>
      lines.filter((line) => {
        try {
          return Object.hasOwn(JSON.parse(line) as object, name);
        } catch {
          return false;
        }
      }).length,
    restore,
  };
}

/**
 * 이 조직의 조직 잠금 문장에서 주어진 SQLSTATE 로 실패하는 풀(나머지는 실제 풀 그대로). `times` 번 실패한 뒤로는 통과한다(기본 무한 —
 * 재시도 테스트가 1 을 준다). `failures()` 는 지금까지 낸 실패 수.
 */
export function failingPool(pool: Pool, organizationId: string, sqlState: string, times = Number.POSITIVE_INFINITY): Pool & { failures: () => number } {
  let failed = 0;
  const wrapClient = (client: PoolClient): PoolClient =>
    new Proxy(client, {
      get(target, key) {
        if (key !== 'query') {
          const value = Reflect.get(target, key) as unknown;
          return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
        }
        return (text: unknown, values?: unknown) => {
          if (failed < times && typeof text === 'string' && text.includes("'org_entitlements:'") && Array.isArray(values) && values.includes(organizationId)) {
            failed += 1;
            return Promise.reject(Object.assign(new Error('deadlock detected'), { code: sqlState }));
          }
          return target.query(text as string, values as unknown[]);
        };
      },
    });
  // withTransaction 은 connect() 로 연결을 빌린다 — 그 연결만 감싼다. 나머지(pool.query 등)는 실제 풀에 묶어 그대로 부른다.
  return new Proxy(pool as Pool & { failures: () => number }, {
    get(target, key) {
      if (key === 'failures') return () => failed;
      if (key === 'connect') return async () => wrapClient(await target.connect());
      const value = Reflect.get(target, key) as unknown;
      return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  });
}
