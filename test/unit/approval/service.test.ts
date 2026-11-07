/**
 * `approval/service.ts` — 상태 전이의 **분기**를 인메모리로 본다.
 *
 * 조건부 UPDATE·트리거·CHECK 같은 DB 의 성질은 `test/integration/approval/approval-flow.test.ts` 와
 * `idempotency.test.ts` 의 AC-i4 가 실제 Postgres 에서 본다. 여기서 보는 것은 서비스가 저장소의 답을
 * **어떻게 읽는가** — 특히 "전이에 졌다" 를 발송 없이 돌려주는 모든 갈래다.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  approveRequest,
  DomainScopeConfirmationRequiredError,
  expireRequest,
  rejectRequest,
  relationshipsFor,
  sweepExpiredRequests,
  ThreadScopeUnavailableError,
  type ApprovalStore,
  type ApproveCommand,
  type ExpireCommand,
  type RejectCommand,
} from '../../../src/approval/service';
import type { ApprovalRequestItemRow, ApprovalRequestRow, ApprovalStatus } from '../../../src/db/schema';
import { toAgentId } from '../../../src/db/schema';
import { resetLogSink, setLogSink } from '../../../src/observability/logger';

const NOW = new Date('2026-10-15T12:00:00.000Z');
const AGENT = toAgentId('a'.repeat(32));
/** 웹훅 빌더가 uuid 만 받으므로(`webhooks/events.ts`) 식별자는 전부 정규형 uuid 다. */
const APR = '00000000-0000-4000-8000-00000000a001';
const APR_A = '00000000-0000-4000-8000-00000000a00a';
const APR_B = '00000000-0000-4000-8000-00000000a00b';
const MSG = '00000000-0000-4000-8000-00000000b001';
const AUD = '00000000-0000-4000-8000-00000000c001';

function request(status: ApprovalStatus, id: string = APR): ApprovalRequestRow {
  return {
    id,
    agent_id: AGENT,
    subject: 'message',
    status,
    created_at: NOW,
    expires_at: new Date(NOW.getTime() + 3_600_000),
    decided_at: status === 'pending' ? null : NOW,
    decided_by: status === 'approved' || status === 'rejected' ? 'owner' : null,
    granted_scope: status === 'approved' ? 'recipient' : null,
  };
}

function item(overrides: Partial<ApprovalRequestItemRow> = {}): ApprovalRequestItemRow {
  return {
    approval_id: APR,
    message_id: MSG,
    audit_id: AUD,
    from_address: 'agent@atmark.ai',
    recipients: ['Partner+tag@Example.com', 'partner@example.com'],
    is_thread_reply: false,
    thread_id: null,
    cost_cents: 0,
    created_at: NOW,
    ...overrides,
  };
}

/** 저장소 대역 — `find` 가 호출마다 다른 답을 줄 수 있다(전이 사이에 누가 이겼는가). */
function fakeStore(options: {
  readonly finds: readonly (ApprovalRequestRow | null)[];
  readonly approveReturns?: ApprovalRequestRow | null;
  readonly items?: readonly ApprovalRequestItemRow[];
  readonly riskHoldReasons?: readonly string[];
  readonly expireResults?: Readonly<Record<string, boolean>>;
  readonly due?: readonly string[];
  readonly oldest?: Date | null;
  readonly rejectReturns?: boolean;
  readonly overdue?: number;
}): ApprovalStore & {
  readonly approveCalls: ApproveCommand[];
  readonly rejectCalls: RejectCommand[];
  readonly expireCalls: ExpireCommand[];
  readonly overdueCalls: Date[];
} {
  let findIndex = 0;
  const overdueCalls: Date[] = [];
  const approveCalls: ApproveCommand[] = [];
  const rejectCalls: RejectCommand[] = [];
  const expireCalls: ExpireCommand[] = [];
  return {
    approveCalls,
    rejectCalls,
    expireCalls,
    overdueCalls,
    find: () => {
      const answer = options.finds[Math.min(findIndex, options.finds.length - 1)] ?? null;
      findIndex += 1;
      return Promise.resolve(answer);
    },
    items: () => Promise.resolve(options.items ?? [item()]),
    riskHoldReasons: () => Promise.resolve(options.riskHoldReasons ?? []),
    approve: (command) => {
      approveCalls.push(command);
      return Promise.resolve(options.approveReturns ?? null);
    },
    reject: (command) => {
      rejectCalls.push(command);
      return Promise.resolve(options.rejectReturns ?? true);
    },
    expire: (command) => {
      expireCalls.push(command);
      return Promise.resolve(options.expireResults?.[command.approvalId] ?? false);
    },
    listDue: () => Promise.resolve(options.due ?? []),
    oldestPendingCreatedAt: () => Promise.resolve(options.oldest ?? null),
    countPendingOverdue: (at) => {
      overdueCalls.push(at);
      return Promise.resolve(options.overdue ?? 0);
    },
    // 서비스는 릴리스 일정을 만지지 않는다(일정은 승인 전이 트리거가 만든다) — 불리면 그 자체가 결함이다.
    claimDueReleases: () => Promise.reject(new Error('서비스가 릴리스 일정을 집었다')),
    deferRelease: () => Promise.reject(new Error('서비스가 릴리스를 미뤘다')),
    settleRelease: () => Promise.reject(new Error('서비스가 릴리스를 닫았다')),
  };
}

