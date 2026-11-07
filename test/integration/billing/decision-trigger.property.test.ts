/**
 * 결정 함수 ↔ DB 트리거 합치(코드 검토 M-7) — 실제 Postgres · **`atmark_billing` 롤** · 시드 고정 무작위.
 *
 * 무작위 지금 행(없음 · default · operator(넘김 여부) · provider — 요금제·칸 섞기·유예 과거/미래/없음)과 무작위 구독 묶음·계기에 대해:
 *   ① `decideProviderEntitlement` 가 write 를 내면 그대로 쓴 버전을 트리거(출처-롤 · 카탈로그 · 감사 짝)가 **받아들인다**(커밋까지).
 *   ② noop 이유가 `operator_row_*`(held · kept)이면 원하는 요금제를 **억지로 써 봤을 때 트리거가 거부한다**(42501) — 그 거부가 **D-3 규칙**
 *      (`org_entitlements_source_by_role` 의 "Free 로 떨어뜨리지 못한다" · "칸별로 넘지 못한다")에서 왔는지 메시지로 확인한다. 42501 은 칸 권한 거부·
 *      카탈로그 규칙·출처 규칙도 같은 코드라, 코드만 보면 다른 이유의 거부가 속성을 통과시킨다.
 * 결정 시각은 트랜잭션의 `SELECT now()` — sync 와 같은 시계(L-1). 두 쪽이 한 번이라도 어긋나면 결정 함수는 쓰는데 트리거가 막거나(결제 적용 실패),
 * 결정 함수는 보류하는데 트리거는 허용하는(보류가 코드 규칙뿐인) 틈이 있다는 뜻이다. 반복마다 새 조직 하나(행은 지울 수 없다).
 */

import type { Pool, PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  ENTITLEMENTS_TABLE_MISSING,
  LIMIT_COLUMNS,
  PAID_PLAN_CODES,
  PLAN_CATALOG,
  type EntitlementLimits,
  type PaidPlanCode,
  type PlanCode,
} from '../../../src/billing/plans';
import { PROVIDER_SUBSCRIPTION_STATUSES } from '../../../src/billing/provider';
import { BILLING_SYNC_ACTOR, databaseNow } from '../../../src/billing/sync';
import { decideProviderEntitlement, type DecisionSubscription, type DecisionTrigger } from '../../../src/billing/sync-decision';
import { loadOrgEntitlementsControlRow, writeEntitlementVersion } from '../../../src/db/repositories/entitlements-write';
import { AVAILABLE, ownerPool } from '../admin/support';
import { billingOrg, billingPool } from './support';

const SEED = 20260925;
const ITERATIONS = 40;
const DAY = 24 * 60 * 60 * 1000;
const PLANS: readonly PlanCode[] = ['free', 'beta', 'pro', 'team', 'scale'];
const TRIGGERS: readonly DecisionTrigger[] = ['event', 'reconcile', 'operator_sync'];
/** D-3 거부 메시지(0400 `org_entitlements_source_by_role` — 운영자·백필 행 위의 provider 쓰기). 다른 42501(칸 권한·카탈로그·출처)과 가른다. */
const D3_REJECTIONS = [/^org_entitlements: 공급자는 운영자·백필 행을 Free 로 떨어뜨리지 못한다/, /^org_entitlements: 공급자 요금제가 운영자·백필 행의 한도를 칸별로 넘지 못한다/];

/** mulberry32 — 시드 고정 PRNG(실패를 그대로 재현한다). */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface RowPlan {
  readonly source: 'default' | 'operator' | 'provider';
  readonly cause: string;
  readonly plan: PlanCode;
  readonly limits: EntitlementLimits;
  readonly graceUntil: Date | null;
  readonly override: boolean;
}

