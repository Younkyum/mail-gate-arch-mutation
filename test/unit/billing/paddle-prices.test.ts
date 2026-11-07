/**
 * Paddle 가격 id → 요금제(계획 §3-7, `src/billing/paddle/prices.ts`).
 *
 *   ① 커밋된 표: id 형식 `^pri_[a-z0-9]{26}$` · 환경 안 1:1 · 값은 유료 요금제만(free·beta 금지) · 샌드박스와 운영의 id 가 겹치지 않는다.
 *      (지금은 가격 자리표시라 두 표가 비어 있다 — 비어 있어도 이 규칙들은 참이고, 진윤겸의 id 를 커밋하는 순간 같은 단언이 그 값을 본다.)
 *   ② `planForPrice` — 모르는 id · 모양 밖 · null → null("모름" — 구독 없음이 아니다) · 프로토타입 키에 속지 않는다.
 *   ③ `priceForPlan` — 요금제 하나에 가격 하나일 때만 그 id(1:1 이 깨지면 고르지 않는다).
 */

import { describe, expect, it } from 'vitest';

import { PADDLE_ENVIRONMENTS } from '../../../src/billing/constants';
import { PADDLE_PRICE_ID_SHAPE, PADDLE_PRICE_PLANS, planForPrice, priceForPlan, type PaddlePriceTable } from '../../../src/billing/paddle/prices';
import { PAID_PLAN_CODES } from '../../../src/billing/plans';

const PRO = `pri_${'a'.repeat(26)}`;
const TEAM = `pri_${'b'.repeat(26)}`;
const SCALE = `pri_${'c'.repeat(25)}9`;
const FAKE: PaddlePriceTable = { [PRO]: 'pro', [TEAM]: 'team', [SCALE]: 'scale' };

describe('① 커밋된 가격표', () => {
  it.each(PADDLE_ENVIRONMENTS)('%s — 형식 · 유료 요금제만 · 1:1', (environment) => {
    const table = PADDLE_PRICE_PLANS[environment];
    for (const [id, plan] of Object.entries(table)) {
      expect(id, id).toMatch(PADDLE_PRICE_ID_SHAPE);
      expect(PAID_PLAN_CODES as readonly string[], id).toContain(plan);
    }
    const plans = Object.values(table);
    expect(new Set(plans).size).toBe(plans.length);
  });

  it('환경마다 표가 있고 샌드박스·운영의 id 가 겹치지 않는다', () => {
    expect(Object.keys(PADDLE_PRICE_PLANS).sort()).toEqual([...PADDLE_ENVIRONMENTS].sort());
    const sandbox = new Set(Object.keys(PADDLE_PRICE_PLANS.sandbox));
    expect(Object.keys(PADDLE_PRICE_PLANS.production).filter((id) => sandbox.has(id))).toEqual([]);
  });
});

describe('② planForPrice', () => {
  it('아는 id → 요금제 · 모르는 id · 모양 밖 · null → null', () => {
    expect(planForPrice(FAKE, PRO)).toBe('pro');
    expect(planForPrice(FAKE, SCALE)).toBe('scale');
    expect(planForPrice(FAKE, `pri_${'d'.repeat(26)}`)).toBeNull();
    expect(planForPrice(FAKE, `PRI_${'a'.repeat(26)}`)).toBeNull();
    expect(planForPrice(FAKE, `${PRO} `)).toBeNull();
    expect(planForPrice(FAKE, null)).toBeNull();
    expect(planForPrice({}, PRO)).toBeNull();
  });

  it('프로토타입 키 · 유료가 아닌 값은 요금제가 아니다', () => {
    expect(planForPrice(FAKE, 'constructor')).toBeNull();
    const poisoned = { [PRO]: 'beta' } as unknown as PaddlePriceTable;
    expect(planForPrice(poisoned, PRO)).toBeNull();
  });
});

describe('③ priceForPlan', () => {
  it('요금제 → 가격 id 하나 · 없으면 null · 1:1 이 깨지면 null', () => {
    expect(priceForPlan(FAKE, 'team')).toBe(TEAM);
    expect(priceForPlan({ [PRO]: 'pro' }, 'scale')).toBeNull();
    expect(priceForPlan({ [PRO]: 'pro', [TEAM]: 'pro' }, 'pro')).toBeNull();
    expect(priceForPlan(PADDLE_PRICE_PLANS.sandbox, 'pro')).toBe(Object.keys(PADDLE_PRICE_PLANS.sandbox).find((id) => PADDLE_PRICE_PLANS.sandbox[id] === 'pro') ?? null);
  });
});
