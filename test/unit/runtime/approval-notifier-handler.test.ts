/**
 * approval-notifier 틱 — 승인 알림 → 도메인 알림 → 격리 알림(ADR-0016 2026-10-07). 격리 알림 킬 스위치(`ATMARK_QUARANTINE_NOTICE=off`)면 조립 루트가
 * `quarantineNotices: null` 을 주고, 틱은 격리 알림 배출을 건너뛴다(보고에 `quarantine_` 키가 없다). 켜져 있으면 `quarantine_` 접두사로 합친다.
 */

import { describe, expect, it } from 'vitest';

import type { Queryable } from '../../../src/db/client';
import type { ApprovalNotifierLambdaDependencies } from '../../../src/runtime/composition';
import { createApprovalNotifierHandler } from '../../../src/runtime/handlers/approval-notifier';

const empty: Queryable = { query: () => Promise.resolve({ rows: [], rowCount: 0 }) } as unknown as Queryable;
const never = (): never => {
  throw new Error('기한 된 행이 없으니 부르지 않는다');
};
const context = { awsRequestId: 'req-1', invokedFunctionArn: 'arn:aws:lambda:ap-northeast-2:123456789012:function:atmark-approval-notifier', callbackWaitsForEmptyEventLoop: true };

function depsWith(quarantine: boolean): ApprovalNotifierLambdaDependencies {
  const now = (): Date => new Date();
  return {
    db: empty,
    notifier: { notify: never },
    now,
    domainNotices: { db: empty, notifier: { send: never }, now },
    quarantineNotices: quarantine ? { db: empty, notifier: { send: never }, now } : null,
  } as unknown as ApprovalNotifierLambdaDependencies;
}

describe('approval-notifier 틱 — 격리 알림 킬 스위치', () => {
  it('켜져 있으면 격리 알림을 배출하고 quarantine_ 접두사로 보고한다', async () => {
    const handler = createApprovalNotifierHandler(() => Promise.resolve({ deps: depsWith(true) }));
    const report = await handler({}, { ...context });
    expect(report.counts).toMatchObject({ quarantine_sent: 0, quarantine_suppressed: 0, domain_sent: 0, sent: 0 });
  });

  it('꺼져 있으면(null) 격리 알림 배출을 건너뛴다 — 보고에 quarantine_ 키가 없다', async () => {
    const handler = createApprovalNotifierHandler(() => Promise.resolve({ deps: depsWith(false) }));
    const report = await handler({}, { ...context });
    expect(Object.keys(report.counts).filter((key) => key.startsWith('quarantine_'))).toEqual([]);
    expect(report.counts).toMatchObject({ domain_sent: 0, sent: 0 });
  });
});
