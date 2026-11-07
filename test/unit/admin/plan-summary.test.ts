/**
 * `/api/me` 요금제 요약(`planSummaryOp`, ADR-0011 결과 절) — **싼 조회만** 한다.
 *
 * 되돌림 방지: `/api/me` 는 화면마다 불린다. 요약이 다시 `planUsageOp` 처럼 24시간 수신자 합(`messages` 표 훑기)을 부르면 아래 단언이 빨개진다.
 * 설정의 `GET /api/plan`(`planUsageOp`)만 그 조회를 한다.
 */

import { describe, expect, it } from 'vitest';

import { planSummaryOp, planUsageOp } from '../../../src/admin/ops/plan';
import type { Queryable } from '../../../src/db/client';

const ORG = '00000000-0000-4000-8000-000000000001';

/** SQL 을 적어 두는 가짜 DB — 표는 있고(`to_regclass`) 요금제 행은 없다(= Free) · 수는 전부 0. */
function recordingDb(): { readonly db: Queryable; readonly sql: string[] } {
  const sql: string[] = [];
  const db = {
    query: (text: string) => {
      sql.push(text);
      if (text.includes('to_regclass')) return Promise.resolve({ rows: [{ ok: true }] });
      if (text.includes('FROM org_entitlements')) return Promise.resolve({ rows: [] });
      if (text.includes('FROM organizations')) return Promise.resolve({ rows: [{ sending_started_at: null }] });
      return Promise.resolve({ rows: [{ n: 0, non_disabled: 0, total: 0 }] });
    },
  } as unknown as Queryable;
  return { db, sql };
}

describe('planSummaryOp — /api/me 요약은 메시지 표를 훑지 않는다', () => {
  it('요금제 · 분모 · 초과 항목을 주고, 24시간 수신자 합은 부르지 않는다(설정의 planUsageOp 만)', async () => {
    const summary = recordingDb();
    expect(await planSummaryOp(summary.db, ORG, new Date('2026-09-25T00:00:00Z'))).toEqual({
      code: 'free',
      basis: 'missing',
      maxAgents: 3,
      overLimit: [],
    });
    expect(summary.sql.some((text) => /FROM messages/.test(text))).toBe(false);

    const usage = recordingDb();
    await planUsageOp(usage.db, ORG, new Date('2026-09-25T00:00:00Z'));
    expect(usage.sql.some((text) => /FROM messages/.test(text))).toBe(true);
  });
});
