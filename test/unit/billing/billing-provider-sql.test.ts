/**
 * 마이그레이션 `202609250400_billing_provider.sql` 의 CHECK·가드 상수 = 코드 상수(WP-2, ADR-0012) — 한쪽만 바꾸면 여기서 빨개진다.
 *
 *   - 공통 CHECK: provider = `BILLING_PROVIDERS` · environment = `PADDLE_ENVIRONMENTS`(두 칸을 싣는 표 넷 — 커서 표는 둘 다 없다).
 *   - 이벤트 종류 = `BILLING_EVENT_TYPES` · 이유 코드 = `BILLING_EVENT_REASON_CODES`.
 *   - 결제로 사는 요금제(구독·체크아웃) = `PLAN_CODES` − free − beta · provider 출처 요금제(L9) = `PLAN_CODES` − beta.
 *   - 출처-롤 가드의 카탈로그 배열(free·pro·team·scale) = `PLAN_CATALOG`(`LIMIT_COLUMNS` 순서) — billing 롤의 provider 행은 카탈로그 값만(L-4),
 *     "유예가 끝난 행 = Free" 는 로더(`resolveEntitlements`)와 같은 해석. billing 롤의 감사 행위자 = `BILLING_SYNC_ACTOR`.
 *   - 새 SECURITY DEFINER 함수 없음(계획 §4-4).
 * 표·칸·권한이 실제 DB 와 같은지는 통합 테스트(`test/integration/db/billing-provider.test.ts` · `restricted-roles.test.ts`)가 본다.
 */

import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { BILLING_EVENT_REASON_CODES, BILLING_EVENT_TYPES, BILLING_PROVIDERS, PADDLE_ENVIRONMENTS } from '../../../src/billing/constants';
import { LATE_LIMIT_KEYS, LIMIT_COLUMNS, PLAN_CATALOG, PLAN_CODES } from '../../../src/billing/plans';
import { BILLING_SYNC_ACTOR } from '../../../src/billing/sync';

const SQL = readFileSync(new URL('../../../src/db/migrations/202609250400_billing_provider.sql', import.meta.url), 'utf8').replace(/--[^\n]*/g, '');

/** `<칸> IN ('a', 'b')` 의 목록 전부(칸 이름 바로 뒤). */
function inLists(column: string): string[][] {
  const pattern = new RegExp(`\\b${column}\\s+IN\\s*\\(([^)]*)\\)`, 'g');
  return [...SQL.matchAll(pattern)].map((match) => [...(match[1] ?? '').matchAll(/'([^']+)'/g)].map((item) => item[1] ?? ''));
}

describe('202609250400 CHECK = src/billing/constants.ts', () => {
  it('provider CHECK 은 공급자를 싣는 표 넷(커서 표 제외)에 있고 모두 BILLING_PROVIDERS 와 같다', () => {
    const lists = inLists('provider');
    expect(lists).toHaveLength(4);
    for (const list of lists) expect(list).toEqual([...BILLING_PROVIDERS]);
  });

  it('environment CHECK 은 환경을 싣는 표 넷에 있고 모두 PADDLE_ENVIRONMENTS 와 같다', () => {
    const lists = inLists('environment');
    expect(lists).toHaveLength(4);
    for (const list of lists) expect(list).toEqual([...PADDLE_ENVIRONMENTS]);
  });

  it('event_type CHECK = BILLING_EVENT_TYPES(11종 + 고객 둘 — 202610021203 이 상위 집합으로 바꾼다) · last_error CHECK = BILLING_EVENT_REASON_CODES', () => {
    const customer = ['customer.created', 'customer.updated'];
    expect(inLists('event_type')).toEqual([BILLING_EVENT_TYPES.filter((type) => !customer.includes(type))]);
    expect(BILLING_EVENT_TYPES).toHaveLength(13);
    const replaced = readFileSync(new URL('../../../src/db/migrations/202610021203_billing_customer_events.sql', import.meta.url), 'utf8').replace(/--[^\n]*/g, '');
    const list = /\bevent_type\s+IN\s*\(([^)]*)\)/.exec(replaced)?.[1] ?? '';
    expect([...list.matchAll(/'([^']+)'/g)].map((item) => item[1])).toEqual([...BILLING_EVENT_TYPES]);
    expect(inLists('last_error')).toEqual([[...BILLING_EVENT_REASON_CODES]]);
  });

  it('결제로 사는 요금제는 free·beta 가 아니다 · provider 출처 요금제는 beta 가 아니다(L9)', () => {
    const paid = PLAN_CODES.filter((code) => code !== 'free' && code !== 'beta');
    const planLists = inLists('plan_code');
    // 체크아웃 CHECK · 구독 CHECK · L9 CHECK — 셋.
    expect(planLists).toHaveLength(3);
    expect(planLists.filter((list) => list.length === paid.length)).toEqual([paid, paid]);
    expect(planLists).toContainEqual(PLAN_CODES.filter((code) => code !== 'beta'));
  });

  it('출처-롤 가드의 카탈로그 배열 넷 = PLAN_CATALOG.{free,pro,team,scale} (LIMIT_COLUMNS 순서) · beta 배열은 없다(L9 CHECK 몫)', () => {
    for (const plan of ['free', 'pro', 'team', 'scale'] as const) {
      const match = new RegExp(`${plan}_limits CONSTANT bigint\\[\\] := ARRAY\\[([^\\]]*)\\]`).exec(SQL);
      expect(match, plan).not.toBeNull();
      const values = (match?.[1] ?? '').split(',').map((value) => Number(value.trim()));
      // 0400 의 배열은 아홉 칸(당시 LIMIT_COLUMNS). 메일 기본기 2차가 끝에 두 칸을 더했고 그 재정의(열한 칸)는
      // `test/unit/billing/entitlements-late-sql.test.ts` 가 본다.
      expect(values, plan).toEqual(LIMIT_COLUMNS.filter(([key]) => !LATE_LIMIT_KEYS.has(key)).map(([key]) => PLAN_CATALOG[plan][key]));
      expect(SQL).toMatch(new RegExp(`WHEN '${plan}' THEN ${plan}_limits`));
    }
    expect(SQL).not.toMatch(/beta_limits/);
  });

  it('billing 롤의 감사 행위자 = BILLING_SYNC_ACTOR', () => {
    const match = /current_user = 'atmark_billing' AND NEW\.actor <> '([^']+)'/.exec(SQL);
    expect(match?.[1]).toBe(BILLING_SYNC_ACTOR);
  });

  it('새 SECURITY DEFINER 함수가 없다 · 출처-롤 가드는 current_user 를 본다', () => {
    expect(SQL).not.toMatch(/SECURITY DEFINER/i);
    expect(SQL).toMatch(/current_user = 'atmark_billing_operator'/);
    expect(SQL).toMatch(/current_user = 'atmark_billing'/);
  });

  it('맨 위에서 잠금 시간을 5초로 건다 · 롤 둘이 없으면 멈춘다', () => {
    expect(SQL.trimStart().startsWith("SET LOCAL lock_timeout = '5s';")).toBe(true);
    expect(SQL).toMatch(/ARRAY\['atmark_admin', 'atmark_billing', 'atmark_billing_operator'\]/);
  });
});
