/**
 * 요금제 카탈로그·해석(ADR-0011) — 천장 규칙과 fail-closed.
 *
 *   ① 코드 천장 = 각 적용 지점의 기존 상수(토큰 5 · 조직 키 5 · 웹훅 10 · 메시지당 수신자 50 · 워밍업 정상상태 1000 · 에이전트 절대 천장).
 *   ② 카탈로그의 모든 값 ≤ 천장 — 요금제가 천장을 넘는 값을 약속하지 않는다(Team·Scale 의 조직 수신자/일도 1000).
 *   ③ 마이그레이션 CHECK 상한 = 천장 · 백필 값 = 카탈로그(beta · free).
 *   ④ 해석: 행 없음 · 모르는 코드 · 유예 끝 → Free · 천장으로 자른다 · 모양 밖 값은 0(막는 쪽).
 *   ⑤ 베타 기간 스위치(ADR-0011 §10): `BETA_ON_ACTIVATION` 은 2026-09-30 창업자 결정으로 꺼져 있고(가입 즉시 활성 · Free) 켜질 때의 부여 요금제는 beta · 원인 `review` 가 코드와 DB CHECK(202609250300)에 함께 있다.
 *   ⑥ 결제 공급자(WP-2): 결제로 살 수 있는 요금제 = `BillingPlanCode`(schema) · `PLAN_RANK` 에 beta · 칸별 지배 — 어느 유료 요금제도 beta 를 지배하지 못한다
 *      (beta 기간 업그레이드 잠김의 근거, D-3).
 */

import { readFileSync } from 'node:fs';

import { describe, expect, expectTypeOf, it } from 'vitest';

import { MAX_AGENTS_PER_ORG } from '../../../src/admin/ops/agents';
import { MAX_ACTIVE_ORG_KEYS } from '../../../src/admin/ops/org-keys';
import { MAX_ACTIVE_TOKENS_PER_AGENT } from '../../../src/admin/ops/tokens';
import { MAX_WEBHOOK_ENDPOINTS_PER_AGENT } from '../../../src/api/routes/webhook-endpoints';
import {
  ACTIVATION_PLAN,
  agentTotalCeiling,
  BETA_ON_ACTIVATION,
  dominatesLimits,
  ENTITLEMENT_CAUSES,
  ENTITLEMENT_CEILINGS,
  LATE_LIMIT_KEYS,
  LIMIT_COLUMNS,
  isPaidPlanCode,
  PAID_PLAN_CODES,
  PLAN_CATALOG,
  PLAN_CODES,
  PLAN_RANK,
  resolveEntitlements,
  type PaidPlanCode,
} from '../../../src/billing/plans';
import type { BillingPlanCode } from '../../../src/db/schema';
import { MAX_RECIPIENTS_PER_MESSAGE } from '../../../src/policy/rules/content';
import { WARMUP_STEADY_STATE_DAILY_CAP } from '../../../src/policy/rules/limits';
import { entitlementRow } from '../../support/entitlements';

const MIGRATION = readFileSync(new URL('../../../src/db/migrations/202609250300_org_entitlements.sql', import.meta.url), 'utf8').replace(/--[^\n]*/g, '');
const NOW = new Date('2026-10-01T00:00:00.000Z');

describe('① 코드 천장 = 적용 지점의 상수', () => {
  it('토큰 · 조직 키 · 웹훅 · 메시지당 수신자 · 조직 하루 · 에이전트', () => {
    expect(ENTITLEMENT_CEILINGS.tokensPerAgentMax).toBe(MAX_ACTIVE_TOKENS_PER_AGENT);
    expect(ENTITLEMENT_CEILINGS.orgApiKeysMax).toBe(MAX_ACTIVE_ORG_KEYS);
    expect(ENTITLEMENT_CEILINGS.webhookEndpointsPerAgentMax).toBe(MAX_WEBHOOK_ENDPOINTS_PER_AGENT);
    expect(ENTITLEMENT_CEILINGS.recipientsPerMessageMax).toBe(MAX_RECIPIENTS_PER_MESSAGE);
    expect(ENTITLEMENT_CEILINGS.orgDailyRecipients).toBe(WARMUP_STEADY_STATE_DAILY_CAP);
    expect(ENTITLEMENT_CEILINGS.maxAgents).toBe(MAX_AGENTS_PER_ORG);
  });
});

