/**
 * 초대만 받은 사용자 주소 지우기의 **하루 한 번** 창(ADR-0010 후속 L7) — TTL 스위퍼(5분 주기) 안에서 03:00–03:05 KST 틱에만 DB 에 간다.
 * 창 길이 = 스케줄 주기라서 창 안의 틱이 정확히 하나다(인프라 `SCHEDULES` 와 대조). 배치 크기는 500(함수 안 상한과 같다).
 *
 * 적대적 검토 M1 이후: 배치가 500 을 다 지우면 다음 배치(최대 10) · 지운·건너뛴·밀린 수를 지표로(배치가 던져도) · 핸들러의 단계는 서로
 * 막지 않는다(앞 단계가 던져도 지우기·가입 링크 보존이 돈다 — 첫 실패는 끝에서 다시 던진다).
 */

import { afterEach, describe, expect, it } from 'vitest';

import { SCHEDULES } from '../../../infra/cdk/stacks/compute-stack';
import { INVITED_USER_ERASURE_BATCH, type InvitedUserErasure, type InvitedUserErasureResult } from '../../../src/db/repositories/invited-user-erasure';
import { resetLogSink, setLogSink } from '../../../src/observability/logger';
import { METRIC_NAMES } from '../../../src/observability/metrics';
import { createApprovalExpiryHandler } from '../../../src/runtime/handlers/approval-expiry';
import type { LambdaContext } from '../../../src/runtime/lambda';
import {
  INVITED_USER_ERASURE_MAX_BATCHES,
  INVITED_USER_ERASURE_WINDOW_MINUTES,
  invitedUserErasureDue,
  runInvitedUserErasure,
  runSignupLinkRetention,
  type ApprovalExpiryDependencies,
} from '../../../src/workers/approval-expiry';

const INSIDE = new Date('2026-09-25T18:02:00.000Z');
const OUTSIDE = new Date('2026-09-25T12:00:00.000Z');

function recorder(
  results: readonly (InvitedUserErasureResult | Error)[] = [{ erased: 2, skipped: 1 }],
  backlog = 0,
): { readonly store: InvitedUserErasure; readonly limits: number[]; readonly backlogCalls: number[] } {
  const limits: number[] = [];
  const backlogCalls: number[] = [];
  return {
    limits,
    backlogCalls,
    store: {
      erase: (limit) => {
        limits.push(limit);
        const next = results[Math.min(limits.length - 1, results.length - 1)] ?? { erased: 0, skipped: 0 };
        return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
      },
      backlog: () => {
        backlogCalls.push(1);
        return Promise.resolve(backlog);
      },
    },
  };
}

/** EMF 줄에서 지표 값만 모은다(이름 → 값들). */
function captureMetrics(): Map<string, number[]> {
  const seen = new Map<string, number[]>();
  setLogSink((line) => {
    const parsed = JSON.parse(line) as Record<string, unknown>;
    for (const name of Object.values(METRIC_NAMES)) {
      const value = parsed[name];
      if (typeof value === 'number') seen.set(name, [...(seen.get(name) ?? []), value]);
    }
  });
  return seen;
}

afterEach(() => {
  resetLogSink();
});

