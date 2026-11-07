/**
 * TTL 스위퍼의 운영자 콘솔 단계(`runOpsRetention`, `src/workers/approval-expiry.ts`) — 가짜 저장소, DB 0(코드 리뷰 M1).
 *
 * 되돌리면 빨개져야 하는 것: census 게이지 넷은 **먼저** 낸다(알람 #31 의 입력 — 보존·만료가 실패해도 빠지지 않는다) · 보존·만료·census 는
 * 서로 막지 않는다 · 첫 실패는 셋이 다 돈 뒤에 다시 던진다 · 마이그레이션 전(null)이면 게이지를 내지 않고 던지지 않는다.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { OpsCensus, OpsRetention } from '../../../src/db/repositories/ops-retention';
import * as logger from '../../../src/observability/logger';
import { OPS_METRIC_NAMES } from '../../../src/ops/metrics';
import { runOpsRetention } from '../../../src/workers/approval-expiry';

const CENSUS: OpsCensus = { active: 2, pending: 1, addressesFailingToday: 3, addressesLocked: 0 };

function gauges(spy: ReturnType<typeof vi.spyOn>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const call of spy.mock.calls as unknown[][]) {
    const line = String(call[0]);
    if (!line.includes('"_aws"')) continue;
    const record = JSON.parse(line) as Record<string, unknown>;
    for (const [key, value] of Object.entries(record)) if (key.startsWith('atmark.ops.census_')) out[key] = value;
  }
  return out;
}

describe('runOpsRetention — census 먼저 · 단계는 서로 막지 않는다', () => {
  afterEach(() => vi.restoreAllMocks());

  it('정상 — 게이지 넷 · 지운 수 · 만료 수', async () => {
    const spy = vi.spyOn(logger, 'writeLine');
    const ops: OpsRetention = { purge: () => Promise.resolve(4), expire: () => Promise.resolve(1), census: () => Promise.resolve(CENSUS) };
    expect(await runOpsRetention({ ops })).toEqual({ purged: 4, expired: 1, census: CENSUS });
    expect(gauges(spy)).toEqual({
      [OPS_METRIC_NAMES.censusActive]: 2,
      [OPS_METRIC_NAMES.censusPending]: 1,
      [OPS_METRIC_NAMES.censusAddressesFailingToday]: 3,
      [OPS_METRIC_NAMES.censusAddressesLocked]: 0,
    });
  });

  it('보존이 던져도 census 게이지는 나가고 만료도 돈다 — 첫 실패를 끝에서 다시 던진다', async () => {
    const spy = vi.spyOn(logger, 'writeLine');
    const order: string[] = [];
    const ops: OpsRetention = {
      census: () => (order.push('census'), Promise.resolve(CENSUS)),
      purge: () => (order.push('purge'), Promise.reject(new Error('purge down'))),
      expire: () => (order.push('expire'), Promise.reject(new Error('expire down'))),
    };
    await expect(runOpsRetention({ ops })).rejects.toThrow('purge down');
    expect(order).toEqual(['census', 'purge', 'expire']);
    expect(gauges(spy)[OPS_METRIC_NAMES.censusActive]).toBe(2);
  });

  it('census 가 던져도 보존·만료는 돈다 · 마이그레이션 전(null)이면 게이지 없이 조용히', async () => {
    const order: string[] = [];
    const broken: OpsRetention = {
      census: () => Promise.reject(new Error('census down')),
      purge: () => (order.push('purge'), Promise.resolve(0)),
      expire: () => (order.push('expire'), Promise.resolve(0)),
    };
    await expect(runOpsRetention({ ops: broken })).rejects.toThrow('census down');
    expect(order).toEqual(['purge', 'expire']);

    const spy = vi.spyOn(logger, 'writeLine');
    const early: OpsRetention = { census: () => Promise.resolve(null), purge: () => Promise.resolve(null), expire: () => Promise.resolve(null) };
    expect(await runOpsRetention({ ops: early })).toEqual({ purged: null, expired: null, census: null });
    expect(gauges(spy)).toEqual({});
  });
});
