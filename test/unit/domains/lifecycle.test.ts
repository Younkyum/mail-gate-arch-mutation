/**
 * 고객 도메인 수명주기 — 순수 판정(ADR-0014 단계 4 · 계획 §3.3 수용 기준). DB · SES 없이:
 *   ① 요청 계획: 상태별 요청 · **removed · superseded 행에는 sync_policy · audit_policy 가 없다**(#12) · 예산 P/R 분리.
 *   ② 판정: `error` 100회 연속 → 상태 · 카운터 불변 · 확정 실패 1회 → 30분 뒤 · 2회 연속 → suspended · reputation · operator 는 자동 복귀 없음 ·
 *      ownership_lost · dkim_failed 는 성공하면 복귀 · 사가 전진 · drift → operator · 만료 → ownership_lost · 제거 사가 not_owner → done.
 *   ③ 시간 전이(72시간 · 14일 · D-3) · 요금제 강등·복귀.
 */

import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  DEFINITIVE_FAILURE_RETRY_MS,
  DOMAIN_TICK_PENDING_BUDGET,
  DOMAIN_TICK_RECHECK_BUDGET,
  OWNERSHIP_LOST_REMOVAL_MS,
  PENDING_EXPIRY_MS,
  RECHECK_INTERVAL_MS,
  type DomainControlRequest,
  type DomainControlResult,
} from '../../../src/domains/contract';
import {
  canSuspend,
  decide,
  lastErrorOf,
  nextSagaStep,
  packBudget,
  planLimitChanges,
  planRow,
  policyOpsAllowed,
  isSteward,
  pendingSagaStep,
  removalHandoverDue,
  removalNeedsNoSes,
  supersededRemovalAction,
  timedTransition,
} from '../../../src/domains/lifecycle';
import type { DomainRow } from '../../../src/domains/store';

const NOW = new Date('2026-10-20T00:00:00.000Z');
const ID = '11111111-1111-4111-8111-111111111111';

function row(patch: Partial<DomainRow> = {}): DomainRow {
  return {
    id: ID,
    organizationId: '22222222-2222-4222-8222-222222222222',
    domain: 'agents.example.com',
    registrable: 'example.com',
    status: 'verified',
    suspendedReason: null,
    pendingReason: null,
    challengeToken: 't'.repeat(43),
    txtVerifiedAt: new Date(NOW.getTime() - 10 * 86_400_000),
    sagaStep: 'done',
    sagaAttempts: 0,
    removalStep: 'none',
    lastError: null,
    sesIdentityRowTag: ID,
    supersededBy: null,
    dkimStatus: 'success',
    dkimTokens: [],
    mailFromStatus: 'success',
    inboundMxStatus: 'ses',
    policyDigest: null,
    policySyncRequestedAt: null,
    lastCheckedAt: null,
    nextCheckAt: new Date(NOW.getTime() - 1),
    consecutiveDefinitiveFailures: 0,
    registrationExpiresAt: null,
    registrationCheckedAt: NOW,
    verifiedAt: new Date(NOW.getTime() - 9 * 86_400_000),
    suspendedAt: null,
    removedAt: null,
    removalDueAt: null,
    identityDeletedAt: null,
    identityClaimedAt: new Date(NOW.getTime() - 10 * 86_400_000),
    identityReleasedAt: null,
    identityHandoverTo: null,
    createdAt: new Date(NOW.getTime() - 11 * 86_400_000),
    updatedAt: NOW,
    ...patch,
  };
}

const ctx = { now: NOW, addresses: ['a@agents.example.com'], supersededRowId: null };
const ops = (requests: readonly DomainControlRequest[]): string[] => requests.map((request) => request.op);

const check = (txt: 'present' | 'absent' | 'error', mx: 'missing' | 'ses' | 'other' | 'error' = 'ses'): DomainControlResult => ({
  op: 'check',
  rowId: ID,
  txt,
  mx,
  errorCode: txt === 'error' || mx === 'error' ? 'dns_timeout' : null,
});
const audit = (outcome: 'clean' | 'drift' | 'not_owner' | 'error', dkimStatus: 'success' | 'failed' | 'pending' | 'unknown' = 'success'): DomainControlResult => ({
  op: 'audit_policy',
  rowId: ID,
  outcome,
  dkimStatus,
  errorCode: outcome === 'error' ? 'Throttling' : null,
});

/** 결정 하나를 행에 적용한 것처럼(상태 · 사유 · 카운터만 — 테스트의 상태 기계 흉내). */
function apply(current: DomainRow, results: readonly DomainControlResult[]): DomainRow {
  const decision = decide(current, results, NOW);
  if (decision.kind !== 'update') throw new Error('update 가 아니다');
  const p = decision.patch;
  return {
    ...current,
    status: (p['status'] as DomainRow['status'] | undefined) ?? current.status,
    suspendedReason: p['suspended_reason'] !== undefined ? (p['suspended_reason'] as DomainRow['suspendedReason']) : current.suspendedReason,
    consecutiveDefinitiveFailures: (p['consecutive_definitive_failures'] as number | undefined) ?? current.consecutiveDefinitiveFailures,
    removalDueAt: p['removal_due_at'] !== undefined ? (p['removal_due_at'] as Date | null) : current.removalDueAt,
  };
}