describe('초대만 받은 사용자 주소 지우기 — 하루 창', () => {
  it('창은 18:00–18:05 UTC(= 03:00–03:05 KST) 하나 — 창 길이는 approval-expiry 스케줄 주기와 같다', () => {
    expect(SCHEDULES.find((schedule) => schedule.handler === 'approval-expiry')?.minutes).toBe(INVITED_USER_ERASURE_WINDOW_MINUTES);
    expect(invitedUserErasureDue(new Date('2026-09-25T18:00:00.000Z'))).toBe(true);
    expect(invitedUserErasureDue(new Date('2026-09-25T18:04:59.999Z'))).toBe(true);
    expect(invitedUserErasureDue(new Date('2026-09-25T18:05:00.000Z'))).toBe(false);
    expect(invitedUserErasureDue(new Date('2026-09-25T17:59:59.999Z'))).toBe(false);
    expect(invitedUserErasureDue(new Date('2026-09-25T03:00:00.000Z'))).toBe(false);
    // 5분 주기 틱이 어느 위상이든 하루 288틱 중 창 안은 정확히 하나.
    for (const offsetSeconds of [0, 37, 299]) {
      let due = 0;
      for (let tick = 0; tick < 288; tick += 1) {
        if (invitedUserErasureDue(new Date(Date.UTC(2026, 8, 25) + offsetSeconds * 1000 + tick * 5 * 60 * 1000))) due += 1;
      }
      expect(due, `offset ${String(offsetSeconds)}s`).toBe(1);
    }
  });

  it('창 밖이면 DB 에 가지 않는다(null) · 창 안이면 배치 500 · 다 못 채운 배치에서 멈춘다', async () => {
    const outside = recorder();
    await expect(runInvitedUserErasure({ invitedUsers: outside.store, now: () => OUTSIDE })).resolves.toBeNull();
    expect([outside.limits, outside.backlogCalls]).toEqual([[], []]);

    const inside = recorder();
    await expect(runInvitedUserErasure({ invitedUsers: inside.store, now: () => INSIDE })).resolves.toEqual({ erased: 2, skipped: 1 });
    expect(inside.limits).toEqual([INVITED_USER_ERASURE_BATCH]);
    expect(INVITED_USER_ERASURE_BATCH).toBe(500);
  });

  it('배치가 500 을 다 지우면 다음 배치 — 다 못 채운 배치에서 멈추고 합을 돌려준다 · 상한 10 배치', async () => {
    const full = { erased: INVITED_USER_ERASURE_BATCH, skipped: 0 };
    const three = recorder([full, full, { erased: 7, skipped: 2 }]);
    await expect(runInvitedUserErasure({ invitedUsers: three.store, now: () => INSIDE })).resolves.toEqual({ erased: 1007, skipped: 2 });
    expect(three.limits).toHaveLength(3);

    // 건너뛴 행이 섞여 500 을 못 지운 배치에서도 멈춘다(같은 막힌 행을 다시 보지 않는다 — 밀린 수가 알람으로 본다).
    const blocked = recorder([{ erased: 499, skipped: 1 }]);
    await runInvitedUserErasure({ invitedUsers: blocked.store, now: () => INSIDE });
    expect(blocked.limits).toHaveLength(1);

    const endless = recorder([full]);
    await expect(runInvitedUserErasure({ invitedUsers: endless.store, now: () => INSIDE })).resolves.toEqual({
      erased: INVITED_USER_ERASURE_BATCH * INVITED_USER_ERASURE_MAX_BATCHES,
      skipped: 0,
    });
    expect(endless.limits).toHaveLength(INVITED_USER_ERASURE_MAX_BATCHES);
    expect(INVITED_USER_ERASURE_MAX_BATCHES).toBe(10);
  });

  it('지운·건너뛴·밀린 수를 지표로 낸다(0 포함) — 배치가 던져도 밀린 수는 내고 다시 던진다', async () => {
    const metrics = captureMetrics();
    await runInvitedUserErasure({ invitedUsers: recorder([{ erased: 4, skipped: 1 }], 0).store, now: () => INSIDE });
    expect(metrics.get(METRIC_NAMES.privacyErasureErased)).toEqual([4]);
    expect(metrics.get(METRIC_NAMES.privacyErasureSkipped)).toEqual([1]);
    expect(metrics.get(METRIC_NAMES.privacyErasureBacklog)).toEqual([0]);

    const failing = recorder([{ erased: INVITED_USER_ERASURE_BATCH, skipped: 0 }, new Error('statement timeout')], 3);
    await expect(runInvitedUserErasure({ invitedUsers: failing.store, now: () => INSIDE })).rejects.toThrow('statement timeout');
    expect(failing.backlogCalls).toHaveLength(1);
    expect(metrics.get(METRIC_NAMES.privacyErasureErased)).toEqual([4, INVITED_USER_ERASURE_BATCH]);
    expect(metrics.get(METRIC_NAMES.privacyErasureBacklog)).toEqual([0, 3]);
  });

  it('가입 링크 보존도 같은 하루 창에서만', async () => {
    let calls = 0;
    const signupLinks = {
      purge: () => {
        calls += 1;
        return Promise.resolve(5);
      },
    };
    await expect(runSignupLinkRetention({ signupLinks, now: () => OUTSIDE })).resolves.toBeNull();
    await expect(runSignupLinkRetention({ signupLinks, now: () => INSIDE })).resolves.toBe(5);
    expect(calls).toBe(1);
  });
});