describe('② 카탈로그 ≤ 천장', () => {
  it.each(PLAN_CODES)('%s', (plan) => {
    for (const [key] of LIMIT_COLUMNS) expect(PLAN_CATALOG[plan][key], `${plan}.${key}`).toBeLessThanOrEqual(ENTITLEMENT_CEILINGS[key]);
  });

  it('beta = 도입 전 한도(에이전트 10 · 토큰 5 · 조직 키 5 · 웹훅 10 · 수신자 50) — 조용히 낮추지 않는다', () => {
    expect(PLAN_CATALOG.beta).toMatchObject({ maxAgents: 10, tokensPerAgentMax: 5, orgApiKeysMax: 5, webhookEndpointsPerAgentMax: 10, recipientsPerMessageMax: 50 });
    expect(PLAN_CATALOG.beta.agentPerMinuteMax).toBe(ENTITLEMENT_CEILINGS.agentPerMinuteMax);
    expect(PLAN_CATALOG.beta.orgDailyRecipients).toBe(WARMUP_STEADY_STATE_DAILY_CAP);
  });

  it('비활성 포함 총합 = 요금제 × 3, 절대 천장 이하', () => {
    expect(agentTotalCeiling(PLAN_CATALOG.free)).toBe(9);
    expect(agentTotalCeiling(PLAN_CATALOG.beta)).toBe(30);
    expect(agentTotalCeiling({ maxAgents: 1000 })).toBe(1000);
  });
});

describe('③ 마이그레이션 = 코드', () => {
  it('칸 CHECK 의 상한 = 천장', () => {
    // 202609250300 의 아홉 칸. 늦게 더한 두 칸(202609270105)은 `entitlements-late-sql.test.ts`.
    for (const [key, column] of LIMIT_COLUMNS.filter(([limit]) => !LATE_LIMIT_KEYS.has(limit))) {
      const match = new RegExp(`${column}\\s+(?:integer|bigint) NOT NULL CHECK \\(${column} BETWEEN (\\d+) AND (\\d+)\\)`).exec(MIGRATION);
      expect(match, column).not.toBeNull();
      expect(Number(match?.[2]), column).toBe(ENTITLEMENT_CEILINGS[key]);
    }
  });

  it('요금제 코드 CHECK = PLAN_CODES', () => {
    const match = /plan_code\s+text NOT NULL CHECK \(plan_code IN \(([^)]*)\)\)/.exec(MIGRATION);
    expect([...(match?.[1] ?? '').matchAll(/'([a-z]+)'/g)].map((m) => m[1])).toEqual([...PLAN_CODES]);
  });

  it('백필 값(beta · free) = 카탈로그', () => {
    for (const plan of ['beta', 'free'] as const) {
      const match = new RegExp(`\\('${plan}', ([\\d, ]+)::bigint\\)`).exec(MIGRATION);
      expect(match, plan).not.toBeNull();
      const values = (match?.[1] ?? '').split(',').map((value) => Number(value.trim()));
      expect(values, plan).toEqual(LIMIT_COLUMNS.filter(([key]) => !LATE_LIMIT_KEYS.has(key)).map(([key]) => PLAN_CATALOG[plan][key]));
    }
  });
});

describe('④ resolveEntitlements', () => {
  it('행 없음 → Free(missing) · 모르는 코드 → Free', () => {
    expect(resolveEntitlements(null, NOW)).toEqual({ planCode: 'free', basis: 'missing', ...PLAN_CATALOG.free });
    expect(resolveEntitlements(entitlementRow('pro', { plan_code: 'gold' }), NOW).planCode).toBe('free');
  });

  it('표 없음(table_missing, 마이그레이션 전) → Free 가 아니라 도입 전 한도(beta 값) — 승인된 봉투가 Free 한도로 영구 거부되지 않는다', () => {
    expect(resolveEntitlements('table_missing', NOW)).toEqual({ planCode: 'beta', basis: 'table_missing', ...PLAN_CATALOG.beta });
    expect(resolveEntitlements('table_missing', NOW).recipientsPerMessageMax).toBeGreaterThan(PLAN_CATALOG.free.recipientsPerMessageMax);
  });

  it('유예 끝(<= now) → Free(grace_expired) · 유예 전 → 행 그대로', () => {
    expect(resolveEntitlements(entitlementRow('team', { grace_until: NOW }), NOW)).toMatchObject({ planCode: 'free', basis: 'grace_expired' });
    expect(resolveEntitlements(entitlementRow('team', { grace_until: new Date(NOW.getTime() + 1) }), NOW)).toMatchObject({ planCode: 'team', basis: 'row' });
  });

  it('천장으로 자른다 · bigint 문자열을 읽는다 · 모양 밖 값은 0', () => {
    const resolved = resolveEntitlements(
      entitlementRow('scale', { tokens_per_agent_max: 50, inbound_storage_bytes: '2199023255552', max_agents: -1, org_api_keys_max: Number.NaN }),
      NOW,
    );
    expect(resolved).toMatchObject({ tokensPerAgentMax: 5, inboundStorageBytes: ENTITLEMENT_CEILINGS.inboundStorageBytes, maxAgents: 0, orgApiKeysMax: 0 });
    expect(resolveEntitlements(entitlementRow('beta', { inbound_storage_bytes: 'x' }), NOW).inboundStorageBytes).toBe(0);
  });
});