describe('① 요청 계획', () => {
  it('상태별 요청 — pending check · 사가 다음 단계 · 사가 끝 check+audit([]) · verified check+audit+만료', () => {
    expect(ops(planRow(row({ status: 'pending', sagaStep: 'none', identityClaimedAt: null, dkimTokens: ['t1', 't2', 't3'] }), ctx))).toEqual(['check']);
    const saga = planRow(row({ status: 'verifying', sagaStep: 'identity' }), { ...ctx, supersededRowId: null });
    expect(saga).toEqual([{ op: 'saga_step', rowId: ID, domain: 'agents.example.com', registrable: 'example.com', step: 'mail_from', supersededRowId: null }]);
    const done = planRow(row({ status: 'verifying', sagaStep: 'done' }), ctx);
    expect(ops(done)).toEqual(['check', 'audit_policy']);
    expect(done[1]).toMatchObject({ addresses: [] });
    expect(ops(planRow(row({ registrationCheckedAt: null }), ctx))).toEqual(['check', 'audit_policy', 'check_expiry']);
    expect(planRow(row(), ctx)[1]).toMatchObject({ op: 'audit_policy', addresses: ['a@agents.example.com'] });
  });

  it('정책 동기화가 밀렸으면 audit 대신 sync — verified 는 주소, suspended 는 빈 집합(정책 삭제) · 기한 전이면 sync 만', () => {
    const requested = new Date(NOW.getTime() - 1000);
    expect(planRow(row({ policySyncRequestedAt: requested }), ctx)[1]).toMatchObject({ op: 'sync_policy', addresses: ['a@agents.example.com'] });
    expect(planRow(row({ status: 'suspended', suspendedReason: 'plan_limit', policySyncRequestedAt: requested }), ctx)[1]).toMatchObject({
      op: 'sync_policy',
      addresses: [],
    });
    expect(ops(planRow(row({ policySyncRequestedAt: requested, nextCheckAt: new Date(NOW.getTime() + 60_000) }), ctx))).toEqual(['sync_policy']);
  });

  it('★ removed · superseded 행에는 sync_policy · audit_policy 가 없다(#12) — 정책 동기화 표시가 남아 있어도', () => {
    const requested = new Date(NOW.getTime() - 1000);
    const removed = row({ status: 'removed', removalStep: 'none', policySyncRequestedAt: requested, removedAt: NOW });
    expect(ops(planRow(removed, ctx))).toEqual(['remove_step']);
    const superseded = row({ status: 'removed', supersededBy: '33333333-3333-4333-8333-333333333333', policySyncRequestedAt: requested, removedAt: NOW });
    expect(planRow(superseded, ctx)).toEqual([]); // 정산 판정 없이는 SES 호출 0
    expect(planRow(superseded, { ...ctx, supersededAction: 'settle' })).toEqual([]);
    expect(planRow(superseded, { ...ctx, supersededAction: 'wait' })).toEqual([]);
    // 후속 행이 채택 전에 사라졌다 — 옛 행의 정상 제거 사가(정책 요청은 여전히 없다).
    expect(ops(planRow(superseded, { ...ctx, supersededAction: 'remove' }))).toEqual(['remove_step']);
    expect(removalNeedsNoSes(superseded)).toBe(false);
    expect(policyOpsAllowed(superseded)).toBe(false);
    expect(policyOpsAllowed(row({ status: 'verified', supersededBy: '33333333-3333-4333-8333-333333333333' }))).toBe(false);
    // 모든 상태 × 동기화 표시에서 removed 는 정책 요청을 만들지 않는다.
    for (const removalStep of ['none', 'policy', 'identity', 'done'] as const) {
      expect(ops(planRow(row({ status: 'removed', removalStep, policySyncRequestedAt: requested }), ctx)).filter((op) => op === 'sync_policy' || op === 'audit_policy')).toEqual([]);
    }
  });

  it('★ 대체된 옛 행의 정산(#13 M2) — 후속 행이 채택했으면 settle · 채택 전에 사라졌으면 remove · 아직이면 wait', () => {
    const successor = { id: 'b', status: 'verifying', sagaStep: 'none', sesIdentityRowTag: null } as const;
    expect(supersededRemovalAction({ ...successor, sesIdentityRowTag: 'b' })).toBe('settle');
    expect(supersededRemovalAction({ ...successor, sagaStep: 'identity' })).toBe('settle');
    expect(supersededRemovalAction({ ...successor, status: 'removed', sagaStep: 'mail_from' })).toBe('settle'); // 채택 뒤 제거 — 후속 행의 사가가 지운다
    expect(supersededRemovalAction(successor)).toBe('wait');
    expect(supersededRemovalAction({ ...successor, status: 'pending' })).toBe('wait');
    expect(supersededRemovalAction({ ...successor, status: 'removed' })).toBe('remove');
    expect(supersededRemovalAction(null)).toBe('remove');
  });

  it('identity 를 가진 적 없는 removed(pending 만료)는 SES 호출 0 · 사가 순서', () => {
    expect(removalNeedsNoSes(row({ status: 'removed', txtVerifiedAt: null, sesIdentityRowTag: null, sagaStep: 'none', identityClaimedAt: null }))).toBe(true);
    expect(removalNeedsNoSes(row({ status: 'removed', sesIdentityRowTag: null, sagaStep: 'none' }))).toBe(false); // verifying 에 들어섰던 행(관리자)
    // one-shot — 클레임한 적 없음 → SES 0 · 관리권을 놓았음 → SES 0(대체된 행이어도) · 관리자 pending 만료 → 제거 사가
    expect(removalNeedsNoSes(row({ status: 'removed', identityClaimedAt: null, sesIdentityRowTag: ID, sagaStep: 'config_set' }))).toBe(true);
    expect(removalNeedsNoSes(row({ status: 'removed', identityReleasedAt: NOW }))).toBe(true);
    expect(removalNeedsNoSes(row({ status: 'removed', identityReleasedAt: NOW, supersededBy: '33333333-3333-4333-8333-333333333333' }))).toBe(true);
    expect(removalNeedsNoSes(row({ status: 'removed', txtVerifiedAt: null, sagaStep: 'config_set' }))).toBe(false);
    expect(['none', 'identity', 'mail_from', 'config_set', 'policy', 'done'].map((step) => nextSagaStep(step as DomainRow['sagaStep']))).toEqual([
      'identity',
      'mail_from',
      'config_set',
      'policy',
      null,
      null,
    ]);
  });

  it('예산 — 요청 수로 P(pending·verifying) 8 · R(재확인·제거) 10 을 따로 채우고, 한 행의 요청은 나누지 않는다', () => {
    // pending 행은 요청 2개(관리자 사가 + check · 또는 check + peek) — P=8 에 네 행.
    const pending = Array.from({ length: 8 }, (_, i) => ({ row: row({ id: `p${String(i)}`, status: 'pending' }), requests: planRow(row({ status: 'pending', sagaStep: 'none' }), ctx) }));
    const recheck = Array.from({ length: 8 }, (_, i) => ({ row: row({ id: `r${String(i)}` }), requests: planRow(row({ registrationCheckedAt: null }), ctx) }));
    const chosen = packBudget([...pending, ...recheck]);
    const cost = (status: string[]): number =>
      chosen.filter((item) => status.includes(item.row.status)).reduce((sum, item) => sum + item.requests.length, 0);
    expect(cost(['pending', 'verifying'])).toBe(DOMAIN_TICK_PENDING_BUDGET);
    expect(cost(['verified', 'suspended', 'removed'])).toBeLessThanOrEqual(DOMAIN_TICK_RECHECK_BUDGET);
    expect(chosen.filter((item) => item.row.status === 'verified')).toHaveLength(3); // 3 요청씩 → 9 ≤ 10
    expect(chosen.filter((item) => item.row.status === 'pending')).toHaveLength(4); // 2 요청씩 → 8
  });
});