describe('approval-expiry 핸들러 — 보존 단계는 서로 막지 않는다', () => {
  const context: LambdaContext = {
    awsRequestId: 'req',
    invokedFunctionArn: 'arn:aws:lambda:ap-northeast-2:123456789012:function:x',
    callbackWaitsForEmptyEventLoop: true,
  } as LambdaContext;

  function deps(now: Date, store: InvitedUserErasure, overrides: Partial<Record<keyof ApprovalExpiryDependencies, unknown>> = {}) {
    let signupPurges = 0;
    const value = {
      approvals: {
        listDue: () => Promise.resolve([]),
        oldestPendingCreatedAt: () => Promise.resolve(null),
        countPendingOverdue: () => Promise.resolve(0),
      },
      snippets: { sweep: () => Promise.resolve({ cleared: 0, stuckIds: [] }) },
      orgApiWindows: { purge: () => Promise.resolve(0) },
      loginCodeAttempts: { purge: () => Promise.resolve(0) },
      ops: { purge: () => Promise.resolve(0), expire: () => Promise.resolve(0), census: () => Promise.resolve(null) },
      injectionSignals: { purge: () => Promise.resolve(0) },
      complaintHashes: { purge: () => Promise.resolve(0) },
      // 실시간 연결 스윕(묶음 E).
      realtimeConnections: { sweep: () => Promise.resolve({ closed: 0, purged: 0 }) },
      invitedUsers: store,
      signupLinks: {
        purge: () => {
          signupPurges += 1;
          return Promise.resolve(4);
        },
      },
      now: () => now,
      ...overrides,
    } as unknown as ApprovalExpiryDependencies;
    return { value, signupPurges: () => signupPurges };
  }

  it('지운 수·가입 링크 수를 보고한다(창 밖은 0 · DB 에 가지 않는다)', async () => {
    const inside = recorder();
    const insideDeps = deps(INSIDE, inside.store);
    const report = await createApprovalExpiryHandler(() => Promise.resolve({ deps: insideDeps.value }))({}, context);
    expect([report.counts['invited_users_erased'], report.counts['signup_links_purged'], inside.limits]).toEqual([2, 4, [500]]);

    const outside = recorder();
    const outsideDeps = deps(OUTSIDE, outside.store);
    const quiet = await createApprovalExpiryHandler(() => Promise.resolve({ deps: outsideDeps.value }))({}, context);
    expect([quiet.counts['invited_users_erased'], quiet.counts['signup_links_purged'], outside.limits, outsideDeps.signupPurges()]).toEqual([0, 0, [], 0]);
  });

  it('앞 단계(만료·스니펫·창 보존)가 던져도 지우기·가입 링크 보존은 돈다 — 첫 실패를 끝에서 다시 던진다', async () => {
    const store = recorder();
    const broken = deps(INSIDE, store.store, {
      approvals: new Proxy({}, { get: () => () => Promise.reject(new Error('approvals down')) }),
      snippets: { sweep: () => Promise.reject(new Error('snippets down')) },
      orgApiWindows: { purge: () => Promise.reject(new Error('windows down')) },
    });
    await expect(createApprovalExpiryHandler(() => Promise.resolve({ deps: broken.value }))({}, context)).rejects.toThrow('approvals down');
    expect(store.limits).toEqual([500]);
    expect(store.backlogCalls).toHaveLength(1);
    expect(broken.signupPurges()).toBe(1);
  });

  it('지우기가 던져도 가입 링크 보존은 돈다', async () => {
    const store = recorder([new Error('erase down')]);
    const broken = deps(INSIDE, store.store);
    await expect(createApprovalExpiryHandler(() => Promise.resolve({ deps: broken.value }))({}, context)).rejects.toThrow('erase down');
    expect(broken.signupPurges()).toBe(1);
  });
});
