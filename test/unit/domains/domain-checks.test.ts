/**
 * 도메인 보기의 레코드별 확인 상태(`checks` — 2026-10 콘솔 도메인 화면). 순수 접기 `domainChecksOf` 와 `domainView` 가 그것을 싣는지 · 기존 칸은 그대로인지.
 */

import { describe, expect, it } from 'vitest';

import { domainChecksOf, domainView, type DomainCheckState } from '../../../src/admin/ops/domains';
import { CUSTOM_DOMAIN_SES_STATUSES, INBOUND_MX_STATUSES, type CustomDomainSesStatus, type InboundMxStatus } from '../../../src/domains/contract';
import type { DomainRow } from '../../../src/domains/store';

const NOW = new Date('2026-10-05T00:00:00.000Z');
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
    txtVerifiedAt: new Date(NOW.getTime() - 86_400_000),
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
    lastCheckedAt: NOW,
    nextCheckAt: NOW,
    consecutiveDefinitiveFailures: 0,
    registrationExpiresAt: null,
    registrationCheckedAt: null,
    verifiedAt: NOW,
    suspendedAt: null,
    removedAt: null,
    removalDueAt: null,
    identityDeletedAt: null,
    identityClaimedAt: null,
    identityReleasedAt: null,
    identityHandoverTo: null,
    createdAt: new Date(NOW.getTime() - 2 * 86_400_000),
    updatedAt: NOW,
    ...patch,
  };
}

describe('domainChecksOf — 레코드별 확인 상태', () => {
  it('verified · 전부 성공 → 넷 다 ok', () => {
    expect(domainChecksOf(row())).toEqual({ ownership: 'ok', dkim: 'ok', mailFrom: 'ok', inboundMx: 'ok' });
  });

  it('SES 상태 → DKIM · MAIL FROM(같은 표) — success ok · failed/temporary_failure failed · pending pending · not_started/unknown not_checked', () => {
    const expected: Record<CustomDomainSesStatus, DomainCheckState> = {
      success: 'ok',
      failed: 'failed',
      temporary_failure: 'failed',
      pending: 'pending',
      not_started: 'not_checked',
      unknown: 'not_checked',
    };
    for (const status of CUSTOM_DOMAIN_SES_STATUSES) {
      expect(domainChecksOf(row({ dkimStatus: status })).dkim, status).toBe(expected[status]);
      expect(domainChecksOf(row({ mailFromStatus: status })).mailFrom, status).toBe(expected[status]);
    }
  });

  it('수신 MX — ses ok · other failed · missing pending · unknown not_checked', () => {
    const expected: Record<InboundMxStatus, DomainCheckState> = { ses: 'ok', other: 'failed', missing: 'pending', unknown: 'not_checked' };
    for (const status of INBOUND_MX_STATUSES) expect(domainChecksOf(row({ inboundMxStatus: status })).inboundMx, status).toBe(expected[status]);
  });

  it('소유 확인 — pending(TXT 전) pending · verifying(TXT 확인됨) ok · ownership_lost failed · 다른 정지는 ok', () => {
    const fresh = row({ status: 'pending', txtVerifiedAt: null, verifiedAt: null, dkimStatus: 'not_started', mailFromStatus: 'not_started', inboundMxStatus: 'unknown' });
    expect(domainChecksOf(fresh)).toEqual({ ownership: 'pending', dkim: 'not_checked', mailFrom: 'not_checked', inboundMx: 'not_checked' });
    expect(domainChecksOf(row({ status: 'pending', txtVerifiedAt: null, pendingReason: 'subdomain_has_mail', inboundMxStatus: 'other' }))).toMatchObject({ ownership: 'pending', inboundMx: 'failed' });
    expect(domainChecksOf(row({ status: 'verifying', verifiedAt: null, dkimStatus: 'pending' }))).toMatchObject({ ownership: 'ok', dkim: 'pending' });
    expect(domainChecksOf(row({ status: 'suspended', suspendedReason: 'ownership_lost' })).ownership).toBe('failed');
    expect(domainChecksOf(row({ status: 'suspended', suspendedReason: 'dkim_failed', dkimStatus: 'failed' }))).toMatchObject({ ownership: 'ok', dkim: 'failed' });
    for (const reason of ['reputation', 'operator', 'plan_limit'] as const) {
      expect(domainChecksOf(row({ status: 'suspended', suspendedReason: reason })).ownership, reason).toBe('ok');
    }
  });

  it('removed — 더 확인하지 않는다(넷 다 not_checked)', () => {
    expect(domainChecksOf(row({ status: 'removed', removedAt: NOW }))).toEqual({ ownership: 'not_checked', dkim: 'not_checked', mailFrom: 'not_checked', inboundMx: 'not_checked' });
  });

  it('domainView 는 checks 를 덧붙인다 — 기존 칸(상태 문자열)은 그대로', () => {
    const view = domainView(row({ dkimStatus: 'pending', inboundMxStatus: 'missing' }));
    expect(view.checks).toEqual({ ownership: 'ok', dkim: 'pending', mailFrom: 'ok', inboundMx: 'pending' });
    expect(view).toMatchObject({ status: 'verified', dkimStatus: 'pending', mailFromStatus: 'success', inboundMxStatus: 'missing' });
  });
});