const lines: string[] = [];
beforeEach(() => {
  lines.length = 0;
  setLogSink((line) => lines.push(line));
});
afterEach(() => resetLogSink());

const approveInput = { approvalId: APR, decidedBy: 'owner', now: NOW, scope: 'recipient' as const, confirmScope: null };

describe('approveRequest — 전이에 진 모든 갈래는 발송 없이 `not_pending` 이다', () => {
  it('요청이 없다 → missing (저장소 전이를 시도조차 하지 않는다)', async () => {
    const store = fakeStore({ finds: [null] });
    expect(await approveRequest(store, approveInput)).toEqual({ kind: 'not_pending', status: 'missing' });
    expect(store.approveCalls).toHaveLength(0);
  });

  it.each(['approved', 'rejected', 'expired'] as const)('이미 %s → 그 상태를 돌려준다', async (status) => {
    const store = fakeStore({ finds: [request(status)] });
    expect(await approveRequest(store, approveInput)).toEqual({ kind: 'not_pending', status });
    expect(store.approveCalls).toHaveLength(0);
  });

  it.each([
    ['만료가 먼저 커밋했다', request('expired'), 'expired'],
    ['TTL 을 넘겼는데 스위퍼가 아직이다', request('pending'), 'past_ttl'],
    ['그 사이 행이 사라졌다', null, 'missing'],
  ] as const)('pending 을 봤는데 전이에 졌다(%s) → %s', async (_label, after, expected) => {
    const store = fakeStore({ finds: [request('pending'), after], approveReturns: null });
    expect(await approveRequest(store, approveInput)).toEqual({ kind: 'not_pending', status: expected });
  });

  it('이기면 관계를 상대방당 1행으로 계산해 넘기고, 항목을 돌려준다(릴리스의 입력)', async () => {
    const store = fakeStore({ finds: [request('pending')], approveReturns: request('approved') });
    const outcome = await approveRequest(store, approveInput);
    expect(outcome.kind).toBe('approved');
    // 관계는 **소유자가 본 주소 그대로**(소문자만) — `Partner+tag@` 와 `partner@` 는 다른 상대다(V1 MINOR-2).
    // `+tag` 를 잘라 한 행으로 합치면 `partner+tag@` 의 승인이 `partner@`·모든 `partner+*` 를 연다.
    expect(store.approveCalls[0]?.relationships).toEqual([
      { scope: 'recipient', address: 'partner+tag@example.com', domain: null, threadId: null, domainScopeConfirmedBy: null },
      { scope: 'recipient', address: 'partner@example.com', domain: null, threadId: null, domainScopeConfirmedBy: null },
    ]);
    expect(lines.some((line) => line.includes('"approval.approved"'))).toBe(true);
  });

  it('ADR-0016 — 위험 보류의 승인은 고른 범위와 무관하게 once · 관계 0 · 결과에 riskHold 표지', async () => {
    for (const scope of ['recipient', 'domain'] as const) {
      const store = fakeStore({ finds: [request('pending')], approveReturns: request('approved'), riskHoldReasons: ['dlp_inbound_copy'] });
      const outcome = await approveRequest(store, { ...approveInput, scope, confirmScope: scope === 'domain' ? 'domain' : null });
      expect(outcome.kind === 'approved' && outcome.riskHold).toBe(true);
      expect(store.approveCalls[0]?.scope).toBe('once');
      expect(store.approveCalls[0]?.relationships).toEqual([]);
    }
    const plain = fakeStore({ finds: [request('pending')], approveReturns: request('approved') });
    const outcome = await approveRequest(plain, approveInput);
    expect(outcome.kind === 'approved' && outcome.riskHold).toBe(false);
    expect(plain.approveCalls[0]?.scope).toBe('recipient');
  });

  it('AC-d5 — domain 은 confirm_scope 가 domain 일 때만, 확인자가 **그 경우에만** 채워진다', async () => {
    await expect(
      approveRequest(fakeStore({ finds: [request('pending')] }), { ...approveInput, scope: 'domain' }),
    ).rejects.toThrow(DomainScopeConfirmationRequiredError);

    const store = fakeStore({ finds: [request('pending')], approveReturns: request('approved') });
    await approveRequest(store, { ...approveInput, scope: 'domain', confirmScope: 'domain' });
    expect(store.approveCalls[0]?.relationships).toEqual([
      { scope: 'domain', address: null, domain: 'example.com', threadId: null, domainScopeConfirmedBy: 'owner' },
    ]);
  });
});