describe('⑤ 베타 기간 스위치 — 꺼짐(검토 활성화가 요금제를 주지 않는다)', () => {
  it('스위치는 꺼져 있고(2026-09-30 창업자 결정: 가입 즉시 활성 · Free) 켜질 때의 부여 요금제는 beta — 카탈로그의 beta 는 도입 전 한도 그대로', () => {
    // 다시 켤 때는 이 단언과 ADR-0011 §10 · SQL `ops_activation_beta_enabled()` 를 함께 고친다(조용히 켜지지 않게).
    expect(BETA_ON_ACTIVATION).toBe(false);
    expect(ACTIVATION_PLAN).toBe('beta');
    expect(PLAN_CATALOG[ACTIVATION_PLAN].maxAgents).toBe(10);
  });

  it('원인 review 는 코드 목록과 DB CHECK(두 표) 양쪽에 있고 출처 operator 와만 짝이 된다', () => {
    expect(ENTITLEMENT_CAUSES).toContain('review');
    const causeLists = [...MIGRATION.matchAll(/CHECK \(cause IN \(([^)]*)\)\)/g)].map((m) => (m[1] ?? '').replace(/[\s']/g, '').split(','));
    expect(causeLists).toHaveLength(2);
    for (const list of causeLists) expect([...list].sort()).toEqual([...ENTITLEMENT_CAUSES].sort());
    expect(MIGRATION.replace(/\s+/g, ' ')).toContain("(source = 'operator' AND cause IN ('operator', 'review'))");
  });
});

describe('⑥ 결제 공급자(WP-2) — 유료 요금제 · 순위 · 칸별 지배', () => {
  it('결제로 살 수 있는 요금제 = pro · team · scale = schema 의 BillingPlanCode(free·beta 는 결제로 얻지 못한다)', () => {
    expect([...PAID_PLAN_CODES]).toEqual(['pro', 'team', 'scale']);
    expectTypeOf<PaidPlanCode>().toEqualTypeOf<BillingPlanCode>();
    for (const plan of PLAN_CODES) expect(isPaidPlanCode(plan), plan).toBe(plan !== 'free' && plan !== 'beta');
    expect(isPaidPlanCode('gold')).toBe(false);
    expect(isPaidPlanCode(undefined)).toBe(false);
  });

  it('PLAN_RANK — 모든 요금제에 순위(beta 포함) · free 0 · pro = beta · team · scale 순', () => {
    expect(Object.keys(PLAN_RANK).sort()).toEqual([...PLAN_CODES].sort());
    expect(PLAN_RANK).toEqual({ free: 0, pro: 1, beta: 1, team: 2, scale: 3 });
  });

  it('dominatesLimits — 아홉 칸 모두 ≥ 일 때만 참(한 칸이라도 작으면 거짓) · 자기 자신은 지배한다', () => {
    for (const plan of PLAN_CODES) expect(dominatesLimits(PLAN_CATALOG[plan], PLAN_CATALOG[plan]), plan).toBe(true);
    expect(dominatesLimits(PLAN_CATALOG.team, PLAN_CATALOG.pro)).toBe(true);
    expect(dominatesLimits(PLAN_CATALOG.scale, PLAN_CATALOG.team)).toBe(true);
    expect(dominatesLimits(PLAN_CATALOG.pro, PLAN_CATALOG.free)).toBe(true);
    expect(dominatesLimits(PLAN_CATALOG.pro, PLAN_CATALOG.team)).toBe(false);
    for (const [key] of LIMIT_COLUMNS) {
      const lower = { ...PLAN_CATALOG.team, [key]: PLAN_CATALOG.team[key] - 1 };
      expect(dominatesLimits(lower, PLAN_CATALOG.team), key).toBe(false);
    }
  });

  it('어느 유료 요금제도 beta 를 지배하지 못한다 — beta 기간에 결제가 beta 행을 덮지 않는 근거(D-3)', () => {
    for (const plan of PAID_PLAN_CODES) expect(dominatesLimits(PLAN_CATALOG[plan], PLAN_CATALOG.beta), plan).toBe(false);
  });
});
