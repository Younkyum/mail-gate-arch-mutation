/**
 * src/billing/paddle/prices.ts — **Paddle 가격 id → 요금제**(계획 §3-7). 코드 상수다 — 가격 id 는 비밀이 아니고, 매핑을 바꾸려면 커밋과 리뷰를
 * 거친다(카탈로그와 같은 규율). Paddle 대시보드에서 만든 id 를 리드가 커밋한다(계획 §7-5 · §8-2).
 * 표가 빈 환경에서는 모든 구독이 "모르는 가격" 이라 요금제를 바꾸지 않고(noop + `billing.unknown_price` 알람), 체크아웃은 잠긴다(가격 id 없음 → 409).
 *
 * 규칙(테스트 `test/unit/billing/paddle-prices.test.ts`):
 *   - id 형식 `^pri_[a-z0-9]{26}$`.
 *   - 한 환경 안에서 **1:1** — 요금제 하나에 가격 하나(체크아웃이 고를 가격이 하나), 가격 하나에 요금제 하나.
 *   - 값은 결제로 살 수 있는 요금제만(`PAID_PLAN_CODES` — free·beta 금지).
 *   - 샌드박스와 운영은 id 가 겹치지 않는다(계정이 완전히 분리 — 계획 §0 P15).
 */

import type { PaddleEnvironment } from '../constants';
import { isPaidPlanCode, type PaidPlanCode } from '../plans';

/** 한 환경의 가격표 — 가격 id → 요금제. */
export type PaddlePriceTable = Readonly<Record<string, PaidPlanCode>>;

export const PADDLE_PRICE_ID_SHAPE = /^pri_[a-z0-9]{26}$/;

export const PADDLE_PRICE_PLANS: Readonly<Record<PaddleEnvironment, PaddlePriceTable>> = {
  // 2026-09-26 샌드박스 카탈로그(월 USD 자리표시 — Pro 29 · Team 99 · Scale 299). 상품: pro_01m3cjy0d9w1g10p7nncy9qzeq ·
  // pro_01m3ck1v9dyvppn16c5v0fjkmp · pro_01m3ck3pvzj4mp8hj0sgtfxw7s.
  sandbox: {
    pri_01m3ck17r0q92j24xzjz35agsf: 'pro',
    pri_01m3ck2w4k2m4phkpc1xmqacay: 'team',
    pri_01m3ck4bx17j3acvh73x9sfys1: 'scale',
  },
  // 2026-09-26 운영 카탈로그(Chronostasis · 월 USD — Pro 29 · Team 99 · Scale 299, 가격 페이지와 같다). 상품:
  // pro_01m3dkcax05mhhtcv3gscvhjqj · pro_01m3dkddzt39fqfq9xj0jp330g · pro_01m3dke9w7wzk01nq7h6cmkksj.
  production: {
    pri_01m3dkczkkhjsk1y34xbesqf7d: 'pro',
    pri_01m3dkdwwb4mekvwskyg4g2ajr: 'team',
    pri_01m3dkepz2mddk85wndgd5m0bw: 'scale',
  },
};

/** 가격 id → 요금제. 모르는 id · 모양 밖 · null 이면 null(**구독 없음이 아니라 "모름"** — 결정 함수가 noop 한다). */
export function planForPrice(table: PaddlePriceTable, priceId: string | null): PaidPlanCode | null {
  if (priceId === null || !PADDLE_PRICE_ID_SHAPE.test(priceId) || !Object.hasOwn(table, priceId)) return null;
  const plan = table[priceId];
  return isPaidPlanCode(plan) ? plan : null;
}

/** 요금제 → 체크아웃에 쓸 가격 id. 없으면 null(→ 그 요금제의 체크아웃은 잠긴다). 1:1 이 깨져 둘 이상이면 null(고르지 않는다). */
export function priceForPlan(table: PaddlePriceTable, plan: PaidPlanCode): string | null {
  const ids = Object.keys(table).filter((id) => table[id] === plan && PADDLE_PRICE_ID_SHAPE.test(id));
  return ids.length === 1 ? (ids[0] ?? null) : null;
}