describe('② 판정', () => {
  it('★ error 100회 연속 — 상태 · 사유 · 확정 실패 카운터 불변(원칙 3)', () => {
    let current = row();
    for (let i = 0; i < 100; i += 1) current = apply(current, [check('error', 'error'), audit('error', 'unknown')]);
    expect([current.status, current.suspendedReason, current.consecutiveDefinitiveFailures]).toEqual(['verified', null, 0]);
    let suspended = row({ status: 'suspended', suspendedReason: 'ownership_lost', suspendedAt: NOW, removalDueAt: NOW });
    for (let i = 0; i < 100; i += 1) suspended = apply(suspended, [check('error'), audit('error', 'unknown')]);
    expect([suspended.status, suspended.suspendedReason]).toEqual(['suspended', 'ownership_lost']);
  });

  it('★ 확정 실패 1회 → 30분 뒤 재확인 · 2회 연속 → suspended(ownership_lost) + 14일 제거 시각 + 알림', () => {
    const first = decide(row(), [check('absent'), audit('clean')], NOW);
    expect(first.kind === 'update' && first.patch).toMatchObject({ consecutive_definitive_failures: 1, next_check_at: new Date(NOW.getTime() + DEFINITIVE_FAILURE_RETRY_MS) });
    expect(first.kind === 'update' && first.patch['status']).toBeUndefined();
    const second = decide(row({ consecutiveDefinitiveFailures: 1 }), [check('absent'), audit('clean')], NOW);
    expect(second.kind === 'update' && second.patch).toMatchObject({
      status: 'suspended',
      suspended_reason: 'ownership_lost',
      removal_due_at: new Date(NOW.getTime() + OWNERSHIP_LOST_REMOVAL_MS),
    });
    expect(second.kind === 'update' && second.notices.map((notice) => notice.kind)).toEqual(['suspended']);
    // DKIM FAILED 2회 → dkim_failed.
    const dkim = decide(row({ consecutiveDefinitiveFailures: 1 }), [check('present'), audit('clean', 'failed')], NOW);
    expect(dkim.kind === 'update' && dkim.patch).toMatchObject({ status: 'suspended', suspended_reason: 'dkim_failed', removal_due_at: null });
    // 성공은 카운터를 지운다.
    const ok = decide(row({ consecutiveDefinitiveFailures: 1 }), [check('present'), audit('clean')], NOW);
    expect(ok.kind === 'update' && ok.patch).toMatchObject({ consecutive_definitive_failures: 0, next_check_at: new Date(NOW.getTime() + RECHECK_INTERVAL_MS) });
  });

  it('★ reputation · operator · plan_limit 은 자동 복귀하지 않는다 · ownership_lost · dkim_failed 는 복귀한다', () => {
    for (const reason of ['reputation', 'operator', 'plan_limit'] as const) {
      const decision = decide(row({ status: 'suspended', suspendedReason: reason, suspendedAt: NOW }), [check('present'), audit('clean')], NOW);
      expect(decision.kind === 'update' && decision.patch['status'], reason).toBeUndefined();
    }
    const lost = decide(row({ status: 'suspended', suspendedReason: 'ownership_lost', suspendedAt: NOW, removalDueAt: NOW }), [check('present'), audit('clean')], NOW);
    expect(lost.kind === 'update' && lost.patch).toMatchObject({ status: 'verified', suspended_reason: null, removal_due_at: null });
    const dkimPending = decide(row({ status: 'suspended', suspendedReason: 'dkim_failed', suspendedAt: NOW }), [check('present'), audit('clean', 'pending')], NOW);
    expect(dkimPending.kind === 'update' && dkimPending.patch['status']).toBeUndefined(); // DKIM 성공을 봐야 푼다
    const dkimOk = decide(row({ status: 'suspended', suspendedReason: 'dkim_failed', suspendedAt: NOW }), [check('present'), audit('clean', 'success')], NOW);
    expect(dkimOk.kind === 'update' && dkimOk.patch['status']).toBe('verified');
  });

  it('확인 완료 알림(verified) — 첫 확인 · 자동 복귀(ownership_lost · dkim_failed)마다 한 번(사건 키 = 그 시각) · 그대로 verified · 사람만 푸는 정지는 없다', () => {
    const epoch = String(Math.floor(NOW.getTime() / 1000));
    const first = decide(row({ status: 'verifying', sagaStep: 'done', verifiedAt: null }), [check('present', 'ses'), audit('clean', 'success')], NOW);
    expect(first.kind === 'update' && first.notices).toEqual([{ kind: 'verified', eventKey: `verified:${epoch}` }]);
    const lost = decide(row({ status: 'suspended', suspendedReason: 'ownership_lost', suspendedAt: NOW, removalDueAt: NOW }), [check('present'), audit('clean')], NOW);
    expect(lost.kind === 'update' && lost.notices).toEqual([{ kind: 'verified', eventKey: `recovered:${epoch}` }]);
    const dkimOk = decide(row({ status: 'suspended', suspendedReason: 'dkim_failed', suspendedAt: NOW }), [check('present'), audit('clean', 'success')], NOW);
    expect(dkimOk.kind === 'update' && dkimOk.notices.map((notice) => notice.kind)).toEqual(['verified']);
    // 이미 verified 인 행의 평소 확인 · 확인 안 된 verifying · 사람만 푸는 정지는 알리지 않는다.
    const steady = decide(row(), [check('present'), audit('clean')], NOW);
    expect(steady.kind === 'update' && steady.notices).toEqual([]);
    const notYet = decide(row({ status: 'verifying', sagaStep: 'done', verifiedAt: null }), [check('absent'), audit('clean', 'success')], NOW);
    expect(notYet.kind === 'update' && notYet.notices).toEqual([]);
    for (const reason of ['reputation', 'operator', 'plan_limit'] as const) {
      const held = decide(row({ status: 'suspended', suspendedReason: reason, suspendedAt: NOW }), [check('present'), audit('clean')], NOW);
      expect(held.kind === 'update' && held.notices, reason).toEqual([]);
    }
    // 다른 회차는 다른 키 — 복귀 뒤 다시 정지 · 복귀하면 또 보낸다.
    const later = new Date(NOW.getTime() + 60_000);
    const again = decide(row({ status: 'suspended', suspendedReason: 'ownership_lost', suspendedAt: NOW, removalDueAt: NOW }), [check('present'), audit('clean')], later);
    expect(again.kind === 'update' && again.notices[0]?.eventKey).not.toBe(`recovered:${epoch}`);
  });

  it('정지 사유는 세지는 쪽으로만 — 약한 사유로 바꾸지 않는다 · drift → operator · 만료 → ownership_lost · D-30/D-7 예고', () => {
    expect(canSuspend(row({ status: 'suspended', suspendedReason: 'reputation' }), 'ownership_lost')).toBe(false);
    expect(canSuspend(row({ status: 'suspended', suspendedReason: 'plan_limit' }), 'dkim_failed')).toBe(true);
    const drift = decide(row(), [check('present'), audit('drift')], NOW);
    expect(drift.kind === 'update' && drift.patch).toMatchObject({ status: 'suspended', suspended_reason: 'operator' });
    // RDAP 만료(#13 L1) — 첫 관측은 기록만 · 하루가 안 지났으면 기록만 · 앞 틱도 하루 넘게 지난 만료를 봤으면 그때 ownership_lost.
    const expiry = (at: string): DomainControlResult => ({ op: 'check_expiry', rowId: ID, outcome: 'ok', expiresAt: at, errorCode: null });
    const first = decide(row(), [check('present'), audit('clean'), expiry('2026-10-18T00:00:00.000Z')], NOW);
    expect(first.kind === 'update' && first.patch).toMatchObject({ registration_expires_at: new Date('2026-10-18T00:00:00.000Z') });
    expect(first.kind === 'update' && first.patch['status']).toBeUndefined();
    const previous = { registrationExpiresAt: new Date('2026-10-18T00:00:00.000Z'), registrationCheckedAt: new Date(NOW.getTime() - 86_400_000 + 1) };
    const recent = decide(row({ ...previous, registrationExpiresAt: new Date('2026-10-19T12:00:00.000Z') }), [check('present'), audit('clean'), expiry('2026-10-19T12:00:00.000Z')], NOW);
    expect(recent.kind === 'update' && recent.patch['status']).toBeUndefined(); // 지난 지 하루가 안 됐다
    const confirmed = decide(row({ registrationExpiresAt: new Date('2026-10-17T00:00:00.000Z'), registrationCheckedAt: new Date(NOW.getTime() - 86_400_000) }), [check('present'), audit('clean'), expiry('2026-10-17T00:00:00.000Z')], NOW);
    expect(confirmed.kind === 'update' && confirmed.patch).toMatchObject({ status: 'suspended', suspended_reason: 'ownership_lost' });
    const soon = decide(row(), [check('present'), audit('clean'), { op: 'check_expiry', rowId: ID, outcome: 'ok', expiresAt: '2026-10-25T00:00:00.000Z', errorCode: null }], NOW);
    expect(soon.kind === 'update' && soon.notices.map((notice) => notice.eventKey)).toEqual(['d30:20261025', 'd7:20261025']);
  });

  it('사가 — advanced 면 다음 단계로(policy 다음은 done) · identity 단계가 행 태그를 적는다 · error 는 시도 수만', () => {
    const advanced: DomainControlResult = {
      op: 'saga_step',
      rowId: ID,
      outcome: 'advanced',
      ownerRowTag: null,
      dkimTokens: ['abc', 'def', 'ghi'],
      dkimStatus: 'pending',
      mailFromStatus: 'unknown',
      policyDigest: 'f'.repeat(64),
      errorCode: null,
    };
    const identity = decide(row({ status: 'verifying', sagaStep: 'none', sesIdentityRowTag: null }), [advanced], NOW);
    expect(identity.kind === 'update' && identity.patch).toMatchObject({ saga_step: 'identity', ses_identity_row_tag: ID, dkim_tokens: ['abc', 'def', 'ghi'], next_check_at: NOW });
    const policy = decide(row({ status: 'verifying', sagaStep: 'config_set' }), [advanced], NOW);
    expect(policy.kind === 'update' && policy.patch).toMatchObject({ saga_step: 'done', policy_digest: 'f'.repeat(64) });
    const failed = decide(row({ status: 'verifying', sagaStep: 'mail_from', sagaAttempts: 2 }), [{ ...advanced, outcome: 'error', errorCode: 'TooManyRequestsException' }], NOW);
    expect(failed.kind === 'update' && failed.patch).toMatchObject({ saga_attempts: 3, last_error: 'toomanyrequestsexception' });
    expect(failed.kind === 'update' && failed.patch['saga_step']).toBeUndefined();
    const elsewhere = decide(row({ status: 'verifying', sagaStep: 'none' }), [{ ...advanced, outcome: 'identity_owned_elsewhere', ownerRowTag: 'x' }], NOW);
    expect(elsewhere.kind === 'update' && elsewhere.patch['last_error']).toBe('identity_owned_elsewhere');
  });

  it('verifying(사가 끝) — TXT present + MX missing|ses + DKIM success 일 때만 verified · pending — present+MX ok 는 진입 시도 · MX other 는 사유', () => {
    const verifying = row({ status: 'verifying', sagaStep: 'done', verifiedAt: null });
    expect(decide(verifying, [check('present', 'missing'), audit('clean', 'success')], NOW)).toMatchObject({ kind: 'update', patch: { status: 'verified' } });
    for (const results of [
      [check('present', 'other'), audit('clean', 'success')],
      [check('absent'), audit('clean', 'success')],
      [check('present'), audit('clean', 'pending')],
    ]) {
      const decision = decide(verifying, results, NOW);
      expect(decision.kind === 'update' && decision.patch['status']).toBeUndefined();
    }
    expect(decide(row({ status: 'pending' }), [check('present', 'ses')], NOW)).toMatchObject({ kind: 'enter_verifying', inboundMx: 'ses', patch: {} });
    expect(decide(row({ status: 'pending' }), [check('present', 'other')], NOW)).toMatchObject({ kind: 'update', patch: { pending_reason: 'subdomain_has_mail' } });
  });

  it('★ DMARC 는 확인과 무관하다(2026-10-06 권장 레코드) — DMARC 없는 결과로 verified · 수명주기 · DNS 조회 · domain-control 은 DMARC 를 묻지 않는다', () => {
    const verifying = row({ status: 'verifying', sagaStep: 'done', verifiedAt: null });
    expect(decide(verifying, [check('present', 'ses'), audit('clean', 'success')], NOW)).toMatchObject({ kind: 'update', patch: { status: 'verified' } });
    for (const file of ['src/domains/lifecycle.ts', 'src/domains/dns-lookup.ts', 'src/runtime/handlers/domain-control.ts']) {
      expect(readFileSync(file, 'utf8')).not.toMatch(/dmarc/i);
    }
  });

  it('제거 사가 — policy → identity → done · not_owner 는 곧바로 done(남의 identity 는 지우지 않는다) · error 는 그대로', () => {
    const removed = row({ status: 'removed', removedAt: NOW });
    const advanced: DomainControlResult = { op: 'remove_step', rowId: ID, outcome: 'advanced', errorCode: null };
    expect(decide(removed, [advanced], NOW)).toMatchObject({ patch: { removal_step: 'policy' } });
    expect(decide({ ...removed, removalStep: 'policy' }, [advanced], NOW)).toMatchObject({ patch: { removal_step: 'done', identity_deleted_at: NOW } });
    expect(decide(removed, [{ ...advanced, outcome: 'not_owner' }], NOW)).toMatchObject({ patch: { removal_step: 'done' } });
    const error = decide(removed, [{ ...advanced, outcome: 'error', errorCode: 'Throttling' }], NOW);
    expect(error.kind === 'update' && error.patch['removal_step']).toBeUndefined();
  });

  it('last_error 는 칸 모양으로', () => {
    expect(lastErrorOf('AlreadyExistsException')).toBe('alreadyexistsexception');
    expect(lastErrorOf('9bad code')).toBe('e_9bad_code');
    expect(lastErrorOf(null)).toBeNull();
  });
});