describe('relationshipsFor — 스코프별 관계', () => {
  it('thread 스코프 — 스레드가 있는 항목이면 (스레드, 주소) 쌍', () => {
    expect(relationshipsFor([item({ thread_id: 't-1', recipients: ['a@x.io'] })], 'thread', null, APR)).toEqual([
      { scope: 'thread', address: 'a@x.io', domain: null, threadId: 't-1', domainScopeConfirmedBy: null },
    ]);
  });

  it('thread 스코프 — 스레드가 없는 시도(P2 전부)는 던진다: recipient 로 조용히 넓히지 않는다', () => {
    expect(() => relationshipsFor([item()], 'thread', null, APR)).toThrow(ThreadScopeUnavailableError);
  });

  it('domain 스코프 — 확인자가 없으면 `null` 로 남긴다(DB CHECK 가 거부할 값을 그대로 넘긴다)', () => {
    expect(relationshipsFor([item()], 'domain', null, APR)[0]?.domainScopeConfirmedBy).toBeNull();
  });
});

describe('거절 · 만료', () => {
  it('rejectRequest — pending 을 읽고, 저장소의 답을 그대로 돌려주고 결말을 로그로 남긴다', async () => {
    const won = fakeStore({ finds: [request('pending')], rejectReturns: true });
    expect(await rejectRequest(won, { approvalId: APR, decidedBy: 'o', now: NOW })).toBe(true);
    const lost = fakeStore({ finds: [request('pending')], rejectReturns: false });
    expect(await rejectRequest(lost, { approvalId: APR, decidedBy: 'o', now: NOW })).toBe(false);
    expect(lines.filter((line) => line.includes('"approval.rejected"'))).toHaveLength(2);
  });

  it('rejectRequest — `approval.resolved`(rejected) 를 전이 명령에 싣는다: 에이전트·메시지 id 는 요청에서', async () => {
    const store = fakeStore({ finds: [request('pending')], rejectReturns: true });
    await rejectRequest(store, { approvalId: APR, decidedBy: 'o', now: NOW });
    const event = store.rejectCalls[0]?.event;
    expect(event).toMatchObject({ type: 'approval.resolved', agentId: AGENT, dedupeKey: `approval.resolved:${APR}` });
    expect(JSON.parse(event?.body ?? '{}')).toMatchObject({
      agent_id: AGENT,
      data: { approval_id: APR, decision: 'rejected', message_ids: [MSG], resolved_at: NOW.toISOString() },
    });
  });

  it.each([
    ['rejectRequest', '요청이 없다', null],
    ['rejectRequest', '이미 결정됐다', request('approved')],
    ['expireRequest', '요청이 없다', null],
    ['expireRequest', '이미 결정됐다', request('rejected')],
  ] as const)('%s — %s → 저장소 전이를 시도하지 않고 false', async (fn, _label, found) => {
    const store = fakeStore({ finds: [found] });
    const result =
      fn === 'rejectRequest'
        ? await rejectRequest(store, { approvalId: APR, decidedBy: 'o', now: NOW })
        : await expireRequest(store, APR, NOW);
    expect(result).toBe(false);
    expect(store.rejectCalls).toHaveLength(0);
    expect(store.expireCalls).toHaveLength(0);
  });

  it('expireRequest — 저장소에 위임하고(TTL 판정은 조건부 UPDATE 와 CHECK 의 몫) `approval.expired` 를 싣는다', async () => {
    const store = fakeStore({ finds: [request('pending')], expireResults: { [APR]: true } });
    expect(await expireRequest(store, APR, NOW)).toBe(true);
    const event = store.expireCalls[0]?.event;
    expect(event).toMatchObject({ type: 'approval.expired', agentId: AGENT, dedupeKey: `approval.expired:${APR}` });
    expect(JSON.parse(event?.body ?? '{}')).toMatchObject({
      data: { approval_id: APR, expired_at: NOW.toISOString(), message_ids: [MSG] },
    });
  });

  it('approveRequest — `approval.resolved`(approved) 를 전이 명령에 싣는다', async () => {
    const store = fakeStore({ finds: [request('pending')], approveReturns: request('approved') });
    await approveRequest(store, approveInput);
    expect(JSON.parse(store.approveCalls[0]?.event.body ?? '{}')).toMatchObject({
      type: 'approval.resolved',
      agent_id: AGENT,
      data: { approval_id: APR, decision: 'approved', message_ids: [MSG] },
    });
  });

  it('sweep — 이긴 것과 진 것을 가르고, 가장 오래된 대기의 나이를 방출한다', async () => {
    const store = fakeStore({
      finds: [request('pending', APR_A), request('pending', APR_B)],
      due: [APR_A, APR_B],
      expireResults: { [APR_A]: true, [APR_B]: false },
      oldest: new Date(NOW.getTime() - 90_000),
    });
    expect(await sweepExpiredRequests(store, NOW, 10)).toEqual({ expired: [APR_A], lost: [APR_B] });
    const metric = lines.find((line) => line.includes('atmark.approval.pending_age_seconds'));
    expect(metric).toBeDefined();
    expect(metric).toContain('90');
  });

  it('sweep — 대기가 없으면 나이 0 (결측이 아니다 — 알람이 INSUFFICIENT_DATA 로 잠들지 않게)', async () => {
    await sweepExpiredRequests(fakeStore({ finds: [], oldest: null }), NOW, 10);
    const metric = lines.find((line) => line.includes('atmark.approval.pending_age_seconds'));
    expect(metric).toBeDefined();
  });
});