describe.skipIf(!AVAILABLE)('결정 함수 ↔ 출처-롤 트리거 — 시드 고정 속성(M-7)', () => {
  let owner: Pool;
  let billing: Pool;
  beforeAll(() => {
    owner = ownerPool();
    billing = billingPool();
  });
  afterAll(async () => {
    await Promise.all([owner.end(), billing.end()]);
  });

  /** 지금 행을 소유자 롤로 심는다(감사 짝과 한 문장). */
  async function plant(organizationId: string, row: RowPlan): Promise<void> {
    const values = LIMIT_COLUMNS.map(([key]) => row.limits[key]);
    const columns = LIMIT_COLUMNS.map(([, column]) => column);
    await owner.query(
      `WITH audit AS (
         INSERT INTO billing_audit (organization_id, from_plan, to_plan, cause, actor, entitlement_version) VALUES ($1, NULL, $2, $3, 'test', 1)
       )
       INSERT INTO org_entitlements (organization_id, plan_code, source, cause, ${columns.join(', ')}, grace_until, provider_override_allowed, version)
       VALUES ($1, $2, $4, $3, ${columns.map((_c, i) => `$${String(i + 5)}`).join(', ')}, $${String(columns.length + 5)}, $${String(columns.length + 6)}, 1)`,
      [organizationId, row.plan, row.cause, row.source, ...values, row.graceUntil, row.override],
    );
  }

  it(`무작위 ${String(ITERATIONS)}회 — write 는 트리거가 받고, operator_row_* 를 억지로 쓰면 트리거가 거부한다`, async () => {
    const random = prng(SEED);
    const pick = <T,>(items: readonly T[]): T => items[Math.floor(random() * items.length)] as T;
    const dbNow = (await owner.query<{ now: Date }>('SELECT now() AS now')).rows[0]?.now ?? new Date();
    const seen = { writes: 0, forced: 0, other: 0, rules: new Set<string>() };

    for (let i = 0; i < ITERATIONS; i += 1) {
      const org = await billingOrg(owner, null);
      // --- 지금 행 ---
      const kind = pick(['none', 'default', 'operator', 'operator', 'provider'] as const);
      let row: RowPlan | null = null;
      if (kind !== 'none') {
        const plan = kind === 'provider' ? pick(['free', ...PAID_PLAN_CODES] as const) : pick(PLANS);
        // 운영자 행은 칸을 섞는다(다른 요금제의 같은 칸 — 천장 안). provider 행은 카탈로그 그대로(atmark_billing 이 쓸 수 있는 모양).
        const limits: Record<string, number> = { ...PLAN_CATALOG[plan] };
        if (kind !== 'provider' && random() < 0.6) {
          for (const [key] of LIMIT_COLUMNS) if (random() < 0.3) limits[key] = PLAN_CATALOG[pick(PLANS)][key];
        }
        const grace = pick([null, null, -DAY, 3 * DAY] as const);
        row = {
          source: kind,
          cause: kind === 'default' ? 'backfill' : kind === 'operator' ? pick(['operator', 'review'] as const) : pick(['provider_event', 'reconcile'] as const),
          plan,
          limits: limits as unknown as EntitlementLimits,
          graceUntil: grace === null ? null : new Date(dbNow.getTime() + grace),
          override: kind === 'operator' && random() < 0.4,
        };
        await plant(org.id, row);
      }
      // --- 구독 묶음 · 계기 ---
      const subscriptions: DecisionSubscription[] = Array.from({ length: Math.floor(random() * 4) }, () => {
        const status = pick(PROVIDER_SUBSCRIPTION_STATUSES);
        const planCode: PaidPlanCode | null = random() < 0.1 ? null : pick(PAID_PLAN_CODES);
        return { status, planCode, pastDueSince: status === 'past_due' ? new Date(dbNow.getTime() - pick([3, 20] as const) * DAY) : null };
      });
      const trigger = pick(TRIGGERS);
      const label = `#${String(i)} ${JSON.stringify({ row: row && { ...row, limits: undefined }, subscriptions, trigger })}`;

      // --- atmark_billing 로 결정 → 쓰기 ---
      const client: PoolClient = await billing.connect();
      try {
        await client.query('BEGIN');
        const now = await databaseNow(client);
        const current = await loadOrgEntitlementsControlRow(client, org.id);
        if (current === ENTITLEMENTS_TABLE_MISSING) throw new Error('org_entitlements 표가 없다');
        const decision = decideProviderEntitlement({ subscriptions, row: current, now, trigger });
        if (decision.kind === 'write') {
          seen.writes += 1;
          await writeEntitlementVersion(client, {
            organizationId: org.id,
            plan: decision.write.planCode,
            limits: decision.write.limits,
            graceUntil: decision.write.graceUntil,
            source: 'provider',
            cause: decision.write.cause,
            providerOverrideAllowed: false,
            actor: BILLING_SYNC_ACTOR,
            providerEventId: null,
            note: null,
          }).catch((error: unknown) => {
            throw new Error(`${label} — 결정은 write 인데 트리거가 거부했다: ${(error as { code?: string }).code ?? ''} ${(error as Error).message}`);
          });
          // 감사 짝(지연 트리거)까지 — 커밋이 통과해야 받아들인 것이다.
          await client.query('COMMIT').catch((error: unknown) => {
            throw new Error(`${label} — 커밋에서 거부: ${(error as Error).message}`);
          });
          continue;
        }
        if (decision.reason === 'operator_row_held' || decision.reason === 'operator_row_kept') {
          seen.forced += 1;
          const plan = decision.desired ?? 'free';
          const forced = await writeEntitlementVersion(client, {
            organizationId: org.id,
            plan,
            limits: PLAN_CATALOG[plan],
            graceUntil: null,
            source: 'provider',
            cause: trigger === 'event' ? 'provider_event' : 'reconcile',
            providerOverrideAllowed: false,
            actor: BILLING_SYNC_ACTOR,
            providerEventId: null,
            note: null,
          }).then(
            () => null,
            (error: unknown) => error as { code?: string; message?: string; where?: string },
          );
          expect(forced, `${label} — ${decision.reason} 인데 트리거가 억지 쓰기를 받아들였다`).not.toBeNull();
          expect(forced?.code, label).toBe('42501');
          // 거부 이유가 D-3 규칙인가 — 권한 거부(permission denied)·카탈로그·출처 규칙의 42501 이 아니다. Free 를 원하면 Free 규칙, 아니면 칸별 규칙.
          const message = forced?.message ?? '';
          expect(D3_REJECTIONS.some((rule) => rule.test(message)), `${label} — D-3 규칙이 아닌 42501: ${message}`).toBe(true);
          expect(message, label).toMatch(plan === 'free' ? D3_REJECTIONS[0] ?? /$^/ : D3_REJECTIONS[1] ?? /$^/);
          expect(forced?.where ?? '', label).toContain('org_entitlements_source_by_role');
          seen.rules.add(plan === 'free' ? 'free' : 'columns');
        } else {
          seen.other += 1;
        }
        await client.query('ROLLBACK');
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    }
    // 속성이 비지 않았다 — 두 갈래 모두 여러 번 돌았다.
    const summary = JSON.stringify({ ...seen, rules: [...seen.rules] });
    expect(seen.writes, summary).toBeGreaterThanOrEqual(5);
    expect(seen.forced, summary).toBeGreaterThanOrEqual(3);
    // D-3 규칙 둘(Free 금지 · 칸별 지배) 모두 거부 쪽에서 한 번 이상 확인했다.
    expect([...seen.rules].sort(), summary).toEqual(['columns', 'free']);
  });
});