describe('③ 시간 전이 · 요금제 강등', () => {
  it('pending 72시간 → removed(제거 사가도 끝) · verifying 72시간 → removed(사가가 identity 를 지운다) · ownership_lost 14일 → removed + 알림 · D-3 예고', () => {
    const old = new Date(NOW.getTime() - PENDING_EXPIRY_MS - 1);
    expect(timedTransition(row({ status: 'pending', createdAt: old, identityClaimedAt: null }), NOW)?.patch).toMatchObject({ status: 'removed', removal_step: 'done' });
    // 관리자 pending(one-shot — identity 를 만들었다) 만료는 제거 사가를 남긴다(넘겨주기 · 삭제).
    const stewardExpired = timedTransition(row({ status: 'pending', createdAt: old }), NOW);
    expect(stewardExpired?.patch).toMatchObject({ status: 'removed' });
    expect(stewardExpired?.patch['removal_step']).toBeUndefined();
    // 관리권을 놓은 pending 만료는 SES 0.
    expect(timedTransition(row({ status: 'pending', createdAt: old, identityReleasedAt: NOW }), NOW)?.patch).toMatchObject({ removal_step: 'done' });
    expect(timedTransition(row({ status: 'pending', createdAt: NOW }), NOW)).toBeNull();
    const verifying = timedTransition(row({ status: 'verifying', txtVerifiedAt: old }), NOW);
    expect(verifying?.patch).toMatchObject({ status: 'removed' });
    expect(verifying?.patch['removal_step']).toBeUndefined();
    const lost = timedTransition(row({ status: 'suspended', suspendedReason: 'ownership_lost', removalDueAt: new Date(NOW.getTime() - 1) }), NOW);
    expect(lost?.patch).toMatchObject({ status: 'removed', suspended_reason: null });
    expect(lost?.notices.map((notice) => notice.kind)).toEqual(['removed']);
    const d3 = timedTransition(row({ status: 'suspended', suspendedReason: 'ownership_lost', removalDueAt: new Date(NOW.getTime() + 2 * 86_400_000) }), NOW);
    expect(d3?.patch).toEqual({});
    expect(d3?.notices.map((notice) => notice.kind)).toEqual(['removal_d3']);
  });

  it('요금제 강등 — 정책 로더와 같은 해석(resolveEntitlements): 유예 중이면 그 요금제 · 유예 만료면 Free(전부 강등) · 행 없음 = Free · 한도 안 plan_limit 은 복귀', () => {
    const at = (days: number): Date => new Date(NOW.getTime() - days * 86_400_000);
    const rows = [row({ id: 'a', verifiedAt: at(3) }), row({ id: 'b', verifiedAt: at(2) }), row({ id: 'c', verifiedAt: at(1), status: 'suspended', suspendedReason: 'plan_limit' })];
    expect(planLimitChanges({ planCode: 'pro', graceUntil: null, rows }, NOW).map((change) => [change.row.id, change.to])).toEqual([['b', 'plan_limit']]);
    expect(planLimitChanges({ planCode: 'team', graceUntil: null, rows }, NOW).map((change) => [change.row.id, change.to])).toEqual([['c', 'verified']]);
    // 유예 중 — 요금제(pro) 그대로: 한도 1 이라 b 만.
    expect(planLimitChanges({ planCode: 'team', graceUntil: new Date(NOW.getTime() + 1), rows }, NOW).map((change) => [change.row.id, change.to])).toEqual([['c', 'verified']]);
    expect(planLimitChanges({ planCode: 'pro', graceUntil: new Date(NOW.getTime() + 1), rows }, NOW).map((change) => [change.row.id, change.to])).toEqual([['b', 'plan_limit']]);
    // 유예 만료(= 지금 포함) — Free(0): verified 전부 강등, plan_limit 행은 그대로(복귀 없음).
    expect(planLimitChanges({ planCode: 'team', graceUntil: NOW, rows }, NOW).map((change) => [change.row.id, change.to])).toEqual([['a', 'plan_limit'], ['b', 'plan_limit']]);
    // 모르는 요금제 코드도 Free.
    expect(planLimitChanges({ planCode: 'enterprise', graceUntil: null, rows }, NOW).map((change) => change.row.id)).toEqual(['a', 'b']);
    expect(planLimitChanges({ planCode: null, graceUntil: null, rows }, NOW).map((change) => change.row.id)).toEqual(['a', 'b']);
  });
});

describe('④ 한 번에 설정(one-shot) — identity 관리자', () => {
  const OTHER = '33333333-3333-4333-8333-333333333333';
  const pendingRow = (patch: Partial<DomainRow> = {}): DomainRow =>
    row({ status: 'pending', txtVerifiedAt: null, verifiedAt: null, sagaStep: 'none', sesIdentityRowTag: null, dkimStatus: 'unknown', mailFromStatus: 'unknown', ...patch });
  const peekResult = (ownerIsRow: boolean, tokens: readonly string[] = ['a1', 'b2', 'c3']): DomainControlResult => ({
    op: 'peek_identity',
    rowId: ID,
    outcome: 'found',
    ownerIsRow,
    dkimTokens: tokens,
    dkimStatus: ownerIsRow ? 'pending' : 'unknown',
    mailFromStatus: ownerIsRow ? 'pending' : 'unknown',
    errorCode: null,
  });
  const sagaOk: DomainControlResult = {
    op: 'saga_step',
    rowId: ID,
    outcome: 'advanced',
    ownerRowTag: null,
    dkimTokens: ['a1', 'b2', 'c3'],
    dkimStatus: 'pending',
    mailFromStatus: 'not_started',
    policyDigest: null,
    errorCode: null,
  };

  it('planRow pending 4경우 — 클레임 전 · 관리자 사가 중 · 관리자 사가 끝 · 관리자 아님(토큰만)', () => {
    // 클레임 전(관리자 아님) · 토큰 없음 → check + peek
    expect(ops(planRow(pendingRow({ identityClaimedAt: null }), ctx))).toEqual(['check', 'peek_identity']);
    // 관리자 · 사가 none → identity(채택 대상 함께) + check
    const first = planRow(pendingRow(), { ...ctx, supersededRowId: OTHER });
    expect(first[0]).toEqual({ op: 'saga_step', rowId: ID, domain: 'agents.example.com', registrable: 'example.com', step: 'identity', supersededRowId: OTHER });
    expect(ops(first)).toEqual(['saga_step', 'check']);
    // 관리자 · mail_from 단계 — 채택 대상은 identity 단계에만
    expect(planRow(pendingRow({ sagaStep: 'identity' }), { ...ctx, supersededRowId: OTHER })[0]).toMatchObject({ step: 'mail_from', supersededRowId: null });
    expect(planRow(pendingRow({ sagaStep: 'mail_from' }), ctx)[0]).toMatchObject({ step: 'config_set' });
    // 관리자 · 사가 = config_set → check + peek(상태 표시) · policy 는 보내지 않는다
    expect(ops(planRow(pendingRow({ sagaStep: 'config_set' }), ctx))).toEqual(['check', 'peek_identity']);
    // 관리권을 놓은 행 → 관리자 아님
    expect(ops(planRow(pendingRow({ identityReleasedAt: NOW, sagaStep: 'config_set' }), ctx))).toEqual(['check', 'peek_identity']);
    // 기한 전이면 없음
    expect(planRow(pendingRow({ nextCheckAt: new Date(NOW.getTime() + 60_000) }), ctx)).toEqual([]);
  });

  it('★ pending 에는 policy 단계를 보내지 않는다 — 어떤 사가 단계 · 관리자 여부에서도', () => {
    for (const sagaStep of ['none', 'identity', 'mail_from', 'config_set', 'done'] as const) {
      for (const identityClaimedAt of [null, NOW]) {
        const requests = planRow(pendingRow({ sagaStep, identityClaimedAt }), ctx);
        expect(requests.filter((request) => request.op === 'saga_step' && request.step === 'policy')).toEqual([]);
        expect(requests.filter((request) => request.op === 'sync_policy' || request.op === 'audit_policy')).toEqual([]);
      }
    }
    expect(pendingSagaStep('none')).toBe('identity');
    expect(pendingSagaStep('config_set')).toBeNull();
    expect(pendingSagaStep('done')).toBeNull();
  });

  it('decide pending — 사가 identity 나아감 → 토큰 · 태그 · 사가 칸 저장, 상태 불변, 다음 틱이 잇는다', () => {
    const decision = decide(pendingRow(), [sagaOk, check('absent')], NOW);
    expect(decision.kind).toBe('update');
    if (decision.kind !== 'update') return;
    expect(decision.patch).toMatchObject({ saga_step: 'identity', ses_identity_row_tag: ID, dkim_tokens: ['a1', 'b2', 'c3'], dkim_status: 'pending', next_check_at: NOW });
    expect(decision.patch['status']).toBeUndefined();
    expect(decision.transition).toBeNull();
    // config_set 다음은 policy 가 아니라 멈춘다 — 사가 칸이 'done' 이 되지 않는다.
    const last = decide(pendingRow({ sagaStep: 'mail_from' }), [sagaOk, check('absent')], NOW);
    expect(last.kind === 'update' && last.patch['saga_step']).toBe('config_set');
  });

  it('decide pending — 관리자 아닌 peek 은 토큰만(상태 칸 불변) · 관리자 peek 은 상태도 · identity_owned_elsewhere 지표 없음', () => {
    const other = decide(pendingRow({ identityClaimedAt: null }), [check('absent'), peekResult(false)], NOW);
    expect(other.kind === 'update' && other.patch).toMatchObject({ dkim_tokens: ['a1', 'b2', 'c3'] });
    expect(other.kind === 'update' && other.patch['dkim_status']).toBeUndefined();
    expect(other.kind === 'update' && other.patch['mail_from_status']).toBeUndefined();
    expect(other.metrics).toEqual([]);
    const own = decide(pendingRow({ sagaStep: 'config_set', dkimTokens: ['a1', 'b2', 'c3'] }), [check('absent'), peekResult(true)], NOW);
    expect(own.kind === 'update' && own.patch).toMatchObject({ dkim_status: 'pending', mail_from_status: 'pending' });
    expect(own.kind === 'update' && own.patch['dkim_tokens']).toBeUndefined(); // 같은 토큰은 다시 쓰지 않는다
  });

  it('decide pending — TXT present 이면 진입 시도에 사가 · peek 결과를 함께 싣는다', () => {
    const decision = decide(pendingRow(), [sagaOk, check('present', 'missing')], NOW);
    expect(decision).toMatchObject({ kind: 'enter_verifying', inboundMx: 'missing', patch: { saga_step: 'identity', dkim_tokens: ['a1', 'b2', 'c3'] } });
  });

  it('removed 관리자 — 넘겨받고 채택 전이면 먼저 채택(saga identity) · 채택 결과는 태그만 · not_owner 는 포기(released)', () => {
    const removed = row({ status: 'removed', removedAt: NOW, removalStep: 'none', sagaStep: 'none', sesIdentityRowTag: null });
    expect(planRow(removed, { ...ctx, supersededRowId: OTHER })).toEqual([
      { op: 'saga_step', rowId: ID, domain: 'agents.example.com', registrable: 'example.com', step: 'identity', supersededRowId: OTHER },
    ]);
    expect(ops(planRow(removed, ctx))).toEqual(['remove_step']); // 채택 대상이 없으면 정상 제거 사가(domain-control 이 태그를 본다)
    const adopted = decide(removed, [sagaOk], NOW);
    expect(adopted.kind === 'update' && adopted.patch).toMatchObject({ ses_identity_row_tag: ID });
    expect(adopted.kind === 'update' && adopted.patch['removal_step']).toBeUndefined();
    const notOwner = decide(row({ status: 'removed', removedAt: NOW }), [{ op: 'remove_step', rowId: ID, outcome: 'not_owner', errorCode: null }], NOW);
    expect(notOwner.kind === 'update' && notOwner.patch).toMatchObject({ removal_step: 'done', identity_released_at: NOW });
    // 관리자가 아니던 행의 not_owner 는 놓을 것이 없다.
    const plain = decide(row({ status: 'removed', removedAt: NOW, identityClaimedAt: null }), [{ op: 'remove_step', rowId: ID, outcome: 'not_owner', errorCode: null }], NOW);
    expect(plain.kind === 'update' && plain.patch['identity_released_at']).toBeUndefined();
  });

  it('removalHandoverDue — 관리자 · 정책 없음(사가가 정책 전) 또는 정책 단계를 지났을 때만', () => {
    const removed = (patch: Partial<DomainRow>): DomainRow => row({ status: 'removed', removedAt: NOW, ...patch });
    expect(removalHandoverDue(removed({ removalStep: 'none', sagaStep: 'config_set' }))).toBe(true);
    expect(removalHandoverDue(removed({ removalStep: 'none', sagaStep: 'done' }))).toBe(false); // 정책을 먼저 지운다
    expect(removalHandoverDue(removed({ removalStep: 'policy', sagaStep: 'done' }))).toBe(true);
    expect(removalHandoverDue(removed({ removalStep: 'done' }))).toBe(false);
    expect(removalHandoverDue(removed({ removalStep: 'policy', identityReleasedAt: NOW }))).toBe(false);
    expect(removalHandoverDue(removed({ removalStep: 'policy', identityClaimedAt: null }))).toBe(false);
    expect(removalHandoverDue(row({ status: 'verified' }))).toBe(false);
  });

  it('isSteward — claimed ∧ ¬released ∧ ¬deleted', () => {
    expect(isSteward(row())).toBe(true);
    expect(isSteward(row({ identityClaimedAt: null }))).toBe(false);
    expect(isSteward(row({ identityReleasedAt: NOW }))).toBe(false);
    expect(isSteward(row({ identityDeletedAt: NOW }))).toBe(false);
  });
});
